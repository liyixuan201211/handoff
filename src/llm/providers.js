/**
 * Provider 配置与密钥解析。
 *
 * 产品的「零配置」承诺就落在这里：
 * 普通用户装了 Cherry Studio 的话，我们直接读它的本地配置拿 Key，
 * 用户什么都不用填就能用。读不到才提示他去 .env 里填。
 *
 * 安全约定：
 *  - 只读打开 sqlite，绝不写。
 *  - 密钥只在本模块与 gateway 之间流动，绝不进入 job 数据、日志、HTTP 响应。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// node:sqlite 在 ESM 里用 createRequire 更稳（也便于在不支持的运行时优雅降级）
const require = createRequire(import.meta.url);

/** 结构化 provider 定义。baseURL 是**固定常量**，绝不由用户输入决定（防 SSRF）。 */
export const PROVIDERS = {
  'deepseek-official': {
    id: 'deepseek-official',
    label: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: ['DEEPSEEK_API_KEY', 'HANDOFF_DEEPSEEK_API_KEY'],
  },
  aiping: {
    id: 'aiping',
    label: 'AI Ping',
    baseURL: 'https://aiping.cn/api/v1',
    apiKeyEnv: ['AIPING_API_KEY', 'HANDOFF_AIPING_API_KEY'],
  },
};

/** 默认降级链。左边优先。 */
export const DEFAULT_CHAIN = [
  { provider: 'deepseek-official', model: 'deepseek-flash' },
  { provider: 'aiping', model: 'DeepSeek-V4-Flash' },
  { provider: 'aiping', model: 'DeepSeek-V4.1-Flash' },
  { provider: 'aiping', model: 'GLM-5.3' },
  { provider: 'aiping', model: 'Qwen3.8-Max' },
];

export function resolveChain(env = process.env) {
  const raw = env.HANDOFF_MODEL_CHAIN;
  if (!raw || !raw.trim()) return DEFAULT_CHAIN;
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const [provider, ...rest] = token.split('/');
      if (rest.length === 0) {
        // 没写 provider 前缀：猜一个。含 DeepSeek- 前缀的优先给 aiping，其余给官方。
        return { provider: 'deepseek-official', model: token };
      }
      return { provider, model: rest.join('/') };
    })
    .filter((s) => PROVIDERS[s.provider] !== undefined);
  return parsed.length ? parsed : DEFAULT_CHAIN;
}

const cherryStudioDbPath = () =>
  path.join(
    os.homedir(),
    'Library/Application Support/CherryStudio/Data/cherrystudio.sqlite',
  );

/** Cherry Studio 里 aiping provider 的固定 id（本机实测） */
const CHERRY_AIPING_PROVIDER_IDS = [
  '94e4eaab-6470-4e47-86e5-28484934ef8b',
  'aiping',
];
const CHERRY_DEEPSEEK_PROVIDER_IDS = ['deepseek'];

/**
 * 从本机 Cherry Studio 读一个可用的密钥。
 * 失败一律返回 null —— 零配置是「加分项」，绝不能因为读不到就让服务起不来。
 */
export function keyFromCherryStudio(providerId, dbPath = cherryStudioDbPath()) {
  const candidateIds =
    providerId === 'aiping' ? CHERRY_AIPING_PROVIDER_IDS : CHERRY_DEEPSEEK_PROVIDER_IDS;
  let db;
  try {
    if (!fs.existsSync(dbPath)) return null;
    // 动态 import，避免在没装 sqlite 支持的 Node 上直接崩
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    for (const id of candidateIds) {
      const row = db
        .prepare('select api_keys, is_enabled from user_provider where provider_id = ?')
        .get(id);
      if (!row) continue;
      const keys = JSON.parse(row.api_keys ?? '[]');
      const usable = keys.find(
        (k) => k && k.isEnabled !== false && typeof k.key === 'string' && k.key.trim() !== '',
      );
      if (usable) return usable.key.trim();
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* 关不掉就算了，只读连接无所谓 */
    }
  }
}

/**
 * 解析某个 provider 的密钥。顺序：
 *   1. 显式传入（测试注入）
 *   2. 环境变量
 *   3. Cherry Studio 本地配置
 * @returns {{key:string, source:'explicit'|'env'|'cherry-studio'} | null}
 */
export function resolveKey(providerId, { env = process.env, explicitKey, dbPath } = {}) {
  if (explicitKey && String(explicitKey).trim()) {
    return { key: String(explicitKey).trim(), source: 'explicit' };
  }
  const def = PROVIDERS[providerId];
  if (!def) return null;
  for (const name of def.apiKeyEnv) {
    const v = env[name];
    if (v && String(v).trim()) return { key: String(v).trim(), source: 'env' };
  }
  const fromCherry = keyFromCherryStudio(providerId, dbPath);
  if (fromCherry) return { key: fromCherry, source: 'cherry-studio' };
  return null;
}

/**
 * 探测整条链的可用性（只做密钥存在性检查，不打网络）。
 * 用于 /api/health 和启动时的自我诊断日志。
 */
export function inspectChain(chain = DEFAULT_CHAIN, opts = {}) {
  return chain.map((step) => {
    const def = PROVIDERS[step.provider];
    const resolved = resolveKey(step.provider, opts);
    return {
      provider: step.provider,
      providerLabel: def?.label ?? step.provider,
      model: step.model,
      baseURL: def?.baseURL ?? null,
      configured: resolved !== null,
      keySource: resolved?.source ?? null,
      // 注意：这里绝不返回 key 本身
    };
  });
}
