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
  STAGE_TIMEOUT_MS,
  systemPromptFor,
  buildUser,
} from '../prompts/index.js';
import {
  parseArtifactBlocks,
  parseIssueBlocks,
  ARTIFACT_PROTOCOL_SPEC,
  CRITIQUE_PROTOCOL_SPEC,
  looksTruncated,
} from '../llm/text-protocol.js';
import { AppError, ERR } from '../llm/errors.js';

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

/**
 * 长文本阶段专用：不用 JSON，直接收 markdown。
 *
 * 为什么（真实数据，别改回去）：
 * 让模型把 2000 字中文 markdown 塞进 JSON 字符串，转义失败率高得离谱，
 * 一个阶段要重试三四轮、跨两三个模型、跑 100~300 秒 —— 对普通人就是「卡住了」。
 * 改成定界符协议后，模型写 markdown 是它的强项，一次就过。
 *
 * 兜底：万一模型还是输出了 JSON（它有时很固执），这里也认。
 */
/**
 * 把技能块拼到 system 提示词后面。
 *
 * 为什么每个阶段都要带：技能是"这类事该怎么做的经验"，
 * 接待员理解需求时用得上（知道这类事的关键点在哪），
 * 执行专员写的时候更用得上，质检员验收时也用得上（知道该查什么）。
 * 全部阶段统一注入，比挑几个阶段注入更不容易出错。
 */
const sysWith = (system, ctx) => `${system}${ctx?.skillsBlock ?? ''}`;

async function callForArtifacts(ctx, { system, user, maxTokens, purpose, role, temperature }) {
  const stageTimeout = timeoutFor(purpose);
  // 「动手做」允许用工具：写东西之前先查一下、把用户的文件读一遍，
  // 产出物的质量差别很大。只在真的有工具时才走这条路。
  const useTools = ctx.toolsAvailable && ctx.toolsAvailable.length > 0;

  const runOnce = (extra = '') => {
    const sys = sysWith(`${system}\n\n${ARTIFACT_PROTOCOL_SPEC}${extra}`, ctx);
    if (useTools) {
      return ctx.callModelWithTools({
        system:
          sys +
          '\n\n【你这次可以使用工具】在动笔之前，如果有需要核实的事实、' +
          '用户提到的文件或链接，**先用工具查清楚**再写。查不到的部分如实说明，不要编。',
        user,
        allowedTools: ctx.toolsAvailable,
        maxTokens,
        purpose,
        role,
      });
    }
    return ctx.callModel({
      system: sys,
      user,
      schema: null,
      maxTokens,
      purpose,
      role,
      temperature,
      timeoutMs: stageTimeout,
    });
  };

  let res = await runOnce();
  let text = resText(res);
  let parsed = parseArtifactBlocks(text);

  // 撞到输出上限会在半句话中间停住 —— 这时候补一轮，别把半截文档交给用户。
  // 半截文档比报错更让人困惑：用户会以为"就这么多"。
  const truncated =
    parsed.blocks.some((b) => looksTruncated(b.content)) ||
    (!parsed.found && looksTruncated(text));
  if (truncated) {
    ctx.log('上一次输出像是被截断了，正在要求它把剩下的部分补完整。', 'warn');
    res = await runOnce(
      '\n\n【重要】上一次你的输出在中间被截断了，很多内容没写完。\n这次请**优先保证每一份交付物都完整**：如果篇幅不够，就把每份写得更精炼，但绝对不能写到一半停住。\n每一份的结尾必须有 <<<END>>>。',
    );
    text = resText(res);
    parsed = parseArtifactBlocks(text);
    if (parsed.blocks.some((b) => looksTruncated(b.content))) {
      ctx.log('补写后仍然偏短，可能是本次内容确实不多，继续往下走。', 'warn');
    }
  }

  if (parsed.blocks.length && parsed.blocks.some((b) => b.content.length > 80)) {
    return {
      artifacts: parsed.blocks.map((b) => ({
        deliverableId: b.deliverableId,
        content: b.content,
        assumptions: b.assumptions,
        confidence: b.confidence,
      })),
      changeLog: extractChangeLog(text),
      _protocol: 'text',
    };
  }

  // 退路一：模型把结果写成了 JSON
  const jsonAttempt = extractJsonObject(text);
  if (jsonAttempt?.artifacts?.length) {
    ctx.log('模型这次用了 JSON 格式，已自动兼容。', 'warn');
    return { artifacts: jsonAttempt.artifacts, changeLog: jsonAttempt.changeLog ?? [], _protocol: 'json' };
  }

  // 退路二：什么定界符都没有，但正文看着是像样的 markdown → 整体当成第一个交付物的正文
  const deliverables = ctx.plan?.deliverables ?? [];
  if (text.trim().length > 200 && deliverables.length) {
    ctx.log('模型没按约定用定界符，已把输出整体当作第一份交付物。', 'warn');
    return {
      artifacts: [
        {
          deliverableId: String(deliverables[0].id),
          content: text.trim(),
          assumptions: [],
          confidence: 'medium',
        },
      ],
      changeLog: [],
      _protocol: 'fallback-raw',
    };
  }

  throw new AppError(
    ERR.LLM_EMPTY_RESPONSE,
    '模型这次没能把内容写出来（输出为空或格式完全不可识别）。',
    { status: 502 },
  );
}

/** 从 callModel 的返回值里取文本（兼容有/无 schema 两种返回形状） */
function resText(res) {
  if (typeof res === 'string') return res;
  if (typeof res?.text === 'string') return res.text;
  if (typeof res?.content === 'string') return res.content;
  return '';
}

/** 从文本里抠出 <<<CHANGELOG>>> 段 */
function extractChangeLog(text) {
  const m = String(text ?? '').match(/<<<[ \t]*CHANGELOG[ \t]*>>>([\s\S]*?)(?=<<<|$)/i);
  if (!m) return [];
  return m[1]
    .replace(/<<<[ \t]*END[ \t]*>>>/gi, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*·]|\d+[.、)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 12);
}

/** 尝试从文本里解析出一个 JSON 对象（模型偶尔很固执地输出 JSON） */
function extractJsonObject(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 给某个阶段算超时。取该阶段配置，没配就用 120 秒兜底。
 * @param {string} key 阶段 key
 */
const timeoutFor = (key) => STAGE_TIMEOUT_MS[key] ?? 120000;

/**
 * 交付阶段的兜底：不靠模型，用**已有的真实信息**拼一份「怎么用」。
 *
 * 触发条件：模型在最后一步失败（超时/格式不对）。这时候用户要的成果已经做完了，
 * 我们绝不能因为"说明没写成"就把整个任务标成失败 ——
 * 那会让用户以为白等了，而东西其实就在旁边。
 *
 * 拼出来的内容全部来自 plan（标题、假设、风险）和 artifacts（名字），
 * 都是真实数据，不是编的。
 * @param {object} ctx 阶段上下文
 * @param {Error} err 原始错误（只用来记日志，不展示给用户）
 */
function synthesizeDelivery(ctx, err) {
  const plan = ctx.plan ?? {};
  const names = (ctx.artifacts ?? []).map((a) => a.name).filter(Boolean);
  const risks = plan.risks ?? [];
  return {
    headline: plan.title ? `${plan.title}：东西已经做好了` : '东西已经做好了',
    howToUse: [
      names.length
        ? `先看成果里的这几份：${names.join('、')}。`
        : '先看下面列出的成果。',
      (plan.assumptions ?? []).length
        ? '再看「我们替你做的假设」那一栏 —— 里面任何一条不对，都值得你补一句让我们重做。'
        : '如果哪一部分不对，在下面补一句话，我们会重做。',
      '想拿走的话，每份成果右上角都有复制和下载。',
    ],
    nextSteps: [
      '把成果里标为"必须做"的部分先落实。',
      risks.length ? `特别留意这一条：${risks[0]}` : '有拿不准的地方，把具体情况补进来再让我们看一遍。',
    ],
    cautions: risks.slice(1, 3).map((r) => `别忘了：${r}`),
    _fallback: true,
    _reason: err?.code ?? 'unknown',
  };
}

/**
 * 把"用了工具的研究阶段"的自由文本产出，抽成结构化的 findings/sources/cautions。
 *
 * 为什么需要兜底：带工具时我们不再强制 JSON schema（模型要一边调工具一边输出
 * 严格 JSON 很别扭，失败率很高）。所以它可能给散文、可能给 JSON、可能给混搭。
 * **无论哪种，查到的东西都不能丢** —— 这是这个函数存在的唯一理由。
 *
 * @param {string} text 模型最终正文
 * @param {Array} steps 工具调用轨迹（用来兜底：至少告诉下游"查了什么"）
 */
export function salvageResearch(text, steps = []) {
  const src = String(text ?? '').trim();

  // 情形一：它还是给了 JSON（有些模型很固执）
  const jsonGuess = extractJsonObject(src);
  if (jsonGuess && Array.isArray(jsonGuess.findings)) {
    return {
      findings: jsonGuess.findings.map((f) => String(f)).filter(Boolean).slice(0, 12),
      sources: Array.isArray(jsonGuess.sources) ? jsonGuess.sources.map(String).slice(0, 8) : [],
      cautions: Array.isArray(jsonGuess.cautions) ? jsonGuess.cautions.map(String).slice(0, 8) : [],
      _protocol: 'json',
    };
  }

  if (!src) {
    // 一句话都没写出来，但工具确实跑过：至少把"查了什么"记下来
    return {
      findings: steps.length
        ? [`（这一步调用了 ${steps.length} 次工具，但没能整理出结论）`]
        : [],
      sources: steps.map((s) => `${s.name}(${JSON.stringify(s.args ?? {}).slice(0, 80)})`).slice(0, 8),
      cautions: ['这一步没能整理出结论，交付物里应说明部分信息未能核实。'],
      _protocol: 'empty',
    };
  }

  // 情形二：散文。按标题/列表切段，尽量把要点提出来。
  const findings = [];
  for (const block of src.split(/\n\s*\n/)) {
    const cleaned = block
      .split('\n')
      .map((l) => l.replace(/^\s*(?:[-*·]|\d+[.、)]|#{1,6})\s*/, '').trim())
      .filter(Boolean)
      .join(' ');
    if (cleaned.length > 8) findings.push(cleaned);
  }

  // 把明显是"提醒/注意"的段落单独挑出来当 cautions
  const cautions = findings.filter((f) => /^注意|小心|警惕|风险|不确定|未能/.test(f)).slice(0, 6);
  const pure = findings.filter((f) => !cautions.includes(f));

  return {
    findings: (pure.length ? pure : findings).slice(0, 12),
    sources: steps.map((s) => `${s.name}${s.summary ? `：${s.summary.slice(0, 60)}` : ''}`).slice(0, 8),
    cautions,
    _protocol: 'prose',
  };
}

export const STAGE_RUNNERS = {
  async intake(ctx) {
    const out = await ctx.callModel({
      timeoutMs: timeoutFor('intake'),
      system: sysWith(systemPromptFor('intake'), ctx),
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
      timeoutMs: timeoutFor('plan'),
      system: sysWith(systemPromptFor('plan'), ctx),
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
    // 有工具时，「查资料」才是名副其实的查资料 —— 不然它只是"凭记忆写"。
    // 实测：给它 read_text_file/web_fetch/web_search 之后，它会把用户提到的
    // 文件真的读一遍、把用户给的链接真的打开，而不是猜。
    const useTools = ctx.toolsAvailable && ctx.toolsAvailable.length > 0;
    if (useTools) {
      const r = await ctx.callModelWithTools({
        system:
          sysWith(systemPromptFor('research'), ctx) +
          '\n\n【你这次可以使用工具】如果用户提到了某个文件或某个链接，' +
          '**先用工具真的去读/去查**，不要凭印象猜。查到的东西才写进 findings，' +
          '并说明来源。查不到就如实说查不到。',
        user: buildUser.research({ goal: ctx.goal, plan: ctx.plan }),
        allowedTools: ctx.toolsAvailable,
        maxTokens: MAX_TOKENS.research,
        purpose: 'research',
        role: TEAM.research.role,
      });
      // 工具跑完后的正文可能是散文，抽成结构化 findings；抽不出来就用原文兜底 ——
      // 绝不因为"格式没按要求"就把查到的东西丢掉。
      const salvaged = salvageResearch(r.text, r.steps);
      ctx.log(`补齐了 ${salvaged.findings.length} 条背景知识${r.toolCount ? `（用了 ${r.toolCount} 次工具）` : ''}`);
      for (const c of salvaged.cautions ?? []) ctx.log(`  注意：${c}`, 'warn');
      return salvaged;
    }

    const out = await ctx.callModel({
      timeoutMs: timeoutFor('research'),
      system: sysWith(systemPromptFor('research'), ctx),
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
    const out = await callForArtifacts(ctx, {
      system: sysWith(systemPromptFor('draft'), ctx),
      user:
        buildUser.draft({
          goal: ctx.goal,
          plan: ctx.plan,
          research: ctx.outputs.research,
          feedback: null,
        }) + extraRequirements(ctx.job.userMessages),
      maxTokens: MAX_TOKENS.draft,
      purpose: 'draft',
      role: TEAM.draft.role,
      temperature: 0.5,
    });
    return out;
  },

  async critique(ctx) {
    const res = await ctx.callModel({
      timeoutMs: timeoutFor('critique'),
      system: `${systemPromptFor('critique')}\n\n${CRITIQUE_PROTOCOL_SPEC}`,
      user: buildUser.critique({ goal: ctx.goal, plan: ctx.plan, artifacts: ctx.artifacts }),
      schema: null,
      maxTokens: MAX_TOKENS.critique,
      purpose: 'critique',
      role: TEAM.critique.role,
      temperature: 0.4,
    });
    const text =
      typeof res === 'string' ? res : typeof res?.text === 'string' ? res.text : '';
    let out = parseIssueBlocks(text);

    // 兼容：模型固执地写了 JSON
    if (!out.issues.length) {
      const j = extractJsonObject(text);
      if (j?.issues) out = { issues: j.issues, overall: j.overall ?? '' };
    }
    // 一条问题都挑不出来：这是**不够好**的信号（我们要求它至少找点毛病），
    // 但不该因此让任务失败。记一条日志，让 verify 去把关。
    if (!out.issues.length) {
      ctx.log('审查员这次没挑出问题（可能是内容确实扎实，也可能是它偷懒了）。', 'warn');
    }
    const high = out.issues.filter((i) => i.severity === 'high').length;
    ctx.log(`挑出 ${out.issues.length} 个问题（其中 ${high} 个比较严重）`);
    for (const i of out.issues.slice(0, 3)) ctx.log(`  · ${i.problem}`, 'warn');
    return { issues: out.issues, overall: out.overall || '（无总评）' };
  },

  async revise(ctx) {
    const issues = ctx.outputs.critique?.issues ?? [];
    const out = await callForArtifacts(ctx, {
      system: sysWith(systemPromptFor('revise'), ctx),
      user: buildUser.revise({
        goal: ctx.goal,
        plan: ctx.plan,
        artifacts: ctx.artifacts,
        issues,
      }),
      maxTokens: MAX_TOKENS.revise,
      purpose: 'revise',
      role: TEAM.revise.role,
      temperature: 0.45,
    });
    const log = out.changeLog ?? [];
    ctx.log(`改完了，动了 ${log.length} 处`);
    for (const c of log.slice(0, 3)) ctx.log(`  · ${c}`);
    return out;
  },

  async verify(ctx) {
    const out = await ctx.callModel({
      timeoutMs: timeoutFor('verify'),
      system: sysWith(systemPromptFor('verify'), ctx),
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
    // ⚠️ 交付说明是**整条流水线的最后一步**，而用户真正要的东西这时候已经做好了。
    // 如果模型在这一步掉链子（超时、格式不对），绝不能因此把整个任务判为失败 ——
    // 那等于告诉用户「你等了 8 分钟，什么都没有」，而其实成果就躺在旁边。
    // 所以这里兜底：拿不到模型写的说明，就用我们自己拼的（内容来自 plan，全是真实数据）。
    let out;
    try {
      out = await ctx.callModel({
      timeoutMs: timeoutFor('deliver'),
      system: sysWith(systemPromptFor('deliver'), ctx),
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
    } catch (err) {
      ctx.log('交付说明这一步没写成，我用现成的信息替你拼一份。', 'warn');
      out = synthesizeDelivery(ctx, err);
    }
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
