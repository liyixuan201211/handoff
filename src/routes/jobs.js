/**
 * 任务相关 HTTP 路由（CONTRACT §2）。
 *
 * 一条最重要的纪律：**POST /api/jobs 绝不 await 流水线跑完**。
 * 一个任务要跑几分钟，等它跑完再响应的话，浏览器和反向代理都会超时。
 * 所以这里只等 startJob() 把 job 建起来（拿到 id），立刻 201 返回，剩下的走 SSE 推。
 */
import express from 'express';
import { startJob, sendMessage, retryJob, cancelJob } from '../pipeline/engine.js';
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

/** 全量 job（去掉交付物正文，正文走下载接口，避免 detail 响应几 MB） */
export function publicJob(job) {
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
      const text = requireMessageText(req.body?.text);
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
