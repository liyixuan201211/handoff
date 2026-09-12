/**
 * 工具系统的引导 —— 把配置、原生工具、MCP、技能接到一起。
 *
 * 为什么要有这么一个"总装"文件：
 * 前面几个模块（config / native / mcp-client / skills）各自都只管自己那块，
 * 但"到底开哪些工具、用哪个配置、什么时候该加载"是一个**编排**问题。
 * 把它集中在这里，好处是：
 *   · server.js 只需要调一次 `initToolSystem()`
 *   · 测试可以单独调它、注入自己的配置和 fs
 *   · 加载失败的处理逻辑只有一处，不会每个调用点各写一遍
 *
 * ⚠️ 一条纪律：**工具系统初始化失败绝不能阻止服务启动**。
 * 配置写错了、MCP 服务没装、技能目录不存在 —— 这些都是"工具少一点"，
 * 而不是"整个产品用不了"。用户应该能打开界面、能跑任务，只是没有那个工具。
 */
import path from 'node:path';
import fs from 'node:fs';

import { loadConfig, describeConfig, auditConfig, DEFAULT_CONFIG, expandHome } from './config.js';
import { registerWebFetch, registerWebSearch, registerReadFile } from './native.js';
import { loadMcpServers, closeMcpServers, mcpSummary } from './mcp-client.js';
import { listTools, clearTools } from './registry.js';
import { loadSkills } from '../skills/loader.js';

/** 初始化结果（给 /api/health 用） */
export const toolSystemState = {
  /**
   * 真实配置对象（引擎通过 toolConfigRef 拿它）。
   * 注意：**不要**把它直接返回给 HTTP —— 里面有 apiKey 之类的字段。
   * 对外用 toolSystemSummary()。
   */
  __config: null,
  initialized: false,
  configSource: 'default',
  configPath: null,
  warnings: [],
  tools: [],
  skills: [],
  mcp: { enabled: false, servers: [] },
  errors: [],
};

let initPromise = null;

/**
 * 初始化工具系统。可以重复调用（幂等）。
 *
 * @param {object} [opts]
 * @param {string} [opts.rootDir] 项目根目录（找配置文件和技能目录的基准）
 * @param {object} [opts.env] 环境变量
 * @param {object} [opts.fsImpl] 测试注入
 * @param {Function} [opts.fetchImpl] 测试注入
 * @param {boolean} [opts.skipMcp] 测试里跳过 MCP（避免真的拉进程）
 * @param {object} [opts.configOverride] 直接给一份配置（测试用，跳过文件读取）
 * @returns {Promise<typeof toolSystemState>}
 */
export async function initToolSystem(opts = {}) {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const {
      rootDir = process.cwd(),
      env = process.env,
      fsImpl = fs,
      fetchImpl = null,
      skipMcp = false,
      configOverride = null,
    } = opts;

    // 每次重新初始化都要先清空，否则重复调用会累积旧工具
    clearTools();
    toolSystemState.errors = [];
    toolSystemState.warnings = [];

    const loaded = configOverride
      ? { config: configOverride, source: 'override', path: null, warnings: [] }
      : loadConfig({ rootDir, env, fsImpl });

    const config = loaded.config;
    toolSystemState.configSource = loaded.source;
    toolSystemState.configPath = loaded.path;
    toolSystemState.warnings = [...loaded.warnings];

    // ── 原生工具（逐个 try：一个装不上不影响别的）──
    const t = config.tools ?? {};

    if (t.webFetch?.enabled) {
      try {
        registerWebFetch({
          allowHosts: t.webFetch.allowHosts ?? [],
          allowPrivateHosts: Boolean(t.webFetch.allowPrivateHosts),
          timeoutMs: t.webFetch.timeoutMs ?? 15000,
          maxBytes: t.webFetch.maxBytes ?? 2000000,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
      } catch (err) {
        toolSystemState.errors.push(`web_fetch 注册失败：${err.message}`);
      }
    }

    if (t.webSearch?.enabled) {
      try {
        registerWebSearch({
          searchUrl: t.webSearch.searchUrl ?? '',
          apiKey: t.webSearch.apiKey ?? '',
          timeoutMs: t.webSearch.timeoutMs ?? 15000,
          allowPrivateHosts: Boolean(t.webFetch?.allowPrivateHosts),
          ...(fetchImpl ? { fetchImpl } : {}),
        });
      } catch (err) {
        toolSystemState.errors.push(`web_search 注册失败：${err.message}`);
      }
    }

    if (t.readFile?.enabled) {
      try {
        // ⚠️ 必须先展开 ~ 再 resolve。配置文件里写 `~/Desktop` 是人之常情，
        // 不展开的话那个目录会被当成不存在的相对路径，用户会以为是自己写错了。
        const roots = (t.readFile.allowedRoots ?? []).map((r) => path.resolve(rootDir, expandHome(r)));
        registerReadFile({
          allowedRoots: roots,
          maxBytes: t.readFile.maxBytes ?? 400000,
          fs: fsImpl,
          path,
        });
      } catch (err) {
        toolSystemState.errors.push(`read_text_file 注册失败：${err.message}`);
      }
    }

    // ── MCP ──
    if (!skipMcp && config.mcp?.enabled) {
      try {
        await loadMcpServers(config.mcp, {});
      } catch (err) {
        // loadMcpServers 内部已经逐个服务捕获了，这里只是最后一道保险
        toolSystemState.errors.push(`MCP 初始化异常：${String(err?.message ?? err).slice(0, 200)}`);
      }
    }

    // ── 技能（只加载，按任务再选；这里只统计数量）──
    try {
      const { skills, warnings } = loadSkills({
        dirs: config.skills?.dirs ?? ['skills'],
        rootDir,
        fsImpl,
        maxCharsPerSkill: config.skills?.maxCharsPerSkill ?? 4000,
      });
      toolSystemState.skills = skills.map((s) => ({ name: s.name, description: s.description }));
      toolSystemState.warnings.push(...warnings);
    } catch (err) {
      toolSystemState.errors.push(`技能加载失败：${err.message}`);
    }

    toolSystemState.tools = listTools().map((x) => ({
      name: x.name,
      source: x.source,
      dangerous: x.dangerous,
      description: x.description.slice(0, 200),
    }));
    toolSystemState.mcp = mcpSummary();
    toolSystemState.__config = config;
    toolSystemState.initialized = true;
    return toolSystemState;
  })();

  return initPromise;
}

/** 关掉工具系统（主要是关 MCP 子进程）。进程退出前必须调。 */
export async function shutdownToolSystem() {
  try {
    await closeMcpServers();
  } catch {
    /* 退出路径上不要因为清理失败而抛出去 */
  }
  initPromise = null;
  toolSystemState.initialized = false;
}

/** 当前配置的可公开摘要（**不含任何密钥**） */
export function toolSystemSummary() {
  return {
    initialized: toolSystemState.initialized,
    configSource: toolSystemState.configSource,
    // 注意：published 里不能出现 "key" 字段名 —— 安全测试会拿 /"key"/ 扫整个响应
    tools: toolSystemState.tools,
    skills: toolSystemState.skills,
    mcp: toolSystemState.mcp,
    warnings: toolSystemState.warnings,
    errors: toolSystemState.errors,
  };
}

/** 测试用 */
export function __resetToolSystemForTest() {
  initPromise = null;
  clearTools();
  toolSystemState.initialized = false;
  toolSystemState.tools = [];
  toolSystemState.skills = [];
  toolSystemState.mcp = { enabled: false, servers: [] };
  toolSystemState.warnings = [];
  toolSystemState.errors = [];
}

export { DEFAULT_CONFIG, describeConfig, auditConfig };
