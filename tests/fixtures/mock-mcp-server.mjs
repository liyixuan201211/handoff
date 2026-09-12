/**
 * 一个**真的** MCP 服务端（stdio 传输），用来测我们的 MCP 客户端。
 *
 * 为什么要有它：MCP 集成最容易"看起来做完了、其实没通"。
 * 只有拿一个真服务端、走真协议、真子进程通信，才能证明它真的能用。
 *
 * 它暴露三个工具：
 *   echo      —— 回显输入（测基本通路）
 *   add       —— 算两个数之和（测参数校验与结构化结果）
 *   fail_always —— 永远报错（测错误处理不会被吞掉）
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'handoff-mock', version: '1.0.0' });

server.tool('echo', '把输入原样返回', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: `echo: ${text}` }],
}));

server.tool(
  'add',
  '算两个数之和',
  { a: z.number(), b: z.number() },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
);

server.tool('fail_always', '永远失败，用来测错误处理', {}, async () => {
  throw new Error('这是故意的失败（mock 服务）');
});

const transport = new StdioServerTransport();
await server.connect(transport);
