/**
 * 工具循环测试 —— 用假的模型响应，验证循环控制逻辑。
 *
 * 循环控制是最容易出诡异 bug 的地方：
 *  · 忘了把 tool_calls 塞回历史 → 模型重复请求同一个工具
 *  · 忘了把工具结果按顺序还回去 → 模型困惑
 *  · 没有轮数上限 → 模型陷入死循环烧光用户额度
 *  · 工具失败直接抛异常 → 一个网址打不开就毁掉整个任务
 *
 * 这些都不是"功能问题"，是**控制流问题**，所以要用可编排的假响应来测。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { callModelWithTools, DEFAULT_MAX_TURNS, availableToolNames } from '../../src/tools/loop.js';
import { registerTool, clearTools, executeTool } from '../../src/tools/registry.js';

/** 造一个按脚本逐个返回的假 fetch（走的是真实网关代码路径） */
function makeScriptedFetch(script, onCall) {
  let i = 0;
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    onCall?.(body, i);
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    const payload =
      typeof step === 'function' ? step(body, i) : step;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              index: 0,
              finish_reason: payload.tool_calls ? 'tool_calls' : 'stop',
              message: {
                role: 'assistant',
                content: payload.content ?? '',
                ...(payload.tool_calls ? { tool_calls: payload.tool_calls } : {}),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        };
      },
    };
  };
  return { fetch, calls, count: () => i };
}

const tc = (name, args, id = `call_${name}`) => ({
  id,
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

const deps = (fetch) => ({
  // ⚠️ 必须把假的 fetch 传进去，否则会真的去打网络（第一次写漏了，
  // 结果测试拿真实的 401 报错，看起来像"密钥问题"其实是没注入）
  fetch,
  chain: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
  resolveKey: () => ({ key: 'sk-test-000000000000', source: 'explicit' }),
  env: {},
  sleep: async () => {},
});

describe('工具循环：控制流', () => {
  beforeEach(() => {
    clearTools();
    registerTool({
      name: 'lookup',
      description: '查一个东西',
      parameters: {
        type: 'object',
        required: ['q'],
        properties: { q: { type: 'string' } },
      },
      handler: async (args) => `查到：${args.q} 的结果是 42`,
    });
  });
  afterEach(() => clearTools());

  it('模型一次都不调工具 → 直接返回正文（不进入循环）', async () => {
    const { fetch, count } = makeScriptedFetch([{ content: '我知道答案，不用查。' }]);
    const r = await callModelWithTools({
      system: 'sys',
      user: '问个问题',
      allowedTools: ['lookup'],
      deps: deps(fetch),
    });
    expect(r.text).toBe('我知道答案，不用查。');
    expect(r.toolCount).toBe(0);
    expect(r.turns).toBe(1);
    expect(count()).toBe(1);
  });

  it('调一次工具再作答 → 两轮，且工具结果进了历史', async () => {
    const { fetch, calls, count } = makeScriptedFetch([
      { tool_calls: [tc('lookup', { q: '天气' })] },
      { content: '根据查询结果，是 42。' },
    ]);
    const r = await callModelWithTools({
      system: 'sys',
      user: '问个问题',
      allowedTools: ['lookup'],
      deps: deps(fetch),
    });
    expect(count()).toBe(2);
    expect(r.turns).toBe(2);
    expect(r.toolCount).toBe(1);
    expect(r.text).toContain('42');

    // 第二轮请求里必须带上：assistant 的 tool_calls + tool 的结果
    const second = calls[1];
    const roles = second.messages.map((m) => m.role);
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool');
    const assistantMsg = second.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg.tool_calls).toHaveLength(1); // ← 不带上它，模型会重复请求
    const toolMsg = second.messages.find((m) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('call_lookup'); // ← id 必须对上
    expect(toolMsg.content).toContain('42');
    expect(toolMsg.content).toContain('<tool_result');
  });

  it('连续调三次工具 → 三轮', async () => {
    const { fetch, count } = makeScriptedFetch([
      { tool_calls: [tc('lookup', { q: 'a' }, 'c1')] },
      { tool_calls: [tc('lookup', { q: 'b' }, 'c2')] },
      { tool_calls: [tc('lookup', { q: 'c' }, 'c3')] },
      { content: '最终答案' },
    ]);
    const r = await callModelWithTools({
      system: 's',
      user: 'u',
      allowedTools: ['lookup'],
      deps: deps(fetch),
    });
    expect(r.toolCount).toBe(3);
    expect(r.text).toBe('最终答案');
    expect(count()).toBe(4);
  });

  it('一轮里并行请求两个工具 → 两个都执行，结果都还回去', async () => {
    const { fetch, calls } = makeScriptedFetch([
      { tool_calls: [tc('lookup', { q: 'x' }, 'p1'), tc('lookup', { q: 'y' }, 'p2')] },
      { content: 'done' },
    ]);
    const r = await callModelWithTools({
      system: 's',
      user: 'u',
      allowedTools: ['lookup'],
      deps: deps(fetch),
    });
    expect(r.toolCount).toBe(2);
    const toolMsgs = calls[1].messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id).sort()).toEqual(['p1', 'p2']);
  });

  it('⚠️ 必须强制结束：模型每轮都调工具时，不能无限循环', async () => {
    // 脚本永远只给 tool_calls
    const { fetch, count } = makeScriptedFetch([{ tool_calls: [tc('lookup', { q: 'loop' })] }]);
    const r = await callModelWithTools({
      system: 's',
      user: 'u',
      allowedTools: ['lookup'],
      maxTurns: 3,
      deps: deps(fetch),
    });
    // 3 轮循环 + 1 轮强制收尾 = 4 次请求，绝不能更多
    expect(count()).toBeLessThanOrEqual(4);
    expect(r.text.length).toBeGreaterThan(0); // 必须给出结果，不能空手而归
  });

  it('收尾轮不能带工具（要强制它输出正文）', async () => {
    // 最后一轮给正文，前面的轮次一律要求调工具
    const { fetch, calls } = makeScriptedFetch([
      { tool_calls: [tc('lookup', { q: 'x' })] },
      { content: '收尾正文' },
    ]);
    await callModelWithTools({
      system: 's',
      user: 'u',
      allowedTools: ['lookup'],
      maxTurns: 1,
      deps: deps(fetch),
    });
    const last = calls[calls.length - 1];
    expect(last.tools, '最后一轮不该给工具').toBeUndefined();
    // 而且要明确告诉它"别再要工具了"
    const lastUser = [...last.messages].reverse().find((m) => m.role === 'user');
    expect(lastUser.content).toContain('不要再请求任何工具');
  });

  it('单轮请求超过上限时只执行前 N 个（防止一次被要求做太多）', async () => {
    const many = Array.from({ length: 10 }, (_, i) => tc('lookup', { q: `${i}` }, `m${i}`));
    const { fetch } = makeScriptedFetch([{ tool_calls: many }, { content: 'done' }]);
    const r = await callModelWithTools({
      system: 's',
      user: 'u',
      allowedTools: ['lookup'],
      maxToolCallsPerTurn: 2,
      deps: deps(fetch),
    });
    expect(r.toolCount).toBe(2);
  });

  it('allowedTools 之外的工具有效不可见（模型看不到就调不了）', async () => {
    registerTool({
      name: 'secret_tool',
      description: '不该被这个阶段用到',
      parameters: { type: 'object', properties: {} },
      handler: async () => 'secret',
    });
    let seenTools = null;
    const { fetch } = makeScriptedFetch(
      [{ content: 'ok' }],
      (body) => {
        seenTools = body.tools;
      },
    );
    await callModelWithTools({
      system: 's',
      user: 'u',
      allowedTools: ['lookup'], // 明确不含 secret_tool
      deps: deps(fetch),
    });
    expect(seenTools.map((t) => t.function.name)).toEqual(['lookup']);
  });
});

describe('工具循环：失败处理', () => {
  beforeEach(() => clearTools());
  afterEach(() => clearTools());

  it('⚠️ 工具执行失败不能让整个循环崩掉，要把失败原因喂回模型', async () => {
    registerTool({
      name: 'always_fail',
      description: '总是失败',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('网络不通');
      },
    });
    const { fetch, calls } = makeScriptedFetch([
      { tool_calls: [tc('always_fail', {})] },
      { content: '这个工具用不了，我换个说法直接回答。' },
    ]);
    const r = await callModelWithTools({ system: 's', user: 'u', allowedTools: ['always_fail'], deps: deps(fetch) });

    expect(r.text).toContain('换个说法');
    const toolMsg = calls[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg.content).toContain('error="true"');
    expect(toolMsg.content).toContain('网络不通');
  });

  it('模型幻觉出不存在的工具 → 明确告诉它可用工具，让它改', async () => {
    registerTool({
      name: 'real_tool',
      description: '真的',
      parameters: { type: 'object', properties: {} },
      handler: async () => 'ok',
    });
    const { fetch, calls } = makeScriptedFetch([
      { tool_calls: [tc('imaginary_tool', {})] },
      { content: '我用真实工具重试。' },
    ]);
    await callModelWithTools({ system: 's', user: 'u', allowedTools: ['real_tool'], deps: deps(fetch) });
    const toolMsg = calls[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg.content).toContain('没有名为');
    expect(toolMsg.content).toContain('real_tool');
  });

  it('工具参数不合法 → 拒绝执行并告诉模型为什么', async () => {
    let called = false;
    registerTool({
      name: 'needs_arg',
      description: 'x',
      parameters: { type: 'object', required: ['must'], properties: { must: { type: 'string' } } },
      handler: async () => {
        called = true;
        return 'ok';
      },
    });
    const { fetch, calls } = makeScriptedFetch([
      { tool_calls: [tc('needs_arg', {})] },
      { content: '参数错了。' },
    ]);
    await callModelWithTools({ system: 's', user: 'u', allowedTools: ['needs_arg'], deps: deps(fetch) });
    expect(called, '参数不合法时不该执行 handler').toBe(false);
    const toolMsg = calls[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg.content).toContain('必填');
  });

  it('最后正文为空 → 抛错而不是返回空字符串（调用方要知道失败了）', async () => {
    const { fetch } = makeScriptedFetch([{ content: '' }]);
    await expect(
      callModelWithTools({ system: 's', user: 'u', allowedTools: [], deps: deps(fetch) }),
    ).rejects.toThrow();
  });
});

describe('工具循环：审计轨迹（给 UI 用）', () => {
  beforeEach(() => clearTools());
  afterEach(() => clearTools());

  it('steps 记录每次调用的名字/参数/状态/耗时/摘要', async () => {
    registerTool({
      name: 'fetch_thing',
      description: 'x',
      parameters: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
      handler: async (args) => `抓到了 ${args.url} 的内容，第一行是有用信息`,
    });
    const { fetch } = makeScriptedFetch([
      { tool_calls: [tc('fetch_thing', { url: 'https://example.com/a' })] },
      { content: '好了' },
    ]);
    const events = [];
    const r = await callModelWithTools({
      system: 's',
      user: 'u',
      allowedTools: ['fetch_thing'],
      deps: deps(fetch),
      onToolCall: (e) => events.push(e),
    });

    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].name).toBe('fetch_thing');
    expect(r.steps[0].args.url).toBe('https://example.com/a');
    expect(r.steps[0].status).toBe('ok');
    expect(typeof r.steps[0].ms).toBe('number');
    expect(r.steps[0].summary).toContain('抓到了');

    // start / end 两个阶段都要通知到（UI 要显示"正在做…"）
    expect(events.map((e) => e.phase).sort()).toEqual(['end', 'start']);
  });

  it('参数很大时摘要会截断（事件里不能塞完整网页）', async () => {
    registerTool({
      name: 'big',
      description: 'x',
      parameters: { type: 'object', properties: { blob: { type: 'string' } } },
      handler: async () => 'ok',
    });
    const big = 'x'.repeat(5000);
    const { fetch } = makeScriptedFetch([{ tool_calls: [tc('big', { blob: big })] }, { content: 'done' }]);
    const r = await callModelWithTools({ system: 's', user: 'u', allowedTools: ['big'], deps: deps(fetch) });
    expect(r.steps[0].args.blob.length).toBeLessThan(200);
    expect(r.steps[0].args.blob).toContain('…');
  });
});

describe('可用工具列表', () => {
  beforeEach(() => clearTools());
  afterEach(() => clearTools());

  it('availableToolNames 反映注册表', () => {
    expect(availableToolNames()).toEqual([]);
    registerTool({
      name: 'x_tool',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      handler: async () => '',
    });
    expect(availableToolNames()).toEqual(['x_tool']);
  });
});
