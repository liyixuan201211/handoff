/**
 * HTTP 路由 + 服务装配测试。
 *
 * engine 用 vi.mock 换掉：路由的行为（校验、状态码、限流、文件名清洗）
 * 不该依赖流水线是否写完，也不该打真模型。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const TMP_BASE = path.join(os.tmpdir(), `handoff-test-routes-${process.pid}-${Date.now()}`);
process.env.HANDOFF_DATA_DIR = TMP_BASE;

/* ---------------- mock engine（文件还不存在也必须能跑） ---------------- */
const engine = vi.hoisted(() => ({
  startJob: vi.fn(),
  sendMessage: vi.fn(),
  retryJob: vi.fn(),
  cancelJob: vi.fn(),
}));

vi.mock('../../src/pipeline/engine.js', () => engine);

const { createApp, createRateLimiter, RATE_RULES, loadTemplates } = await import('../../src/server.js');
const store = await import('../../src/store/json-store.js');
const { events } = await import('../../src/store/events.js');
const { newId } = await import('../../src/store/events.js');

const jobsDir = () => path.join(TMP_BASE, 'jobs');

function makeJob(overrides = {}) {
  const now = Date.now();
  return {
    id: newId('job'),
    goal: '帮我把这份租房合同看一遍，我怕有坑',
    templateId: null,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    plan: {
      title: '租房合同风险审查',
      intent: '用户想确认合同里有没有对自己不利的条款',
      assumptions: ['合同是中文的'],
      risks: ['可能缺失关键条款'],
      deliverables: [{ id: 'd1', name: '风险清单', format: 'markdown' }],
    },
    stages: [
      {
        id: 'stage_1',
        key: 'intake',
        title: '理解需求',
        role: '接待员',
        status: 'done',
        startedAt: now,
        endedAt: now,
        ms: 12,
        reason: '先听懂用户要什么',
        log: [{ at: now, level: 'info', text: '收到需求' }],
        output: { intent: '审查合同' },
        error: null,
      },
    ],
    artifacts: [
      {
        id: 'art_0123456789abcdef',
        deliverableId: 'd1',
        name: overrides.artifactName ?? '风险清单',
        format: 'markdown',
        content: `# 风险清单\n\n${'这是一条风险说明。'.repeat(20)}`,
        assumptions: ['合同为中文'],
        confidence: 'high',
        basedOn: ['stage_1'],
        createdAt: now,
      },
    ],
    review: null,
    security: null,
    usage: { calls: 1, promptTokens: 10, completionTokens: 20, ms: 30 },
    clarifyQuestions: [],
    error: null,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  store.resetStore();
  events.drop('*');
  await fs.rm(TMP_BASE, { recursive: true, force: true });
  await fs.mkdir(jobsDir(), { recursive: true });
  engine.startJob.mockImplementation(async (input) => makeJob({ goal: input.goal, status: 'queued' }));
  engine.sendMessage.mockResolvedValue({ ok: true });
  engine.retryJob.mockImplementation(async (id) => store.getJob(id));
  engine.cancelJob.mockReturnValue(true);
});

afterAll(async () => {
  store.stopSyncTimer();
  store.resetStore();
  await fs.rm(TMP_BASE, { recursive: true, force: true });
});

/* ================================================================== */
describe('POST /api/jobs', () => {
  const app = createApp({ rateLimit: false });

  it('正常创建：201 + job，且不等待流水线跑完', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .send({ goal: '帮我把这份租房合同看一遍，我怕有坑' });
    expect(res.status).toBe(201);
    expect(res.body.job.id).toMatch(/^job_[a-z0-9]{8,32}$/);
    expect(res.body.job.goal).toBe('帮我把这份租房合同看一遍，我怕有坑');
    expect(engine.startJob).toHaveBeenCalledTimes(1);
    expect(engine.startJob.mock.calls[0][0]).toMatchObject({
      goal: '帮我把这份租房合同看一遍，我怕有坑',
      tone: null,
      demo: false,
    });
  });

  it('选项字段被规整', async () => {
    await request(app).post('/api/jobs').send({
      goal: '做一个家长会用的成绩分析表',
      templateId: 'grade-analysis',
      audience: '学生家长',
      tone: 'simple',
      deadline: '2026-10-01T00:00:00.000Z',
      demo: true,
    });
    expect(engine.startJob.mock.calls[0][0]).toMatchObject({
      templateId: 'grade-analysis',
      audience: '学生家长',
      tone: 'simple',
      deadline: '2026-10-01T00:00:00.000Z',
      demo: true,
    });
  });

  it('缺 goal → 400', async () => {
    const res = await request(app).post('/api/jobs').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(engine.startJob).not.toHaveBeenCalled();
  });

  it('goal 超长（>4000）→ 400', async () => {
    const res = await request(app).post('/api/jobs').send({ goal: '啊'.repeat(4001) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('4000');
  });

  it('goal 恰好 4000 字 → 201', async () => {
    const res = await request(app).post('/api/jobs').send({ goal: '啊'.repeat(4000) });
    expect(res.status).toBe(201);
  });

  it('goal 全是控制字符 → 400（剥离后为空）', async () => {
    const res = await request(app).post('/api/jobs').send({ goal: '\u0000\u0001\u0002\u0007' });
    expect(res.status).toBe(400);
  });

  it('非法 JSON → 400 而不是 500', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .set('Content-Type', 'application/json')
      .send('{"goal": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('请求体超过 256kb → 413', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .send({ goal: 'x'.repeat(300 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('engine 抛 AppError → 用它的状态码与文案', async () => {
    const { AppError, ERR } = await import('../../src/llm/errors.js');
    engine.startJob.mockRejectedValueOnce(
      new AppError(ERR.SECURITY_BLOCKED, '这个请求我们不能受理。', { status: 400 }),
    );
    const res = await request(app).post('/api/jobs').send({ goal: '正常的需求' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SECURITY_BLOCKED');
  });
});

/* ================================================================== */
describe('列表与详情', () => {
  const app = createApp({ rateLimit: false });

  it('GET /api/jobs 返回摘要（轻量，不含交付物正文）', async () => {
    const job = await store.saveJob(makeJob());
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].id).toBe(job.id);
    expect(res.body.jobs[0].stageCount).toBe(1);
    expect(res.body.jobs[0].artifactCount).toBe(1);
    expect(res.body.jobs[0].stages).toBeUndefined();
  });

  it('GET /api/jobs 最多 50 条', async () => {
    for (let i = 0; i < 55; i += 1) await store.saveJob(makeJob());
    const res = await request(app).get('/api/jobs');
    expect(res.body.jobs).toHaveLength(50);
  });

  it('GET /api/jobs/:id 返回全量（含 stage 日志），但不含交付物正文', async () => {
    const job = await store.saveJob(makeJob());
    const res = await request(app).get(`/api/jobs/${job.id}`);
    expect(res.status).toBe(200);
    expect(res.body.job.stages[0].log[0].text).toBe('收到需求');
    expect(res.body.job.artifacts[0].name).toBe('风险清单');
    expect(res.body.job.artifacts[0].content).toBeUndefined();
    expect(res.body.job.artifacts[0].bytes).toBeGreaterThan(80);
  });

  it('不存在的 id → 404', async () => {
    const res = await request(app).get(`/api/jobs/${newId('job')}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('非法 id（路径穿越形态）→ 404，不泄漏文件系统信息', async () => {
    const res = await request(app).get('/api/jobs/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('/etc');
  });
});

/* ================================================================== */
describe('message / retry / delete', () => {
  const app = createApp({ rateLimit: false });

  it('POST /message 正常：调 engine.sendMessage 并回最新 job', async () => {
    const job = await store.saveJob(makeJob({ status: 'awaiting_input' }));
    const res = await request(app).post(`/api/jobs/${job.id}/message`).send({ text: '我是承租方' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(engine.sendMessage).toHaveBeenCalledWith(job.id, '我是承租方');
  });

  it('POST /message 空文本 → 400', async () => {
    const job = await store.saveJob(makeJob());
    const res = await request(app).post(`/api/jobs/${job.id}/message`).send({ text: '   ' });
    expect(res.status).toBe(400);
    expect(engine.sendMessage).not.toHaveBeenCalled();
  });

  it('POST /message 超长（>2000）→ 400', async () => {
    const job = await store.saveJob(makeJob());
    const res = await request(app).post(`/api/jobs/${job.id}/message`).send({ text: '啊'.repeat(2001) });
    expect(res.status).toBe(400);
  });

  it('POST /message 对不存在的 job → 404', async () => {
    const res = await request(app).post(`/api/jobs/${newId('job')}/message`).send({ text: '在吗' });
    expect(res.status).toBe(404);
  });

  it('POST /retry 正常', async () => {
    const job = await store.saveJob(makeJob({ status: 'failed' }));
    const res = await request(app).post(`/api/jobs/${job.id}/retry`).send({});
    expect(res.status).toBe(200);
    expect(engine.retryJob).toHaveBeenCalledWith(job.id);
  });

  it('POST /retry 对不存在的 job → 404', async () => {
    const res = await request(app).post(`/api/jobs/${newId('job')}/retry`).send({});
    expect(res.status).toBe(404);
  });

  it('DELETE 正常：先取消再删盘', async () => {
    const job = await store.saveJob(makeJob());
    const res = await request(app).delete(`/api/jobs/${job.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: job.id });
    expect(engine.cancelJob).toHaveBeenCalledWith(job.id);
    expect(await store.getJob(job.id)).toBeNull();
  });

  it('DELETE 不存在 → 404', async () => {
    const res = await request(app).delete(`/api/jobs/${newId('job')}`);
    expect(res.status).toBe(404);
  });
});

/* ================================================================== */
describe('交付物下载', () => {
  const app = createApp({ rateLimit: false });

  it('正常下载：markdown + attachment + 正文', async () => {
    const job = await store.saveJob(makeJob());
    const res = await request(app).get(`/api/jobs/${job.id}/artifacts/art_0123456789abcdef/download`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.text).toContain('# 风险清单');
    // 中文文件名走 RFC 5987
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(res.headers['content-disposition']).toContain(encodeURIComponent('风险清单.md'));
  });

  it('危险文件名被清洗（路径穿越 / 引号 / 换行 / 控制字符）', async () => {
    const evil = '../../etc/passwd"\r\nX-Injected: 1';
    const job = await store.saveJob(makeJob({ artifactName: evil }));
    const res = await request(app).get(`/api/jobs/${job.id}/artifacts/art_0123456789abcdef/download`);
    expect(res.status).toBe(200);
    const cd = res.headers['content-disposition'];
    expect(cd).not.toContain('..');
    expect(cd).not.toContain('/');
    expect(cd).not.toContain('\\');
    expect(cd).not.toContain('\r');
    expect(cd).not.toContain('\n');
    expect(cd).not.toContain('"X-Injected');
    expect(res.headers['x-injected']).toBeUndefined();
  });

  it('文件名清洗：空值 / 只有符号 / 超长 / Windows 保留名都有兜底', async () => {
    const { sanitizeFilename } = await import('../../src/routes/jobs.js');
    expect(sanitizeFilename('', 'deliverable')).toBe('deliverable');
    expect(sanitizeFilename('///', 'deliverable')).toBe('deliverable');
    expect(sanitizeFilename('....', 'deliverable')).toBe('deliverable');
    expect(sanitizeFilename('CON', 'deliverable')).toBe('deliverable');
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j', 'deliverable')).toBe('a b c d e f g h i j');
    expect(sanitizeFilename('x'.repeat(200), 'deliverable')).toHaveLength(80);
    expect(sanitizeFilename(' 风险 清单 ', 'deliverable')).toBe('风险 清单');
  });

  it('artifactId 不存在 → 404', async () => {
    const job = await store.saveJob(makeJob());
    const res = await request(app).get(`/api/jobs/${job.id}/artifacts/art_notexist/download`);
    expect(res.status).toBe(404);
  });
});

/* ================================================================== */
describe('SSE 流', () => {
  const app = createApp({ rateLimit: false });

  it('job 不存在 → 404 JSON（不是挂住的空连接）', async () => {
    const res = await request(app).get(`/api/jobs/${newId('job')}/stream`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('sseHandler 先补发历史再推增量，并在 cleanup 后停止推送', async () => {
    const { sseHandler } = await import('../../src/util/sse.js');
    const jobId = newId('job');

    // 连接前已有 2 条历史
    events.publish(jobId, { type: 'stage', stageId: 'stage_1', status: 'running' });
    events.publish(jobId, { type: 'log', stageId: 'stage_1', level: 'info', text: '干活中' });

    const written = [];
    const listeners = new Map();
    const fakeReq = {
      query: {},
      headers: {},
      on(ev, fn) {
        listeners.set(ev, fn);
      },
      off(ev) {
        listeners.delete(ev);
      },
    };
    const fakeRes = {
      headers: {},
      status() {
        return this;
      },
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      flushHeaders() {},
      write(chunk) {
        written.push(chunk);
      },
      flush() {},
      on(ev, fn) {
        listeners.set(`res:${ev}`, fn);
      },
      off(ev) {
        listeners.delete(`res:${ev}`);
      },
    };

    const cleanup = sseHandler({ jobId, req: fakeReq, res: fakeRes });
    const first = written.join('');
    expect(fakeRes.headers['content-type']).toContain('text/event-stream');
    expect(fakeRes.headers['cache-control']).toContain('no-cache');
    expect(fakeRes.headers['x-accel-buffering']).toBe('no');
    // 历史两条都补发了，且带 id: <seq>
    expect(first).toContain('id: 1');
    expect(first).toContain('id: 2');
    expect(first).toContain('event: message');
    expect(first).toContain('"type":"log"');

    // 增量
    events.publish(jobId, { type: 'done', status: 'done' });
    expect(written.join('')).toContain('id: 3');
    expect(written.join('')).toContain('"type":"done"');

    // 清理后：不再推送，监听器归零
    expect(events.listenerCount(jobId)).toBe(1);
    cleanup();
    expect(events.listenerCount(jobId)).toBe(0);
    const before = written.length;
    events.publish(jobId, { type: 'job', job: { id: jobId } });
    expect(written.length).toBe(before);
    cleanup(); // 幂等
    expect(events.listenerCount(jobId)).toBe(0);
  });

  it('?since= 与 Last-Event-ID 取较大者，只补发之后的事件', async () => {
    const { resolveSince } = await import('../../src/util/sse.js');
    expect(resolveSince({ query: { since: '5' }, headers: { 'last-event-id': '3' } })).toBe(5);
    expect(resolveSince({ query: {}, headers: { 'last-event-id': '9' } })).toBe(9);
    expect(resolveSince({ query: { since: 'abc' }, headers: {} })).toBe(0);
    expect(resolveSince({ query: { since: '-4' }, headers: {} })).toBe(0);
  });
});

/* ================================================================== */
describe('限流', () => {
  it('POST /api/jobs 第 11 次 → 429 RATE_LIMITED', async () => {
    const app = createApp();
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await request(app).post('/api/jobs').send({ goal: `第 ${i} 个需求` });
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('RATE_LIMITED');
    expect(last.body.error.message).toBe('操作太快了，请稍等一分钟再试');
    expect(last.headers['retry-after']).toBeDefined();
    expect(engine.startJob).toHaveBeenCalledTimes(10);
    app.locals.rateLimiter.dispose();
  });

  it('/message 每分钟 20 次', async () => {
    const app = createApp();
    const job = await store.saveJob(makeJob());
    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await request(app).post(`/api/jobs/${job.id}/message`).send({ text: `补充 ${i}` });
    }
    expect(last.status).toBe(429);
    expect(engine.sendMessage).toHaveBeenCalledTimes(20);
    app.locals.rateLimiter.dispose();
  });

  it('GET 不受限流影响', async () => {
    const app = createApp();
    for (let i = 0; i < 30; i += 1) {
      const res = await request(app).get('/api/jobs');
      expect(res.status).toBe(200);
    }
    app.locals.rateLimiter.dispose();
  });

  it('rateLimit:false 时完全不限流', async () => {
    const app = createApp({ rateLimit: false });
    for (let i = 0; i < 15; i += 1) {
      const res = await request(app).post('/api/jobs').send({ goal: `需求 ${i}` });
      expect(res.status).toBe(201);
    }
    expect(app.locals.rateLimiter).toBeNull();
  });

  it('窗口过期后恢复（注入可控时钟）', async () => {
    let now = 1_000_000;
    const limiter = createRateLimiter({ rules: RATE_RULES, now: () => now });
    const app = createApp({ rateLimit: false });
    app.use(limiter);
    const send = () => request(app).post('/api/jobs').send({ goal: 'x' });
    for (let i = 0; i < 10; i += 1) await send();
    expect((await send()).status).toBe(429);
    now += 61_000;
    expect((await send()).status).toBe(201);
    limiter.dispose();
  });
});

/* ================================================================== */
describe('服务装配', () => {
  it('GET /api/health 返回 ok/version/models/dataDir/jobs 且不含任何 key', async () => {
    const app = createApp({ rateLimit: false });
    await store.saveJob(makeJob());
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.version).toBe('string');
    expect(res.body.uptimeMs).toBeGreaterThan(0);
    expect(Array.isArray(res.body.models)).toBe(true);
    expect(res.body.models.length).toBeGreaterThan(0);
    expect(res.body.dataDir).toBe(TMP_BASE);
    expect(res.body.jobs).toBe(1);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{12,}/);
    expect(raw).not.toMatch(/QC-[A-Za-z0-9-]{16,}/);
    expect(raw).not.toMatch(/apiKey|api_key|"key"/i);
    for (const m of res.body.models) {
      expect(m.key).toBeUndefined();
      expect(m.apiKey).toBeUndefined();
      expect(typeof m.configured).toBe('boolean');
    }
  });

  it('GET /api/templates 在目录不存在时返回空数组而不是 500', async () => {
    const app = createApp({ rateLimit: false });
    expect(await loadTemplates(path.join(TMP_BASE, 'nope'))).toEqual([]);
    const res = await request(app).get('/api/templates');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.templates)).toBe(true);
  });

  it('GET /api/templates 能读目录里的 json，并跳过损坏文件', async () => {
    const dir = path.join(TMP_BASE, 'templates');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify({ id: 'a', title: '合同审查' }), 'utf8');
    await fs.writeFile(path.join(dir, 'b.json'), '{ 坏掉的 json', 'utf8');
    const list = await loadTemplates(dir);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'a', title: '合同审查' });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('未知 API 路径 → JSON 404；未知页面 → HTML 404/SPA', async () => {
    const app = createApp({ rateLimit: false });
    const api = await request(app).get('/api/nope');
    expect(api.status).toBe(404);
    expect(api.body.error.code).toBe('NOT_FOUND');

    const page = await request(app).get('/some/deep/page');
    expect(page.status).toBe(200); // SPA 兜底（public/index.html 或占位页）
    expect(page.headers['content-type']).toContain('html');
  });

  it('未知异常 → 500 且不泄漏内部堆栈 / 密钥', async () => {
    const app = createApp({ rateLimit: false });
    const { AppError } = await import('../../src/llm/errors.js');
    engine.startJob.mockRejectedValueOnce(
      new Error('内部实现细节：sk-abcdefghijklmnopqrstuvwxyz 崩了 at /secret/path.js:1'),
    );
    const res = await request(app).post('/api/jobs').send({ goal: '正常需求' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(raw).not.toContain('/secret/path.js');
    expect(raw).not.toContain('内部实现细节');
    expect(AppError).toBeDefined();
  });

  it('createApp 是纯装配：不监听端口', async () => {
    const app = createApp({ rateLimit: false });
    expect(typeof app.listen).toBe('function');
    expect(app.locals.rateLimiter).toBeNull();
  });
});
