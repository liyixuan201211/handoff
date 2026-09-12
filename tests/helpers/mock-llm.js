/**
 * 测试用模型桩（mock LLM）。
 *
 * 为什么需要它：
 *   网关（src/llm/gateway.js）的价值全在「出错时怎么办」——重试、降级、JSON 抢救、超时。
 *   这些分支用真网络基本测不到（谁也不能让上游准时返回 500）。
 *   所以这里做一套**可控的、只吐预设响应**的 fetch 桩，断言它被调了几次、body 是什么。
 *
 * 纪律：
 *   1. 绝不打真网络。所有测试都必须注入本文件的桩。
 *   2. `sleep` 也要 mock 掉（真实退避会让测试等好几秒，还会 flaky）。
 *   3. 桩必须像真 fetch 一样**响应 init.signal**，否则超时/取消路径测不出来。
 */

/** 一个形态真实的假密钥。用于断言「密钥绝不泄漏」——刻意用真 key 的样子。 */
export const TEST_KEY = 'sk-test-not-a-real-key-000000000000';

/** OpenAI 兼容的成功响应体 */
export function completionBody(content, { promptTokens = 10, completionTokens = 20, finishReason = 'stop' } = {}) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

/** 造一个 fetch Response 形状的对象（够 gateway 用：ok/status/text()/json()） */
export function jsonResponse(body, { status = 200 } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
  };
}

/** 失败的 HTTP 响应（如 500 / 429 / 400） */
export function errorResponse(status, bodyText = 'upstream error') {
  return jsonResponse(bodyText, { status });
}

/** 让请求「永远不返回」，但响应 abort（模拟超时 / 用户取消） */
export function hangingFetch() {
  return (url, init = {}) =>
    new Promise((_resolve, reject) => {
      const signal = init.signal;
      const rejectAbort = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
      if (signal) {
        if (signal.aborted) rejectAbort();
        else signal.addEventListener('abort', rejectAbort, { once: true });
      }
    });
}

/**
 * 按脚本依次返回的 fetch 桩。
 *
 * @param {Array<object|Function>} script 每一项：
 *   - Response 形状对象 → 直接返回
 *   - 函数 (url, init, callIndex) => Response|Promise → 由它决定
 *   - 抛出的异常会原样抛出（模拟网络层错误）
 * @returns {{fetch:Function, calls:Array<{url:string, init:object, body:any, index:number}>, count:()=>number}}
 */
export function makeFetch(script) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const index = calls.length;
    const rawBody = init?.body;
    let parsedBody = null;
    try {
      parsedBody = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody ?? null;
    } catch {
      parsedBody = rawBody ?? null;
    }
    calls.push({ url, init, body: parsedBody, index });

    const step = Array.isArray(script) ? script[Math.min(index, script.length - 1)] : script;
    if (step === undefined) throw new Error(`mock fetch 脚本没有第 ${index + 1} 项`);
    if (typeof step === 'function') return step(url, init, index);
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetch, calls, count: () => calls.length };
}

/** 从记录下来的调用里取出 user 消息文本（断言「错误反馈有没有塞回去」用） */
export function userTextOf(call) {
  const messages = call?.body?.messages ?? [];
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  return typeof user === 'string' ? user : JSON.stringify(user);
}

/** 系统消息文本 */
export function systemTextOf(call) {
  const messages = call?.body?.messages ?? [];
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  return typeof system === 'string' ? system : JSON.stringify(system);
}

/** 记录 sleep 调用的桩：不真的等，但能断言「退避发生了、退避了多久」 */
export function makeSleep() {
  const waits = [];
  const sleep = async (ms, signal) => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    waits.push(ms);
  };
  sleep.waits = waits;
  sleep.total = () => waits.reduce((a, b) => a + b, 0);
  return sleep;
}

/** 两条 provider 的降级链，够覆盖「换 provider」的全部分支 */
export const TWO_STEP_CHAIN = [
  { provider: 'deepseek-official', model: 'deepseek-flash' },
  { provider: 'aiping', model: 'DeepSeek-V4-Flash' },
];

export const ONE_STEP_CHAIN = [{ provider: 'aiping', model: 'DeepSeek-V4-Flash' }];

/**
 * 组装一份「确定性」的注入依赖。
 * 测试里一定要用它，避免误打真网络或真的等待退避。
 */
export function makeDeps(overrides = {}) {
  const mock = overrides.fetchResult ?? makeFetch(overrides.script ?? [jsonResponse(completionBody('{"ok":true}'))]);
  const fetch = overrides.fetch ?? mock.fetch;
  const sleep = overrides.sleep ?? makeSleep();
  return {
    deps: {
      fetch,
      chain: overrides.chain ?? TWO_STEP_CHAIN,
      resolveKey: overrides.resolveKey ?? (() => ({ key: TEST_KEY, source: 'explicit' })),
      env: overrides.env ?? {},
      sleep,
      ...(overrides.keyOverrides ? { keyOverrides: overrides.keyOverrides } : {}),
      ...(overrides.extra ?? {}),
    },
    calls: mock.calls,
    count: mock.count,
    sleep,
  };
}

/** 一个最简 schema，够触发「结构校验 + 反馈重试」分支 */
export const TITLE_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string', minLength: 2 } },
};

/** 单属性 enum schema（不要加第二个属性，见 docs/reports/S8-QA.md 缺陷 #1） */
export const CONFIDENCE_SCHEMA = {
  type: 'object',
  required: ['confidence'],
  properties: { confidence: { type: 'string', enum: ['high', 'medium', 'low'] } },
};
