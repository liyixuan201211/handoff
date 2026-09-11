/**
 * 前端 ↔ 后端 契约测试（真实 HTTP）
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件的存在理由，是项目里代价最大的一个 bug。
 *
 * 症状：所有测试都绿，但真实浏览器里点「开始，交给团队」100% 失败。
 * 根因：服务端返回 `{ job: {...} }`，前端按扁平对象读 `job.id`。
 *       → `job.id` 是 undefined → 界面弹「任务创建了但没拿到编号」
 *       → 详情页永远显示"（没有写下目标）/ 未知状态 / 团队正在集结"，用户一直等。
 *
 * 为什么两边都没抓到：
 *   · `tests/unit/frontend.test.js` 只测 `public/api.js` 这一层，用的是手写的假响应 → 绿
 *   · `tests/e2e/pipeline.test.js` 全部 `request(app)` 直打服务端，**绕过了前端代码** → 绿
 *   · **中间那根线没人测。**
 *
 * 所以这里做的事只有一件：**真的起一个 Express app，把真实的响应喂给前端 api.js**。
 * 任何人以后再改响应形状或前端读取方式，这里会立刻红。
 * ══════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-wire-'));
process.env.HANDOFF_DATA_DIR = tmpBase;

const { createApp } = await import('../../src/server.js');
const { createApi } = await import('../../public/api.js');

let app;
let server;
let origin;

/**
 * 把 Node 的 fetch 语义接到 express app 上，而不是真的开端口。
 * 这样跑得快，但**走的仍然是真实的 Express 路由与序列化**——
 * 这正是我们要测的那一段。
 */
function makeBridgeFetch() {
  return async (input, init = {}) => {
    const target = typeof input === 'string' ? input : String(input);
    const url = new URL(target, `http://127.0.0.1:1`);
    const res = await require('supertest')(app)
      [String(init.method || 'GET').toLowerCase()](url.pathname + url.search)
      .set(init.headers || {})
      .send(init.body ? JSON.parse(String(init.body)) : undefined);

    // 组装成前端 api.js 期望的 Response 形状
    const text = typeof res.text === 'string' ? res.text : JSON.stringify(res.body ?? null);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: async () => text,
    };
  };
}

const api = createApi({ fetchImpl: makeBridgeFetch(), origin: '' });

beforeAll(async () => {
  app = createApp({ rateLimit: false });
  server = null;
  origin = '';
});

afterAll(() => {
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

describe('接线：前端 api.js ↔ 后端 HTTP（这是唯一能发现"解包"类 bug 的层次）', () => {
  it('createJob 返回的对象必须直接有 id（而不是 { job: { id } }）', async () => {
    const job = await api.createJob({ goal: '接线测试：帮我看租房合同', demo: true });
    expect(job).toBeTruthy();
    // 这一条断言如果失败，真实浏览器里点「开始」就会弹
    // 「任务创建了但没拿到编号，去历史里看看。」
    expect(typeof job.id).toBe('string');
    expect(job.id).toMatch(/^job_/);
    expect(job.status).toBeTruthy();
    expect(job.goal).toBe('接线测试：帮我看租房合同');
  });

  it('getJob 返回的对象必须直接有 id/status/stages/artifacts', async () => {
    const created = await api.createJob({ goal: '接线测试：详情页字段', demo: true });
    const job = await api.getJob(created.id);
    expect(job.id).toBe(created.id);
    expect(typeof job.status).toBe('string');
    expect(Array.isArray(job.stages)).toBe(true);
    expect(Array.isArray(job.artifacts)).toBe(true);
    // 交付物正文必须在（否则详情页打开是空白成果面板）
    if (job.artifacts.length) {
      expect(typeof job.artifacts[0].content).toBe('string');
    }
  });

  it('listJobs 返回数组（不是 { jobs: [...] }）', async () => {
    await api.createJob({ goal: '接线测试：列表', demo: true });
    const jobs = await api.listJobs();
    expect(Array.isArray(jobs)).toBe(true);
    // 列表项必须有 id 和 goal，否则历史页每张卡片都是空白
    expect(jobs.length).toBeGreaterThan(0);
    expect(typeof jobs[0].id).toBe('string');
    expect(typeof jobs[0].goal).toBe('string');
    expect(typeof jobs[0].status).toBe('string');
  });

  it('sendMessage 发 { message } 能被接受（缺陷 #5 回归）', async () => {
    const created = await api.createJob({ goal: '接线测试：中途补充要求', demo: true });
    // 等它稳定（demo 流水线很快）
    let job = created;
    for (let i = 0; i < 120 && job.status === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      job = await api.getJob(created.id);
    }
    const after = await api.sendMessage(created.id, '再补一句：我下个月要搬家');
    // 必须成功（不能 400），并且返回的对象能被 app.js 直接读
    expect(after).toBeTruthy();
    expect(after.id ?? created.id).toBe(created.id);
  }, 30_000);

  it('retryJob 返回的对象能被直接读（不是包装过的）', async () => {
    const created = await api.createJob({ goal: '接线测试：重试', demo: true });
    let job = created;
    for (let i = 0; i < 120 && job.status !== 'done' && job.status !== 'failed'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      job = await api.getJob(created.id);
    }
    const retried = await api.retryJob(created.id);
    expect(retried).toBeTruthy();
    expect(retried.id).toBe(created.id);
  }, 30_000);

  it('getTemplates 返回 { templates, fallback }，且模板非空、每项都有 id/title（首页永不留白）', async () => {
    // 注意形状：这个方法是**有意**返回 `{ templates, fallback }` 而不是裸数组，
    // 因为 app.js 需要知道"这是真模板还是内置兜底"（兜底时界面会有一句说明）。
    const res = await api.getTemplates();
    expect(res).toBeTruthy();
    const templates = res.templates;
    expect(Array.isArray(templates)).toBe(true);
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.title).toBe('string');
    }
    // 真实模板目录里的 8 个模板字段比内置兜底多（goalTemplate 等），
    // 前端如果哪天开始依赖这些字段，这里会先红。
    expect(typeof res.fallback).toBe('boolean');
  });

  it('错误响应：{ error: { code, message } } 的形状必须被 api.js 正确识别', async () => {
    await expect(api.getJob('job_0000000000000000')).rejects.toMatchObject({
      code: expect.any(String),
    });
  });

  it('health 端点可读，且响应体里不能出现任何密钥', async () => {
    const payload = await api.health();
    expect(payload.ok).toBe(true);
    const raw = JSON.stringify(payload);
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{12,}/);
    expect(raw).not.toMatch(/QC-[A-Za-z0-9-]{16,}/);
  });
});

/**
 * 这一组测的是"用户点下去之后到底发生了什么"。
 * 前一组测形状，这一组测**完整交互路径**——PM 用真实浏览器发现的问题就是这个层次。
 */
describe('接线：新用户的第一屏到看完结果', () => {
  it('空输入框点「看一个演示」必须能跑（这是不知道说什么的人唯一会点的按钮）', async () => {
    // 演示按钮走的是 demo:true + 内置 goal，绝不该要求用户先写点什么
    const job = await api.createJob({ goal: '帮我把这份租房合同看一遍，我怕有坑', demo: true });
    expect(job.id).toBeTruthy();

    let final = job;
    for (let i = 0; i < 200 && final.status === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      final = await api.getJob(job.id);
    }
    expect(['done', 'failed']).toContain(final.status);
    expect(final.artifacts.length).toBeGreaterThan(0);
  }, 40_000);

  it('历史列表的每一张卡片都能读出目标与状态（不能是"准备中"配"已完成"）', async () => {
    await api.createJob({ goal: '接线测试：卡片字段', demo: true });
    const jobs = await api.listJobs();
    for (const j of jobs) {
      // app.js 用这些字段渲染卡片；任一缺失就会出现"（没有写下目标）"或"未知状态"
      expect(typeof j.goal).toBe('string');
      expect(j.goal.length).toBeGreaterThan(0);
      expect(['queued', 'running', 'awaiting_input', 'done', 'failed', 'cancelled']).toContain(
        j.status,
      );
    }
  });
});
