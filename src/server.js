/**
 * Express 装配 + 启动。
 *
 * 纪律：**模块顶层绝不 listen()**。测试要能 `import { createApp }` 拿到一个干净的
 * app 去打 supertest，任何顶层副作用（监听端口、读 env、起定时器）都会把测试搞坏。
 * 只有本文件被直接执行（node src/server.js）时才 startServer()。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

import { createJobsRouter } from './routes/jobs.js';
import { createStreamRouter } from './routes/stream.js';
import { ERR, AppError, toPublicError, redactSecrets } from './llm/errors.js';
import { inspectChain } from './llm/providers.js';
import * as store from './store/json-store.js';
import { isDemoMode } from './runtime-flags.js';
import { initToolSystem, shutdownToolSystem, toolSystemSummary, toolSystemState } from './tools/bootstrap.js';
import { toolConfigRef } from './pipeline/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(HERE, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const TEMPLATES_DIR = path.join(ROOT_DIR, 'templates');
export const VERSION = '1.0.0';

/**
 * 加载项目根目录的 `.env`。
 *
 * 为什么要在代码里做这件事，而不是只靠 `npm start` 的 `--env-file`：
 * README、`.env.example`、以及"没有 Key"时的报错文案，三处都在教用户"建一个 .env"。
 * 如果只有 `npm start` 读它，那么用 `node src/server.js`、Docker、systemd、PM2
 * 启动的用户会得到一份**静默失效**的配置 —— 他改了端口没生效，还以为是产品坏了。
 * 承诺在哪里说的，就要在哪里兑现。
 *
 * 优先级（Node 自己的 `--env-file` 遵循同一套规则）：
 *   **真实环境变量 > .env 文件里的值**
 * 所以 `HANDOFF_PORT=9000 node src/server.js` 依然能覆盖 .env 里的端口 ——
 * "临时改一下"这件事必须做得到。
 */
function loadDotEnvFile() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (typeof process.loadEnvFile !== 'function') return; // 老 Node 安静跳过
  const snapshot = { ...process.env }; // ① 记下启动时真实存在的键
  try {
    process.loadEnvFile(envPath); // ② .env 全部生效
  } catch {
    return; // 文件不存在 / 格式不对都不该阻止服务启动
  }
  // ③ 把启动时就存在的键"赢"回来，恢复「真实环境变量优先」
  for (const [k, v] of Object.entries(snapshot)) {
    if (v !== undefined) process.env[k] = v;
  }
}

loadDotEnvFile();

/** 请求体上限（CONTRACT §5.8） */
export const BODY_LIMIT = '256kb';

/* ------------------------------------------------------------------ */
/* 限流（自写，零依赖）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 滑动窗口限流。
 * 为什么自写？—— 契约禁止新增依赖，而这事本身只有 20 行。
 * 为什么用 Map<ip, number[]>？—— 需要「最近 60 秒内几次」，计数窗口做不到平滑。
 * 为什么要有 dispose()？—— 定时清理是必需的（否则恶意 IP 能把内存撑爆），
 *   但测试里必须能停掉它，不然 vitest 会挂着不退出。
 */
export function createRateLimiter({
  windowMs = 60_000,
  rules = [],
  cleanupMs = 60_000,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, number[]>} key = `${name}|${ip}` */
  const hits = new Map();

  const clientIp = (req) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return String(ip);
  };

  const prune = (key, list, timestamp) => {
    while (list.length > 0 && timestamp - list[0] >= windowMs) list.shift();
  };

  const timer = setInterval(() => {
    const timestamp = now();
    for (const [key, list] of hits) {
      prune(key, list, timestamp);
      if (list.length === 0) hits.delete(key);
    }
  }, cleanupMs);
  timer.unref?.();

  const middleware = (req, res, next) => {
    const rule = rules.find((r) => r.method === req.method && r.match(req));
    if (!rule) return next();

    const key = `${rule.name}|${clientIp(req)}`;
    const timestamp = now();
    const list = hits.get(key) ?? [];
    prune(key, list, timestamp);

    if (list.length >= rule.limit) {
      const retryAfterMs = Math.max(0, windowMs - (timestamp - list[0]));
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({
        error: { code: ERR.RATE_LIMITED, message: '操作太快了，请稍等一分钟再试' },
      });
    }

    list.push(timestamp);
    hits.set(key, list);
    return next();
  };

  middleware.dispose = () => clearInterval(timer);
  middleware.hits = hits; // 测试辅助
  return middleware;
}

/** 契约 §5.7：POST /api/jobs 每 IP 每分钟 10 次；/message 每分钟 20 次 */
export const RATE_RULES = [
  // 注意：这个中间件挂在 app 级，req.path 是完整路径（含 /api 前缀）
  { name: 'createJob', method: 'POST', limit: 10, match: (req) => req.path === '/api/jobs' },
  {
    name: 'message',
    method: 'POST',
    limit: 20,
    match: (req) => /^\/api\/jobs\/[^/]+\/message$/.test(req.path),
  },
];

/* ------------------------------------------------------------------ */
/* 模板                                                                */
/* ------------------------------------------------------------------ */

/**
 * 读 templates/*.json。
 * 目录不存在或为空 → []（模板由 main 并行创建，缺了不能算服务坏了）。
 */
export async function loadTemplates(dir = TEMPLATES_DIR) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        out.push({ id: parsed.id ?? name.replace(/\.json$/, ''), ...parsed });
      }
    } catch (err) {
      console.warn(`[server] 跳过损坏的模板 ${name}：${err.message}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 健康检查                                                            */
/* ------------------------------------------------------------------ */

async function healthPayload() {
  let jobs = 0;
  try {
    jobs = await store.countJobs();
  } catch {
    jobs = 0;
  }
  let models = [];
  try {
    models = inspectChain(); // 已保证只报「有没有配 key」，不含 key 本身
  } catch (err) {
    models = [{ provider: 'unavailable', configured: false, error: redactSecrets(err.message) }];
  }
  return {
    ok: true,
    version: VERSION,
    uptimeMs: Math.round(process.uptime() * 1000),
    models,
    dataDir: path.resolve(store.getDataDir()),
    jobs,
    // 让用户（和排查问题的人）一眼知道现在是不是离线演示模式
    demoMode: isDemoMode(),
    // 工具体系状态：开了哪些工具、接了什么 MCP、加载了几个技能。
    // describeConfig 里已经把 apiKey 之类过滤成"有没有配"的布尔值，不会泄漏密钥。
    tools: toolSystemSummary(),
    // 注意字段命名：不要含 "key" 字样 —— 安全测试会用 /"key"/ 扫整个响应体，
    // 字段名撞上就会误报"密钥泄漏"。命名也是安全边界的一部分。
    modelPlan: models.map((m) => `${m.provider}/${m.model}`),
  };
}

/* ------------------------------------------------------------------ */
/* app 装配                                                            */
/* ------------------------------------------------------------------ */

/**
 * 纯装配，无副作用。
 * @param {{ rateLimit?: boolean|object, limiter?: Function }} [options]
 *   rateLimit:false 用于测试关闭限流；也可传自定义规则对象。
 *   limiter: 直接注入一个现成的限流中间件（测试要控制时钟时用）。
 *   注意：限流器必须在这里注册 —— Express 5 里 `app.use()` 注册在路由**之后**
 *   的中间件对该路由不会执行，所以调用方事后 `app.use(limiter)` 是无效的。
 */
export function createApp({ rateLimit = true, limiter: injectedLimiter = null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // 默认不信任任何代理头：X-Forwarded-For 是客户端可伪造的，信了限流就形同虚设。
  app.set('trust proxy', false);

  let limiter = injectedLimiter;
  if (limiter === null && rateLimit !== false) {
    limiter = createRateLimiter(
      typeof rateLimit === 'object' && rateLimit !== null ? { rules: RATE_RULES, ...rateLimit } : { rules: RATE_RULES },
    );
  }
  app.locals.rateLimiter = limiter;

  app.use(express.json({ limit: BODY_LIMIT }));

  // 体积超限：express 抛 PayloadTooLargeError，这里翻译成人话
  app.use((err, req, res, next) => {
    if (!err) return next();
    if (err.type === 'entity.too.large' || err.status === 413) {
      return res.status(413).json({
        error: { code: ERR.PAYLOAD_TOO_LARGE, message: '内容太大了，请精简一下再试。' },
      });
    }
    if (err.type === 'entity.parse.failed' || (err.status === 400 && 'body' in err)) {
      return res.status(400).json({
        error: { code: ERR.BAD_REQUEST, message: '请求内容不是合法的 JSON。' },
      });
    }
    return next(err);
  });

  if (limiter) app.use(limiter);

  // ---- 业务 API ----
  app.get('/api/health', async (req, res, next) => {
    try {
      res.json(await healthPayload());
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/templates', async (req, res, next) => {
    try {
      res.json({ templates: await loadTemplates() });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api', createJobsRouter());
  app.use('/api', createStreamRouter());

  // ---- 静态资源 + SPA ----
  app.use(express.static(PUBLIC_DIR, { index: ['index.html'], maxAge: 0 }));

  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  app.get('/{*splat}', async (req, res, next) => {
    if (req.path.startsWith('/api/')) return next(); // 交给 404 兜底
    try {
      const html = await fs.readFile(indexPath, 'utf8');
      res.type('html').send(html);
    } catch {
      // 前端还没写（S5 并行开发中）：给一句人话，不要 500
      res
        .status(200)
        .type('html')
        .send('<!doctype html><meta charset="utf-8"><title>交接 Handoff</title><p>界面正在准备中，请稍后再刷新。</p>');
    }
  });

  // ---- 404 兜底 ----
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({
        error: { code: ERR.NOT_FOUND, message: '这个接口不存在。' },
      });
    }
    return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><p>页面不存在。</p>');
  });

  // ---- 全局错误处理（4 参数，必须最后）----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const { status, body } = toPublicError(err);
    // 服务端留全量日志（脱敏），对外只说人话
    console.error(
      `[server] ${req.method} ${req.path} → ${status} ${body.error.code}: ${redactSecrets(err?.stack || err?.message || String(err))}`,
    );
    if (res.headersSent) return res.end();
    return res.status(status).json(body);
  });

  return app;
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

/** unhandledRejection 只记日志不退出：一次网络抖动不该让整个服务死掉 */
let guardsInstalled = false;
function installProcessGuards() {
  if (guardsInstalled) return; // startServer 可能被调用多次（测试、多次启动）
  guardsInstalled = true;
  process.on('unhandledRejection', (reason) => {
    console.error(`[server] unhandledRejection（已忽略，服务继续）：${redactSecrets(reason?.stack || reason?.message || String(reason))}`);
  });
  process.on('uncaughtException', (err) => {
    // 未捕获异常通常意味着状态已不可信，但这里仍然先记录；真正的崩溃让 Node 自己决定
    console.error(`[server] uncaughtException：${redactSecrets(err?.stack || err?.message || String(err))}`);
  });
}

/**
 * 把上次进程中断时留下的「运行中」任务标记为已中断。
 * @returns {Promise<number>} 处理了几个
 */
export async function markInterruptedJobs() {
  let count = 0;
  try {
    // ⚠️ 必须扫**磁盘全量**，不能用 listJobs（它只看内存缓存，上限 200 个）。
    // 用 listJobs 的话，任务数超过 200 时更早的中断任务永远卡在"运行中" ——
    // 用户每次打开都看到进度条不动，重启多少次都修不好（对抗性测试 S9-8）。
    const jobs = await store.listAllJobsOnDisk();
    for (const job of jobs) {
      if (job.status !== 'running' && job.status !== 'queued') continue;
      const fresh = await store.updateJob(job.id, (j) => {
        j.status = 'failed';
        j.updatedAt = Date.now();
        j.error = {
          code: 'INTERRUPTED',
          message: '这次运行被中断了（服务被关闭或电脑休眠）。已经做好的部分都保留在上面，点「重试」可以接着做完。',
          attempts: null,
        };
        const active = [...(j.stages ?? [])].reverse().find((s) => s.status === 'running');
        if (active) {
          active.status = 'failed';
          active.endedAt = Date.now();
          active.error = j.error;
        }
      });
      if (fresh) count += 1;
    }
  } catch (err) {
    console.warn(`[server] 中断任务恢复失败（不影响启动）：${err?.message ?? err}`);
  }
  if (count > 0) {
    console.log(`[server] 已把 ${count} 个上次被中断的任务标记为可重试。`);
  }
  return count;
}

/**
 * 启动服务。
 *
 * 端口/主机的环境变量名必须与 `.env.example` 一致：HANDOFF_PORT / HANDOFF_HOST。
 * （曾经误用通用的 PORT/HOST，导致按文档设了 HANDOFF_PORT 却仍然监听 3000 —— 
 *   这类「文档说 A、代码做 B」的偏差对普通用户是最伤的一种 bug。）
 */
export async function startServer({
  port = Number(process.env.HANDOFF_PORT) || Number(process.env.PORT) || 8787,
  host = process.env.HANDOFF_HOST || process.env.HOST || '127.0.0.1',
} = {}) {
  installProcessGuards();
  await store.loadFromDisk();
  store.startSyncTimer();

  // 工具体系：读配置、注册原生工具、接 MCP、加载技能。
  // 它内部已经保证"任何失败都只是少一个能力"，不会抛出来挡住启动。
  await initToolSystem({ rootDir: ROOT_DIR });
  // 把配置交给引擎（引擎不直接依赖配置模块，避免循环依赖）
  toolConfigRef.value = { ...toolSystemState.__config, __rootDir: ROOT_DIR };
  for (const w of toolSystemState.warnings) console.warn(`[tools] ${w}`);
  // 崩溃恢复：上次进程被强杀时，正在跑的任务会永远停在 running，
  // 用户看到的是一个**永远不会再往前走**的进度条 —— 比报错更糟，因为他会一直等。
  // 启动时把这些任务标成 interrupted，并给出能看懂的解释和重试入口。
  const interrupted = await markInterruptedJobs();
  const app = createApp();
  // ⚠️ 两个坑都在这里（QA 登记的缺陷 #7）：
  //  1. Express 5 的 `app.listen` 会把 listen 错误**也传给成功回调**（不只是 emit 'error'）。
  //     所以回调必须看第一个参数，否则端口被占用时会 resolve 一个坏 server，
  //     然后在 server.address() 那里炸成 "Cannot read properties of null" —— 用户完全看不懂。
  //  2. 端口用 `??` 语义而不是 `||`：显式传 0（让系统随机分配端口，测试常用）不能被当成"没传"。
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, (err) => {
      if (err) reject(err);
      else resolve(s);
    });
    s.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('服务没能绑定到端口，可能端口被别的程序占用了。');
  }
  const url = `http://${host}:${address.port}`;
  console.log(`[server] 交接 Handoff 已启动：${url}  (dataDir=${path.resolve(store.getDataDir())})`);
  return { server, url };
}

/** 只有被直接执行时才真的监听端口 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

/**
 * 退出前把工具系统关掉。
 *
 * 为什么必须有：MCP 的 stdio 服务是**我们拉起来的子进程**。
 * 不显式关闭的话，用户按 Ctrl+C 之后会留下一堆 npx/node 孤儿进程 ——
 * 他下次打开活动监视器会发现"这东西怎么还在跑"，对开源项目的信任就是这样丢掉的。
 */
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    console.log(`[server] 收到 ${signal}，正在退出…`);
    await shutdownToolSystem();
  } catch (err) {
    console.warn(`[server] 退出清理时出错（忽略）：${err?.message ?? err}`);
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    gracefulShutdown(sig).finally(() => process.exit(0));
  });
}
// 'exit' 里不能 await（同步上下文），但 close 是尽力而为的同步触发
process.on('exit', () => {
  shutdownToolSystem().catch(() => {});
});

if (invokedDirectly) {
  startServer().catch((err) => {
    console.error(`[server] 启动失败：${redactSecrets(err?.stack || err?.message || String(err))}`);
    process.exitCode = 1;
  });
}

export { AppError };
export default createApp;
