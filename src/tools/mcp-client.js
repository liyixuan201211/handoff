/**
 * MCP 客户端 —— 接入外部工具服务。
 *
 * ══════════════════════════════════════════════════════════════════
 * MCP（Model Context Protocol）让我们能接上别人写好的工具服务：
 * 浏览器自动化、数据库、文件系统、GitHub……不用自己重写一遍。
 *
 * 两种传输：
 *  · **stdio**：我们拉起一个子进程，用标准输入输出通信。
 *    能接的东西最多（大多数 MCP 服务是这个形态），但**风险也最大** ——
 *    它会在你机器上执行命令。所以配置里必须写 `enabled: true` 才会启动。
 *  · **http**：连一个已经在跑的服务。风险小，但需要用户自己有那个服务。
 *
 * 三条工程纪律：
 *  1. **服务挂了不能拖垮主流程**。连接失败就记一条警告、跳过它，
 *     其他工具照常可用。用户不该因为"某个 MCP 服务没起来"而整个用不了。
 *  2. **必须能干净退出**。stdio 服务是子进程，不关就会变成孤儿进程 ——
 *     用户关了程序之后发现一堆 node 进程还在跑，这是很糟的体验。
 *  3. **工具名要加前缀**（`服务名__工具名`）。两个服务都有 `search` 时不能互相覆盖。
 * ══════════════════════════════════════════════════════════════════
 */
import { registerTool, unregisterByPrefix } from './registry.js';
import { clipOutput } from './registry.js';

/** 服务名 → { client, transport, def, tools:[] } */
const connections = new Map();

/** 正在连接中的 promise（防止并发初始化时重复拉起进程） */
let initPromise = null;

/** 已加载的结果（给健康检查用） */
export const mcpState = {
  loaded: false,
  servers: [], // [{name, type, ok, toolCount, error}]
};

/** 懒加载 SDK：没开 MCP 的环境不需要付出加载成本 */
async function loadSdk() {
  const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  return { Client, StdioClientTransport, StreamableHTTPClientTransport };
}

/** 把 MCP 的工具名规范化成我们注册表允许的形式，并加上服务前缀 */
export function mcpToolName(serverName, toolName) {
  const clean = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'tool';
  return `${clean(serverName)}__${clean(toolName)}`.slice(0, 64);
}

/**
 * 启动配置里所有 MCP 服务并把它们的工具注册进来。
 *
 * **不会抛异常**：任何服务失败都只是记进 mcpState，主流程继续。
 *
 * @param {object} cfg config.mcp（见 config.js）
 * @param {object} [deps] 测试注入 { loadSdk }
 * @returns {Promise<typeof mcpState>}
 */
export async function loadMcpServers(cfg = {}, deps = {}) {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!cfg?.enabled) {
      mcpState.loaded = true;
      mcpState.servers = [];
      return mcpState;
    }

    const servers = cfg.servers ?? {};
    const sdk = deps.loadSdk ? await deps.loadSdk() : await loadSdk();
    const results = [];

    for (const [name, def] of Object.entries(servers)) {
      const type = def?.type;
      // stdio 型必须显式 enabled:true —— 它会在用户机器上执行命令
      if (type === 'stdio' && def.enabled !== true) {
        results.push({ name, type, ok: false, toolCount: 0, error: '没写 enabled:true，未启动' });
        continue;
      }
      if (type !== 'stdio' && type !== 'http') {
        results.push({ name, type: type ?? '未知', ok: false, toolCount: 0, error: 'type 必须是 stdio 或 http' });
        continue;
      }

      try {
        const connected = await connectOne(name, def, sdk, cfg);
        results.push(connected);
      } catch (err) {
        results.push({
          name,
          type,
          ok: false,
          toolCount: 0,
          error: String(err?.message ?? err).slice(0, 300),
        });
      }
    }

    mcpState.loaded = true;
    mcpState.servers = results;
    return mcpState;
  })();

  return initPromise;
}

async function connectOne(name, def, sdk, cfg) {
  const { Client, StdioClientTransport, StreamableHTTPClientTransport } = sdk;

  let transport;
  if (def.type === 'stdio') {
    transport = new StdioClientTransport({
      command: def.command,
      args: Array.isArray(def.args) ? def.args : [],
      env: {
        // 只透传 PATH 一类必要变量 + 用户显式给的 env。
        // **不要把整个 process.env 传进去** —— 那等于把 API Key 交给一个第三方程序。
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...(def.env && typeof def.env === 'object' ? def.env : {}),
      },
      stderr: 'ignore', // 子进程的 stderr 不要灌进我们的日志
    });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(def.url));
  }

  const client = new Client(
    { name: 'handoff', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);

  const listed = await client.listTools();
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  const callTimeout = Number(cfg.callTimeoutMs) || 30000;

  let registered = 0;
  const localNames = [];
  for (const t of tools) {
    const originalName = t?.name;
    if (!originalName) continue;
    const localName = mcpToolName(name, originalName);
    const schema = t.inputSchema && typeof t.inputSchema === 'object'
      ? t.inputSchema
      : { type: 'object', properties: {} };
    // 我们的注册表要求 parameters.type === 'object'
    if (schema.type !== 'object') schema.type = 'object';

    registerTool({
      name: localName,
      description: `[${name}] ${t.description || `来自 ${name} 服务的工具`}`,
      parameters: schema,
      source: `mcp:${name}`,
      dangerous: true, // 外部工具一律标危险：UI 会让用户看到"团队用了外部工具"
      timeoutMs: callTimeout + 5000,
      handler: async (args) => {
        try {
          const res = await client.callTool(
            { name: originalName, arguments: args },
            undefined,
            { timeout: callTimeout },
          );
          // ⚠️ MCP 协议里"工具执行失败"有两种表现形式：
          //   a) 传输层抛异常
          //   b) 正常返回一个**带 `isError: true` 的结果**（工具内部报错走这条）
          // 只处理 (a) 的话，(b) 会被当成成功 —— 模型拿到一段错误文字却以为拿到了数据，
          // 于是拿着"错误信息"往下写，交付物就带上了幻觉。
          // 实测：`fail_always` 这种工具返回 isError:true，以前 ok 报的是 true。
          if (res?.isError) {
            return {
              ok: false,
              text: '',
              error: renderMcpContent(res) || `MCP 工具 ${name}/${originalName} 执行失败`,
              meta: { mcpServer: name, tool: originalName, isError: true },
            };
          }
          return { ok: true, text: renderMcpContent(res), meta: { mcpServer: name, tool: originalName } };
        } catch (err) {
          return {
            ok: false,
            text: '',
            error: `MCP 工具 ${name}/${originalName} 调用失败：${String(err?.message ?? err).slice(0, 300)}`,
          };
        }
      },
    });
    registered += 1;
    localNames.push(localName);
  }

  connections.set(name, { client, transport, def, tools: tools.map((t) => t.name), localNames });
  return { name, type: def.type, ok: true, toolCount: registered, error: null };
}

/**
 * MCP 的返回可能是文本、图片、资源链接的混合数组。
 * 我们只取**文本**部分 —— 图片对纯文本模型没有意义，硬塞反而是噪音。
 */
export function renderMcpContent(res) {
  const parts = Array.isArray(res?.content) ? res.content : [];
  const texts = [];
  for (const p of parts) {
    if (p?.type === 'text' && typeof p.text === 'string') texts.push(p.text);
    else if (p?.type === 'resource' && typeof p.resource?.text === 'string') texts.push(p.resource.text);
    else if (p?.type === 'image') texts.push('（这个工具返回了一张图片，我这边只能处理文字，看不到图片内容）');
  }
  if (!texts.length) {
    // 有些服务把结果放在 structuredContent 里
    if (res?.structuredContent !== undefined) {
      try {
        return clipOutput(JSON.stringify(res.structuredContent, null, 2));
      } catch {
        /* 落到下面的兜底 */
      }
    }
    return res?.isError ? '（工具报错了，但没有给出说明）' : '（工具没有返回文字内容）';
  }
  return clipOutput(texts.join('\n\n'));
}

/**
 * 断开所有 MCP 连接。
 *
 * **必须在进程退出前调用**，否则 stdio 型的子进程会变成孤儿 ——
 * 用户关掉程序之后发现一堆 npx/node 进程还在跑。
 * server.js 里注册了 SIGINT/SIGTERM 和 'exit' 来保证这件事。
 */
export async function closeMcpServers() {
  const results = [];
  // ⚠️ 必须先遍历、再 clear。原实现先 clear 了 connections 又去遍历它，
  // 那段清理循环是**死代码** —— 工具会永远留在注册表里。
  const entries = [...connections.entries()];
  for (const [name, conn] of entries) {
    try {
      await conn.client?.close?.();
    } catch (err) {
      results.push({ name, error: String(err?.message ?? err).slice(0, 200) });
    }
    try {
      await conn.transport?.close?.();
    } catch {
      /* 尽力而为：能关就关，关不掉也不该阻断退出 */
    }
    // 用注册时记下来的**精确**名字注销，不靠前缀猜
    const names = Array.isArray(conn.localNames) ? conn.localNames : [];
    if (names.length) {
      const { unregisterTool } = await import('./registry.js');
      for (const n of names) unregisterTool(n);
    } else {
      unregisterByPrefix(`${mcpToolName(name, '')}`);
    }
  }
  connections.clear();
  initPromise = null;
  mcpState.loaded = false;
  mcpState.servers = [];
  return results;
}

/** 目前接上了哪些服务（给健康检查用） */
export function mcpSummary() {
  return {
    enabled: mcpState.loaded ? mcpState.servers.length > 0 : false,
    servers: mcpState.servers,
  };
}

/** 测试用：重置内部状态 */
export function __resetMcpForTest() {
  connections.clear();
  initPromise = null;
  mcpState.loaded = false;
  mcpState.servers = [];
}
