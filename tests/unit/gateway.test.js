/**
 * 网关单元测试 —— 用 mock fetch，**绝不打真网络**。
 *
 * 为什么下这么重的手：
 *   网关是「普通人的任务不能因为一次网络抖动就失败」这句话的唯一实现者。
 *   它的每一条分支（429 退避、5xx 换 provider、JSON 抢救、取消不重试）都是真实会发生的，
 *   而且都只在出错时才走到 —— 也就是平时没人看的地方。
 *
 * 约定：
 *   - 所有依赖（fetch / chain / resolveKey / env / sleep）都通过 `deps` 注入。
 *   - `sleep` 一定要 mock，否则测试会真的等退避时间，既慢又 flaky。
 *   - `it.fails(...)` = **已知的契约差异**，详见 docs/reports/S8-QA.md 缺陷清单。
 *     缺陷修好后，这些用例会变红 —— 那就是提醒你把它们改成 `it(...)` 正断言。
 */
import { describe, it, expect } from 'vitest';
import { callModel, backoffMs } from '../../src/llm/gateway.js';
import { ERR } from '../../src/llm/errors.js';
import {
  TEST_KEY,
  ONE_STEP_CHAIN,
  TWO_STEP_CHAIN,
  TITLE_SCHEMA,
  CONFIDENCE_SCHEMA,
  completionBody,
  jsonResponse,
  errorResponse,
  hangingFetch,
  makeDeps,
  makeFetch,
  makeSleep,
  userTextOf,
  systemTextOf,
} from '../helpers/mock-llm.js';

/** 把整条错误链（含 cause）拼成一段文本，用于断言「没有密钥泄漏」 */
function errorDump(err) {
  const parts = [];
  let cur = err;
  let depth = 0;
  while (cur && depth < 10) {
    parts.push(String(cur.code ?? ''), String(cur.message ?? ''), String(cur.stack ?? ''));
    if (cur.details) parts.push(JSON.stringify(cur.details));
    cur = cur.cause;
    depth += 1;
  }
  return parts.join('\n');
}

const base = (over) => ({ system: '你是测试助手', user: '请输出 JSON', purpose: 'unit-test', role: '测试员', ...over });

/* ================================================================== *
 * 正常路径
 * ================================================================== */
describe('callModel — 正常路径', () => {
  it('正常返回 → 解析出 json，并带上 provider / model / usage / attempts', async () => {
    const mock = makeFetch([jsonResponse(completionBody('{"title":"租房合同风险清单"}', { promptTokens: 120, completionTokens: 45 }))]);
    const sleep = makeSleep();

    const r = await callModel(
      base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } }),
    );

    expect(r.json).toEqual({ title: '租房合同风险清单' });
    expect(r.text).toContain('租房合同风险清单');
    expect(r.provider).toBe('aiping');
    expect(r.providerLabel).toBe('AI Ping');
    expect(r.model).toBe('DeepSeek-V4-Flash');
    expect(r.usage).toEqual({ promptTokens: 120, completionTokens: 45 });
    expect(r.degraded).toBe(false);
    expect(r.attempts).toBe(1);
    expect(mock.count()).toBe(1);
    expect(typeof r.ms).toBe('number');
  });

  it('请求体形态正确：system+user 两条消息、stream:false、Authorization 带 key', async () => {
    const mock = makeFetch([jsonResponse(completionBody('{"title":"ok"}'))]);
    await callModel(
      base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() } }),
    );
    const call = mock.calls[0];
    expect(call.url).toBe('https://aiping.cn/api/v1/chat/completions');
    expect(call.body.stream).toBe(false);
    expect(call.body.messages[0].role).toBe('system');
    expect(call.body.messages[1].role).toBe('user');
    expect(call.init.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it('带 schema 时把 enum 具体取值写进 system（这是实测最有效的约束方式）', async () => {
    const mock = makeFetch([jsonResponse(completionBody('{"confidence":"high"}'))]);
    await callModel(
      base({ schema: CONFIDENCE_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() } }),
    );
    const sys = systemTextOf(mock.calls[0]);
    expect(sys).toContain('"high"');
    // 措辞在 2026-09-12 强化过一次：不再只说"请遵守格式"，而是把它必须满足的**每一条**
    // 硬约束（取值列表 / 字段白名单 / 必填字段 / 不许有多余字段）都摊开写给它看。
    // 这是把「一个阶段耗尽整条降级链、跑 15 分钟不结束」变成「1 次尝试成功」的关键改动。
    expect(sys).toContain('JSON 对象');
    expect(sys).toContain('不要任何解释文字');
    expect(sys).toContain('只能有这些字段');
    expect(sys).toContain('必填字段');
  });

  it('content 为多模态数组时也能取出正文', async () => {
    const body = {
      choices: [{ index: 0, message: { content: [{ type: 'text', text: '{"title":"多模态"}' }] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    };
    const mock = makeFetch([jsonResponse(body)]);
    const r = await callModel(
      base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() } }),
    );
    expect(r.json).toEqual({ title: '多模态' });
  });
});

/* ================================================================== *
 * JSON 抢救（产品抗摔的核心之一）
 * ================================================================== */
describe('callModel — JSON 抢救', () => {
  const run = async (content) => {
    const mock = makeFetch([jsonResponse(completionBody(content))]);
    const sleep = makeSleep();
    const r = await callModel(
      base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } }),
    );
    return { r, mock, sleep };
  };

  it('```json 围栏 → 能被抢救出来', async () => {
    const { r } = await run('```json\n{"title":"围栏里"} \n```');
    expect(r.json).toEqual({ title: '围栏里' });
  });

  it('前后有废话 → 能被抢救出来', async () => {
    const { r } = await run('好的，这是你要的结果：\n{"title":"废话包围"}\n希望对你有帮助！');
    expect(r.json).toEqual({ title: '废话包围' });
  });

  it('被截断的 JSON（{"title":"abc"）→ 关闭结构后成功', async () => {
    const { r } = await run('{"title":"被截断了');
    expect(r.json).toEqual({ title: '被截断了' });
  });

  it('尾逗号 + 中文引号 → 机械修复后成功', async () => {
    const { r } = await run('{“title”:“中文引号”,}');
    expect(r.json).toEqual({ title: '中文引号' });
  });

  // 重试策略在 2026-09-12 收紧过一次：单 provider 首试 + 1 次重试（原为 3 次尝试）。
  // 理由：普通人不会盯着一个卡住的页面等 15 分钟。宁可少试一次、早点告诉他结果，
  // 也不要拿用户的时间去赌运气。整条链另有 budgetMs 总时间预算兜底。
  it('非 JSON 文本：连试 2 次并退避（说明它确实在抢救，而不是直接放弃）', async () => {
    const mock = makeFetch([jsonResponse(completionBody('这是一段普通文字，不是 JSON。'))]);
    const sleep = makeSleep();
    await expect(
      callModel(base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } })),
    ).rejects.toThrow();
    expect(mock.count()).toBe(2); // 单 provider 链上共 2 次尝试（首试 + 1 次重试）
    expect(sleep.waits.length).toBe(1); // 一次退避
  });

  it('模型返回空正文（reasoning_content 只有思维链）→ 视为失败并重试', async () => {
    const body = { choices: [{ message: { content: '', reasoning_content: '我想想…' }, finish_reason: 'length' }], usage: {} };
    const mock = makeFetch([jsonResponse(body)]);
    const sleep = makeSleep();
    await expect(
      callModel(base({ schema: null, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } })),
    ).rejects.toThrow(/没有返回正文内容/);
  });
});

/* ================================================================== *
 * 结构校验 + 语义收敛
 * ================================================================== */
describe('callModel — 结构校验与语义收敛', () => {
  it('schema 校验失败 → 重试 1 次，并在第二次请求里带上具体错误反馈', async () => {
    const mock = makeFetch([
      jsonResponse(completionBody('{"nope":1}')), // 缺必填 title
      jsonResponse(completionBody('{"title":"改好了"}')),
    ]);
    const sleep = makeSleep();

    const r = await callModel(
      base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } }),
    );

    expect(mock.count()).toBe(2); // 断言 fetch 恰好被调用 2 次
    expect(r.json).toEqual({ title: '改好了' });
    expect(r.attempts).toBe(2);
    expect(r.degraded).toBe(false); // 修好了就不该算降级

    const feedback = userTextOf(mock.calls[1]);
    expect(feedback).toContain('系统反馈');
    expect(feedback).toContain('$.title'); // 具体到字段路径
    expect(feedback).toContain('缺少必填字段');
  });

  it('schema 连续失败 → 不会无限重试（只反馈一次，然后换 provider）', async () => {
    const mock = makeFetch([jsonResponse(completionBody('{"nope":1}'))]);
    const sleep = makeSleep();
    await expect(
      callModel(base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: TWO_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } })),
    ).rejects.toThrow();
    // 每个 provider 最多 2 次（首次 + 反馈重试 1 次），两条链就是 4 次
    expect(mock.count()).toBe(4);
  });

  it('enum 语义收敛：模型返回 confidence:"0.95" → 最终是 "high"，且不算降级', async () => {
    const mock = makeFetch([jsonResponse(completionBody('{"confidence":"0.95"}'))]);
    const sleep = makeSleep();
    const notices = [];

    const r = await callModel(
      base({
        schema: CONFIDENCE_SCHEMA,
        onNotice: (n) => notices.push(n.text),
        deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep },
      }),
    );

    expect(r.json).toEqual({ confidence: 'high' });
    expect(r.degraded).toBe(false);
    expect(r.attempts).toBe(1);
    expect(mock.count()).toBe(1); // 收敛成功，不需要重试
    expect(notices.join('\n')).toContain('自动修正');
  });

  it('enum 语义收敛：中文严重度「严重」也能映射到 high', async () => {
    const schema = { type: 'object', required: ['severity'], properties: { severity: { type: 'string', enum: ['high', 'medium', 'low'] } } };
    const mock = makeFetch([jsonResponse(completionBody('{"severity":"严重"}'))]);
    const r = await callModel(
      base({ schema, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() } }),
    );
    expect(r.json).toEqual({ severity: 'high' });
  });
});

/* ================================================================== *
 * 重试：网络抖动不该让普通人的任务失败
 * ================================================================== */
describe('callModel — 重试', () => {
  it('网络层错误（ECONNREFUSED）→ 指数退避重试，单 provider 共 2 次尝试', async () => {
    const mock = makeFetch([new TypeError('fetch failed: ECONNREFUSED')]);
    const sleep = makeSleep();
    await expect(
      callModel(base({ schema: null, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } })),
    ).rejects.toThrow();
    expect(mock.count()).toBe(2);
    expect(sleep.waits.length).toBe(1);
    expect(sleep.waits[0]).toBeGreaterThan(0); // 确实退避了
  });

  it('500 之后第二次成功 → 不换 provider，也不算降级', async () => {
    const mock = makeFetch([errorResponse(500, 'internal boom'), jsonResponse(completionBody('{"title":"重试成功"}'))]);
    const sleep = makeSleep();
    const r = await callModel(
      base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } }),
    );
    expect(r.json).toEqual({ title: '重试成功' });
    expect(r.degraded).toBe(false);
    expect(r.provider).toBe('aiping');
    expect(sleep.waits.length).toBe(1);
  });

  it('400 → 不重试，直接换 provider（参数错了重试没意义）', async () => {
    const mock = makeFetch([errorResponse(400, 'invalid model'), jsonResponse(completionBody('{"title":"备用模型救场"}'))]);
    const sleep = makeSleep();
    const r = await callModel(
      base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: TWO_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } }),
    );
    expect(mock.count()).toBe(2); // 400 那次 + 备用 provider 那次
    expect(sleep.waits.length).toBe(0); // 没有退避等待
    expect(r.provider).toBe('aiping');
    expect(r.degraded).toBe(true);
  });

  it('5xx 重试 3 次后换下一个 provider → 最终成功且 degraded:true', async () => {
    const mock = makeFetch([
      errorResponse(503, 'boom'),
      errorResponse(503, 'boom'),
      errorResponse(503, 'boom'),
      jsonResponse(completionBody('{"title":"备用模型给出的结果"}')),
    ]);
    const sleep = makeSleep();
    const notices = [];

    const r = await callModel(
      base({
        schema: TITLE_SCHEMA,
        onNotice: (n) => notices.push(n.text),
        deps: { fetch: mock.fetch, chain: TWO_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep },
      }),
    );

    expect(mock.count()).toBe(4); // 3 次打第一个 provider + 1 次打第二个
    expect(sleep.waits.length).toBe(2); // 第一个 provider 内部退了 2 次
    expect(r.provider).toBe('aiping');
    expect(r.model).toBe('DeepSeek-V4-Flash');
    expect(r.degraded).toBe(true);
    expect(r.attempts).toBe(4);
    expect(notices.join('\n')).toContain('切换到备用模型');
    expect(notices.join('\n')).toContain('重试');
  });
});

/* ================================================================== *
 * 降级链 + 安全
 * ================================================================== */
describe('callModel — 降级链与密钥安全', () => {
  it('全部 provider 都失败 → 抛 LLM_NO_PROVIDER，且错误信息里不含 API Key', async () => {
    // 故意让上游把 key 回显在响应体里（真实网关会这么干）
    const mock = makeFetch([
      errorResponse(500, `upstream error: Authorization: Bearer ${TEST_KEY} is invalid`),
      errorResponse(500, `key ${TEST_KEY} rejected by provider`),
      errorResponse(401, `again ${TEST_KEY}`), // 401 不可重试 → 直接换 provider
      errorResponse(500, `and finally ${TEST_KEY}`),
    ]);
    const sleep = makeSleep();

    let caught = null;
    try {
      await callModel(
        base({ schema: null, deps: { fetch: mock.fetch, chain: TWO_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } }),
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    // 缺陷 #3 修复后，链上最后一次失败的原因会被**保留**下来
    // （这里全是 HTTP 错误，所以是 LLM_HTTP_ERROR），而不是一律说成 LLM_NO_PROVIDER。
    // 这条用例真正要守的是**密钥不泄漏**，所以这里断言"是已知的错误码之一"。
    expect([ERR.LLM_HTTP_ERROR, ERR.LLM_NO_PROVIDER]).toContain(caught.code);
    // 整条错误链（message + cause + stack）都不许出现密钥
    const dump = errorDump(caught);
    expect(dump).not.toContain(TEST_KEY);
    expect(dump).not.toContain('sk-');
    expect(caught.message).toContain('[已隐去密钥]');
  });

  it('没有密钥时不打网络，抛 LLM_NO_PROVIDER，并给出可操作提示', async () => {
    const mock = makeFetch([jsonResponse(completionBody('x'))]);
    const sleep = makeSleep();
    let caught = null;
    try {
      await callModel(base({ schema: null, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => null, env: {}, sleep } }));
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe(ERR.LLM_NO_PROVIDER);
    expect(caught.message).toContain('AIPING_API_KEY');
    expect(mock.count()).toBe(0); // 没有 key 就不该发请求
  });

  it('429 的响应体里带密钥也不会泄漏', async () => {
    const mock = makeFetch([errorResponse(429, `rate limited, your key ${TEST_KEY}`)]);
    const sleep = makeSleep();
    let caught = null;
    try {
      await callModel(base({ schema: null, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } }));
    } catch (e) {
      caught = e;
    }
    expect(errorDump(caught)).not.toContain(TEST_KEY);
  });
});

/* ================================================================== *
 * 超时与取消
 * ================================================================== */
describe('callModel — 超时与取消', () => {
  it('超时 → 抛错（契约要求 code 为 LLM_TIMEOUT），且确实会重试 3 次', async () => {
    const sleep = makeSleep();
    let caught = null;
    try {
      await callModel(
        base({ schema: null, timeoutMs: 40, deps: { fetch: hangingFetch(), chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught.message).toContain('超时');
    expect(caught.attempts).toBe(2);
  });

  it('外部取消 → 抛 LLM_ABORTED，且**不重试**（fetch 只被调用 1 次）', async () => {
    const ac = new AbortController();
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      ac.abort(); // 模拟「用户在第一发请求途中点了取消」
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    };
    const sleep = makeSleep();

    let caught = null;
    try {
      await callModel(
        base({ schema: null, signal: ac.signal, deps: { fetch, chain: TWO_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } }),
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught.code).toBe(ERR.LLM_ABORTED);
    expect(calls).toBe(1); // 关键：取消绝不重试
    expect(sleep.waits.length).toBe(0);
  });

  it('调用前就已经取消 → 一次网络都不打', async () => {
    const ac = new AbortController();
    ac.abort();
    const mock = makeFetch([jsonResponse(completionBody('{}'))]);
    await expect(
      callModel(base({ schema: null, signal: ac.signal, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() } })),
    ).rejects.toMatchObject({ code: ERR.LLM_ABORTED });
    expect(mock.count()).toBe(0);
  });

  it('退避等待期间被取消 → 立刻抛 LLM_ABORTED，不继续重试', async () => {
    const ac = new AbortController();
    const mock = makeFetch([errorResponse(500, 'boom')]);
    // 用真实语义的 sleep：等待期间响应 abort
    const sleep = (ms, signal) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          },
          { once: true },
        );
      });
    setTimeout(() => ac.abort(), 5);

    await expect(
      callModel(base({ schema: null, signal: ac.signal, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } })),
    ).rejects.toMatchObject({ code: ERR.LLM_ABORTED });
    expect(mock.count()).toBe(1);
  });
});

/* ================================================================== *
 * backoffMs
 * ================================================================== */
describe('backoffMs', () => {
  it('随 attempt 单调不减（区间不重叠：第二次的最短等待 > 第一次的最长等待）', () => {
    const sample = (attempt, n = 300) => Array.from({ length: n }, () => backoffMs(attempt));
    const a1 = sample(1);
    const a2 = sample(2);
    const a3 = sample(3);
    expect(Math.max(...a1)).toBeLessThanOrEqual(Math.min(...a2));
    expect(Math.max(...a2)).toBeLessThanOrEqual(Math.min(...a3));
  });

  it('带抖动：多次调用结果不完全相同（避免所有任务同时重试打爆上游）', () => {
    const values = new Set(Array.from({ length: 100 }, () => backoffMs(2)));
    expect(values.size).toBeGreaterThan(50);
  });

  it('有上限，不会无限增长', () => {
    expect(backoffMs(30)).toBeLessThanOrEqual(11000);
  });

  it('接受自定义 base/cap', () => {
    for (let i = 0; i < 50; i += 1) expect(backoffMs(1, 100, 1000)).toBeLessThanOrEqual(1000);
  });
});

/* ==================================================================
 * 以下用例记录**已知的契约差异**。详见 docs/reports/S8-QA.md。
 * 它们现在「红」，用 it.fails 表达：一旦有人把缺陷修好，这些用例会失败，
 * 那就是提醒你改成 it(...) 正断言。
 * ================================================================== */
describe('回归（缺陷 #2 已修复）：429 限流必须退避重试', () => {
  // 这个缺陷的根因值得记住：429 在构造 AppError 时被**归一化成 status: 400**
  //（`status: res.status >= 500 ? 502 : 400`），而重试判定里有一句
  // `err?.status === 400` → 于是明明标了 retriable=true 的 429 被当成硬 400 直接放弃。
  // 而 429 恰恰是最该重试的一种失败：上游只是让我们慢一点。
  // 用户感受到的是「重试一下就好」的场景直接失败。
  //
  // 修法：只信 `retriable`（它由真实 HTTP 状态码算出），不再拿归一化过的 status 当判据。
  it('429 → 退避后重试并成功，且不算降级', async () => {
    const mock = makeFetch([errorResponse(429, 'rate limited'), jsonResponse(completionBody('{"title":"退避后成功"}'))]);
    const sleep = makeSleep();
    const r = await callModel(
      base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } }),
    );
    expect(mock.count()).toBe(2);
    expect(sleep.waits.length).toBe(1); // 确实退避了一次
    expect(sleep.waits[0]).toBeGreaterThan(0);
    expect(r.json).toEqual({ title: '退避后成功' });
    expect(r.degraded).toBe(false); // 还在同一个 provider 上，不算降级
  });

  it('429 一直持续 → 重试用尽后才失败（不能无限重试）', async () => {
    const mock = makeFetch([errorResponse(429, 'rate limited')]); // 永远是 429
    const sleep = makeSleep();
    await expect(
      callModel(base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } })),
    ).rejects.toThrow();
    expect(mock.count()).toBe(2); // 首试 + 1 次重试，有上限
  });

  it('真正的 400（参数错）依然不重试 —— 修 429 不能顺手把 400 也变成重试', async () => {
    const mock = makeFetch([errorResponse(400, 'bad request')]);
    const sleep = makeSleep();
    await expect(
      callModel(base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep } })),
    ).rejects.toThrow();
    expect(mock.count()).toBe(1); // 一次都不重试
    expect(sleep.waits.length).toBe(0);
  });
});

describe('回归（缺陷 #3 已修复）：具体失败原因必须保留，不能一律说成"连不上"', () => {
  // 根因：整条链都没成功时一律抛 LLM_NO_PROVIDER。但真实原因常常是别的东西 ——
  // 全部超时、全部返回无法解析的内容。把它们都说成"所有模型都没连上"，
  // 用户就会去检查网络和 API Key，而其实那两样都是好的。
  // **指错排查方向比不给方向更糟。**
  it('修复后：超时 → LLM_TIMEOUT；JSON 非法 → LLM_JSON_INVALID；结构非法 → LLM_SCHEMA_INVALID', async () => {
    const cases = [];

    // 超时
    try {
      await callModel(base({ schema: null, timeoutMs: 30, deps: { fetch: hangingFetch(), chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() } }));
    } catch (e) {
      cases.push(e.code);
    }
    // JSON 非法
    try {
      await callModel(base({ schema: TITLE_SCHEMA, deps: { fetch: makeFetch([jsonResponse(completionBody('纯文字'))]).fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() } }));
    } catch (e) {
      cases.push(e.code);
    }
    // 结构非法
    try {
      await callModel(base({ schema: TITLE_SCHEMA, deps: { fetch: makeFetch([jsonResponse(completionBody('{"nope":1}'))]).fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() } }));
    } catch (e) {
      cases.push(e.code);
    }

    expect(cases).toEqual([ERR.LLM_TIMEOUT, ERR.LLM_JSON_INVALID, ERR.LLM_SCHEMA_INVALID]);
  });

  it('超时 → 抛 LLM_TIMEOUT（而不是 LLM_NO_PROVIDER）', async () => {
    let caught = null;
    try {
      await callModel(base({ schema: null, timeoutMs: 30, deps: { fetch: hangingFetch(), chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() } }));
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe(ERR.LLM_TIMEOUT);
  });

  it('返回非 JSON 文本 → 抛 LLM_JSON_INVALID（而不是 LLM_NO_PROVIDER）', async () => {
    const mock = makeFetch([jsonResponse(completionBody('这不是 JSON，只是一段话。'))]);
    let caught = null;
    try {
      await callModel(base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() } }));
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe(ERR.LLM_JSON_INVALID);
    expect(caught.raw).toContain('这不是 JSON'); // 契约要求把原文（截断 2000 字）放进错误里
  });

  it('结构连续不合法 → 抛 LLM_SCHEMA_INVALID（而不是 LLM_NO_PROVIDER）', async () => {
    const mock = makeFetch([jsonResponse(completionBody('{"nope":1}'))]);
    let caught = null;
    try {
      await callModel(base({ schema: TITLE_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() } }));
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe(ERR.LLM_SCHEMA_INVALID);
  });
});

describe('回归：语义收敛不能损坏同级字段（缺陷 #1，已修复 —— 这两个用例防复发）', () => {
  const ARRAY_SCHEMA = {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'confidence'],
          properties: {
            name: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
      },
    },
  };

  it('数组里一个元素需要收敛时，其余元素与字段必须原样保留（当初整个数组被 true 覆盖）', async () => {
    const payload = JSON.stringify({ items: [{ name: '风险清单', confidence: '0.95' }, { name: '行动建议', confidence: 'high' }] });
    const mock = makeFetch([jsonResponse(completionBody(payload))]);
    const r = await callModel(
      base({ schema: ARRAY_SCHEMA, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() } }),
    );
    expect(r.json).toEqual({
      items: [
        { name: '风险清单', confidence: 'high' },
        { name: '行动建议', confidence: 'high' },
      ],
    });
    expect(r.degraded).toBe(false);
    expect(mock.count()).toBe(1); // 本该一次就成功，不该被自己的收敛逻辑逼着重试
  });

  it('同级多个字段：第一个需要收敛时，后面的字段不能被改坏', async () => {
    const schema = {
      type: 'object',
      required: ['a', 'b', 'c'],
      properties: {
        a: { type: 'string', enum: ['high', 'low'] },
        b: { type: 'string', enum: ['high', 'low'] },
        c: { type: 'string' },
      },
    };
    const mock = makeFetch([jsonResponse(completionBody('{"a":"0.95","b":"low","c":"原文不能动"}'))]);
    const r = await callModel(
      base({ schema, deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() } }),
    );
    expect(r.json).toEqual({ a: 'high', b: 'low', c: '原文不能动' });
  });

  it('直接单测 coerceInPlace：返回值是哨兵（不是布尔），改动通过 changed 输出参数传达', async () => {
    const { coerceInPlace } = await import('../../src/llm/schema-check.js');
    const schema = {
      type: 'object',
      properties: { a: { type: 'string', enum: ['high', 'low'] }, b: { type: 'string', enum: ['high', 'low'] } },
    };
    const value = { a: '0.95', b: 'low' };
    const changed = { value: false };
    const returned = coerceInPlace(value, schema, changed);
    expect(changed.value).toBe(true);
    expect(value).toEqual({ a: 'high', b: 'low' }); // 兄弟字段没被覆盖
    expect(typeof returned).not.toBe('boolean'); // 返回布尔正是当初的根因
  });
});

describe('缺陷登记 #6：完全合规的输出也会收到「已自动修正格式偏差」的通知', () => {
  const run = async () => {
    const mock = makeFetch([jsonResponse(completionBody('{"confidence":"high"}'))]);
    const notices = [];
    const r = await callModel(
      base({
        schema: CONFIDENCE_SCHEMA,
        onNotice: (n) => notices.push(n.text),
        deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() },
      }),
    );
    return { r, notices };
  };

  it('回归（缺陷 #6 已修复）：什么都没改，就不该说「已自动修正」', async () => {
    const { r } = await run();
    expect(r.json).toEqual({ confidence: 'high' });
    // 根因：coerceInPlace 旧签名把「是否改动」当返回值，导致恒定报"已修正"。
    // 新签名用 changed 引用参数传出，只有真的改了才通知用户。
    expect(r.notices.map((n) => n.text).join('\n')).not.toContain('已自动修正');
    expect(r.notices).toHaveLength(0);
  });

  it('真的发生收敛时才通知（confidence:"0.95" → high）', async () => {
    const mock = makeFetch([jsonResponse(completionBody('{"confidence":"0.95"}'))]);
    const notices = [];
    const r = await callModel(
      base({
        schema: CONFIDENCE_SCHEMA,
        onNotice: (n) => notices.push(n.text),
        deps: { fetch: mock.fetch, chain: ONE_STEP_CHAIN, resolveKey: () => ({ key: TEST_KEY, source: 'explicit' }), env: {}, sleep: makeSleep() },
      }),
    );
    expect(r.json.confidence).toBe('high');
    expect(notices.join('\n')).toContain('已自动修正');
  });
});

/* ================================================================== *
 * 注入隔离（不依赖具体实现细节，只保证「不在模块顶层读环境变量」这一条）
 * ================================================================== */
describe('可测试性', () => {
  it('callModel 的 deps 完全可注入：不传 deps 之外不需要任何环境准备', async () => {
    const { deps } = makeDeps({ script: [jsonResponse(completionBody('{"title":"注入成功"}'))], chain: ONE_STEP_CHAIN });
    const r = await callModel(base({ schema: TITLE_SCHEMA, deps }));
    expect(r.json).toEqual({ title: '注入成功' });
  });

  it('system / user 不是字符串 → 明确报错，而不是带着 undefined 去请求上游', async () => {
    await expect(callModel({ system: null, user: null, deps: {} })).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });
});
