/**
 * 流水线阶段定义。
 *
 * 每个阶段是一个纯函数式的「工人」：拿到上下文，干完活，返回产出。
 * 它不关心存储、不关心 HTTP、不关心 SSE —— 那些是 engine 的事。
 * 这样每个阶段都能被单独测试。
 */
import {
  TEAM,
  SCHEMAS,
  MAX_TOKENS,
  systemPromptFor,
  buildUser,
} from '../prompts/index.js';

/** 阶段元数据。order 决定顺序，与 CONTRACT §3 一致。 */
export const STAGE_META = {
  intake: { order: 10, title: '理解需求', required: true, schema: SCHEMAS.intake, maxTokens: MAX_TOKENS.intake },
  plan: { order: 20, title: '制定方案', required: true, schema: SCHEMAS.plan, maxTokens: MAX_TOKENS.plan },
  research: { order: 30, title: '查资料', required: false, schema: SCHEMAS.research, maxTokens: MAX_TOKENS.research },
  draft: { order: 40, title: '动手做', required: true, schema: SCHEMAS.draft, maxTokens: MAX_TOKENS.draft },
  critique: { order: 50, title: '挑毛病', required: false, schema: SCHEMAS.critique, maxTokens: MAX_TOKENS.critique },
  revise: { order: 60, title: '改稿', required: false, schema: SCHEMAS.revise, maxTokens: MAX_TOKENS.revise },
  verify: { order: 70, title: '验收', required: true, schema: SCHEMAS.verify, maxTokens: MAX_TOKENS.verify },
  deliver: { order: 80, title: '打包交付', required: true, schema: SCHEMAS.deliver, maxTokens: MAX_TOKENS.deliver },
};

export const STAGE_KEYS = Object.keys(STAGE_META).sort((a, b) => STAGE_META[a].order - STAGE_META[b].order);

/** 永远必需、绝不能由 planner 决定的阶段 */
export const FIXED_FIRST = 'intake';
export const FIXED_LAST = 'deliver';

/**
 * 校验 planner 选的阶段序列。
 * 规则（CONTRACT §3）：
 *  - 必须包含 intake 和 deliver
 *  - 必须包含 draft 和 verify（没有这两步就没有交付物和验收）
 *  - 必须是已知阶段的子集，且按 order 升序
 *  - 不能重复
 * 违规时**不报错**，而是自动修正 —— 普通人不能因为模型编排失误而失败。
 * @returns {{keys:string[], repaired:boolean, notes:string[]}}
 */
export function normalizeStages(requested) {
  const notes = [];
  let repaired = false;
  const seen = new Set();
  const keys = [];

  for (const item of Array.isArray(requested) ? requested : []) {
    const key = typeof item === 'string' ? item : item?.key;
    if (!STAGE_META[key]) {
      repaired = true;
      notes.push(`忽略了未知阶段「${key}」`);
      continue;
    }
    if (seen.has(key)) {
      repaired = true;
      notes.push(`去掉了重复的阶段「${key}」`);
      continue;
    }
    seen.add(key);
    keys.push(key);
  }

  for (const must of ['intake', 'plan', 'draft', 'verify', 'deliver']) {
    if (!seen.has(must)) {
      repaired = true;
      notes.push(`补上了必需的阶段「${must}」`);
      seen.add(must);
      keys.push(must);
    }
  }

  // critique 存在但没有 revise：补上 revise，否则挑出来的毛病没人改
  if (seen.has('critique') && !seen.has('revise')) {
    repaired = true;
    notes.push('有「挑毛病」却没有「改稿」，已自动补上改稿');
    keys.push('revise');
    seen.add('revise');
  }
  // revise 存在但没有 critique：补上 critique，否则没有修改依据
  if (seen.has('revise') && !seen.has('critique')) {
    repaired = true;
    notes.push('有「改稿」却没有「挑毛病」，已自动补上挑毛病');
    keys.push('critique');
    seen.add('critique');
  }

  const ordered = keys.slice().sort((a, b) => STAGE_META[a].order - STAGE_META[b].order);
  if (ordered.join(',') !== keys.join(',')) {
    repaired = true;
    notes.push('阶段顺序不规范，已按正确顺序重排');
  }

  return { keys: ordered, repaired, notes };
}

/* ────────────────────────────────────────────────────────────────
 * 阶段执行器
 *
 * 每个 run 函数签名：async (ctx) => output
 *   ctx = { job, goal, plan, intake, research, artifacts, outputs,
 *           callModel, emit, log, checkAbort, userMessages }
 * ──────────────────────────────────────────────────────────────── */

/** 把用户中途追加的要求拼成一段上下文 */
const extraRequirements = (userMessages = []) => {
  const items = userMessages.filter((m) => m && m.text && m.text.trim());
  if (!items.length) return '';
  return `\n【用户中途补充的要求，优先级最高，必须满足】\n${items
    .map((m, i) => `${i + 1}. ${m.text.trim()}`)
    .join('\n')}\n`;
};

export const STAGE_RUNNERS = {
  async intake(ctx) {
    const out = await ctx.callModel({
      system: systemPromptFor('intake'),
      user: buildUser.intake({
        goal: ctx.goal,
        audience: ctx.job.audience,
        tone: ctx.job.tone,
        templateHint: ctx.job.templateTitle,
      }),
      schema: SCHEMAS.intake,
      maxTokens: MAX_TOKENS.intake,
      purpose: 'intake',
      role: TEAM.intake.role,
    });
    ctx.log(`我理解你要的是：${out.intent}`);
    if ((out.clarifyQuestions ?? []).length) {
      ctx.log(`有几个地方想跟你确认一下（${out.clarifyQuestions.length} 个问题）`, 'warn');
    }
    return out;
  },

  async plan(ctx) {
    const out = await ctx.callModel({
      system: systemPromptFor('plan'),
      user:
        buildUser.plan({ goal: ctx.goal, intake: ctx.outputs.intake }) +
        extraRequirements(ctx.job.userMessages),
      schema: SCHEMAS.plan,
      maxTokens: MAX_TOKENS.plan,
      purpose: 'plan',
      role: TEAM.plan.role,
    });
    ctx.log(`方案定好了：${out.title}，要交付 ${out.deliverables.length} 份东西`);
    for (const d of out.deliverables) ctx.log(`  · ${d.name}`);
    return out;
  },

  async research(ctx) {
    const out = await ctx.callModel({
      system: systemPromptFor('research'),
      user: buildUser.research({ goal: ctx.goal, plan: ctx.plan }),
      schema: SCHEMAS.research,
      maxTokens: MAX_TOKENS.research,
      purpose: 'research',
      role: TEAM.research.role,
    });
    ctx.log(`补齐了 ${out.findings.length} 条背景知识`);
    for (const c of out.cautions ?? []) ctx.log(`  注意：${c}`, 'warn');
    return out;
  },

  async draft(ctx) {
    const out = await ctx.callModel({
      system: systemPromptFor('draft'),
      user:
        buildUser.draft({
          goal: ctx.goal,
          plan: ctx.plan,
          research: ctx.outputs.research,
          feedback: null,
        }) + extraRequirements(ctx.job.userMessages),
      schema: SCHEMAS.draft,
      maxTokens: MAX_TOKENS.draft,
      purpose: 'draft',
      role: TEAM.draft.role,
      temperature: 0.5,
    });
    return out;
  },

  async critique(ctx) {
    const out = await ctx.callModel({
      system: systemPromptFor('critique'),
      user: buildUser.critique({ goal: ctx.goal, plan: ctx.plan, artifacts: ctx.artifacts }),
      schema: SCHEMAS.critique,
      maxTokens: MAX_TOKENS.critique,
      purpose: 'critique',
      role: TEAM.critique.role,
      temperature: 0.4,
    });
    const high = (out.issues ?? []).filter((i) => i.severity === 'high').length;
    ctx.log(`挑出 ${(out.issues ?? []).length} 个问题（其中 ${high} 个比较严重）`);
    for (const i of (out.issues ?? []).slice(0, 3)) ctx.log(`  · ${i.problem}`, 'warn');
    return out;
  },

  async revise(ctx) {
    const issues = ctx.outputs.critique?.issues ?? [];
    const out = await ctx.callModel({
      system: systemPromptFor('revise'),
      user: buildUser.revise({
        goal: ctx.goal,
        plan: ctx.plan,
        artifacts: ctx.artifacts,
        issues,
      }),
      schema: SCHEMAS.revise,
      maxTokens: MAX_TOKENS.revise,
      purpose: 'revise',
      role: TEAM.revise.role,
      temperature: 0.45,
    });
    ctx.log(`改完了，动了 ${(out.changeLog ?? []).length} 处`);
    for (const c of (out.changeLog ?? []).slice(0, 3)) ctx.log(`  · ${c}`);
    return out;
  },

  async verify(ctx) {
    const out = await ctx.callModel({
      system: systemPromptFor('verify'),
      user: buildUser.verify({
        goal: ctx.goal,
        plan: { ...ctx.plan, intent: ctx.outputs.intake?.intent },
        artifacts: ctx.artifacts,
      }),
      schema: SCHEMAS.verify,
      maxTokens: MAX_TOKENS.verify,
      purpose: 'verify',
      role: TEAM.verify.role,
      temperature: 0.2,
    });
    const passed = (out.checklist ?? []).filter((c) => c.ok).length;
    ctx.log(`验收完成：${passed}/${(out.checklist ?? []).length} 项通过 → ${out.verdict}`);
    return out;
  },

  async deliver(ctx) {
    const out = await ctx.callModel({
      system: systemPromptFor('deliver'),
      user: buildUser.deliver({
        goal: ctx.goal,
        plan: ctx.plan,
        artifacts: ctx.artifacts,
        review: ctx.outputs.verify,
      }),
      schema: SCHEMAS.deliver,
      maxTokens: MAX_TOKENS.deliver,
      purpose: 'deliver',
      role: TEAM.deliver.role,
      temperature: 0.5,
    });
    ctx.log(`交付说明写好了：${out.headline}`);
    return out;
  },
};

/** 阶段产出的模型名与展示信息 */
export function stageDisplay(key, reasonFromPlan) {
  const meta = STAGE_META[key];
  const team = TEAM[key] ?? { role: '员工', name: '同事' };
  return {
    key,
    title: meta.title,
    role: team.role,
    name: team.name,
    emoji: team.emoji,
    order: meta.order,
    reason: reasonFromPlan || defaultReason(key),
    required: meta.required,
  };
}

function defaultReason(key) {
  return (
    {
      intake: '先把你的话听懂，免得做错方向',
      plan: '把一件事拆成能干活的步骤',
      research: '补齐做这件事需要的背景知识',
      draft: '真正把东西做出来',
      critique: '自己先挑一遍毛病，别让你发现',
      revise: '按挑出来的问题改一遍',
      verify: '对着你的要求逐条验收',
      deliver: '告诉你拿到东西后怎么用',
    }[key] ?? '这一步是为了把事做好'
  );
}
