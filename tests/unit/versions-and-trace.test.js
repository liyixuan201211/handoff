/**
 * 迭代重跑 / 版本历史 / 调用轨迹 的测试。
 *
 * 这三样是产品经理明确要求的能力：
 *   1. 质检说有问题 → **整条流水线从头重跑**（重新查资料、重新写）
 *   2. 交付时**只显示最后一版**，但用户可以查每个版本
 *   3. skill 与 MCP 的调用过程要**看得见**
 *
 * 用脚本模型测，不依赖网络。核心断言是"真的重跑了"——
 * 而不是"看起来重跑了"（只看轮次数字会被糊弄过去，要数各阶段执行次数）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { setToolConfig, startJob } from '../../src/pipeline/engine.js';
import { getJob, resetStore, loadFromDisk } from '../../src/store/json-store.js';
import { events } from '../../src/store/events.js';
import { clearTools, registerTool } from '../../src/tools/registry.js';
import { scriptedOutputFor, stageOfRequest } from '../helpers/e2e-harness.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dataDir;
let realFetch;
let realKeys;

/** 造一个按脚本回答的假 fetch，并记录每个阶段被调用的次数 */
function installModel({ verifyVerdicts, onToolStage = null, toolName = 'read_text_file' }) {
  const stageCounts = {};
  let verifySeq = 0;
  let sawToolMessage = false;

  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const stage = stageOfRequest(body);
    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
    const hasToolMsg = body.messages.some((m) => m.role === 'tool');
    if (hasToolMsg) sawToolMessage = true;

    let payload = { content: JSON.stringify(scriptedOutputFor(stage)) };

    if (stage === 'verify') {
      const verdict = verifyVerdicts[Math.min(verifySeq, verifyVerdicts.length - 1)];
      verifySeq += 1;
      payload = { content: JSON.stringify(verdict) };
    } else if (stage === onToolStage && !hasToolMsg) {
      // 第一次到这个阶段：要求调工具
      payload = {
        content: '',
        tool_calls: [
          {
            id: 'call_x',
            type: 'function',
            function: { name: toolName, arguments: '{"path":"/tmp/x.txt"}' },
          },
        ],
      };
    }

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
                content: payload.content,
                ...(payload.tool_calls ? { tool_calls: payload.tool_calls } : {}),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        };
      },
    };
  };

  return {
    stageCounts,
    verifyCalls: () => verifySeq,
    sawToolMessage: () => sawToolMessage,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

const VERDICT_OK = {
  verdict: 'pass_with_notes',
  checklist: [
    { item: '是否先给出了结论', ok: true, note: '' },
    { item: '是否包含没有信息量的空话', ok: true, note: '' },
    { item: '是否存在写到一半就断掉的段落', ok: true, note: '' },
  ],
  issues: [],
};

const VERDICT_BAD = {
  verdict: 'needs_revision',
  checklist: [
    { item: '是否先给出了结论', ok: false, note: '没有' },
    { item: '是否包含没有信息量的空话', ok: true, note: '' },
    { item: '是否存在写到一半就断掉的段落', ok: true, note: '' },
  ],
  issues: [
    {
      severity: 'high',
      where: 'd1',
      problem: '这份材料没有先给出结论，用户要翻到最后才知道',
      fix: '在开头第一段就写出结论，不要让用户自己找',
    },
  ],
};

async function runToEnd(id, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    const c = await getJob(id);
    if (c && ['done', 'failed', 'cancelled'].includes(c.status)) return c;
  }
  throw new Error('任务没有在预期时间内结束');
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-ver-'));
  process.env.HANDOFF_DATA_DIR = dataDir;
  resetStore();
  await loadFromDisk();
  realFetch = globalThis.fetch;
  realKeys = {
    aiping: process.env.AIPING_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
  };
  // 让网关认为有 key（真正的网络调用被下面的假 fetch 拦掉）
  process.env.AIPING_API_KEY = 'sk-test-0000000000000000';
  process.env.DEEPSEEK_API_KEY = 'sk-test-0000000000000000';
  clearTools();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setToolConfig(null);
  clearTools();
  resetStore();
  if (realKeys.aiping === undefined) delete process.env.AIPING_API_KEY;
  else process.env.AIPING_API_KEY = realKeys.aiping;
  if (realKeys.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = realKeys.deepseek;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('质检说不行 → 整条流水线从头重跑', () => {
  it('第一次 verify 判 needs_revision → 各阶段真的执行了两遍', async () => {
    setToolConfig({ toolStages: [], skills: { dirs: [] } });
    const model = installModel({ verifyVerdicts: [VERDICT_BAD, VERDICT_OK] });

    const created = await startJob({ goal: '写一份给房东的话' });
    const final = await runToEnd(created.id);
    model.restore();

    // 1) 真的重跑了：不能只看 round 数字，要数各阶段执行次数
    expect(model.verifyCalls(), 'verify 应该被问了两次').toBe(2);
    expect(model.stageCounts.research, '调研应该重跑（重新查资料）').toBe(2);
    expect(model.stageCounts.draft, '动手做应该重跑（重新写）').toBe(2);
    expect(model.stageCounts.critique, '挑毛病应该重跑').toBe(2);
    expect(model.stageCounts.deliver, '交付应该重跑').toBe(2);
    // ⚠️ intake / plan 刻意**只跑一次**（它们在 roundLoop 之前执行）：
    // 用户的需求没变、交付物清单没变，重做这两步是纯粹的钱和时间浪费。
    // 质检的意见针对的是内容质量，那是 research/draft/... 该解决的。
    expect(model.stageCounts.intake, 'intake 不该重跑（需求没变）').toBe(1);
    expect(model.stageCounts.plan, 'plan 不该重跑（交付物清单没变）').toBe(1);

    // 2) 最终状态与轮次
    expect(final.status).toBe('done');
    expect(final.round).toBe(2);
    expect(final.roundHistory).toHaveLength(2);
    expect(final.roundHistory[0].verdict).toBe('needs_revision');
    expect(final.roundHistory[1].verdict).toBe('pass_with_notes');
  }, 90_000);

  it('第一轮就通过 → 只跑一遍（不能无脑重跑浪费用户的额度）', async () => {
    setToolConfig({ toolStages: [], skills: { dirs: [] } });
    const model = installModel({ verifyVerdicts: [VERDICT_OK] });

    const created = await startJob({ goal: '随便写点东西' });
    const final = await runToEnd(created.id);
    model.restore();

    expect(model.verifyCalls()).toBe(1);
    expect(model.stageCounts.research).toBe(1);
    expect(final.round).toBe(1);
    expect(final.roundHistory).toHaveLength(1);
  }, 90_000);

  it('重跑次数有上限（质检一直说不行也不能无限烧钱）', async () => {
    setToolConfig({ toolStages: [], skills: { dirs: [] } });
    // 永远判 needs_revision
    const model = installModel({ verifyVerdicts: [VERDICT_BAD] });

    const created = await startJob({ goal: '一直不合格的测试' });
    const final = await runToEnd(created.id, 120_000);
    model.restore();

    // 默认上限 2 轮：会重跑的那几个阶段各执行 2 次，绝不会无限循环
    expect(model.stageCounts.research).toBe(2);
    expect(model.stageCounts.verify).toBe(2);
    expect(model.stageCounts.draft).toBe(2);
    // 用尽重跑机会后仍然要交付（有东西比没东西好）
    expect(final.status).toBe('done');
    expect(final.artifacts.length).toBeGreaterThan(0);
  }, 150_000);
});

describe('版本历史：交付只给最后一版，但可以查所有版本', () => {
  it('重跑后 artifacts[].content 是最新版，versions 里保留两版', async () => {
    setToolConfig({ toolStages: [], skills: { dirs: [] } });
    const model = installModel({ verifyVerdicts: [VERDICT_BAD, VERDICT_OK] });

    const created = await startJob({ goal: '写一份对比表' });
    const final = await runToEnd(created.id);
    model.restore();

    expect(final.artifacts.length).toBeGreaterThan(0);
    for (const a of final.artifacts) {
      // 界面只看 content —— 必须是最新版
      expect(typeof a.content).toBe('string');
      expect(a.content.length).toBeGreaterThan(80);
      expect(a.version).toBe(2);
      // 但历史要留着（用户能查每个版本）
      expect(Array.isArray(a.versions)).toBe(true);
      expect(a.versions.length).toBe(2);
      expect(a.versions.map((v) => v.round)).toEqual([1, 2]);
      expect(a.versions[0].n).toBe(1);
      expect(a.versions[1].n).toBe(2);
      // 每一版都带自己的正文（查询版本时不用再跑一遍模型）
      for (const v of a.versions) {
        expect(typeof v.content).toBe('string');
        expect(v.chars).toBeGreaterThan(0);
      }
    }
    // 跨轮持久化：artifactHistory 才是权威记录
    expect(Object.keys(final.artifactHistory ?? {}).length).toBeGreaterThan(0);
  }, 90_000);

  it('只跑一轮时只有 1 个版本（不给用户制造噪音）', async () => {
    setToolConfig({ toolStages: [], skills: { dirs: [] } });
    const model = installModel({ verifyVerdicts: [VERDICT_OK] });
    const created = await startJob({ goal: '一次就过的任务' });
    const final = await runToEnd(created.id);
    model.restore();
    for (const a of final.artifacts) {
      expect(a.versions).toHaveLength(1);
      expect(a.version).toBe(1);
    }
  }, 90_000);
});

describe('调用轨迹：技能与工具都要看得见', () => {
  it('技能被用上时记进 toolTrace 与 skillsUsed', async () => {
    setToolConfig({
      toolStages: [],
      skills: { dirs: ['skills'], maxSkills: 3 },
      __rootDir: process.cwd(),
    });
    const model = installModel({ verifyVerdicts: [VERDICT_OK] });
    const created = await startJob({ goal: '帮我把这份租房合同看一遍，我怕有坑' });
    const final = await runToEnd(created.id);
    model.restore();

    expect(final.skillsUsed).toContain('合同审查');
    const skillItems = (final.toolTrace ?? []).filter((t) => t.type === 'skill');
    expect(skillItems.length).toBeGreaterThanOrEqual(1);
    expect(skillItems[0].name).toBe('合同审查');
    expect(skillItems[0].at).toBeGreaterThan(0);
  }, 90_000);

  it('工具调用被记进 toolTrace，且带上结果（用户能看到团队动了什么）', async () => {
    clearTools();
    registerTool({
      name: 'read_text_file',
      description: '读文件',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
      handler: async (a) => `文件 ${a.path} 的内容：押金 6000 元，租期一年`,
    });
    setToolConfig({ toolStages: ['research'], skills: { dirs: [] } });
    const model = installModel({ verifyVerdicts: [VERDICT_OK], onToolStage: 'research' });

    const created = await startJob({ goal: '读一下我的合同文件' });
    const final = await runToEnd(created.id);
    model.restore();

    expect(model.sawToolMessage(), '工具结果必须喂回模型').toBe(true);
    const toolItems = (final.toolTrace ?? []).filter((t) => t.type === 'tool');
    expect(toolItems.length).toBe(1);
    expect(toolItems[0].name).toBe('read_text_file');
    expect(toolItems[0].status).toBe('ok');
    expect(toolItems[0].summary).toContain('押金 6000');
    expect(typeof toolItems[0].ms).toBe('number');
    // 轨迹要标明是哪一步用的、第几轮
    expect(toolItems[0].stageKey).toBe('research');
    expect(toolItems[0].round).toBe(1);
  }, 90_000);

  it('MCP 工具（名字带 __）被归类为 mcp_call，便于界面区分外部工具', async () => {
    clearTools();
    registerTool({
      name: 'browser__navigate',
      description: 'MCP 浏览器工具',
      parameters: { type: 'object', properties: { url: { type: 'string' } } },
      source: 'mcp:browser',
      handler: async () => '打开了页面',
    });
    setToolConfig({ toolStages: ['research'], skills: { dirs: [] } });
    const model = installModel({
      verifyVerdicts: [VERDICT_OK],
      onToolStage: 'research',
      toolName: 'browser__navigate',
    });
    const created = await startJob({ goal: '用浏览器看一下某个页面' });
    const final = await runToEnd(created.id);
    model.restore();

    const mcpItems = (final.toolTrace ?? []).filter((t) => t.type === 'mcp_call');
    expect(mcpItems.length).toBe(1);
    expect(mcpItems[0].name).toBe('browser__navigate');
    // 界面上要显示成人话，不能显示内部工具名
    expect(mcpItems[0].label).toContain('browser');
  }, 90_000);
});
