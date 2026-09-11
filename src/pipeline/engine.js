/**
 * 编排引擎 —— 把一次「委托」变成一份「交付物」的全过程。
 *
 * 这里的每一个设计决定，都是为了让普通人**不会因为技术原因失望**：
 *
 *  - 阶段失败时，已完成的产物一律保留（用户不该白跑一趟）
 *  - planner 编排失误时，自动修正而不是报错
 *  - 每个阶段结束都发事件，前端绝不会卡在「运行中」
 *  - 取消信号在每个阶段边界和每次模型调用前检查
 *  - 演示模式：没有网络、没有 Key 也能完整跑通（这是给普通人产品的基本盘）
 *
 * 并发模型：进程内 Map<jobId, { controller, promise }>。单机单进程够用，
 * 而且简单 —— 简单才不容易出错。
 */
import path from 'node:path';
import fs from 'node:fs';

import { callModel as realCallModel } from '../llm/gateway.js';
import { AppError, ERR, redactSecrets } from '../llm/errors.js';
import { events, newId } from '../store/events.js';
import { stageDisplay, STAGE_META, normalizeStages, STAGE_RUNNERS } from './stages.js';
import { SCHEMAS, systemPromptFor, buildUser, TEAM } from '../prompts/index.js';

/** 运行中的任务：jobId → { controller, promise } */
const running = new Map();

/* ────────────────────────────────────────────────────────────────
 * 可选依赖。全部延迟加载，这样任何一个模块没就绪都不会让引擎起不来。
 * ──────────────────────────────────────────────────────────────── */

const optional = async (specifier, exportName) => {
  try {
    const mod = await import(specifier);
    return mod[exportName] ?? mod.default ?? null;
  } catch {
    return null;
  }
};

/** 测试可以整体替换依赖 */
export const deps = {
  callModel: realCallModel,
  saveJob: null,
  getJob: null,
  updateJob: null,
  deleteJob: null,
  demo: null,
  guard: null,
  storeReady: null,
};

export async function loadOptionalDeps() {
  deps.storeReady ??= (async () => {
    const store = await optional('../store/json-store.js');
    if (store) {
      deps.saveJob = store.saveJob;
      deps.getJob = store.getJob;
      deps.updateJob = store.updateJob;
      deps.deleteJob = store.deleteJob;
    }
    const demo = await optional('../demo/fixtures.js');
    if (demo) deps.demo = demo;
    const guard = await optional('../security/guard.js');
    if (guard) {
      deps.guard = guard;
      // 把安全的隔离实现注入提示词层，避免循环依赖
      const prompts = await optional('../prompts/index.js');
      prompts?.setUntrustedWrapper?.(guard.wrapUntrusted);
    }
    return true;
  })();
  return deps.storeReady;
}

/** 内存兜底存储：store 模块缺失时引擎依然可用（也让引擎能被单测） */
const memory = new Map();
const fallbackSave = async (job) => {
  memory.set(job.id, job);
  return job;
};
const fallbackGet = async (id) => memory.get(id) ?? null;

const save = async (job) => (deps.saveJob ?? fallbackSave)(job);
const load = async (id) => (deps.getJob ?? fallbackGet)(id);

/* ────────────────────────────────────────────────────────────────
 * 事件发射（统一出口，保证「每个阶段都有事件」）
 * ──────────────────────────────────────────────────────────────── */

function makeEmitter(jobId) {
  return (payload) => events.publish(jobId, payload);
}

/* ────────────────────────────────────────────────────────────────
 * Job 构造
 * ──────────────────────────────────────────────────────────────── */

const MAX_GOAL = 4000;
const MAX_MESSAGE = 2000;
const DEFAULT_TEMPLATE_TITLE = null;

export function emptyUsage() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 };
}

/** 模板：从 templates/ 目录按 id 读一个。读不到就返回 null（不能让服务挂） */
export function loadTemplate(templateId) {
  if (!templateId || !/^[a-z0-9][a-z0-9-]{0,40}$/i.test(String(templateId))) return null;
  try {
    const dir = path.resolve(process.cwd(), 'templates');
    const file = path.join(dir, `${templateId}.json`);
    // 双保险：解析后必须仍在 templates 目录内（防路径穿越）
    if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) return null;
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function buildJobRecord(input) {
  const now = Date.now();
  const template = loadTemplate(input.templateId);
  return {
    id: newId('job'),
    goal: String(input.goal),
    templateId: template?.id ?? null,
    templateTitle: template?.title ?? DEFAULT_TEMPLATE_TITLE,
    audience: input.audience ? String(input.audience).slice(0, 200) : null,
    tone: ['normal', 'simple', 'formal'].includes(input.tone) ? input.tone : 'normal',
    deadline: input.deadline ?? null,
    demo: Boolean(input.demo),
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    plan: null,
    stages: [],
    artifacts: [],
    review: null,
    security: null,
    usage: emptyUsage(),
    clarifyQuestions: [],
    userMessages: [],
    amendedCount: 0,
    error: null,
  };
}

/* ────────────────────────────────────────────────────────────────
 * 主流程
 * ──────────────────────────────────────────────────────────────── */

/**
 * 创建并启动任务。**立即返回** job（流水线在后台跑）。
 */
export async function startJob(input) {
  await loadOptionalDeps();

  const rawGoal = String(input?.goal ?? '');
  if (!rawGoal.trim()) {
    throw new AppError(ERR.BAD_REQUEST, '请先告诉我们要办什么事。', { status: 400 });
  }
  if (rawGoal.length > MAX_GOAL) {
    throw new AppError(
      ERR.BAD_REQUEST,
      `内容太长了（${rawGoal.length} 字），请精简到 ${MAX_GOAL} 字以内。`,
      { status: 400 },
    );
  }

  // 安全净化（在进入任何模型之前）。guard 缺失时退化为最小净化。
  let goalText = rawGoal;
  let security = null;
  if (deps.guard?.sanitizeUserInput) {
    const s = deps.guard.sanitizeUserInput(rawGoal, { maxLength: MAX_GOAL, field: 'goal' });
    if (!s.ok) {
      throw new AppError(ERR.BAD_REQUEST, s.reason ?? '输入内容不合法。', { status: 400 });
    }
    goalText = s.text;
    if (s.findings?.length) {
      security = { level: pickLevel(s.findings), findings: s.findings };
    }
  } else {
    goalText = rawGoal
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
  }

  const job = buildJobRecord({ ...input, goal: goalText });
  job.security = security;
  await save(job);
  events.publish(job.id, { type: 'job', job: summarize(job) });

  // 故意不 await：HTTP 立即返回，流水线在后台推进
  const promise = execute(job).catch(async (err) => {
    await failJob(job.id, err);
  });
  running.set(job.id, { controller: new AbortController(), promise });

  return job;
}

/** 给前端/SSE 用的轻量摘要（不含大段正文，避免每次事件都传几万字） */
export function summarize(job) {
  return {
    id: job.id,
    goal: job.goal,
    templateTitle: job.templateTitle,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    title: job.plan?.title ?? null,
    stageCount: job.stages.length,
    artifactCount: job.artifacts.length,
    review: job.review ? { verdict: job.review.verdict } : null,
    securityLevel: job.security?.level ?? null,
    error: job.error,
  };
}

const pickLevel = (findings) => {
  if (findings.some((f) => f.severity === 'high' && f.kind === 'secret_leak')) return 'blocked';
  return findings.length ? 'notice' : 'clean';
};

/** 把异常写进 job 并广播 */
async function failJob(jobId, err) {
  const entry = running.get(jobId);
  const cancelled = err?.code === ERR.LLM_ABORTED || err?.code === ERR.PIPELINE_CANCELLED;
  try {
    const job = await load(jobId);
    if (!job) return;
    job.status = cancelled ? 'cancelled' : 'failed';
    job.updatedAt = Date.now();
    job.error = {
      code: err?.code ?? 'INTERNAL_ERROR',
      message: redactSecrets(
        err?.message ?? '这一步没能完成，我们也不知道具体原因。可以点重试。',
      ),
      attempts: err?.attempts ?? null,
    };
    // 最后跑起来的那个阶段标记为失败
    const active = [...job.stages].reverse().find((s) => s.status === 'running');
    if (active) {
      active.status = 'failed';
      active.endedAt = Date.now();
      active.ms = active.startedAt ? active.endedAt - active.startedAt : null;
      active.error = job.error;
    }
    await save(job);
    events.publish(jobId, {
      type: 'error',
      message: job.error.message,
      stageId: active?.id ?? null,
      code: job.error.code,
    });
    events.publish(jobId, { type: 'done', status: job.status });
  } catch {
    // 兜底：连失败都记录不了的话，至少广播一条
    events.publish(jobId, { type: 'error', message: '任务失败，且未能保存失败原因。' });
    events.publish(jobId, { type: 'done', status: 'failed' });
  } finally {
    running.delete(jobId);
    void entry;
  }
}

/**
 * 执行整个流水线。demo=true 时走离线演示。
 */
async function execute(job) {
  await loadOptionalDeps();

  const signal = running.get(job.id)?.controller.signal ?? new AbortController().signal;
  const emit = makeEmitter(job.id);

  const checkAbort = () => {
    if (signal.aborted) {
      throw new AppError(ERR.PIPELINE_CANCELLED, '任务已被取消。', { status: 499 });
    }
  };

  // 演示模式：不调任何模型，用离线数据"演出"一遍
  if (job.demo && deps.demo?.runDemoPipeline) {
    job.status = 'running';
    job.updatedAt = Date.now();
    await save(job);
    emit({ type: 'job', job: summarize(job) });

    const finished = await deps.demo.runDemoPipeline(job.goal, (event) => emit(event), { signal });

    Object.assign(job, {
      status: finished.status ?? 'done',
      plan: finished.plan ?? job.plan,
      stages: finished.stages ?? job.stages,
      artifacts: finished.artifacts ?? job.artifacts,
      review: finished.review ?? job.review,
      // 演示模式的安全结论优先（它是有意构造的示例）
      security: finished.security ?? job.security,
      usage: finished.usage ?? job.usage,
      updatedAt: Date.now(),
    });
    await save(job);
    emit({ type: 'job', job: summarize(job) });
    emit({ type: 'done', status: job.status });
    running.delete(job.id);
    return job;
  }

  if (job.demo && !deps.demo?.runDemoPipeline) {
    throw new AppError(
      ERR.BAD_REQUEST,
      '演示模式暂时不可用（演示数据模块未加载）。请去掉演示模式后重试。',
      { status: 503 },
    );
  }

  // ── 真实模式 ───────────────────────────────────────────────
  job.status = 'running';
  job.updatedAt = Date.now();
  await save(job);
  emit({ type: 'job', job: summarize(job) });

  // 阶段列表：重跑时保留已有记录（能看到上次跑到哪），首次运行则建一个 intake 占位。
  // 关键是**立刻**有一个 running 的 intake，让前端马上看到"有人在干活"。
  if (!Array.isArray(job.stages) || job.stages.length === 0) {
    job.stages = [makeStageRecord('intake', null, 1)];
  } else if (!job.stages.some((s) => s.key === 'intake')) {
    job.stages = [makeStageRecord('intake', null, 1), ...job.stages];
  }
  await save(job);

  /** @type {Record<string, any>} 各阶段产出 */
  const outputs = {};
  // 从已有产物出发：中途补充要求重跑时，draft 之前的产物要保留（用户不该重看一遍已好的东西）
  let artifacts = Array.isArray(job.artifacts) ? [...job.artifacts] : [];
  const notices = [];

  /** 当前正在跑的阶段（永远取最后一个，避免索引错位） */
  const currentStage = () => job.stages.at(-1) ?? null;

  /** 统一的模型调用包装：统计用量 + 广播降级通知 */
  const callModelWithAccounting = async (opts) => {
    checkAbort();
    const started = Date.now();
    const res = await deps.callModel({
      ...opts,
      signal,
      onNotice: (n) => {
        notices.push(n);
        const st = currentStage();
        if (st) st.log.push({ at: Date.now(), level: n.level ?? 'warn', text: n.text });
        emit({
          type: 'log',
          stageId: st?.id ?? null,
          level: n.level ?? 'warn',
          text: n.text,
          at: Date.now(),
        });
      },
    });
    job.usage.calls += 1;
    job.usage.promptTokens += res.usage?.promptTokens ?? 0;
    job.usage.completionTokens += res.usage?.completionTokens ?? 0;
    job.usage.ms += Date.now() - started;
    if (res.degraded) {
      const st = currentStage();
      emit({
        type: 'log',
        stageId: st?.id ?? null,
        level: 'warn',
        text: `主模型繁忙，已自动切换到备用模型（${res.providerLabel ?? res.provider}）继续。`,
        at: Date.now(),
      });
    }
    return res.json ?? { text: res.text };
  };

  /* 阶段 1：intake（必需，先跑，因为它的产出决定了后面的编排） */
  const intakeStage = job.stages.find((s) => s.key === 'intake');
  const intakeOut = await runOneStage({
    job,
    stage: intakeStage,
    key: 'intake',
    outputs,
    artifacts,
    callModel: callModelWithAccounting,
    emit,
    checkAbort,
    save,
    signal,
  });
  outputs.intake = intakeOut;

  // 如果接待员认为必须问清楚，才停下来等用户（默认策略是先做）
  const questions = (intakeOut?.clarifyQuestions ?? []).filter(
    (q) => typeof q === 'string' && q.trim().length > 3,
  );
  if (questions.length && !job.userMessages.length) {
    job.clarifyQuestions = questions.slice(0, 2);
    job.status = 'awaiting_input';
    job.updatedAt = Date.now();
    await save(job);
    emit({ type: 'clarify', questions: job.clarifyQuestions });
    emit({ type: 'job', job: summarize(job) });
    emit({ type: 'done', status: 'awaiting_input' });
    running.delete(job.id);
    return job;
  }

  /* 阶段 2：plan（必需，决定后面所有阶段） */
  const planStage = makeStageRecord('plan', null, 2);
  job.stages.push(planStage);
  await save(job);
  const planOut = await runOneStage({
    job,
    stage: planStage,
    key: 'plan',
    outputs,
    artifacts,
    callModel: callModelWithAccounting,
    emit,
    checkAbort,
    save,
    signal,
  });
  outputs.plan = planOut;
  job.plan = {
    title: planOut.title,
    intent: outputs.intake?.intent ?? null,
    assumptions: planOut.assumptions ?? [],
    risks: planOut.risks ?? [],
    deliverables: (planOut.deliverables ?? []).map((d, i) => ({
      id: normalizeDeliverableId(d.id, i),
      name: d.name,
      format: 'markdown',
      outline: d.outline,
    })),
  };
  // 重建完整阶段列表（把 intake 换成 plan 给出的更准确的理由）
  const normalized = normalizeStages(planOut.stages);
  const reasons = new Map(
    (planOut.stages ?? []).map((s) => [typeof s === 'string' ? s : s?.key, s?.reason]),
  );
  job.stages = normalized.keys.map((key, i) => {
    const existing =
      key === 'intake' ? job.stages.find((s) => s.key === 'intake') : key === 'plan' ? planStage : null;
    if (existing) {
      existing.reason = reasons.get(key) || existing.reason;
      existing.index = i + 1;
      return existing;
    }
    return makeStageRecord(key, reasons.get(key), i + 1);
  });
  if (normalized.repaired) {
    emit({ type: 'log', stageId: planStage.id, level: 'warn', text: `已自动调整执行计划：${normalized.notes.join('；')}`, at: Date.now() });
  }
  await save(job);

  /* 阶段 3..n：按 planner 编排的剩余阶段依次执行 */
  const remaining = normalized.keys.filter((k) => k !== 'intake' && k !== 'plan');
  for (const key of remaining) {
    checkAbort();
    const stage =
      job.stages.find((s) => s.key === key) ?? makeStageRecord(key, reasons.get(key), undefined);
    if (!job.stages.includes(stage)) job.stages.push(stage);

    const out = await runOneStage({
      job,
      stage,
      key,
      outputs,
      artifacts,
      callModel: callModelWithAccounting,
      emit,
      checkAbort,
      save,
      signal,
      onArtifacts: (next) => {
        artifacts = next;
      },
    });
    outputs[key] = out;

    // 各阶段产出的落地
    if (key === 'draft' || key === 'revise') {
      artifacts = buildArtifacts(job, out.artifacts, artifacts);
      job.artifacts = artifacts;
      await save(job);
      for (const a of artifacts) {
        emit({
          type: 'artifact',
          artifactId: a.id,
          name: a.name,
          deliverableId: a.deliverableId,
        });
      }
    }
    if (key === 'verify') {
      const review = normalizeReview(out);
      job.review = review;
      await save(job);
      emit({ type: 'review', review });
    }
    if (key === 'deliver') {
      // 把交付说明也做成一份 artifact，用户能直接下载
      const deliverArtifact = buildDeliverArtifact(job, out);
      artifacts = [...artifacts, deliverArtifact];
      job.artifacts = artifacts;
      await save(job);
      emit({
        type: 'artifact',
        artifactId: deliverArtifact.id,
        name: deliverArtifact.name,
        deliverableId: deliverArtifact.deliverableId,
      });
    }
    // deliver 之后就没有阶段了；中途也要更新摘要让前端进度条走动
    emit({ type: 'job', job: summarize(job) });
  }

  /* 收尾：安全审计 + 最终状态判定 */
  const security = await runSecurityAudit(job, artifacts);
  job.security = mergeSecurity(job.security, security);
  job.usage = { ...job.usage };

  const problems = validateDelivery(job);
  if (problems.length) {
    job.status = 'failed';
    job.error = {
      code: ERR.PIPELINE_STAGE_FAILED,
      message: `交付没达标：${problems.join('；')}`,
      attempts: null,
    };
  } else {
    job.status = 'done';
    job.error = null;
  }
  job.updatedAt = Date.now();
  await save(job);
  if (job.security) emit({ type: 'security', security: job.security });
  emit({ type: 'job', job: summarize(job) });
  emit({ type: 'done', status: job.status });
  running.delete(job.id);
  return job;
}

/* ────────────────────────────────────────────────────────────────
 * 单个阶段的执行
 * ──────────────────────────────────────────────────────────────── */

function makeStageRecord(key, reason, index) {
  const display = stageDisplay(key, reason);
  return {
    id: newId('stage'),
    key,
    title: display.title,
    role: display.role,
    name: display.name,
    emoji: display.emoji,
    order: display.order,
    index,
    reason: display.reason,
    status: 'pending',
    startedAt: null,
    endedAt: null,
    ms: null,
    log: [],
    output: null,
    error: null,
  };
}

async function runOneStage({
  job,
  stage,
  key,
  outputs,
  artifacts,
  callModel,
  emit,
  checkAbort,
  save,
  signal,
}) {
  checkAbort();
  const runner = STAGE_RUNNERS[key];
  if (!runner) throw new AppError(ERR.PIPELINE_STAGE_FAILED, `未知阶段：${key}`, { status: 500 });

  stage.status = 'running';
  stage.startedAt = Date.now();
  stage.endedAt = null;
  stage.error = null;
  job.updatedAt = Date.now();
  await save(job);
  emit({
    type: 'stage',
    stageId: stage.id,
    status: 'running',
    title: stage.title,
    role: stage.role,
    name: stage.name,
    emoji: stage.emoji,
    key,
  });

  const log = (text, level = 'info') => {
    const entry = { at: Date.now(), level, text: redactSecrets(String(text)) };
    stage.log.push(entry);
    emit({ type: 'log', stageId: stage.id, level, text: entry.text, at: entry.at });
  };

  try {
    const output = await runner({
      job,
      goal: job.goal,
      plan: job.plan,
      outputs,
      artifacts,
      callModel,
      log,
      emit,
      checkAbort,
      signal,
    });

    stage.status = 'done';
    stage.endedAt = Date.now();
    stage.ms = stage.endedAt - stage.startedAt;
    stage.output = compactOutput(output);
    job.updatedAt = Date.now();
    await save(job);
    emit({
      type: 'stage',
      stageId: stage.id,
      status: 'done',
      title: stage.title,
      role: stage.role,
      ms: stage.ms,
      key,
    });
    return output;
  } catch (err) {
    if (err?.code === ERR.LLM_ABORTED || err?.code === ERR.PIPELINE_CANCELLED) {
      stage.status = 'pending';
      stage.endedAt = Date.now();
      await save(job);
      throw err;
    }
    stage.status = 'failed';
    stage.endedAt = Date.now();
    stage.ms = stage.endedAt - stage.startedAt;
    stage.error = {
      code: err?.code ?? 'INTERNAL_ERROR',
      message: redactSecrets(err?.message ?? '这一步没能完成'),
    };
    log(stage.error.message, 'error');
    job.updatedAt = Date.now();
    await save(job);
    emit({
      type: 'stage',
      stageId: stage.id,
      status: 'failed',
      title: stage.title,
      role: stage.role,
      ms: stage.ms,
    });
    throw err;
  }
}

/** 阶段产出里可能含几万字的正文，落进 job.stages[].output 前要压缩 */
function compactOutput(output) {
  if (!output || typeof output !== 'object') return output;
  const clone = JSON.parse(JSON.stringify(output));
  if (Array.isArray(clone.artifacts)) {
    clone.artifacts = clone.artifacts.map((a) => ({
      deliverableId: a.deliverableId,
      length: typeof a.content === 'string' ? a.content.length : 0,
      assumptions: a.assumptions ?? undefined,
      confidence: a.confidence ?? undefined,
    }));
  }
  return clone;
}

/* ────────────────────────────────────────────────────────────────
 * 产物构建
 * ──────────────────────────────────────────────────────────────── */

const normalizeDeliverableId = (id, index) => {
  const s = String(id ?? '').trim();
  if (/^[A-Za-z0-9_-]{1,24}$/.test(s)) return s;
  return `d${index + 1}`;
};

/**
 * 把模型返回的 artifacts 变成正式的 artifact 记录。
 *
 * 关键设计：
 *  - **deliverableId 对不上时绝不丢内容**，按顺序兜底挂到一个交付物上。
 *  - 同一份交付物被重做时替换旧版本，但**保留原来的 id**（前端折叠状态不会丢）。
 *  - 其他交付物的旧版本原样保留。
 */
export function buildArtifacts(job, rawArtifacts, previous = []) {
  const deliverables = job.plan?.deliverables ?? [];
  const byId = new Map(deliverables.map((d) => [String(d.id), d]));
  const usedDeliverables = new Set();
  const produced = [];
  const producedIds = new Set();

  for (const [i, raw] of (rawArtifacts ?? []).entries()) {
    let deliverable = byId.get(String(raw?.deliverableId));
    if (!deliverable) {
      // 模型给了一个我们不认识的 id：按顺序兜底，绝不丢内容
      deliverable =
        deliverables.find((d) => !usedDeliverables.has(String(d.id))) ?? deliverables[i] ?? null;
    }
    const deliverableId = String(deliverable?.id ?? raw?.deliverableId ?? `d${i + 1}`);
    usedDeliverables.add(deliverableId);
    producedIds.add(deliverableId);

    const content = typeof raw?.content === 'string' ? raw.content : '';
    const prev = previous.find((p) => p.deliverableId === deliverableId);

    produced.push({
      id: prev?.id ?? newId('art'),
      deliverableId,
      name: deliverable?.name ?? raw?.name ?? `交付物 ${i + 1}`,
      format: 'markdown',
      content,
      assumptions: raw?.assumptions ?? prev?.assumptions ?? [],
      confidence: raw?.confidence ?? prev?.confidence ?? 'medium',
      basedOn: (job.stages ?? []).filter((s) => s.status === 'done').map((s) => s.id),
      createdAt: Date.now(),
    });
  }

  // 没被重做的旧产物（例如"怎么用"说明）原样留下
  const untouched = previous.filter(
    (p) => !producedIds.has(p.deliverableId) && !(rawArtifacts ?? []).some((r) => String(r?.deliverableId) === p.deliverableId),
  );

  // 万一模型一个 artifact 都没给，用计划里的交付物补一个占位，保证形状不破
  if (!produced.length && deliverables.length) {
    const d = deliverables[0];
    const prev = previous.find((p) => p.deliverableId === String(d.id));
    produced.push({
      id: prev?.id ?? newId('art'),
      deliverableId: String(d.id),
      name: d.name,
      format: 'markdown',
      content: '',
      assumptions: [],
      confidence: 'low',
      basedOn: [],
      createdAt: Date.now(),
    });
  }

  return [...produced, ...untouched];
}

function normalizeReview(out) {
  return {
    verdict: out?.verdict ?? 'pass_with_notes',
    issues: out?.issues ?? [],
    checklist: out?.checklist ?? [],
    reviewedAt: Date.now(),
  };
}

/** 「怎么用」说明本身也是一份交付物 —— 普通人最需要它 */
function buildDeliverArtifact(job, deliverOut) {
  const plan = job.plan ?? {};
  const lines = [];
  lines.push(`# ${deliverOut.headline ?? '你的东西做好了'}`);
  lines.push('');
  lines.push(`**你的委托**：${job.goal.slice(0, 300)}`);
  lines.push('');
  if ((plan.assumptions ?? []).length) {
    lines.push('## 我们替你做的假设');
    lines.push('');
    lines.push('如果下面任何一条不对，请在页面里补充说明，我们会重做。');
    lines.push('');
    for (const a of plan.assumptions) lines.push(`- ${a}`);
    lines.push('');
  }
  lines.push('## 怎么用');
  lines.push('');
  for (const [i, step] of (deliverOut.howToUse ?? []).entries()) lines.push(`${i + 1}. ${step}`);
  lines.push('');
  lines.push('## 下一步做什么');
  lines.push('');
  for (const s of deliverOut.nextSteps ?? []) lines.push(`- [ ] ${s}`);
  if ((deliverOut.cautions ?? []).length) {
    lines.push('');
    lines.push('## 要小心的地方');
    lines.push('');
    for (const c of deliverOut.cautions) lines.push(`> ⚠️ ${c}`);
  }
  return {
    id: newId('art'),
    deliverableId: '__handoff_guide__',
    name: '先看这份：怎么用',
    format: 'markdown',
    content: lines.join('\n'),
    assumptions: plan.assumptions ?? [],
    confidence: 'high',
    basedOn: (job.stages ?? []).filter((s) => s.status === 'done').map((s) => s.id),
    createdAt: Date.now(),
  };
}

/* ────────────────────────────────────────────────────────────────
 * 安全审计
 * ──────────────────────────────────────────────────────────────── */

async function runSecurityAudit(job, artifacts) {
  if (!deps.guard?.auditJob) return null;
  try {
    return deps.guard.auditJob({ artifacts, review: job.review, plan: job.plan });
  } catch {
    return null; // 审计失败不能导致交付失败
  }
}

function mergeSecurity(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const rank = { clean: 0, notice: 1, blocked: 2 };
  return {
    level: rank[b.level] > rank[a.level] ? b.level : a.level,
    findings: [...(a.findings ?? []), ...(b.findings ?? [])],
  };
}

/* ────────────────────────────────────────────────────────────────
 * 验收标准（CONTRACT §7）
 * ──────────────────────────────────────────────────────────────── */

export function validateDelivery(job) {
  const problems = [];
  if (job.status === 'cancelled') return problems;
  if (!job.artifacts?.length) problems.push('没有任何交付物');
  const realArtifacts = (job.artifacts ?? []).filter((a) => a.deliverableId !== '__handoff_guide__');
  if (!realArtifacts.length) problems.push('没有实际的交付内容');
  for (const a of realArtifacts) {
    if (typeof a.content !== 'string' || a.content.length <= 80) {
      problems.push(`「${a.name}」内容太短，没有实际价值`);
    }
  }
  if (!job.review) problems.push('缺少验收结果');
  else if (job.review.verdict === 'needs_revision') problems.push('质检判定需要重做');
  if (job.security?.level === 'blocked') problems.push('安全检查拦截了本次交付');
  const hasGuide = (job.artifacts ?? []).some((a) => a.deliverableId === '__handoff_guide__');
  if (!hasGuide) problems.push('缺少「怎么用」的说明');
  return problems;
}

/* ────────────────────────────────────────────────────────────────
 * 中途追加消息 / 重试 / 取消
 * ──────────────────────────────────────────────────────────────── */

export async function sendMessage(jobId, text) {
  await loadOptionalDeps();
  const clean = String(text ?? '').trim();
  if (!clean) throw new AppError(ERR.BAD_REQUEST, '内容不能为空。', { status: 400 });
  if (clean.length > MAX_MESSAGE) {
    throw new AppError(ERR.BAD_REQUEST, `补充内容太长了，请控制在 ${MAX_MESSAGE} 字内。`, { status: 400 });
  }

  const job = await load(jobId);
  if (!job) throw new AppError(ERR.NOT_FOUND, '没找到这个任务。', { status: 404 });
  if (running.has(jobId)) {
    throw new AppError(ERR.BAD_REQUEST, '任务正在执行中，请等它跑完再补充要求。', { status: 409 });
  }

  let messageText = clean;
  if (deps.guard?.sanitizeUserInput) {
    const s = deps.guard.sanitizeUserInput(clean, { maxLength: MAX_MESSAGE, field: 'message' });
    if (!s.ok) throw new AppError(ERR.BAD_REQUEST, s.reason ?? '内容不合法。', { status: 400 });
    messageText = s.text;
  }

  job.userMessages.push({ at: Date.now(), text: messageText });
  job.amendedCount = (job.amendedCount ?? 0) + 1;
  job.updatedAt = Date.now();

  // 等待澄清回答：这次带上用户的回答重跑，「理解需求」不会再反问
  if (job.status === 'awaiting_input') job.clarifyQuestions = [];
  // 已有产物 → 从「动手做」之前重跑（复用已经定好的方案，省时间也省钱）
  const restartKey = job.artifacts?.length ? 'draft' : 'intake';

  await save(job);
  events.publish(jobId, { type: 'job', job: summarize(job) });

  const controller = new AbortController();
  // 先登记 controller，再启动；否则用户立刻点取消会取消不掉
  running.set(jobId, { controller, promise: null });
  const promise = rerunFrom(job, restartKey, controller.signal).catch((err) =>
    failJob(jobId, err),
  );
  const entry = running.get(jobId);
  if (entry) entry.promise = promise;

  return { ok: true, restartedFrom: restartKey };
}

/**
 * 从指定阶段起重跑。用于「用户补充要求后重做」和「失败后重试」。
 * 已完成的产物会保留，直到 draft 阶段产出新版本覆盖它。
 */
async function rerunFrom(job, fromKey, signal) {
  const emit = makeEmitter(job.id);
  const checkAbort = () => {
    if (signal.aborted) throw new AppError(ERR.PIPELINE_CANCELLED, '任务已被取消。', { status: 499 });
  };

  job.status = 'running';
  job.error = null;
  job.updatedAt = Date.now();
  // 把 fromKey 及其之后的阶段重置为 pending
  const fromOrder = STAGE_META[fromKey]?.order ?? 10;
  for (const st of job.stages ?? []) {
    if ((STAGE_META[st.key]?.order ?? 0) >= fromOrder) {
      st.status = 'pending';
      st.startedAt = null;
      st.endedAt = null;
      st.ms = null;
      st.error = null;
      st.log = [];
    }
  }
  // 重跑时把 plan 之后阶段的 reason 保留，但阶段列表需要按补的要求重新规划
  if (fromKey === 'intake') {
    job.plan = null;
    job.artifacts = [];
    job.review = null;
  }
  await save(job);
  emit({ type: 'job', job: summarize(job) });

  // 复用主流程：把 job 交给 execute，它会按现状继续
  return execute(job);
}

export async function retryJob(jobId) {
  await loadOptionalDeps();
  const job = await load(jobId);
  if (!job) throw new AppError(ERR.NOT_FOUND, '没找到这个任务。', { status: 404 });
  if (running.has(jobId)) {
    throw new AppError(ERR.BAD_REQUEST, '任务正在执行中。', { status: 409 });
  }
  const failedStage = (job.stages ?? []).find((s) => s.status === 'failed');
  const fromKey = failedStage?.key ?? (job.artifacts?.length ? 'draft' : 'intake');

  job.status = 'queued';
  job.error = null;
  job.updatedAt = Date.now();
  await save(job);

  const controller = new AbortController();
  const promise = rerunFrom(job, fromKey, controller.signal).catch((err) => failJob(jobId, err));
  running.set(jobId, { controller, promise });

  const fresh = await load(jobId);
  return fresh ?? job;
}

export function cancelJob(jobId) {
  const entry = running.get(jobId);
  if (!entry) return false;
  entry.controller.abort();
  return true;
}

export function isRunning(jobId) {
  return running.has(jobId);
}

/** 测试辅助 */
export const __internals = { execute, rerunFrom, running, memory, normalizeDeliverableId };
