/**
 * 端到端测试用的「剧本模型」与引擎装配。
 *
 * 为什么需要剧本模型：
 *   真实模式下要验证的东西，用真模型根本测不了 —— 我们没法让真模型在第 5 个阶段准时失败，
 *   也没法让它稳定返回「confidence 写成 0.95」这种脏数据。
 *   所以这里做一个按 purpose 分派的假 callModel：返回的 JSON 严格符合 prompts/index.js 的 SCHEMAS，
 *   同时可以指定「在第 N 个阶段抛错」。
 *
 * 关于 wireEngineDeps：
 *   engine.js 的 `optional()` 曾经有缺陷（见 docs/reports/S8-QA.md 缺陷 #1）：
 *   它写成 `mod[exportName] ?? mod.default ?? null`，而调用点都不传 exportName，
 *   于是 store / demo / guard 全被加载成 null ——「演示模式直接失败 + 引擎不落盘 + 安全审查没跑」。
 *   该缺陷已修复（engine.js 现在不传 exportName 时返回整个 namespace）。
 *   这里保留 `??=` 兜底：万一将来又有人把加载器改坏，e2e 仍然能跑到真实流水线，
 *   而「装载是否成功」由 pipeline.test.js 的回归用例单独钉住。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

import * as engine from '../../src/pipeline/engine.js';
import * as store from '../../src/store/json-store.js';
import * as fixtures from '../../src/demo/fixtures.js';
import * as guard from '../../src/security/guard.js';
import { events } from '../../src/store/events.js';
import { AppError, ERR } from '../../src/llm/errors.js';

/* ------------------------------------------------------------------ *
 * 剧本模型
 * ------------------------------------------------------------------ */

const LONG = (title) =>
  `# ${title}\n\n## 一句话结论\n这是一份用于端到端测试的交付物，正文长度必须超过 80 个字符，` +
  `否则引擎的验收标准（CONTRACT §7.2）会判定它没有实际价值。\n\n` +
  `## 具体建议\n1. 先把押金退还期限写进合同。\n2. 再谈维修责任的划分。\n3. 最后谈提前退租的违约金上限。\n\n` +
  `## 我们替你做的假设\n- 假定你是承租方。\n- 假定合同尚未签字。\n`;

const CONTENT = LONG('测试交付物');

/** 各阶段的合法产出（严格满足 SCHEMAS，additionalProperties:false 所以不能多字段） */
export function stageOutputs({ confidence = 'high', deliverableIds = ['d1', 'd2'] } = {}) {
  const deliverables = deliverableIds.map((id, i) => ({
    id,
    name: i === 0 ? '风险清单' : `交付物 ${i + 1}`,
    format: 'markdown',
    outline: '逐条列出风险、影响与改法，最后给出行动建议',
  }));
  return {
    intake: {
      intent: '用户想确认合同里有没有对自己不利、会直接造成损失的条款。',
      restated: '你想知道这份租房合同里有没有坑，尤其是会让你亏钱的条款。',
      ambiguities: ['合同是整份还是节选'],
      missingInfo: [],
      clarifyQuestions: [], // 默认策略：先做，把假设亮出来
    },
    plan: {
      title: '租房合同风险审查',
      assumptions: ['假定你是承租方', '假定合同尚未签字'],
      risks: ['押金退还期限缺失'],
      deliverables,
      stages: [
        { key: 'intake', reason: '先把你的话听懂，免得做错方向' },
        { key: 'plan', reason: '把一件事拆成能干活的步骤' },
        { key: 'research', reason: '补齐做这件事需要的背景知识' },
        { key: 'draft', reason: '真正把东西做出来' },
        { key: 'critique', reason: '自己先挑一遍毛病' },
        { key: 'revise', reason: '按挑出来的问题改一遍' },
        { key: 'verify', reason: '对着你的要求逐条验收' },
        { key: 'deliver', reason: '告诉你拿到东西后怎么用' },
      ],
    },
    research: { findings: ['押金纠纷是租房争议里最常见的一类'], sources: [], cautions: ['演示用背景知识'] },
    draft: {
      artifacts: deliverableIds.map((id) => ({
        deliverableId: id,
        content: CONTENT,
        assumptions: ['假定你是承租方'],
        confidence, // ← 传 "0.95" 就能复现缺陷 #1
      })),
    },
    critique: {
      overall: '整体可用，但有两处建议不够具体。',
      issues: [
        { severity: 'medium', where: deliverableIds[0], problem: '违约金示例只算了一种情形。', fix: '补一句通用计算公式。' },
      ],
    },
    revise: {
      changeLog: ['补上违约金计算公式'],
      artifacts: deliverableIds.map((id) => ({ deliverableId: id, content: CONTENT + '\n（已按审查意见修订）\n' })),
    },
    verify: {
      verdict: 'pass_with_notes',
      checklist: [
        { item: '是否回答了用户真实问的问题', ok: true, note: '' },
        { item: '结论是否可执行', ok: true, note: '' },
        { item: '关键数字是否复核', ok: false, note: '只算了一种情形' },
      ],
      issues: [],
    },
    deliver: {
      headline: '你的合同审查好了',
      howToUse: ['先看结论那一段', '再看高风险三条', '照着话术发给房东'],
      nextSteps: ['把改好的合同再发进来复查'],
      cautions: ['我们不是律师，重大金额请咨询执业律师'],
    },
  };
}

/** 引擎期望的 callModel 返回形状 */
const mockResult = (json, purpose) => ({
  text: JSON.stringify(json),
  json,
  usage: { promptTokens: 100, completionTokens: 50 },
  ms: 3,
  provider: 'mock',
  providerLabel: '剧本模型',
  model: 'mock-model',
  degraded: false,
  notices: [],
  attempts: 1,
  purpose,
});

/**
 * 造一个按 purpose 分派的假 callModel。
 *
 * @param {object} [opts]
 * @param {string[]} [opts.failPurposes] 这些阶段抛「所有模型都失败」错误
 * @param {number} [opts.failAfter] 第 N 次调用之后开始抛错（1 起）
 * @param {string} [opts.confidence] draft 阶段的 confidence 值（传 '0.95' 复现缺陷 #1）
 * @param {string[]} [opts.deliverableIds]
 * @returns {{callModel:Function, calls:Array, purposes:()=>string[]}}
 */
/**
 * 按「阶段」取剧本产出的公开入口。
 *
 * 为什么需要它：e2e 里要替换的是 HTTP 传输（stub fetch），而不是 callModel。
 * 那种写法下必须自己从请求体判断"这是哪个阶段"，然后给出对应的剧本返回值。
 * 这个判断曾经被做错两次（截断 + 顺序敏感的内容词），所以把"判定"这一步
 * 收进这里统一实现，测试里只调用它，别再各自写一套匹配逻辑。
 *
 * 判定依据：每个阶段的 system 提示词都以「你是这家 AI 公司的**岗位名**。」开头。
 *
 * @param {object} body 请求体（已 JSON.parse）
 * @returns {string} 阶段 key，识别不出返回 'unknown'
 */
export function stageOfRequest(body) {
  const sysText = String(
    (body?.messages ?? []).find((m) => m.role === 'system')?.content ?? '',
  );
  const ROLE_TO_STAGE = {
    接待员: 'intake',
    项目经理: 'plan',
    调研员: 'research',
    执行专员: 'draft', // 同时用于 draft/revise，下面再细分
    审查员: 'critique',
    质检员: 'verify',
    交付专员: 'deliver',
  };
  for (const [role, key] of Object.entries(ROLE_TO_STAGE)) {
    if (sysText.startsWith(`你是这家 AI 公司的**${role}**`)) {
      // revise 的岗位名也是"执行专员"，靠提示词里的另一句特征区分
      return key === 'draft' && sysText.includes('现在负责**改稿**') ? 'revise' : key;
    }
  }
  return 'unknown';
}

/** 取某个阶段的剧本产出（给 stub fetch 用） */
export function scriptedOutputFor(stage, opts = {}) {
  return stageOutputs(opts)[stage] ?? null;
}

export function scriptedModel(opts = {}) {
  const { failPurposes = [], failAfter = null, confidence = 'high', deliverableIds = ['d1', 'd2'] } = opts;
  const outputs = stageOutputs({ confidence, deliverableIds });
  const calls = [];

  const callModel = async (o = {}) => {
    const purpose = o.purpose ?? 'unknown';
    calls.push({ purpose, role: o.role, system: o.system, user: o.user, schema: o.schema });
    if (failPurposes.includes(purpose) || (failAfter !== null && calls.length > failAfter)) {
      throw new AppError(ERR.LLM_NO_PROVIDER, '所有模型都没能完成任务（剧本模型故意失败）。', { status: 503 });
    }
    const json = outputs[purpose];
    if (!json) throw new AppError(ERR.LLM_SCHEMA_INVALID, `剧本模型没有为 ${purpose} 准备输出。`, { status: 502 });
    return mockResult(json, purpose);
  };

  return { callModel, calls, purposes: () => calls.map((c) => c.purpose) };
}

/** 临时替换引擎的 callModel，用完自动还原（真实模式测试必须先还原成真模型） */
export async function withMockModel(stub, fn) {
  const original = engine.deps.callModel;
  engine.deps.callModel = stub;
  try {
    return await fn();
  } finally {
    engine.deps.callModel = original;
  }
}

/* ------------------------------------------------------------------ *
 * 引擎装配
 * ------------------------------------------------------------------ */

let wired = false;

/**
 * 把 loadOptionalDeps 本该装上的依赖补齐（缺陷 #1 的临时补丁，见文件头注释）。
 */
export async function wireEngineDeps() {
  await engine.loadOptionalDeps();
  engine.deps.saveJob ??= store.saveJob;
  engine.deps.getJob ??= store.getJob;
  engine.deps.updateJob ??= store.updateJob;
  engine.deps.deleteJob ??= store.deleteJob;
  engine.deps.demo ??= fixtures;
  engine.deps.guard ??= guard;
  wired = true;
  return engine.deps;
}

export const engineDepsWired = () => wired;

/* ------------------------------------------------------------------ *
 * 测试环境
 * ------------------------------------------------------------------ */

/** 建一个干净的数据目录（测试结束必须删掉，别在仓库里留垃圾） */
export function makeTempDataDir(prefix = 'handoff-e2e-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HANDOFF_DATA_DIR = dir;
  return dir;
}

export function cleanupTempDataDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清不掉就算了，别让测试因为清理失败而红 */
  }
}

/** 轮询直到任务落到终态；返回最终 job（超时抛错，附带最后一帧便于排查） */
export async function waitForJob(app, id, { timeoutMs = 30_000, intervalMs = 100, until = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/jobs/${id}`);
    last = res.body?.job ?? null;
    const settled = last && ['done', 'failed', 'cancelled', 'awaiting_input'].includes(last.status);
    if (until ? until(last) : settled) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待任务 ${id} 超时（${timeoutMs}ms），最后一帧：${JSON.stringify(last)?.slice(0, 500)}`);
}

/** 直接读引擎内存（不受持久化缺陷影响） */
export function memoryJob(id) {
  return engine.__internals.memory.get(id) ?? null;
}

/** 创建 demo 任务并等它跑完（e2e 里最常用的两步） */
export async function runDemoJobViaHttp(app, goal = fixtures.DEFAULT_DEMO_GOAL) {
  const created = await request(app).post('/api/jobs').send({ goal, demo: true });
  if (created.status !== 201) throw new Error(`创建任务失败：${created.status} ${JSON.stringify(created.body)}`);
  const id = created.body.job.id;
  const job = await waitForJob(app, id);
  return { created, id, job };
}

/** 采集某个 job 的事件（等价于 SSE 端点的数据源） */
export function collectEvents(jobId) {
  const stop = events.subscribe(jobId, () => {});
  stop();
  return { since: (seq = 0) => events.since(jobId, seq), cursor: () => events.cursor(jobId) };
}

export { engine, store, fixtures, guard, events, request };
