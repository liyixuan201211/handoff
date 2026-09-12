/**
 * 配置加载 —— 决定"这个程序被允许做什么"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 设计立场：**默认什么都不允许。**
 *
 * 这不是保守，是因为开源软件的默认值会被成千上万人在完全不同的环境里跑。
 * 一个 clone 下来就能替你抓任意网页、读任意文件、拉起任意进程的程序，
 * 不是一个可以负责任地开源的程序。
 *
 * 所以要开一个能力，必须在这份配置里**显式写出来**：
 *   · 要抓网页 → 开 webFetch
 *   · 要读本地文件 → 开 readFile 并列出允许的目录
 *   · 要接 MCP 服务 → 在 mcpServers 里逐个列出，且 stdio 类型必须 enabled:true
 *
 * 配置文件：项目根目录的 handoff.config.json（可选，不存在就用全默认）
 * 环境变量优先级高于配置文件（方便容器/CI 场景）。
 * ══════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 展开路径里的 `~`（家目录）。
 *
 * 为什么必须有：配置文件是写给人看的，而人写路径时一定会用 `~/Desktop`。
 * 不展开的话 `fs.existsSync('~/Desktop')` 永远返回 false ——
 * 用户会在日志里看到"目录不存在"，但他明明有那个目录，
 * 然后他会以为是自己写错了，而不是程序不认识 `~`。
 */
export function expandHome(p, home = os.homedir()) {
  const s = String(p ?? '');
  if (s === '~') return home;
  if (s.startsWith('~/')) return path.join(home, s.slice(2));
  return s;
}

/** 全部能力的默认值（**除了安全的本地能力，其余一律关**） */
export const DEFAULT_CONFIG = Object.freeze({
  tools: {
    /** 抓网页。默认关 —— 它能让模型访问外网。 */
    webFetch: { enabled: false, allowHosts: [], allowPrivateHosts: false, timeoutMs: 15000, maxBytes: 2000000 },
    /** 搜索。默认关。没配 searchUrl 时会退化到 DuckDuckGo 的公开端点（不稳定）。 */
    webSearch: { enabled: false, searchUrl: '', apiKey: '', timeoutMs: 15000 },
    /** 读本地文本文件。默认关，且必须列出允许的目录（空列表 = 拒绝一切）。 */
    readFile: { enabled: false, allowedRoots: [], maxBytes: 400000 },
    /**
     * 单个任务最多调用几次工具。防止模型陷入"调工具→不满意→再调"的死循环。
     * 这个上限是**成本保护**：每次工具调用都可能带动下一次模型调用。
     */
    maxCallsPerJob: 24,
  },
  mcp: {
    /** 总开关。默认关 —— MCP 能起进程、能连网络。 */
    enabled: false,
    /** 单个 MCP 服务的工具调用超时 */
    callTimeoutMs: 30000,
    /**
     * MCP 服务定义。格式（key 是服务名，会成为工具名前缀）：
     *   "my-browser": { type: "stdio", command: "npx", args: ["-y", "some-mcp"], enabled: true }
     *   "my-remote":  { type: "http",  url: "https://example.com/mcp" }
     * 注意：stdio 类型**必须**同时写 enabled:true —— 因为它会在你机器上执行命令，
     * 不能因为配置里出现了一行就被自动拉起来。
     */
    servers: {},
  },
  skills: {
    /** 技能目录（相对项目根）。里面的 SKILL.md 会被读进提示词。 */
    dirs: ['skills'],
    /** 单个技能正文最多注入多少字符（防止把提示词撑爆） */
    maxCharsPerSkill: 4000,
    /** 一次最多注入几个技能 */
    maxSkills: 3,
  },
  /** 流水线里允许用工具的阶段。默认只给"动手做"和"调研"，不让质检去上网。 */
  toolStages: ['research', 'draft'],
});

/** 深合并（只处理普通对象；数组整体替换） */
function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
        ? deepMerge(base[k], v)
        : v;
  }
  return out;
}

/** 环境变量 → 配置覆盖。只支持几个最常用的开关，够容器场景用。 */
export function configFromEnv(env = process.env) {
  const override = {};
  const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());
  const list = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

  if (env.HANDOFF_WEB_FETCH !== undefined) {
    override.tools = { ...(override.tools ?? {}), webFetch: { enabled: bool(env.HANDOFF_WEB_FETCH) } };
  }
  if (env.HANDOFF_WEB_FETCH_ALLOW_HOSTS) {
    override.tools = {
      ...(override.tools ?? {}),
      webFetch: {
        ...(override.tools?.webFetch ?? {}),
        enabled: true,
        allowHosts: list(env.HANDOFF_WEB_FETCH_ALLOW_HOSTS),
      },
    };
  }
  if (env.HANDOFF_READ_ROOTS) {
    override.tools = {
      ...(override.tools ?? {}),
      readFile: { enabled: true, allowedRoots: list(env.HANDOFF_READ_ROOTS) },
    };
  }
  if (env.HANDOFF_MCP_ENABLED !== undefined) {
    override.mcp = { enabled: bool(env.HANDOFF_MCP_ENABLED) };
  }
  if (env.HANDOFF_MCP_SERVERS) {
    // 形如 name=url,name2=url（只支持 http 型；stdio 型必须走配置文件，防止误执行命令）
    const servers = {};
    for (const pair of list(env.HANDOFF_MCP_SERVERS)) {
      const i = pair.indexOf('=');
      if (i > 0) {
        servers[pair.slice(0, i)] = { type: 'http', url: pair.slice(i + 1) };
      }
    }
    override.mcp = { ...(override.mcp ?? {}), enabled: true, servers };
  }
  return override;
}

/**
 * 读配置文件并和环境变量合并。
 * @param {object} opts { rootDir, env, fsImpl }
 * @returns {{config:object, source:string, warnings:string[], path:string|null}}
 */
export function loadConfig(opts = {}) {
  const {
    rootDir = process.cwd(),
    env = process.env,
    fsImpl = fs,
  } = opts;
  const file = path.join(rootDir, 'handoff.config.json');
  const warnings = [];
  let fromFile = {};
  let usedFile = null;

  if (fsImpl.existsSync(file)) {
    try {
      fromFile = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      usedFile = file;
    } catch (err) {
      // 配置文件坏了不能让服务起不来 —— 但要**明确警告**，因为用户会以为配置生效了
      warnings.push(`配置文件解析失败，已忽略它（整份配置走了默认值）：${err.message}`);
    }
  }

  let config = deepMerge(DEFAULT_CONFIG, fromFile);
  config = deepMerge(config, configFromEnv(env));

  // 校验并给出可操作的警告（不阻断启动：一个配置写错不该让程序打不开）
  warnings.push(...auditConfig(config, { rootDir, fsImpl }));

  return {
    config,
    source: usedFile ? 'file' : 'default',
    warnings,
    path: usedFile,
  };
}

/** 检查配置里的明显问题，返回给人看的警告 */
export function auditConfig(config, { rootDir = process.cwd(), fsImpl = fs } = {}) {
  const w = [];
  const rf = config.tools?.readFile;

  if (rf?.enabled) {
    if (!Array.isArray(rf.allowedRoots) || rf.allowedRoots.length === 0) {
      w.push(
        '只读文件功能已开启，但 allowedRoots 是空的 —— 这样任何文件都读不到。' +
          '请在 handoff.config.json 里写上允许的目录。',
      );
    } else {
      for (const root of rf.allowedRoots) {
        const abs = path.resolve(rootDir, expandHome(root));
        if (!fsImpl.existsSync(abs)) {
          w.push(`allowedRoots 里的目录不存在：${root}`);
        }
      }
    }
  }

  const wf = config.tools?.webFetch;
  if (wf?.enabled && wf.allowPrivateHosts) {
    w.push(
      '⚠️ webFetch.allowPrivateHosts 已开启 —— AI 可以访问你本机和内网的地址。' +
        '只在完全清楚后果时使用。',
    );
  }

  const mcp = config.mcp;
  if (mcp?.enabled) {
    const servers = mcp.servers ?? {};
    if (!Object.keys(servers).length) {
      w.push('MCP 已开启但一个服务都没配（mcp.servers 是空的）。');
    }
    for (const [name, def] of Object.entries(servers)) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(name)) {
        w.push(`MCP 服务名不合法（要字母开头、只含字母数字下划线短横线）：${name}`);
      }
      if (def?.type === 'stdio') {
        if (def.enabled !== true) {
          w.push(
            `MCP 服务「${name}」是 stdio 类型但没写 enabled:true —— 不会启动它。` +
              '（stdio 型会在你机器上执行命令，必须显式确认。）',
          );
        }
        if (!def.command) w.push(`MCP 服务「${name}」缺少 command。`);
      } else if (def?.type === 'http') {
        if (!def.url) w.push(`MCP 服务「${name}」缺少 url。`);
      } else if (def) {
        w.push(`MCP 服务「${name}」的 type 必须是 stdio 或 http。`);
      }
    }
  }

  if (config.tools && config.tools.maxCallsPerJob !== undefined) {
    const n = Number(config.tools.maxCallsPerJob);
    if (!Number.isFinite(n) || n < 0) {
      w.push('tools.maxCallsPerJob 必须是非负数字。');
    }
  }

  return w;
}

/**
 * 配置摘要 —— 给 `/api/health` 和界面用。
 * **绝不包含任何密钥**（apiKey 只报"有没有配"）。
 */
export function describeConfig(config) {
  return {
    tools: {
      webFetch: {
        enabled: Boolean(config.tools?.webFetch?.enabled),
        allowHosts: config.tools?.webFetch?.allowHosts ?? [],
        allowPrivateHosts: Boolean(config.tools?.webFetch?.allowPrivateHosts),
      },
      webSearch: {
        enabled: Boolean(config.tools?.webSearch?.enabled),
        hasApiKey: Boolean(config.tools?.webSearch?.apiKey),
        customEndpoint: Boolean(config.tools?.webSearch?.searchUrl),
      },
      readFile: {
        enabled: Boolean(config.tools?.readFile?.enabled),
        rootCount: (config.tools?.readFile?.allowedRoots ?? []).length,
      },
      maxCallsPerJob: config.tools?.maxCallsPerJob ?? 0,
    },
    mcp: {
      enabled: Boolean(config.mcp?.enabled),
      servers: Object.entries(config.mcp?.servers ?? {}).map(([name, def]) => ({
        name,
        type: def?.type ?? 'unknown',
        // stdio 型要能一眼看出"它会不会被启动"
        willStart: def?.type === 'http' ? true : def?.enabled === true,
      })),
    },
    skills: {
      dirs: config.skills?.dirs ?? [],
    },
    toolStages: config.toolStages ?? [],
  };
}
