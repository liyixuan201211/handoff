/**
 * MCP 集成测试 —— 用**真的** MCP 服务端走真协议。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须用真服务端，而不是 mock 掉 SDK：
 *
 * MCP 集成最容易出的问题是"看起来做完了、其实没通" ——
 * 因为我们自己写的 mock 会按我们的**假设**回应，
 * 而真实协议可能有我们没想到的字段、时序、错误形态。
 *
 * 实测就是这么抓到两个 bug 的：
 *   1. MCP 工具执行失败时返回的是 `isError: true` 的**正常结果**，
 *      不是抛异常 —— 我原来只处理了抛异常的情况，于是错误被吞成"成功了"
 *   2. 断开连接时先 clear 了 Map 又去遍历它，清理循环是**死代码**，
 *      工具永远留在注册表里，stdio 子进程也不会被收掉
 *
 * test fixture：tests/fixtures/mock-mcp-server.mjs（一个真的 MCP 服务端）
 * ══════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadMcpServers,
  closeMcpServers,
  mcpSummary,
  mcpToolName,
  renderMcpContent,
  __resetMcpForTest,
} from '../../src/tools/mcp-client.js';
import { listTools, executeTool, clearTools, getTool } from '../../src/tools/registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.resolve(HERE, '..', 'fixtures', 'mock-mcp-server.mjs');

/** 起一个连到 mock 服务端的配置 */
const withMock = (extra = {}) => ({
  enabled: true,
  callTimeoutMs: 15000,
  servers: {
    mock: { type: 'stdio', command: process.execPath, args: [MOCK_SERVER], enabled: true, ...extra },
  },
});

afterEach(async () => {
  await closeMcpServers();
  clearTools();
  __resetMcpForTest();
});

afterAll(async () => {
  await closeMcpServers();
});

describe('MCP 工具名规范化', () => {
  it('加服务名前缀，避免两个服务互相覆盖', () => {
    expect(mcpToolName('browser', 'navigate')).toBe('browser__navigate');
    expect(mcpToolName('my-server', 'do.thing')).toBe('my_server__do_thing');
  });

  it('超长名字被截到 64 字符以内（我们的注册表有长度限制）', () => {
    const long = mcpToolName('a'.repeat(80), 'b'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(64);
  });
});

describe('MCP 安全默认值', () => {
  it('总开关关着时，一个服务都不连', async () => {
    const state = await loadMcpServers({ enabled: false, servers: { mock: { type: 'stdio', command: 'node', args: [] } } });
    expect(state.servers).toEqual([]);
    expect(listTools()).toHaveLength(0);
  });

  it('⚠️ stdio 服务没写 enabled:true 时**不能**被启动（它会在用户机器上执行命令）', async () => {
    const state = await loadMcpServers({
      enabled: true,
      servers: { mock: { type: 'stdio', command: process.execPath, args: [MOCK_SERVER] } }, // 故意不写 enabled
    });
    expect(state.servers[0].ok).toBe(false);
    expect(state.servers[0].error).toContain('enabled');
    expect(listTools(), '不该注册任何工具').toHaveLength(0);
  });

  it('type 不合法时明确报错，不尝试连接', async () => {
    const state = await loadMcpServers({ enabled: true, servers: { bad: { type: 'weird' } } });
    expect(state.servers[0].ok).toBe(false);
    expect(state.servers[0].error).toContain('stdio 或 http');
  });

  it('服务连不上时只是记错误，不抛异常（其他功能必须照常可用）', async () => {
    const state = await loadMcpServers({
      enabled: true,
      servers: {
        broken: { type: 'stdio', command: '/definitely/not/a/real/binary', args: [], enabled: true },
      },
    });
    expect(state.servers[0].ok).toBe(false);
    expect(typeof state.servers[0].error).toBe('string');
    // 关键：没有抛出去
    expect(listTools()).toHaveLength(0);
  });
});

describe('MCP 真连接（真的子进程 + 真协议）', () => {
  it('能连上、能发现工具、工具名带服务前缀', async () => {
    const state = await loadMcpServers(withMock());
    expect(state.servers[0].ok).toBe(true);
    expect(state.servers[0].toolCount).toBe(3);

    const names = listTools().map((t) => t.name).sort();
    expect(names).toEqual(['mock__add', 'mock__echo', 'mock__fail_always']);
    // 来源要标清楚，UI 上要能告诉用户"这是外部工具"
    expect(getTool('mock__echo').source).toBe('mcp:mock');
    expect(getTool('mock__echo').dangerous).toBe(true);
  });

  it('真的调用 MCP 工具并拿到结果', async () => {
    await loadMcpServers(withMock());
    const r = await executeTool('mock__echo', { text: '你好世界' });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('echo: 你好世界');
  });

  it('结构化参数被正确传过去（add 17+25=42）', async () => {
    await loadMcpServers(withMock());
    const r = await executeTool('mock__add', { a: 17, b: 25 });
    expect(r.ok).toBe(true);
    expect(r.text.trim()).toBe('42');
  });

  it('MCP 工具的参数 schema 也会被校验（不合法就不发出去）', async () => {
    await loadMcpServers(withMock());
    const r = await executeTool('mock__add', { a: '不是数字', b: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('类型');
  });

  it('⚠️ MCP 工具内部报错必须被识别（isError 形式的失败不能当成成功）', async () => {
    // 这是实测抓到的 bug：MCP 协议里"工具执行失败"有两种表现 ——
    // 抛异常、或者正常返回一个 isError:true 的结果。
    // 只处理前者的话，错误会被吞成成功，模型拿着错误信息往下写，产出幻觉。
    await loadMcpServers(withMock());
    const r = await executeTool('mock__fail_always', {});
    expect(r.ok, '内部报错的 MCP 工具不能被当成成功').toBe(false);
    expect(r.error).toContain('故意的失败');
  });

  it('重复初始化不会累积重复工具（幂等）', async () => {
    await loadMcpServers(withMock());
    const first = listTools().length;
    await loadMcpServers(withMock()); // 第二次应当直接返回缓存的 promise
    expect(listTools().length).toBe(first);
  });

  it('⚠️ 断开后工具必须从注册表消失（否则子进程和工具都会残留）', async () => {
    await loadMcpServers(withMock());
    expect(listTools().length).toBeGreaterThan(0);

    await closeMcpServers();
    expect(listTools(), '断开后不该还有 MCP 工具').toHaveLength(0);
    expect(mcpSummary().servers).toEqual([]);
  });

  it('断开之后原来那些工具名调用会明确说"没有这个工具"', async () => {
    await loadMcpServers(withMock());
    await closeMcpServers();
    const r = await executeTool('mock__echo', { text: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有名为');
  });
});

describe('MCP 返回内容的渲染', () => {
  it('纯文本直接取出来', () => {
    expect(renderMcpContent({ content: [{ type: 'text', text: 'abc' }] })).toBe('abc');
  });

  it('多段文本拼接', () => {
    const out = renderMcpContent({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] });
    expect(out).toContain('a');
    expect(out).toContain('b');
  });

  it('图片内容被替换成一句说明（纯文本模型看不到图，硬塞是噪音）', () => {
    const out = renderMcpContent({ content: [{ type: 'image', data: 'xxx', mimeType: 'image/png' }] });
    expect(out).toContain('图片');
  });

  it('structuredContent 兜底', () => {
    const out = renderMcpContent({ content: [], structuredContent: { a: 1 } });
    expect(out).toContain('"a"');
  });

  it('空内容不崩', () => {
    for (const bad of [null, undefined, {}, { content: [] }]) {
      expect(() => renderMcpContent(bad)).not.toThrow();
    }
  });
});
