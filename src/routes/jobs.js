/**
 * 任务相关 HTTP 路由（CONTRACT §2）。
 *
 * 一条最重要的纪律：**POST /api/jobs 绝不 await 流水线跑完**。
 * 一个任务要跑几分钟，等它跑完再响应的话，浏览器和反向代理都会超时。
 * 所以这里只等 startJob() 把 job 建起来（拿到 id），立刻 201 返回，剩下的走 SSE 推。
 */
import express from 'express';
import * as engine from '../pipeline/engine.js';

// 注意：这里必须用 namespace 导入 + 运行时判空，不能写成
// `import { gradeDelivery } from '../pipeline/engine.js'`。
// 因为测试会 `vi.mock()` 整个 engine 模块，具名导入会变成 undefined 并在调用处崩，
// 而 namespace 导入能让这些函数**在模块被替换时优雅退化**（工程上比"崩"好得多）。
const { startJob, sendMessage, retryJob, cancelJob } = engine;
import { AppError, ERR, toPublicError } from '../llm/errors.js';
import * as store from '../store/json-store.js';
import { events } from '../store/events.js';
import { isValidJobId } from '../store/json-store.js';

/* ------------------------------------------------------------------ */
/* 输入限制（CONTRACT §2 / §5）                                         */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  GOAL_MIN: 1,
  GOAL_MAX: 4000,
  MESSAGE_MAX: 2000,
  AUDIENCE_MAX: 200,
  TEMPLATE_ID_MAX: 64,
  TONE_MAX: 16,
  DEADLINE_MAX: 64,
  FILENAME_MAX: 80,
};

const TONES = new Set(['normal', 'simple', 'formal']);

const bad = (message, code = ERR.BAD_REQUEST) => new AppError(code, message, { status: 400 });

/** 剥离控制字符（保留换行/制表），CONTRACT §5.1 */
export function stripControlChars(input) {
  // eslint-disable-next-line no-control-regex
  return String(input).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function requireGoal(raw) {
  if (raw === undefined || raw === null) throw bad('请说一下你需要什么帮助。');
  const goal = stripControlChars(raw).trim();
  if (goal.length < LIMITS.GOAL_MIN) throw bad('请说一下你需要什么帮助。');
  if (goal.length > LIMITS.GOAL_MAX) {
    throw bad(`需求描述太长了，最多 ${LIMITS.GOAL_MAX} 字，现在 ${goal.length} 字。`);
  }
  return goal;
}

export function requireMessageText(raw) {
  if (raw === undefined || raw === null) throw bad('消息内容不能为空。');
  const text = stripControlChars(raw).trim();
  if (text.length < 1) throw bad('消息内容不能为空。');
  if (text.length > LIMITS.MESSAGE_MAX) {
    throw bad(`补充说明太长了，最多 ${LIMITS.MESSAGE_MAX} 字，现在 ${text.length} 字。`);
  }
  return text;
}

function optionalString(raw, { max, field }) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = stripControlChars(raw).trim();
  if (value === '') return null;
  if (value.length > max) throw bad(`${field} 太长了，最多 ${max} 字。`);
  return value;
}

function optionalTone(raw) {
  const value = optionalString(raw, { max: LIMITS.TONE_MAX, field: '语气' });
  if (value === null) return null;
  return TONES.has(value) ? value : 'normal';
}

function optionalDemo(raw) {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function optionalDeadline(raw) {
  const value = optionalString(raw, { max: LIMITS.DEADLINE_MAX, field: '截止时间' });
  if (value === null) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** 把请求体规整成 engine.startJob 的 input */
export function normalizeJobInput(body) {
  const raw = body && typeof body === 'object' ? body : {};
  return {
    goal: requireGoal(raw.goal),
    templateId: optionalString(raw.templateId, {
      max: LIMITS.TEMPLATE_ID_MAX,
      field: '模板',
    }),
    audience: optionalString(raw.audience, { max: LIMITS.AUDIENCE_MAX, field: '交付对象' }),
    tone: optionalTone(raw.tone),
    deadline: optionalDeadline(raw.deadline),
    demo: optionalDemo(raw.demo),
  };
}

/* ------------------------------------------------------------------ */
/* 文件名清洗                                                          */
/* ------------------------------------------------------------------ */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 下载文件名清洗。用户/模型可控的名字直接进 Content-Disposition 是很危险的：
 * 换行可以注入响应头（HTTP 响应拆分），路径分隔符可以诱导浏览器落盘到别处。
 */
export function sanitizeFilename(name, fallback = 'deliverable') {
  let s = name === undefined || name === null ? '' : String(name);
  // 控制字符（含 \r\n）→ 空格，先干掉响应头注入
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = s
    .replace(/[/\\:*?"<>|]/g, ' ') // CONTRACT §2 点名的字符集
    .replace(/\.{2,}/g, '.') // 目录回溯
    .replace(/[^\p{L}\p{N}\s._-]/gu, ' ') // 其余一律换成空格，白名单式收窄
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');

  if (s.length > LIMITS.FILENAME_MAX) s = s.slice(0, LIMITS.FILENAME_MAX).trim();
  if (s === '' || s === '.' || WINDOWS_RESERVED.test(s)) s = String(fallback);
  s = s.replace(/[/\\:*?"<>|]/g, ' ').trim();
  return s === '' ? 'deliverable' : s;
}

/** Content-Disposition 值：ASCII 降级名 + RFC 5987 的 UTF-8 名（中文名也能正确落盘） */
export function contentDisposition(filename) {
  const ascii = sanitizeFilename(filename).replace(/[^\x20-\x7E]/g, '_') || 'deliverable';
  // RFC 5987：单引号/括号在 ext-value 里必须百分号编码（不用废弃的 escape()）
  const utf8 = encodeURIComponent(`${filename}.md`).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}.md"; filename*=UTF-8''${utf8}`;
}

/* ------------------------------------------------------------------ */
/* 视图投影（列表要轻，详情要全）                                       */
/* ------------------------------------------------------------------ */

export function summarizeJob(job) {
  if (!job || typeof job !== 'object') return null;
  const stages = Array.isArray(job.stages) ? job.stages : [];
  const done = stages.filter((s) => s && s.status === 'done').length;
  return {
    id: job.id,
    goal: job.goal,
    templateId: job.templateId ?? null,
    status: job.status,
    title: job.plan?.title ?? null,
    createdAt: job.createdAt ?? null,
    updatedAt: job.updatedAt ?? null,
    stageCount: stages.length,
    stagesDone: done,
    artifactCount: Array.isArray(job.artifacts) ? job.artifacts.length : 0,
  };
}

function artifactMeta(a) {
  return {
    id: a.id,
    deliverableId: a.deliverableId ?? null,
    name: a.name,
    format: a.format ?? 'markdown',
    bytes: typeof a.content === 'string' ? Buffer.byteLength(a.content, 'utf8') : 0,
    confidence: a.confidence ?? null,
    createdAt: a.createdAt ?? null,
  };
}

/**
 * 完整交付物（详情页用）。
 *
 * ⚠️ 这里必须带 `content`。CONTRACT.md §2 的 Job 形状里 `artifacts[].content` 是**必填**，
 * 而前端的加载顺序是「先 GET 快照渲染 → 再接 SSE 增量」。如果快照里没有正文，
 * 用户打开一个已完成的任务会看到**空白交付物** —— 这是最伤信任的一种 bug。
 * （曾经为了"避免响应几 MB"剥掉了 content，那是错的：本产品的交付物是几千字 markdown，
 *   不是二进制大文件，一次几万字完全在合理范围内。）
 */
function artifactFull(a) {
  return {
    id: a.id,
    deliverableId: a.deliverableId ?? null,
    name: a.name,
    format: a.format ?? 'markdown',
    content: typeof a.content === 'string' ? a.content : '',
    assumptions: Array.isArray(a.assumptions) ? a.assumptions : [],
    confidence: a.confidence ?? null,
    basedOn: Array.isArray(a.basedOn) ? a.basedOn : [],
    createdAt: a.createdAt ?? null,
  };
}

/**
 * 全量 job（交付物带正文，前端拿到即可直接渲染）。
 *
 * `grade` = 交付质量的一句话结论（engine.gradeDelivery 生成）。
 * 必须放在**详情接口**里，不能只在 SSE 事件里：用户刷新页面后走的是 GET，
 * 如果没有 grade，界面就不知道该怎么提示"质检提了几条意见"。
 */
export function publicJob(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    ...job,
    grade: safeGrade(job),
    artifacts: Array.isArray(job.artifacts) ? job.artifacts.map(artifactFull) : [],
  };
}

/**
 * 安全地取交付质量分级。
 *
 * 为什么要 try/catch 而不是 `typeof engine.gradeDelivery === 'function'`：
 * vitest 的 `vi.mock()` 会给模块套一层 Proxy，**读取一个 mock 里没定义的属性就会抛错**，
 * 于是 `typeof` 判断本身就把整个请求打成 500。所以这里必须真的 catch。
 * （这个坑很隐蔽：单测全绿、e2e 全绿，只有"有人 mock 了这个模块"时才炸。）
 */
function safeGrade(job) {
  if (!job || job.status !== 'done') return null;
  try {
    const fn = engine.gradeDelivery;
    return typeof fn === 'function' ? fn(job) : null;
  } catch {
    return null;
  }
}

/** 列表页用的轻量摘要（不带正文，避免 50 条任务的响应过大） */
export function summaryJob(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    ...job,
    artifacts: Array.isArray(job.artifacts) ? job.artifacts.map(artifactMeta) : [],
  };
}



/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function loadJobOr404(id, res) {
  if (!isValidJobId(id)) {
    res.status(404).json({ error: { code: ERR.NOT_FOUND, message: '找不到这个任务。' } });
    return null;
  }
  const job = await store.getJob(id);
  if (!job) {
    res.status(404).json({ error: { code: ERR.NOT_FOUND, message: '找不到这个任务。' } });
    return null;
  }
  return job;
}

export function createJobsRouter() {
  const router = express.Router();

  // POST /api/jobs —— 立即返回，流水线在后台跑
  router.post('/jobs', async (req, res, next) => {
    try {
      const input = normalizeJobInput(req.body);
      const job = await startJob(input); // 只等「建起来」，不等「跑完」
      if (!job || typeof job.id !== 'string') {
        throw new AppError(ERR.PIPELINE_STAGE_FAILED, '任务创建失败，请重试一次。', { status: 500 });
      }
      // 兜底持久化：只要 job 已经返回给客户端，就必须能从 GET /api/jobs/:id 读到。
      // 正常情况下 engine 自己会 saveJob（这里是幂等覆盖），但持久化是「刷新页面还在」
      // 这个承诺的底座，不能依赖调用方的实现细节。
      if (!(await store.getJob(job.id))) {
        try {
          await store.saveJob(job);
        } catch (err) {
          console.warn(`[routes/jobs] 兜底持久化失败（不影响本次响应）：${err.message}`);
        }
      }
      res.status(201).json({ job: publicJob(job) });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/jobs —— 最新在前，最多 50（契约固定）
  router.get('/jobs', async (req, res, next) => {
    try {
      const jobs = await store.listJobs(50);
      res.json({ jobs: jobs.map(summarizeJob).filter(Boolean) });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/jobs/:id
  router.get('/jobs/:id', async (req, res, next) => {
    try {
      const job = await loadJobOr404(req.params.id, res);
      if (!job) return;
      res.json({ job: publicJob(job) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/jobs/:id/message —— 回答澄清 / 中途改要求
  router.post('/jobs/:id/message', async (req, res, next) => {
    try {
      const job = await loadJobOr404(req.params.id, res);
      if (!job) return;
      // ⚠️ 字段名兼容：契约 §2 写的是 `{ text }`，但前端实现发的是 `{ message }`（api.js）。
      // 两边不一致 → 追加要求/回答澄清 **100% 返回 400**，核心交互直接不可用。
      // 这类"文档说 A、代码发 B"的偏差**单测发现不了**（两边各自的测试都绿），
      // 只有端到端真跑一次才会暴露。所以这里两个名字都收，并在 e2e 补了回归断言。
      const raw = req.body?.text ?? req.body?.message;
      const text = requireMessageText(raw);
      await sendMessage(job.id, text);
      const fresh = (await store.getJob(job.id)) ?? job;
      res.json({ ok: true, job: publicJob(fresh) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/jobs/:id/retry
  router.post('/jobs/:id/retry', async (req, res, next) => {
    try {
      const job = await loadJobOr404(req.params.id, res);
      if (!job) return;
      const fresh = await retryJob(job.id);
      res.json({ ok: true, job: publicJob(fresh ?? (await store.getJob(job.id)) ?? job) });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/jobs/:id
  router.delete('/jobs/:id', async (req, res, next) => {
    try {
      const job = await loadJobOr404(req.params.id, res);
      if (!job) return;
      // 先停流水线，再删盘，否则后台阶段会把这个 job 又写回来
      try {
        cancelJob(job.id);
      } catch (err) {
        console.warn(`[routes/jobs] 取消任务失败（继续删除）：${err.message}`);
      }
      await store.deleteJob(job.id);
      events.drop(job.id);
      res.json({ ok: true, deleted: job.id });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/jobs/:id/artifacts/:artifactId/download
  router.get('/jobs/:id/artifacts/:artifactId/download', async (req, res, next) => {
    try {
      const job = await loadJobOr404(req.params.id, res);
      if (!job) return;
      const artifacts = Array.isArray(job.artifacts) ? job.artifacts : [];
      const artifact = artifacts.find((a) => a && a.id === req.params.artifactId);
      if (!artifact) {
        res.status(404).json({ error: { code: ERR.NOT_FOUND, message: '找不到这个交付物。' } });
        return;
      }
      const filename = sanitizeFilename(artifact.name, 'deliverable');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', contentDisposition(filename));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(typeof artifact.content === 'string' ? artifact.content : '');
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** 供 server.js 统一挂错误处理：路由内部直接用的 toPublicError */
export { toPublicError };

export default createJobsRouter;
