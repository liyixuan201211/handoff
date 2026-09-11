/**
 * 端到端测试 —— 从 HTTP 请求到最终交付物，整条链路。
 *
 * 两种模式都测：
 *   A. demo 模式（离线，不打网络）—— **必须通过**。没有网络、没有 API Key 也要能完整演示，
 *      这是给普通人看的产品的基本盘。
 *   B. 真实模式（打真网络）—— 只在 HANDOFF_INTEGRATION=1 时跑，见 describe.skipIf。
 *
 * 另外 C 段专门找 bug：空输入、不存在的 id、模型全挂、取消、并发 5 个任务互相污染。
 *
 * ⚠️ 关于依赖注入：engine.js 的 `optional()` 加载器有缺陷（缺陷 #1），
 *    store / demo / guard 三个模块全被加载成 null。为了让 A 段能真的跑通，
 *    beforeAll 里用 `wireEngineDeps()` 按 loadOptionalDeps 的本意把依赖补上，
 *    并在最前面用测试把这个缺陷本身钉住。详见 docs/reports/S8-QA.md。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  engine,
  store,
  fixtures,
  events,
  request,
  scriptedModel,
  wireEngineDeps,
  makeTempDataDir,
  cleanupTempDataDir,
  waitForJob,
  memoryJob,
  runDemoJobViaHttp,
} from '../helpers/e2e-harness.js';
import { createApp } from '../../src/server.js';

const STAGE_ORDER = ['intake', 'plan', 'research', 'draft', 'critique', 'revise', 'verify', 'deliver'];

let dataDir = null;
let app = null;
/** 引擎在「我们打补丁之前」的真实依赖状态（缺陷 #1 的证据） */
let pristineDeps = null;

/* ================================================================== *
 * 缺陷登记：引擎依赖装载（必须最先跑，此时依赖还是「没人动过」的状态）
 * ================================================================== */
describe('回归：引擎依赖装载（缺陷 #1 已修复，这里防止复发）', () => {
  // 注意：文件级 beforeAll 会在**所有** describe 之前跑，所以「装配前」的状态
  // 只能在 beforeAll 里抓快照（pristineDeps），不能靠 describe 的书写顺序。
  it('loadOptionalDeps() 之后 store / demo / guard 必须全部就绪', () => {
    expect(typeof pristineDeps.saveJob).toBe('function');
    expect(typeof pristineDeps.getJob).toBe('function');
    expect(typeof pristineDeps.updateJob).toBe('function');
    expect(typeof pristineDeps.deleteJob).toBe('function');
    expect(pristineDeps.demo?.runDemoPipeline).toBeTypeOf('function');
    expect(pristineDeps.guard?.auditJob).toBeTypeOf('function');
  });

  it('引擎确实把任务写到了磁盘（刷新页面 / 重启进程之后还在）', async () => {
    const created = await request(app).post('/api/jobs').send({ goal: '落盘验证', demo: true });
    const id = created.body.job.id;
    await waitForJob(app, id);
    // 用 store 提供的同步点排空写队列，而不是靠 sleep 猜时间。
    // 这个窗口是真实存在的（内存先变、落盘紧随），靠短 sleep 等它必然偶发失败。
    await store.flushWrites();

    // 内存里的状态先变，磁盘写入是紧随其后的独立异步操作，
    // 所以这里给一个等待窗口，而不是立刻 existsSync —— 否则偶发失败，
    // 而"偶发失败的测试"比没有测试更糟：它会训练人忽略红色。
    //
    // 另外：这个用例曾在全仓并行跑时偶发失败（同一机器上还有基准测试和对抗性
    // 测试在起进程、写文件，I/O 队列被占满）。所以窗口给到 15 秒，
    // 失败时把目录内容一并打出来，便于判断是"慢"还是"真的没写"。
    const file = path.join(dataDir, 'jobs', `${id}.json`);
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(file) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!fs.existsSync(file)) {
      const listing = fs.existsSync(path.join(dataDir, 'jobs'))
        ? fs.readdirSync(path.join(dataDir, 'jobs')).join(', ')
        : '(jobs 目录不存在)';
      throw new Error(
        `任务 ${id} 跑完了但 15 秒内没有落盘。dataDir=${dataDir}\n盘上现有文件：${listing}`,
      );
    }
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.id).toBe(id);
    expect(onDisk.status).toBe('done');
    expect(onDisk.stages.length).toBe(8);
    expect(onDisk.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(onDisk.security.level).not.toBe('blocked');
  }, 40_000);
});

beforeAll(async () => {
  dataDir = makeTempDataDir('handoff-e2e-');
  await store.loadFromDisk();
  app = createApp({ rateLimit: false });
  await engine.loadOptionalDeps();
  pristineDeps = { ...engine.deps }; // 先取证，再补依赖
  await wireEngineDeps();
}, 30_000);

afterAll(() => {
  store.stopSyncTimer();
  cleanupTempDataDir(dataDir);
});

/* ================================================================== *
 * A. Demo 模式（离线，必须通过）
 * ================================================================== */
describe('A. Demo 模式端到端（离线，不打网络）', () => {
  let created = null;
  let job = null;
  let eventsAtStart = [];

  beforeAll(async () => {
    const goal = '帮我把这份租房合同看一遍，我怕有坑';
    created = await request(app).post('/api/jobs').send({ goal, demo: true });
    expect(created.status).toBe(201);
    const id = created.body.job.id;
    eventsAtStart = events.since(id, 0); // 建任务那一刻的事件
    job = await waitForJob(app, id);
  }, 60_000);

  it('POST /api/jobs {goal, demo:true} → 201，并立即返回（不等流水线跑完）', () => {
    expect(created.status).toBe(201);
    expect(created.body.job.id).toMatch(/^job_/);
    // 「立即返回」的证据：响应回来时任务还没跑完
    expect(['queued', 'running']).toContain(created.body.job.status);
  });

  it('轮询直到 done：8 个阶段全部跑过且都是 done', () => {
    expect(job.status).toBe('done');
    expect(job.stages.map((s) => s.key)).toEqual(STAGE_ORDER);
    for (const s of job.stages) {
      expect(s.status).toBe('done');
      expect(s.ms).toBeGreaterThan(0);
      expect(s.reason.length).toBeGreaterThan(4);
      expect(s.log.length).toBeGreaterThan(0);
      expect(s.output).not.toBeNull();
    }
  });

  it('满足 CONTRACT §7 的全部 5 条验收标准', async () => {
    // 1. status done
    expect(job.status).toBe('done');
    // 2. 至少 1 个 artifact，且每个正文 > 80 字
    //    契约 §2 要求详情接口直接带 content（缺陷 #2 已修复），所以这里两种来源都要验：
    //    接口里必须有正文，下载接口也必须能拿到同一份正文。
    expect(job.artifacts.length).toBeGreaterThanOrEqual(1);
    for (const art of job.artifacts) {
      expect(typeof art.content).toBe('string');
      expect(art.content.trim().length).toBeGreaterThan(80);
      expect(art.content).toContain('#'); // 真的是 markdown
      const dl = await request(app).get(`/api/jobs/${job.id}/artifacts/${art.id}/download`);
      expect(dl.status).toBe(200);
      expect(dl.text.trim().length).toBeGreaterThan(80);
      expect(dl.text).toBe(art.content); // 两条路径必须是同一份内容
    }
    // 3. review 非空且不是 needs_revision
    expect(job.review).not.toBeNull();
    expect(job.review.verdict).not.toBe('needs_revision');
    expect(job.review.checklist.length).toBeGreaterThanOrEqual(5);
    // 4. security 不是 blocked
    expect(job.security).not.toBeNull();
    expect(job.security.level).not.toBe('blocked');
    // 5. deliver 阶段产出了「怎么用」说明
    const deliver = job.stages.find((s) => s.key === 'deliver');
    const howTo = JSON.stringify(deliver.output);
    expect(howTo).toContain('howToUse');
  });

  it('SSE 端点能连上并收到事件（真实 HTTP 流，不是模拟）', async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const ac = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}/stream`, {
        signal: ac.signal,
        headers: { Accept: 'text/event-stream' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      // 读够 3 条事件或 3 秒就收工，免得测试挂住
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + 3000;
      while (buffer.split('\n\n').filter((b) => b.includes('data:')).length < 3 && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      const frames = buffer.split('\n\n').filter((b) => b.includes('data:'));
      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(frames[0]).toContain('event: message');
      expect(frames[0]).toContain('id: '); // seq 让浏览器重连时能补发

      const first = JSON.parse(frames[0].split('\n').find((l) => l.startsWith('data: ')).slice(6));
      expect(first.type).toBe('job'); // 契约：连接时先补发快照
      // eslint-disable-next-line no-unused-vars
      void reader;
    } finally {
      ac.abort();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });

  it('事件确实被发布到了事件总线（8 个阶段都有 stage 事件、review/security/done 齐全）', () => {
    const all = events.since(job.id, 0);
    expect(all.length).toBeGreaterThan(10);
    // seq 从 1 开始严格递增
    all.forEach((e, i) => expect(e.seq).toBe(i + 1));
    const types = new Set(all.map((e) => e.type));
    for (const t of ['job', 'stage', 'log', 'artifact', 'review', 'security', 'done']) {
      expect(types.has(t)).toBe(true);
    }
    const runningStages = all.filter((e) => e.type === 'stage' && e.status === 'running');
    expect(runningStages.length).toBe(8);
    const doneStages = all.filter((e) => e.type === 'stage' && e.status === 'done');
    expect(doneStages.length).toBe(8);
    expect(all.at(-1).type).toBe('done');
    expect(eventsAtStart.some((e) => e.type === 'job')).toBe(true);
  });

  it('交付物正文能通过下载接口取回（含中文文件名与完整 markdown）', async () => {
    const art = job.artifacts[0];
    const dl = await request(app).get(`/api/jobs/${job.id}/artifacts/${art.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(dl.text.length).toBeGreaterThan(200);
  });

  it('回归（缺陷 #2 已修复）：GET /api/jobs/:id 的 artifacts 带 content，前端拿得到正文', () => {
    expect(job.artifacts.length).toBeGreaterThan(0);
    expect(typeof job.artifacts[0].content).toBe('string');
    expect(job.artifacts[0].content.length).toBeGreaterThan(80);
  });

  it('GET /api/jobs/:id 应返回交付物正文（契约 §2「单任务全量状态」）', () => {
    expect(typeof job.artifacts[0].content).toBe('string');
    expect(job.artifacts[0].content.length).toBeGreaterThan(80);
  });

  it('SSE 补发的 job 快照应含完整 stages（契约 §2：刷新页面不丢状态）', () => {
    // 注意：第一条 job 事件是「任务刚创建」时的快照，那时阶段列表还是空的
    //（引擎要等 plan 跑完才知道完整阶段编排）。所以这里断言**最后一条**权威快照。
    const jobEvents = events.since(job.id, 0).filter((e) => e.type === 'job');
    expect(jobEvents.length).toBeGreaterThan(0);
    const snapshot = jobEvents.at(-1);
    expect(Array.isArray(snapshot.job.stages)).toBe(true);
    expect(snapshot.job.stages.length).toBeGreaterThan(0);
    // 快照必须能支撑前端直接渲染团队区，而不是先显示「正在集结」
    for (const s of snapshot.job.stages) {
      expect(s.status).toBeTruthy();
      expect(s.role).toBeTruthy();
      expect(Array.isArray(s.log)).toBe(true);
    }
  });

  it('快照里不能夹带阶段产出正文（否则每条事件都要传几十 KB）', () => {
    const jobEvents = events.since(job.id, 0).filter((e) => e.type === 'job');
    const snapshot = jobEvents.at(-1);
    for (const s of snapshot.job.stages) {
      expect(s.output).toBeUndefined();
    }
    // 但交付物元信息要在（名字/长度），让用户知道做出了什么；正文仍然只在详情/下载接口里
    expect(Array.isArray(snapshot.job.artifacts)).toBe(true);
    expect(snapshot.job.artifacts.length).toBeGreaterThan(0);
    expect(snapshot.job.artifacts[0].bytes).toBeGreaterThan(80);
    expect(snapshot.job.artifacts[0].content).toBeUndefined();
  });
});

/* ================================================================== *
 * B. 真实模式（打真网络，默认跳过）
 * ================================================================== */
/**
 * 真实模式的预算。
 *
 * 默认 300 秒是任务书要求的数字，但**实测不够**：
 * 一个「用三句话解释复利」的目标，跑完 intake/plan/draft 就花了 79 秒，
 * 其中 critique 一个阶段就跑了 2 分钟以上（大段生成的单次调用上限是 120 秒，
 * 一旦顶到超时还要重试/降级）。所以这里留一个环境变量，
 * 让维护者不用改测试文件就能放宽：HANDOFF_INTEGRATION_TIMEOUT_MS=1200000
 */
const REAL_TIMEOUT_MS = Number(process.env.HANDOFF_INTEGRATION_TIMEOUT_MS) || 300_000;

describe.skipIf(!process.env.HANDOFF_INTEGRATION)('B. 真实模式端到端（打真网络，慢）', () => {
  it('真实 goal → 跑到 done，至少 1 个交付物且正文 > 80 字', async () => {
    const goal = '用三句话解释什么是复利，给一个初中生看';
    const res = await request(app).post('/api/jobs').send({ goal });
    expect([201, 200]).toContain(res.status);
    const id = res.body.job.id;

    const job = await waitForJob(app, id, { timeoutMs: REAL_TIMEOUT_MS - 10_000, intervalMs: 500 });
    expect(job.status).toBe('done');
    expect(job.stages.length).toBeGreaterThanOrEqual(4);
    expect(job.review).not.toBeNull();
    expect(job.artifacts.length).toBeGreaterThanOrEqual(1);

    const dl = await request(app).get(`/api/jobs/${job.id}/artifacts/${job.artifacts[0].id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.text.length).toBeGreaterThan(80);

    // 真实跑的时候，用量必须是真实增长过的
    expect(job.usage.calls).toBeGreaterThan(0);
    expect(job.usage.promptTokens).toBeGreaterThan(0);
  }, REAL_TIMEOUT_MS);
});

/* ================================================================== *
 * C. 失败与边界
 * ================================================================== */
describe('C. 失败与边界（最容易出 bug 的地方）', () => {
  it('空 goal → 400', async () => {
    for (const goal of ['', '   ', '\n\t']) {
      const res = await request(app).post('/api/jobs').send({ goal });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(typeof res.body.error.message).toBe('string');
    }
  });

  it('goal 超过 4000 字 → 400（并且提示里带上了实际字数）', async () => {
    const res = await request(app).post('/api/jobs').send({ goal: '坑'.repeat(4001) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toMatch(/4000/);
    // 边界值本身必须通过
    const ok = await request(app).post('/api/jobs').send({ goal: '坑'.repeat(4000), demo: true });
    expect(ok.status).toBe(201);
    await waitForJob(app, ok.body.job.id);
  }, 30_000);

  it('不存在的 job id → 404；非法 id 也是 404（不能变成 500 或路径穿越）', async () => {
    for (const id of ['job_0000000000000000', 'job_zzzzzzzzzzzzzzzz', 'not-a-job', '../../etc/passwd']) {
      const res = await request(app).get(`/api/jobs/${encodeURIComponent(id)}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('模型全失败（第 5 阶段挂）→ job failed，但前面已完成的交付物必须保留', async () => {
    // 这里走**真实网关**（只把 HTTP 传输换掉），让 critique 阶段所有 provider 都返回 400。
    // 400 是不可重试的，网关会立刻换下一个 provider —— 5 个 provider 全挂 → 该阶段失败。
    // 用真实网关而不是假 callModel，是因为引擎的模型层最近在重构，
    // 「假 callModel 的返回形状」很容易过时（我就被这个坑了一次）。
    const realKeys = { aiping: process.env.AIPING_API_KEY, deepseek: process.env.DEEPSEEK_API_KEY };
    process.env.AIPING_API_KEY = 'sk-test-0000000000000000';
    process.env.DEEPSEEK_API_KEY = 'sk-test-0000000000000000';

    const outputs = (await import('../helpers/e2e-harness.js')).stageOutputs();
    let critiqueCalls = 0;
    const fakeFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const head = (body.messages?.[0]?.content ?? '').slice(0, 120);
      const stage =
        head.includes('改稿') ? 'revise'
          : head.includes('做出来') ? 'draft'
            : head.includes('项目经理') ? 'plan'
              : head.includes('接待员') ? 'intake'
                : head.includes('调研员') ? 'research'
                  : head.includes('审查员') ? 'critique'
                    : head.includes('质检员') ? 'verify'
                      : 'deliver';

      if (stage === 'critique') {
        critiqueCalls += 1;
        return {
          ok: false,
          status: 400,
          async text() {
            return '上游拒绝了这次请求（剧本：让第 5 个阶段彻底失败）';
          },
          async json() {
            return { error: 'bad request' };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(outputs[stage]) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          };
        },
        async text() {
          return JSON.stringify(outputs[stage]);
        },
      };
    };

    vi.stubGlobal('fetch', fakeFetch);
    let job;
    try {
      const created = await request(app).post('/api/jobs').send({ goal: '帮我审一份合同' });
      expect(created.status).toBe(201);
      job = await waitForJob(app, created.body.job.id, { timeoutMs: 60_000, intervalMs: 100 });
    } finally {
      vi.unstubAllGlobals();
      if (realKeys.aiping === undefined) delete process.env.AIPING_API_KEY;
      else process.env.AIPING_API_KEY = realKeys.aiping;
      if (realKeys.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = realKeys.deepseek;
    }
    expect(critiqueCalls).toBeGreaterThanOrEqual(1); // 确实打到了 critique

    // 1) 整个任务失败
    expect(job.status).toBe('failed');
    expect(job.error).not.toBeNull();

    // 2) 失败发生在第 5 个阶段，前面 4 个阶段都成功了
    expect(job.stages.find((s) => s.key === 'critique').status).toBe('failed');
    expect(job.stages.filter((s) => s.status === 'done').map((s) => s.key)).toEqual([
      'intake',
      'plan',
      'research',
      'draft',
    ]);

    // 3) draft 已经产出的交付物必须还在（用户不该白跑）
    expect(job.artifacts.length).toBeGreaterThanOrEqual(1);
    const dl = await request(app).get(`/api/jobs/${job.id}/artifacts/${job.artifacts[0].id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.text.length).toBeGreaterThan(80);

    // 4) 失败原因要能看懂，且不含密钥
    expect(job.error.message.length).toBeGreaterThan(0);
    expect(JSON.stringify(job.error)).not.toContain('sk-');
  }, 90_000);

  it('取消任务 → status 应为 cancelled，且取消之后不再有新的 stage 事件', async () => {
    const created = await request(app).post('/api/jobs').send({ goal: '取消测试：帮我写一份长报告', demo: true });
    const id = created.body.job.id;

    // demo 任务的 stages 是跑完才整体写回的，所以「跑起来了没有」要看事件总线：
    // 出现第一条 stage(running) 就说明流水线真的在动。
    await waitForJob(app, id, {
      until: () => events.since(id, 0).some((e) => e.type === 'stage' && e.status === 'running'),
      timeoutMs: 10_000,
      intervalMs: 25,
    });
    const cursorAtCancel = events.cursor(id);
    const cancelled = engine.cancelJob(id);
    expect(cancelled).toBe(true);

    const job = await waitForJob(app, id, { timeoutMs: 20_000, intervalMs: 50 });
    const after = events.since(id, cursorAtCancel);

    // 取消之后只允许出现 error / done / job 这几类事件
    expect(after.filter((e) => e.type === 'stage' && e.status === 'running')).toHaveLength(0);
    expect(after.filter((e) => e.type === 'artifact')).toHaveLength(0);
    expect(job.status).not.toBe('running');

    // 回归（缺陷 #4 已修复）：演示流水线抛的是 name=AbortError 的普通 Error，
    // 引擎现在同时认 code 和 name，所以正确判为「取消」而不是「失败」。
    // 用户主动取消却看到"任务失败"，会以为是自己弄坏了什么 —— 这个差别很重要。
    expect(job.status).toBe('cancelled');
    expect(job.error.message).toContain('取消');
  }, 40_000);

  it('回归（缺陷 #4 已修复）：用户主动取消 → status 为 cancelled', async () => {
    const created = await request(app).post('/api/jobs').send({ goal: '取消断言：帮我写方案', demo: true });
    const id = created.body.job.id;
    await waitForJob(app, id, {
      until: () => events.since(id, 0).some((e) => e.type === 'stage' && e.status === 'running'),
      timeoutMs: 10_000,
      intervalMs: 25,
    });
    engine.cancelJob(id);
    const job = await waitForJob(app, id, { timeoutMs: 20_000, intervalMs: 50 });
    expect(job.status).toBe('cancelled');
  }, 40_000);

  it('并发创建 5 个任务 → 全部跑完，且数据零污染（id / 阶段 / 产物都不串）', async () => {
    const goals = ['并发 1：看租房合同', '并发 2：写家长会讲稿', '并发 3：算早餐店成本', '并发 4：整理食谱', '并发 5：写海报文案'];
    const responses = await Promise.all(
      goals.map((goal) => request(app).post('/api/jobs').send({ goal, demo: true })),
    );
    const ids = responses.map((r) => r.body.job.id);

    expect(new Set(ids).size).toBe(5); // id 必须互不相同

    const jobs = await Promise.all(ids.map((id) => waitForJob(app, id, { timeoutMs: 60_000, intervalMs: 100 })));

    // ⚠️ 还要等**磁盘**也收敛到终态：内存状态先变、落盘是紧随其后的独立异步操作。
    // 这个窗口在单跑时只有 1ms，但在全仓并行时会被 I/O 竞争撑大，
    // 于是"读盘校验"偶尔会拿到上一版快照 —— 测试红，产品没问题。
    // 用 store 提供的同步点排空写队列，而不是靠 sleep 猜时间。
    await store.flushWrites();

    const allStageIds = [];
    const allArtifactIds = [];
    jobs.forEach((job, i) => {
      expect(job.status).toBe('done');
      expect(job.goal).toBe(goals[i]); // goal 没有串
      expect(job.stages.map((s) => s.key)).toEqual(STAGE_ORDER);
      expect(job.artifacts.length).toBeGreaterThanOrEqual(1);
      allStageIds.push(...job.stages.map((s) => s.id));
      allArtifactIds.push(...job.artifacts.map((a) => a.id));
    });

    // 产物 id 必须全局唯一（这是真的会串数据的地方）
    expect(new Set(allArtifactIds).size).toBe(allArtifactIds.length);
    // 阶段 id 只要求「任务内部唯一」：契约 §2 的示例就是 stage_1，
    // 事件总线 / 运行中登记表 / 前端节点表都以 jobId 为作用域，跨任务同名不会串。
    for (const job of jobs) {
      const ids = job.stages.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(allStageIds.length).toBe(40);

    // 落盘的内容必须与返回的一致，而且每个产物只能引用「自己任务的」阶段
    // （basedOn 不在 HTTP 视图里 —— 这也是缺陷 #2 的一部分，所以这里读落盘的全量记录）
    for (let i = 0; i < ids.length; i += 1) {
      const persisted = await store.getJob(ids[i]);
      expect(persisted.goal).toBe(goals[i]);
      expect(persisted.artifacts.length).toBe(jobs[i].artifacts.length);
      expect(persisted.stages.length).toBe(8);

      const ownStageIds = new Set(persisted.stages.map((s) => s.id));
      for (const art of persisted.artifacts) {
        expect(art.basedOn.length).toBeGreaterThan(0);
        for (const sid of art.basedOn) {
          expect(ownStageIds.has(sid)).toBe(true); // 不能引用别的任务的阶段
        }
      }
      // 别人的产物一个都不能混进来
      const others = new Set(allArtifactIds.filter((aid) => !persisted.artifacts.some((a) => a.id === aid)));
      for (const art of persisted.artifacts) expect(others.has(art.id)).toBe(false);
    }
  }, 90_000);

  it('限流：同一 IP 第 11 次 POST /api/jobs → 429（契约 §5.7）', async () => {
    const limited = createApp(); // 这个 app 打开限流
    let last = null;
    for (let i = 0; i < 11; i += 1) {
      // 故意用空 goal：被限流挡下的请求不会真的创建任务
      last = await request(limited).post('/api/jobs').send({ goal: '' });
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('RATE_LIMITED');
    limited.locals.rateLimiter?.dispose?.();
  });

  it('非法的 JSON body → 400（不能被当成空对象放过）', async () => {
    const res = await request(app).post('/api/jobs').set('Content-Type', 'application/json').send('{不是 JSON');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('回归（缺陷 #5 已修复）：前端发 { message } 与契约的 { text } 都必须能用', async () => {
    // 这是「两边各自的测试都绿、合起来 100% 坏」的典型案例：
    // public/api.js 发 { message }，routes/jobs.js 原本只读 req.body.text。
    // 用户点"补充要求"永远 400 —— 而两边的单测都发现不了。
    // 每条断言用**独立的任务**。
    // 原因：sendMessage 会让流水线从 draft 起重跑，同一个任务连发两次时
    // 第二次会撞上"任务正在执行中"→ 409（这是正确行为，app.js 也会禁用输入框）。
    // 之前这里共用一个 job，导致偶发 409 flake。
    // 每个断言用独立任务；等到引擎真正释放占位（状态稳定 + 再等一拍）再发，
    // 否则偶尔会撞上"任务刚结束、占位还在"的 409 —— 那是正确行为，不是缺陷。
    const send = async (body) => {
      const created = await request(app).post('/api/jobs').send({ goal: '消息字段测试', demo: true });
      const id = created.body.job.id;
      for (let i = 0; i < 200; i += 1) {
        const j = (await request(app).get(`/api/jobs/${id}`)).body.job;
        if (j && j.status !== 'running' && j.status !== 'queued') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 400));
      return request(app).post(`/api/jobs/${id}/message`).send(body);
    };

    expect((await send({ message: '再补一句' })).status).toBe(200); // 前端用的名字
    expect((await send({ text: '再补一句' })).status).toBe(200); // 契约里的名字
    expect((await send({})).status).toBe(400); // 两个都不给 → 400，不能静默接受空消息
  }, 120_000);

  it('回归：模型把 confidence 写成 "0.95" → 不会再毁掉输出，任务照常 done（缺陷 #1 已修复）', async () => {
    // 这一条走**真实网关**（只把 HTTP 传输换掉），因为收敛发生在 schema-check 里。
    // 这是最有价值的一条回归：收敛逻辑本来就是为了救回这种输出，
    // 一旦它又变成「把 artifacts 数组改成 true」，整条真实流水线会当场挂掉。
    const realKeys = { aiping: process.env.AIPING_API_KEY, deepseek: process.env.DEEPSEEK_API_KEY };
    process.env.AIPING_API_KEY = 'sk-test-0000000000000000';
    process.env.DEEPSEEK_API_KEY = 'sk-test-0000000000000000';

    const outputs = (await import('../helpers/e2e-harness.js')).stageOutputs({ confidence: '0.95' });
    let calls = 0;
    const fakeFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const system = body.messages?.[0]?.content ?? '';
      // 分派必须用「角色行」这一段判断，而且顺序有讲究：
      // plan 的提示词正文里也出现了「接待员」三个字（"把接待员的结论…"），
      // 先判「接待员」会把 plan 的请求错当成 intake —— 这个坑我自己先踩了一次。
      const head = system.slice(0, 120);
      const stage =
        head.includes('改稿') ? 'revise'
          : head.includes('做出来') ? 'draft'
            : head.includes('项目经理') ? 'plan'
              : head.includes('接待员') ? 'intake'
                : head.includes('调研员') ? 'research'
                  : head.includes('审查员') ? 'critique'
                    : head.includes('质检员') ? 'verify'
                      : 'deliver';
      calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(outputs[stage]) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          };
        },
        async text() {
          return JSON.stringify(outputs[stage]);
        },
      };
    };

    vi.stubGlobal('fetch', fakeFetch);
    let job;
    try {
      const created = await request(app).post('/api/jobs').send({ goal: '回归：审一份合同' });
      job = await waitForJob(app, created.body.job.id, { timeoutMs: 30_000, intervalMs: 100 });
    } finally {
      vi.unstubAllGlobals();
      if (realKeys.aiping === undefined) delete process.env.AIPING_API_KEY;
      else process.env.AIPING_API_KEY = realKeys.aiping;
      if (realKeys.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = realKeys.deepseek;
    }

    expect(calls).toBeGreaterThanOrEqual(8); // 8 个阶段，每个至少一次
    // 好消息：收敛逻辑不再毁掉输出，任务能跑完（缺陷 #1 已修）
    expect(job.status).toBe('done');
    expect(job.stages.every((s) => s.status === 'done')).toBe(true);
    expect(job.artifacts.length).toBeGreaterThanOrEqual(1);
    const dl = await request(app).get(`/api/jobs/${job.id}/artifacts/${job.artifacts[0].id}/download`);
    expect(dl.text.length).toBeGreaterThan(80); // 正文没被收敛逻辑毁掉

    // 坏消息（缺陷 #11，见 docs/reports/S8-QA.md）：
    // draft/revise 改成「定界符长文本协议」（schema:null）之后，**结构校验就完全没人做了**；
    // 模型偶尔仍会输出 JSON，stages.js:171 的「退路一」直接 `jsonAttempt.artifacts` 原样收下，
    // 不做 schema 校验、也不做语义收敛 —— 于是 "0.95" 进了 artifact，
    // 违反契约（confidence 只能是 high|medium|low，前端徽章映射表里也没有 "0.95"）。
    expect(job.artifacts[0].confidence).toBe('0.95');
  }, 60_000);

  it.fails('【缺陷 #11】收敛结果应写回调用方：artifact.confidence 应为 high，不是 "0.95"', async () => {
    const realKeys = { aiping: process.env.AIPING_API_KEY, deepseek: process.env.DEEPSEEK_API_KEY };
    process.env.AIPING_API_KEY = 'sk-test-0000000000000000';
    process.env.DEEPSEEK_API_KEY = 'sk-test-0000000000000000';
    const outputs = (await import('../helpers/e2e-harness.js')).stageOutputs({ confidence: '0.95' });
    const fakeFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const head = (body.messages?.[0]?.content ?? '').slice(0, 120);
      const stage =
        head.includes('改稿') ? 'revise'
          : head.includes('做出来') ? 'draft'
            : head.includes('项目经理') ? 'plan'
              : head.includes('接待员') ? 'intake'
                : head.includes('调研员') ? 'research'
                  : head.includes('审查员') ? 'critique'
                    : head.includes('质检员') ? 'verify'
                      : 'deliver';
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ index: 0, message: { content: JSON.stringify(outputs[stage]) }, finish_reason: 'stop' }], usage: {} };
        },
        async text() {
          return JSON.stringify(outputs[stage]);
        },
      };
    };
    vi.stubGlobal('fetch', fakeFetch);
    try {
      const created = await request(app).post('/api/jobs').send({ goal: '收敛写回断言' });
      const job = await waitForJob(app, created.body.job.id, { timeoutMs: 60_000, intervalMs: 100 });
      expect(job.artifacts[0].confidence).toBe('high');
    } finally {
      vi.unstubAllGlobals();
      if (realKeys.aiping === undefined) delete process.env.AIPING_API_KEY;
      else process.env.AIPING_API_KEY = realKeys.aiping;
      if (realKeys.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = realKeys.deepseek;
    }
  }, 60_000);

  it('演示数据模块本身没问题：fixtures 能直接跑完一条任务（与引擎解耦）', async () => {
    const job = await fixtures.runDemoPipeline('独立验证', () => {}, { stepMs: 1 });
    expect(job.status).toBe('done');
    expect(job.artifacts.length).toBe(3);
    expect(memoryJob('job_not_exist')).toBeNull();
    expect(fs.existsSync(dataDir)).toBe(true);
  });
});
