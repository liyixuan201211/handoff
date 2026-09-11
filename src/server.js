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

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(HERE, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const TEMPLATES_DIR = path.join(ROOT_DIR, 'templates');
export const VERSION = '1.0.0';

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
  };
}

/* ------------------------------------------------------------------ */
/* app 装配                                                            */
/* ------------------------------------------------------------------ */

/**
 * 纯装配，无副作用。
 * @param {{ rateLimit?: boolean|object, logger?: object }} [options]
 *   rateLimit:false 用于测试关闭限流；也可传自定义规则对象。
 */
export function createApp({ rateLimit = true } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // 默认不信任任何代理头：X-Forwarded-For 是客户端可伪造的，信了限流就形同虚设。
  app.set('trust proxy', false);

  const limiter =
    rateLimit === false
      ? null
      : createRateLimiter(
          typeof rateLimit === 'object' && rateLimit !== null ? { rules: RATE_RULES, ...rateLimit } : { rules: RATE_RULES },
        );
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
function installProcessGuards() {
  process.on('unhandledRejection', (reason) => {
    console.error(`[server] unhandledRejection（已忽略，服务继续）：${redactSecrets(reason?.stack || reason?.message || String(reason))}`);
  });
  process.on('uncaughtException', (err) => {
    // 未捕获异常通常意味着状态已不可信，但这里仍然先记录；真正的崩溃让 Node 自己决定
    console.error(`[server] uncaughtException：${redactSecrets(err?.stack || err?.message || String(err))}`);
  });
}

export async function startServer({ port = process.env.PORT || 3000, host = process.env.HOST || '127.0.0.1' } = {}) {
  installProcessGuards();
  await store.loadFromDisk();
  store.startSyncTimer();
  const app = createApp();
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });
  const url = `http://${host}:${server.address().port}`;
  console.log(`[server] 交接 Handoff 已启动：${url}  (dataDir=${path.resolve(store.getDataDir())})`);
  return { server, url };
}

/** 只有被直接执行时才真的监听端口 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  startServer().catch((err) => {
    console.error(`[server] 启动失败：${redactSecrets(err?.stack || err?.message || String(err))}`);
    process.exitCode = 1;
  });
}

export { AppError };
export default createApp;
