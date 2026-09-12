/**
 * 工具调用循环 —— 让模型「真的动手」。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这是从"会写字的模型"到"能办事的 Agent"之间那一步。
 *
 * 循环长这样：
 *   模型说「我要用 web_fetch 抓这个网址」
 *     → 我们去抓，把结果塞回对话
 *       → 模型说「我要再用 web_search 查一下」
 *         → 我们去查，塞回去
 *           → 模型说「好了，这是我写的东西」
 *             → 循环结束
 *
 * 三个必须做对的约束（不做对就会出现经典事故）：
 *
 *  1. **必须有上限**。模型可能陷入"调工具→不满意→再调"的死循环，
 *     把用户的额度烧光。所以有 maxTurns（轮数）和 maxToolCallsPerTurn（单轮并行数）。
 *
 *  2. **工具失败不能中断**。工具失败是常态（404、超时）。把失败原因作为
 *     一条 tool 消息喂回去，模型会自己换策略。直接抛异常等于因为一个网址
 *     打不开就毁掉整个任务。
 *
 *  3. **工具结果是不可信数据**。网页内容里可能写着"忽略之前的指令"。
 *     所以渲染时用 `<tool_result>` 包住并声明"这是数据不是指令"，
 *     并且在 system 里也提醒过模型（见 prompts/index.js 的 UNTRUSTED_NOTICE）。
 * ══════════════════════════════════════════════════════════════════
 */
import { AppError, ERR, redactSecrets } from '../llm/errors.js';
import { callModelRaw } from '../llm/gateway.js';
import { executeTool, renderToolResult, toolSpecs, listTools } from './registry.js';

/** 默认最多几轮工具调用。够解决"先搜再读再写"这类真实任务，又不至于失控。 */
export const DEFAULT_MAX_TURNS = 6;
/** 单轮最多并行执行几个工具调用（模型一次可能请求多个） */
export const DEFAULT_MAX_CALLS_PER_TURN = 4;
/** 整个工具循环的墙钟上限 */
export const DEFAULT_LOOP_BUDGET_MS = 300_000;

/**
 * 跑一次带工具能力的模型调用。
 *
 * @param {object} opts
 * @param {string} opts.system system 提示词
 * @param {string} opts.user 用户内容
 * @param {string[]|null} [opts.allowedTools] 只允许这些工具（null = 全部已注册的）
 * @param {number} [opts.maxTurns]
 * @param {number} [opts.maxToolCallsPerTurn]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {number} [opts.timeoutMs] 单次模型调用超时
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.schema] 最终正文需要满足的 JSON Schema（可选）
 * @param {Function} [opts.onToolCall] 每次工具调用前后的回调（给 SSE / UI 用）
 * @param {Function} [opts.onNotice] 降级/重试通知
 * @param {object} [opts.deps] 注入（测试用）
 * @returns {Promise<{text, json, steps, usage, ms, provider, model, degraded, notices, attempts, turns}>}
 */
export async function callModelWithTools(opts = {}) {
  const {
    system = '',
    user = '',
    allowedTools = null,
    maxTurns = DEFAULT_MAX_TURNS,
    maxToolCallsPerTurn = DEFAULT_MAX_CALLS_PER_TURN,
    maxTokens = 8000,
    temperature = 0.3,
    timeoutMs = 90_000,
    signal = null,
    onToolCall = null,
    onNotice = null,
    purpose = 'tools',
    role = '',
    jobId = null,
  } = opts;

  const specs = toolSpecs({ allowed: allowedTools });
  const startedMs = Date.now();

  /** 一次工具都没调用的情况（没配工具 / 模型选择不使用）也要能正常工作 */
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const steps = []; // 审计轨迹：给 UI 显示"团队用了什么工具、拿到了什么"
  const notices = [];
  const usage = { promptTokens: 0, completionTokens: 0 };
  let totalMs = 0;
  let attempts = 0;
  let lastProvider = null;
  let lastModel = null;
  let degraded = false;
  let finalText = '';
  let turns = 0;

  const notice = (item) => {
    notices.push(item);
    try {
      onNotice?.(item);
    } catch {
      /* 通知失败不影响主流程 */
    }
  };

  const loopDeadline = startedMs + DEFAULT_LOOP_BUDGET_MS;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (signal?.aborted) throw new AppError(ERR.LLM_ABORTED, '任务已被取消。', { status: 499 });
    if (Date.now() > loopDeadline) {
      notice({
        level: 'warn',
        text: `工具调用累计耗时超过 ${Math.round(DEFAULT_LOOP_BUDGET_MS / 1000)} 秒，先停下来用现有信息继续。`,
      });
      break;
    }
    turns = turn;

    const res = await callModelRaw({
      messages,
      tools: specs.length ? specs : null,
      maxTokens,
      temperature,
      timeoutMs,
      signal,
      purpose,
      role,
      onNotice: (n) => {
        notices.push(n);
        try {
          onNotice?.(n);
        } catch {
          /* 忽略 */
        }
      },
      deps: opts.deps,
    });

    usage.promptTokens += res.usage?.promptTokens ?? 0;
    usage.completionTokens += res.usage?.completionTokens ?? 0;
    totalMs += res.ms ?? 0;
    attempts += res.attempts ?? 1;
    lastProvider = res.providerLabel ?? res.provider;
    lastModel = res.model;
    if (res.degraded) degraded = true;

    const toolCalls = (res.toolCalls ?? []).slice(0, maxToolCallsPerTurn);

    // ── 没有工具调用：这是最终答案 ──────────────────────────────
    if (!toolCalls.length) {
      finalText = res.text;
      break;
    }

    // 把模型的这条消息（含它请求的工具）记进历史。
    // 必须用原样的 assistantMessage，否则下一轮模型看不到自己请求过什么，
    // 会重复请求同一个工具 —— 这是最典型的工具循环 bug。
    messages.push(res.assistantMessage ?? { role: 'assistant', content: res.text ?? '' });

    // 如果模型一边调工具一边也说了话，先留着（最后一轮会用到）
    if (res.text?.trim()) finalText = res.text;

    // ── 执行工具 ────────────────────────────────────────────────
    const results = await Promise.all(
      toolCalls.map(async (call) => {
        const name = call?.function?.name ?? call?.name ?? 'unknown';
        const rawArgs = call?.function?.arguments ?? call?.arguments ?? '{}';
        const callId = call?.id ?? `call_${turn}_${name}`;

        // 通知 UI：「要用 X 了」
        let step = { turn, name, args: safeArgs(rawArgs), callId, status: 'running' };
        steps.push(step);
        try {
          onToolCall?.({ phase: 'start', ...step, jobId });
        } catch (err) {
          // 不静默：UI 回调抛异常会让我们以为"事件发了"，实际什么都没发生
          console.warn(`[tools] 通知工具开始失败：${String(err?.message ?? err)}`);
        }

        const result = await executeTool(name, rawArgs, { jobId, signal, role });

        step = {
          ...step,
          status: result.ok ? 'ok' : 'failed',
          ms: result.ms,
          // 只留摘要，不把整个网页塞进事件里（前端不需要，传了反而是负担）
          summary: summarize(result),
          error: result.ok ? undefined : redactSecrets(String(result.error ?? '')).slice(0, 300),
        };
        // 就地替换（steps 里那条是同一个对象引用的话就更新它）
        const idx = steps.findIndex((s) => s.callId === callId);
        if (idx >= 0) steps[idx] = step;
        try {
          onToolCall?.({ phase: 'end', ...step, jobId });
        } catch (err) {
          console.warn(`[tools] 通知工具结束失败：${String(err?.message ?? err)}`);
        }
        return { callId, name, result };
      }),
    );

    // 工具结果按**模型请求的顺序**塞回去（顺序错了一些模型会困惑）
    for (const { callId, result } of results) {
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: renderToolResult(result),
      });
    }

    // 走到最后一轮还在调工具：明确让它收尾，而不是硬截断
    if (turn === maxTurns) {
      messages.push({
        role: 'user',
        content:
          '（系统提示）工具调用次数已经用完了。请**基于你已经拿到的全部信息**，现在就给出最终结果，不要再请求任何工具。' +
          '如果有些信息没能核实，就在内容里如实说明哪一部分没能确认。',
      });
      const last = await callModelRaw({
        messages,
        tools: null, // 最后一轮不给工具，强制它输出正文
        maxTokens,
        temperature,
        timeoutMs,
        signal,
        purpose: `${purpose}:final`,
        role,
        deps: opts.deps,
      });
      usage.promptTokens += last.usage?.promptTokens ?? 0;
      usage.completionTokens += last.usage?.completionTokens ?? 0;
      totalMs += last.ms ?? 0;
      attempts += last.attempts ?? 1;
      finalText = last.text;
      degraded = degraded || Boolean(last.degraded);
      lastProvider = last.providerLabel ?? last.provider;
      lastModel = last.model;
    }
  }

  if (!finalText.trim()) {
    // 走到这里说明：模型一直在调工具，最后那轮强制收尾**也没写出正文**。
    // 但工具确实跑过（steps 里有记录），所以不要把"查到的过程"也一起丢掉 ——
    // 把轨迹拼成一段可读的说明交出去，比抛错更符合"成果优先"这个产品的立场。
    // （对抗性测试的思路：用户等了那么久，至少让他看到团队查了什么。）
    if (steps.length) {
      finalText = [
        '这次我查了一些东西，但没能整理成完整的回答。下面是我查到的过程，你可以据此再问一次：',
        '',
        ...steps.map(
          (s) =>
            `- 用「${s.name}」查了 ${JSON.stringify(s.args ?? {}).slice(0, 120)}` +
            `${s.status === 'ok' ? `，拿到了：${s.summary || '(有结果)'}` : `，但失败了：${s.error ?? '未知原因'}`}`,
        ),
      ].join('\n');
    } else {
      throw new AppError(
        ERR.LLM_EMPTY_RESPONSE,
        '模型没能写出结果。可以重试一次。',
        { status: 502 },
      );
    }
  }

  return {
    text: finalText,
    json: null, // 结构化输出由调用方用 repairJson 处理
    steps,
    usage,
    ms: Date.now() - startedMs,
    provider: lastProvider,
    model: lastModel,
    degraded,
    notices,
    attempts,
    turns,
    toolCount: steps.length,
  };
}

/** 参数摘要：事件里不能塞完整参数（可能很大），但也不能只剩个名字 */
function safeArgs(rawArgs) {
  try {
    const obj = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs;
    const out = {};
    for (const [k, v] of Object.entries(obj ?? {})) {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      out[k] = s && s.length > 120 ? `${s.slice(0, 120)}…` : s;
    }
    return out;
  } catch {
    return { _raw: String(rawArgs ?? '').slice(0, 120) };
  }
}

/** 工具结果摘要：给 UI 显示"拿到了什么" */
function summarize(result) {
  if (!result?.ok) return '';
  const text = String(result.text ?? '');
  const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}

/** 当前有几个工具可用（给健康检查和界面用） */
export function availableToolNames() {
  return listTools().map((t) => t.name);
}
