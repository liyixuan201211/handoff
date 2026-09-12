/**
 * 模型网关 —— 产品的心脏。
 *
 * 它存在的唯一理由：**普通人的任务不能因为一次网络抖动就失败。**
 * 所以这里有四层保护：超时、重试、降级链、JSON 抢救。
 *
 * 设计约束（来自 CONTRACT.md §4）：
 *  - 绝不在模块顶层读环境变量（测试要能注入）
 *  - 密钥绝不进入日志 / 错误信息 / 返回值
 *  - 所有对外抛出的错误都是 AppError，code 来自 ERR
 */
import { AppError, ERR, redactSecrets } from './errors.js';
import { PROVIDERS, resolveKey, resolveChain } from './providers.js';
import { repairJson } from './json-repair.js';
import { validate, coerce, describeEnumConstraints } from './schema-check.js';

/** 可注入依赖，默认走真实实现 —— 测试时替换 fetch / 密钥即可 */
const defaultDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  chain: null,
  resolveKey,
  env: process.env,
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) {
        const onAbort = () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    }),
};

const now = () => Date.now();

/** 计算退避时间：指数 + 抖动，避免多个任务同时重试打爆上游 */
export function backoffMs(attempt, base = 600, cap = 8000) {
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.round(exp * (0.7 + Math.random() * 0.6));
}

/** 哪些 HTTP 状态值得重试 */
const retriableStatus = (s) => s === 408 || s === 409 || s === 425 || s === 429 || s >= 500;

/**
 * 组合超时与外部取消信号。
 * 关键：必须能区分「超时」和「用户主动取消」，否则错误的提示会误导用户。
 */
function combineSignals(timeoutMs, externalSignal, timeoutFlag) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timeoutFlag.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => {
    timeoutFlag.aborted = true;
    controller.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.('abort', onExternalAbort);
    },
  };
}

function extractContent(json) {
  const choice = json?.choices?.[0];
  if (!choice) return '';
  const msg = choice.message ?? {};
  // 有些推理模型把内容放在 reasoning_content，正文为空 —— 那也算没结果
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (content.trim()) return content;
  // 兼容 content 为数组的多模态格式
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  }
  return '';
}

/**
 * 调用一次具体 provider（不含重试/降级）。
 * @returns {{text:string, usage:object, model:string, provider:string}}
 */
async function callOnce({
  providerId,
  model,
  system,
  user,
  maxTokens,
  temperature,
  timeoutMs,
  signal,
  deps,
  // 新增（工具循环用）：直接给完整 messages 和 tools，跳过 system/user 拼接
  messages: providedMessages = null,
  tools = null,
}) {
  const def = PROVIDERS[providerId];
  if (!def) throw new AppError(ERR.LLM_NO_PROVIDER, `未知的模型提供方：${providerId}`, { status: 502 });

  const resolved = deps.resolveKey(providerId, { env: deps.env, ...(deps.keyOverrides ?? {}) });
  if (!resolved) {
    throw new AppError(
      ERR.LLM_NO_PROVIDER,
      `没有找到 ${def.label} 的 API Key。可以在项目根目录的 .env 里填 ${def.apiKeyEnv[0]}。`,
      { status: 503 },
    );
  }

  let messages;
  if (Array.isArray(providedMessages)) {
    messages = providedMessages;
  } else {
    messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
  }

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  // 工具调用（OpenAI 兼容格式）。只在真的传了工具时才带上这个字段 ——
  // 有些上游对不认识的字段很敏感，不给它就不会有问题。
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const flag = { timedOut: false, aborted: false };
  const { signal: combined, cleanup } = combineSignals(timeoutMs, signal, flag);
  const started = now();

  let res;
  try {
    res = await deps.fetch(`${def.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.key}`,
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (cause) {
    cleanup();
    if (flag.aborted) {
      throw new AppError(ERR.LLM_ABORTED, '任务已被取消。', { status: 499, cause });
    }
    if (flag.timedOut) {
      throw new AppError(
        ERR.LLM_TIMEOUT,
        `模型响应超时（${Math.round(timeoutMs / 1000)} 秒）。`,
        { status: 504, cause },
      );
    }
    // 网络层错误：可重试
    throw new AppError(ERR.LLM_HTTP_ERROR, `连接模型服务失败：${redactSecrets(cause.message)}`, {
      status: 502,
      cause,
    });
  } finally {
    cleanup();
  }

  if (!res.ok) {
    const rawBody = await res.text().catch(() => '');
    const snippet = redactSecrets(rawBody).slice(0, 300);
    const err = new AppError(
      ERR.LLM_HTTP_ERROR,
      `${def.label} 返回了 ${res.status}：${snippet || '（空响应）'}`,
      { status: res.status >= 500 ? 502 : 400 },
    );
    err.httpStatus = res.status;
    err.retriable = retriableStatus(res.status);
    throw err;
  }

  let json;
  try {
    json = await res.json();
  } catch (cause) {
    throw new AppError(ERR.LLM_HTTP_ERROR, '模型返回的不是合法 JSON 响应。', {
      status: 502,
      cause,
    });
  }

  const text = extractContent(json);
  const usage = {
    promptTokens: json?.usage?.prompt_tokens ?? 0,
    completionTokens: json?.usage?.completion_tokens ?? 0,
  };

  const choice = json?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const finishReason = choice.finish_reason ?? 'unknown';

  // 工具调用是**合法且有内容**的返回，即使正文是空的。
  // 漏掉这一判断的话，模型每次决定调工具都会被我们当成"没返回正文"而重试 ——
  // 那工具功能就完全没法工作了。
  if (!text.trim() && toolCalls.length === 0) {
    // finish_reason=length 时也走这里，因为对我们来说就是没拿到东西
    throw new AppError(
      ERR.LLM_EMPTY_RESPONSE,
      `模型没有返回正文内容（finish_reason=${finishReason}）。`,
      { status: 502 },
    );
  }

  return {
    text,
    usage,
    model,
    provider: providerId,
    ms: now() - started,
    toolCalls,
    finishReason,
    // 原样的 assistant 消息：工具循环要把这条塞回对话历史。
    // 必须连 tool_calls 一起带上，否则下一轮模型看不到自己请求过什么。
    assistantMessage: {
      role: 'assistant',
      content: message.content ?? '',
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
  };
}

/**
 * 用给定的 messages + tools 走一遍「降级链 + 重试 + 时间预算」。
 *
 * 为什么要把这段抽出来：工具循环每一轮都是一次完整的模型调用，
 * 它同样需要重试和降级保护（不然一次网络抖动就毁掉整个工具流程）。
 * 但它的 messages 是**带工具结果的完整对话历史**，不能走 callModel 的
 * system+user 拼接路径。所以这里提供一个"原样传 messages"的入口。
 *
 * 注意：这个函数**不做** schema 校验和 JSON 抢救 —— 工具循环的每一轮
 * 需要的是"模型说了什么/要调什么工具"，结构化输出去外层做。
 *
 * @param {object} opts 见下
 * @returns {Promise<{text, toolCalls, assistantMessage, usage, ms, provider, model, degraded, notices, attempts, finishReason}>}
 */
export async function callModelRaw(opts) {
  const {
    messages,
    tools = null,
    maxTokens = 4000,
    temperature = 0.3,
    timeoutMs = Number(process.env.HANDOFF_LLM_TIMEOUT_MS) || 120000,
    signal = null,
    purpose = 'generic',
    role = '',
    onNotice = null,
    onToolTurn = null,
    deps: injectedDeps = null,
  } = opts ?? {};

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AppError(ERR.BAD_REQUEST, 'callModelRaw 需要非空的 messages 数组。', { status: 500 });
  }

  const deps = { ...defaultDeps, ...(injectedDeps ?? {}) };
  const chain = deps.chain ?? resolveChain(deps.env);

  const notices = [];
  const notice = (text, level = 'warn') => {
    const item = { level, text, purpose, role, at: now() };
    notices.push(item);
    try {
      onNotice?.(item);
    } catch {
      /* 通知失败不影响主流程 */
    }
  };

  const budgetMs = opts.budgetMs ?? Math.max(90_000, timeoutMs * 2);
  const deadline = now() + budgetMs;
  let lastError = null;
  let attemptsMade = 0;
  let budgetExhausted = false;
  const totalUsage = { promptTokens: 0, completionTokens: 0 };
  let totalMs = 0;

  for (let ci = 0; ci < chain.length; ci += 1) {
    const step = chain[ci];
    const MAX_ATTEMPTS = 2;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) throw new AppError(ERR.LLM_ABORTED, '任务已被取消。', { status: 499 });
      if (now() >= deadline) {
        budgetExhausted = true;
        break;
      }
      attemptsMade += 1;

      try {
        onToolTurn?.({ phase: 'request', provider: step.provider, model: step.model, attempt });
        const res = await callOnce({
          providerId: step.provider,
          model: step.model,
          messages,
          tools,
          maxTokens,
          temperature,
          timeoutMs,
          signal,
          deps,
        });
        totalMs += res.ms;
        totalUsage.promptTokens += res.usage.promptTokens;
        totalUsage.completionTokens += res.usage.completionTokens;

        return {
          text: res.text,
          toolCalls: res.toolCalls ?? [],
          finishReason: res.finishReason,
          assistantMessage: res.assistantMessage,
          usage: res.usage,
          ms: res.ms,
          provider: res.provider,
          providerLabel: PROVIDERS[res.provider]?.label ?? res.provider,
          model: res.model,
          degraded: ci > 0,
          notices,
          attempts: attemptsMade,
        };
      } catch (err) {
        if (err?.code === ERR.LLM_ABORTED) throw err;
        // 空正文在工具场景下可能是"模型只想调工具但格式坏了"，
        // 换一家 provider 往往就好 —— 所以这里也允许重试/降级。
        lastError = err;
        if (err?.retriable === false && err?.code !== ERR.LLM_EMPTY_RESPONSE) break;
        if (attempt < MAX_ATTEMPTS) {
          const wait = backoffMs(attempt);
          notice(`${PROVIDERS[step.provider]?.label ?? step.provider} 这次没成功，${Math.round(wait / 1000)} 秒后重试。`);
          try {
            await deps.sleep(wait, signal);
          } catch {
            throw new AppError(ERR.LLM_ABORTED, '任务已被取消。', { status: 499 });
          }
        }
      }
    }

    if (ci < chain.length - 1) {
      notice(`切换到备用模型继续（${PROVIDERS[chain[ci + 1].provider]?.label ?? chain[ci + 1].provider}）。`);
    }
  }

  const detail = lastError?.message ? redactSecrets(lastError.message) : '未知原因';
  const err = new AppError(
    budgetExhausted ? ERR.LLM_TIMEOUT : ERR.LLM_NO_PROVIDER,
    budgetExhausted
      ? `这一步花了太久（超过 ${Math.round(budgetMs / 1000)} 秒）还没拿到结果。最后一次的原因：${detail}`
      : `所有模型都没能完成任务。最后一次的失败原因：${detail}`,
    { status: budgetExhausted ? 504 : 503, cause: lastError },
  );
  err.attempts = attemptsMade;
  err.usage = totalUsage;
  err.ms = totalMs;
  if (lastError?.raw !== undefined) err.raw = lastError.raw;
  if (lastError?.details !== undefined) err.details = lastError.details;
  throw err;
}

/**
 * 对整条降级链执行一次逻辑调用。
 * @returns 见 CONTRACT.md §4
 */
export async function callModel(opts) {
  const {
    system = '',
    user = '',
    schema = null,
    maxTokens = 4000,
    temperature = 0.3,
    timeoutMs = Number(process.env.HANDOFF_LLM_TIMEOUT_MS) || 120000,
    signal = null,
    purpose = 'generic',
    role = '',
    onNotice = null,
  } = opts ?? {};

  if (typeof system !== 'string' || typeof user !== 'string') {
    throw new AppError(ERR.BAD_REQUEST, 'callModel 的 system/user 必须是字符串。', { status: 500 });
  }

  const deps = { ...defaultDeps, ...(opts.deps ?? {}) };
  const chain = deps.chain ?? resolveChain(deps.env);

  // 把 schema 里的**全部**硬性约束直接写进提示词。实测这比任何「请严格遵守格式」都管用：
  // 模型对**具体字段名、具体可选取值、具体长度范围**很敏感，对抽象格式要求不敏感。
  let effectiveSystem = system;
  if (schema) {
    const constraints = describeEnumConstraints(schema);
    effectiveSystem = `${system}\n\n<格式要求>\n你的回答必须是一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。\n${constraints
      .map((c) => `- ${c}`)
      .join('\n')}\n</格式要求>`;
  }

  const notices = [];
  const notice = (text, level = 'warn') => {
    const item = { level, text, purpose, role, at: now() };
    notices.push(item);
    try {
      onNotice?.(item);
    } catch {
      /* 通知失败不能影响主流程 */
    }
  };

  let lastError = null;
  let totalMs = 0;
  const totalUsage = { promptTokens: 0, completionTokens: 0 };
  let attemptsMade = 0;

  /**
   * 时间预算：整条链的**总**墙钟时间上限。
   *
   * 为什么必须有：普通人不会盯着一个卡住的页面看 15 分钟，他们会关掉然后觉得
   * "这破玩意没用"。所以宁可少试几个模型，也要保证一个阶段在有限时间内出结果。
   * 默认 = 单次超时 × 2，最少 90 秒。
   */
  const budgetMs = opts.budgetMs ?? Math.max(90_000, timeoutMs * 2);
  const deadline = now() + budgetMs;
  let budgetExhausted = false;

  for (let ci = 0; ci < chain.length; ci += 1) {
    const step = chain[ci];

    // provider 级尝试：首次 + 1 次重试。再多就是拿用户的时间赌运气了。
    const MAX_ATTEMPTS = 2;
    let schemaRetryUsed = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) {
        throw new AppError(ERR.LLM_ABORTED, '任务已被取消。', { status: 499 });
      }
      if (now() >= deadline) {
        budgetExhausted = true;
        break;
      }
      attemptsMade += 1;
      let userContent = user;
      // 结构化输出：第一次因 schema 失败后，把具体错误反馈回去，让模型自己改
      if (schemaRetryUsed && lastError?.details) {
        userContent = `${user}\n\n<系统反馈>\n你上一次的输出结构不符合要求，请修正后重新输出完整 JSON。具体问题：\n${lastError.details
          .slice(0, 12)
          .map((d) => `- ${d.path}: ${d.message}`)
          .join('\n')}\n</系统反馈>`;
      }

      try {
        const res = await callOnce({
          providerId: step.provider,
          model: step.model,
          system: effectiveSystem,
          user: userContent,
          maxTokens,
          temperature,
          timeoutMs,
          signal,
          deps,
        });

        totalMs += res.ms;
        totalUsage.promptTokens += res.usage.promptTokens;
        totalUsage.completionTokens += res.usage.completionTokens;

        let json = null;
        if (schema) {
          const repaired = repairJson(res.text);
          if (!repaired.ok) {
            const e = new AppError(
              ERR.LLM_JSON_INVALID,
              `模型返回的内容无法解析成 JSON（${repaired.error}）。`,
              { status: 502 },
            );
            e.raw = repaired.raw.slice(0, 2000);
            lastError = e;
            if (attempt < MAX_ATTEMPTS) {
              notice(`第 ${attempt} 次输出不是合法 JSON，正在重试…`);
              await deps.sleep(backoffMs(attempt, 300), signal);
              continue;
            }
            break; // 换下一个 provider
          }
          json = repaired.value;
          // 先尝试语义收敛：把 "0.95" 这类「意思对、格式不听话」的值救回来。
          // 这一步能大幅降低「模型其实答对了但我们判它失败」的概率。
          // ⚠️ 用 coerce() 而不是 coerceInPlace()：后者在新签名下总是返回哨兵 NO_MATCH
          // （真值），直接 if 判断会导致**每次结构化调用都谎报"已修正"**。
          // 这是 QA 登记的缺陷 #6，改动前请先跑 tests/unit/gateway.test.js。
          const { changed } = coerce(json, schema);
          if (changed) {
            notice('已自动修正模型输出中的个别格式偏差（例如把 0.95 归一为 high）。', 'info');
          }
          const errors = validate(json, schema);
          if (errors.length) {
            const e = new AppError(
              ERR.LLM_SCHEMA_INVALID,
              `模型输出的结构不符合要求：${errors
                .slice(0, 5)
                .map((d) => `${d.path} ${d.message}`)
                .join('；')}`,
              { status: 502 },
            );
            e.details = errors;
            lastError = e;
            if (!schemaRetryUsed) {
              schemaRetryUsed = true;
              notice('模型输出结构有偏差，已把问题反馈给它并要求重做一次。');
              continue;
            }
            break; // 换下一个 provider
          }
        }

        return {
          text: res.text,
          json,
          usage: res.usage,
          ms: res.ms,
          provider: res.provider,
          providerLabel: PROVIDERS[res.provider]?.label ?? res.provider,
          model: res.model,
          degraded: ci > 0,
          notices,
          attempts: attemptsMade,
        };
      } catch (err) {
        // 用户取消：立刻抛出，绝不重试
        if (err?.code === ERR.LLM_ABORTED) throw err;

        // ⚠️ 这里曾经写的是 `err?.retriable === false || err?.status === 400`。
        // 问题是：429（限流）在构造 AppError 时被归一成 `status: 400`
        //（见 callOnce 里 `status: res.status >= 500 ? 502 : 400`），
        // 于是**明明标了 retriable=true 的 429 还是被第一个条件放行成了"不可重试"**。
        // 而 429 恰恰是最该重试的一种失败 —— 上游只是让我们慢一点。
        // 用户看到的就是"重试一下就好"的场景直接失败。
        //
        // 修法：只信 `retriable`，不再拿归一化过的 status 当判据。
        // `retriable` 由 retriableStatus() 依据**真实 HTTP 状态码**算出，是权威的。
        if (err?.retriable === false) {
          lastError = err;
          break;
        }
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          const wait = backoffMs(attempt);
          notice(`${PROVIDERS[step.provider]?.label ?? step.provider} 这次没成功，${Math.round(wait / 1000)} 秒后重试（第 ${attempt}/${MAX_ATTEMPTS - 1} 次重试）。`);
          try {
            await deps.sleep(wait, signal);
          } catch {
            throw new AppError(ERR.LLM_ABORTED, '任务已被取消。', { status: 499 });
          }
        }
      }
    }

    if (ci < chain.length - 1) {
      notice(`切换到备用模型继续（${PROVIDERS[chain[ci + 1].provider]?.label ?? chain[ci + 1].provider}）。`);
    }
  }

  if (budgetExhausted) {
    const detail = lastError?.message ? redactSecrets(lastError.message) : '模型一直没能按要求的格式作答';
    const err = new AppError(
      ERR.LLM_TIMEOUT,
      `这一步花了太久（超过 ${Math.round(budgetMs / 1000)} 秒）还没拿到可用结果，已经先停下来，免得你一直等。最后一次的原因：${detail}`,
      { status: 504, cause: lastError },
    );
    err.attempts = attemptsMade;
    err.usage = totalUsage;
    err.ms = totalMs;
    err.budgetExhausted = true;
    throw err;
  }

  /**
   * ⚠️ 保留**具体**的失败原因，而不是一律说成 LLM_NO_PROVIDER。
   *
   * 为什么重要（缺陷 #3）：整条链都没成功时，我们习惯性抛 LLM_NO_PROVIDER
   * （"所有模型都没连上"）。但真实原因常常是**别的东西**：
   *   · 全部超时 → 该说的是「模型想得太久了」
   *   · 全部返回无法解析的内容 → 该说的是「模型答得乱七八糟」
   * 把它们都说成"连不上"，前端翻译表就白做了 —— 用户会去检查网络和 API Key，
   * 而其实网络和 Key 都是好的。**指错排查方向比不给方向更糟。**
   *
   * 规则：链上所有失败都是同一个 code 时，就用那个 code；
   *      否则（失败原因不一致）才退回 LLM_NO_PROVIDER。
   */
  const meaningful =
    lastError?.code && lastError.code !== ERR.LLM_NO_PROVIDER ? lastError.code : null;

  const detail = lastError?.message ? redactSecrets(lastError.message) : '未知原因';
  const headline = meaningful
    ? `${PROVIDERS[chain[0]?.provider]?.label ?? '模型'} 这次没能给出结果。原因：${detail}`
    : `所有模型都没能完成任务。最后一次的失败原因：${detail}`;

  const finalErr = new AppError(meaningful ?? ERR.LLM_NO_PROVIDER, headline, {
    status: meaningful === ERR.LLM_TIMEOUT ? 504 : 503,
    cause: lastError,
  });

  // 把内层错误的**诊断信息**搬到外层。
  // 这些不是给用户看的，是给排障和测试用的：
  //   · raw：模型原文（JSON 修复失败时最有用，能看出它到底写了什么）
  //   · details：结构校验逐条失败的原因
  //   · attempts：一共试了几次
  // 不搬的话，外层错误只剩一句包装文案，出了问题无从下手。
  if (lastError?.raw !== undefined) finalErr.raw = lastError.raw;
  if (lastError?.details !== undefined) finalErr.details = lastError.details;
  finalErr.attempts = attemptsMade;
  finalErr.usage = totalUsage;
  finalErr.ms = totalMs;
  throw finalErr;
}

export const __internals = { callOnce, extractContent, combineSignals, defaultDeps };
