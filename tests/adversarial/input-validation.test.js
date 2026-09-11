/**
 * S9 对抗性测试 · 畸形输入与响应头注入
 *
 * 攻击面：POST /api/jobs 的每一个字段、下载端点的 artifactId 与文件名、
 *         404/413 的错误形状、以及"哪些东西不该出现在响应里"。
 *
 * 所有用例都不打真网络：畸形请求在进入流水线之前就该被拦住；
 * 少数需要"一个真任务"的用例用 demo 模式。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import request from 'supertest';

import { createApp } from '../../src/server.js';
import * as engine from '../../src/pipeline/engine.js';
import * as store from '../../src/store/json-store.js';
import { events } from '../../src/store/events.js';

let dataDir = null;
let app = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newJobId = () => `job_${crypto.randomBytes(8).toString('hex')}`;

/** 直接落一份"已完成"的 job 到磁盘（用来测下载端点，不用等流水线） */
async function seedJob({ name = '交付物', content = '# 标题\n\n' + '正文。'.repeat(60), extra = {} } = {}) {
  const id = newJobId();
  await store.saveJob({
    id,
    goal: '对抗性测试：下载端点',
    templateId: null, templateTitle: null, audience: null, tone: 'normal', deadline: null,
    demo: true, status: 'done',
    createdAt: Date.now() - 1000, updatedAt: Date.now(),
    plan: { title: '测试方案', intent: 'i', assumptions: [], risks: [], deliverables: [{ id: 'd1', name, format: 'markdown' }] },
    stages: [
      { id: 'stage_1', key: 'intake', title: '理解需求', role: '接待员', status: 'done', startedAt: 1, endedAt: 2, ms: 1, log: [], output: null, error: null },
    ],
    artifacts: [{
      id: 'art_target', deliverableId: 'd1', name, format: 'markdown', content,
      assumptions: [], confidence: 'high', basedOn: ['stage_1'], createdAt: Date.now(),
    }],
    review: null, security: null, usage: {}, clarifyQuestions: [], error: null,
    ...extra,
  });
  return id;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-adv-input-'));
  process.env.HANDOFF_DATA_DIR = dataDir;
  await store.loadFromDisk({ force: true });
  await engine.loadOptionalDeps();
  app = createApp({ rateLimit: false });
}, 30_000);

afterEach(async () => {
  // 造出来的 job 立刻删掉，别把临时目录撑大 / 影响其它用例
  const jobs = await store.listJobs(200);
  for (const j of jobs) {
    if (typeof j.goal === 'string' && j.goal.startsWith('对抗性测试')) await store.deleteJob(j.id);
  }
});

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/* ================================================================== *
 * 攻击 1：goal 的类型与边界
 * ================================================================== */
describe('攻击：goal 字段的类型与边界', () => {
  // 【缺陷 S9-9】契约说 goal 是「字符串，1..4000 字」，实际任何类型都被 String() 收下
  it('回归（缺陷 S9-9 已修复）：goal 传数字/布尔/数组/对象必须 400', async () => {
    const cases = [12345, true, ['a', 'b'], { a: 1 }, 3.14, [null], { toString: null }];
    const accepted = [];
    for (const goal of cases) {
      const res = await request(app).post('/api/jobs').send({ goal, demo: true });
      accepted.push({ goal: JSON.stringify(goal), status: res.status, stored: res.body?.job?.goal });
    }
    // 修复前：全部 201，且被 String() 成 "12345" / "true" / "a,b" / "[object Object]"
    // 修复后：一律 400，绝不让 [object Object] 变成任务目标
    expect(accepted.filter((a) => a.status === 201)).toEqual([]);
    expect(accepted.every((a) => a.status === 400)).toBe(true);
  }, 30_000);

  it('回归（缺陷 S9-9 已修复）：goal 是纯对象时返回 400，而不是存成 "[object Object]"', async () => {
    const res = await request(app).post('/api/jobs').send({ goal: { a: 1, b: 2 }, demo: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  }, 30_000);

  it('goal 缺失 / null / 空串 / 纯空白 / 纯控制字符 → 400', async () => {
    for (const goal of [undefined, null, '', '   ', '\u0000\u0001\u0002', '\t\n\r']) {
      const res = await request(app).post('/api/jobs').send({ goal });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    }
  }, 30_000);

  it('goal 长度按 UTF-16 码元算：4000 个 emoji 被判成 8000 字', async () => {
    // 这不是崩溃，而是**错误信息对用户撒谎**：他只贴了 4000 个字符
    const emoji = '😀'.repeat(4000);
    const res = await request(app).post('/api/jobs').send({ goal: emoji, demo: true });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('8000');
    // 换成人话：用户看到的是"你输入了 8000 字"，但他数出来只有 4000
    expect(res.body.error.message).toContain('4000');
  }, 30_000);

  it('4000 个换行被当成空输入（控制字符剥掉后长度不足）', async () => {
    const res = await request(app).post('/api/jobs').send({ goal: '\n'.repeat(4000), demo: true });
    expect(res.status).toBe(400);
  }, 30_000);
});

/* ================================================================== *
 * 攻击 2：templateId 的类型与路径穿越
 * ================================================================== */
describe('攻击：templateId 的类型与路径穿越', () => {
  it('路径穿越形态的 templateId 一律读不到模板（静默降级为 null）', async () => {
    for (const t of ['../../../etc/passwd', '..%2F..%2F', '../../etc/passwd', '....//....//etc/passwd', '/etc/passwd', '..\\..\\windows\\win.ini']) {
      const res = await request(app).post('/api/jobs').send({ goal: `模板穿越 ${t}`, templateId: t, demo: true });
      expect(res.status).toBe(201);
      expect(res.body.job.templateId).toBe(null);
      await request(app).delete(`/api/jobs/${res.body.job.id}`);
    }
  }, 30_000);

  it('templateId 传 null / 数字 / 对象 / 布尔不会 500', async () => {
    for (const t of [null, 123, { a: 1 }, true, ['x'], '']) {
      const res = await request(app).post('/api/jobs').send({ goal: '模板类型攻击', templateId: t, demo: true });
      expect([201, 400]).toContain(res.status);
      if (res.status === 201) await request(app).delete(`/api/jobs/${res.body.job.id}`);
    }
  }, 30_000);

  it('templateId 超长（>64 字）→ 400', async () => {
    const res = await request(app).post('/api/jobs').send({ goal: '超长模板 id', templateId: 'a'.repeat(65), demo: true });
    expect(res.status).toBe(400);
  }, 30_000);
});

/* ================================================================== *
 * 攻击 3：请求体体积 / Content-Type / JSON 形状
 * ================================================================== */
describe('攻击：请求体与 Content-Type', () => {
  it('100MB 请求体 → 413（不是崩溃、不是 500）', async () => {
    const huge = 'x'.repeat(100 * 1024 * 1024);
    const res = await request(app)
      .post('/api/jobs')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ goal: huge }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  }, 60_000);

  it('256kb 边界：刚刚超过 → 413；刚好在里面 → 走正常校验', async () => {
    const over = 'x'.repeat(300 * 1024);
    const r1 = await request(app).post('/api/jobs').set('content-type', 'application/json').send(JSON.stringify({ goal: over }));
    expect(r1.status).toBe(413);

    const ok = 'x'.repeat(200 * 1024);
    const r2 = await request(app).post('/api/jobs').send({ goal: ok, demo: true });
    // 体积没超，但 goal 太长 → 400（长度校验先于流水线）
    expect(r2.status).toBe(400);
  }, 60_000);

  it('Content-Type: text/plain 但 body 是 JSON → 400，不解析也不崩', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .set('content-type', 'text/plain')
      .send(JSON.stringify({ goal: '你好', demo: true }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  }, 30_000);

  it('非法 JSON → 400 且错误形状符合契约 §2', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .set('content-type', 'application/json')
      .send('{"goal": "未闭合}');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(typeof res.body.error.message).toBe('string');
  }, 30_000);

  it('body 是 JSON 数组 / 字符串字面量 / null → 不崩', async () => {
    for (const raw of ['[]', '"hello"', 'null', '123', 'true']) {
      const res = await request(app).post('/api/jobs').set('content-type', 'application/json').send(raw);
      expect([400, 201]).toContain(res.status);
      if (res.status === 201) await request(app).delete(`/api/jobs/${res.body.job.id}`);
    }
  }, 30_000);
});

/* ================================================================== *
 * 攻击 4：下载端点的 artifactId 与文件名
 * ================================================================== */
describe('攻击：交付物下载端点', () => {
  it('artifactId 路径穿越 / 空字节 / 超长 → 404，不读文件系统', async () => {
    const id = await seedJob();
    for (const aid of [
      '../../../../etc/passwd',
      '..%2F..%2F..%2Fetc%2Fpasswd',
      '%00',
      '.',
      '..',
      'a'.repeat(500),
      'art_target/../../../../etc/passwd',
      'art_target\u0000.json',
    ]) {
      const res = await request(app).get(`/api/jobs/${id}/artifacts/${encodeURIComponent(aid)}/download`);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('root:');
    }
    await store.deleteJob(id);
  }, 30_000);

  it('正常 artifactId 能下载到 markdown，且带 RFC 5987 文件名', async () => {
    const id = await seedJob({ name: '合同风险清单' });
    const res = await request(app).get(`/api/jobs/${id}/artifacts/art_target/download`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await store.deleteJob(id);
  }, 30_000);

  it('交付物名字里的换行 / 引号 / 控制字符不会注入响应头', async () => {
    const names = [
      'a"b\r\nX-Injected: yes',
      '\r\n\r\n<script>alert(1)</script>',
      'x%00y',
      'newline\nname',
      '中文名字\r\nSet-Cookie: a=1',
      'semi;colon',
    ];
    for (const name of names) {
      const id = await seedJob({ name });
      const res = await request(app).get(`/api/jobs/${id}/artifacts/art_target/download`);
      expect(res.status).toBe(200);
      const cd = res.headers['content-disposition'];
      expect(cd).toBeTypeOf('string');
      // 头里绝不能出现裸 CR/LF —— 有裸换行才叫响应头注入（HTTP 响应拆分）。
      // 注意：`X-Injected yes` 作为**文件名的一部分**留在同一个头里是安全的，
      // 它必须变成普通文字，而不是第二个头。
      expect(cd).not.toMatch(/[\r\n]/);
      expect(cd).not.toMatch(/;\s*X-Injected\s*:/i);
      expect(cd).not.toMatch(/;\s*Set-Cookie\s*:/i);
      expect(res.headers['x-injected']).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
      await store.deleteJob(id);
    }
  }, 60_000);

  it('交付物名字是 Windows 保留名 / 纯符号 / 超长 → 有兜底文件名', async () => {
    for (const name of ['CON', 'PRN', '..', '.', '///', '"<>|?*', '😀'.repeat(100)]) {
      const id = await seedJob({ name });
      const res = await request(app).get(`/api/jobs/${id}/artifacts/art_target/download`);
      expect(res.status).toBe(200);
      const cd = res.headers['content-disposition'];
      expect(cd).toMatch(/filename="[^"]+\.md"/);
      await store.deleteJob(id);
    }
  }, 60_000);
});

/* ================================================================== *
 * 攻击 5：不该出现的内部信息
 * ================================================================== */
describe('攻击：响应体里不该出现的东西', () => {
  it('任何错误响应都不含堆栈 / 文件路径 / 密钥', async () => {
    const probes = [
      request(app).post('/api/jobs').send({ goal: '' }),
      request(app).post('/api/jobs').send({ goal: 'x'.repeat(5000) }),
      request(app).get('/api/jobs/job_doesnotexistxxxxxx'),
      request(app).get('/api/jobs/../../../etc/passwd'),
      request(app).get('/api/nope'),
      request(app).post('/api/jobs/job_doesnotexistxxxxxx/retry'),
      request(app).post('/api/jobs/job_doesnotexistxxxxxx/message').send({ text: 'hi' }),
    ];
    for (const p of probes) {
      const res = await p;
      const raw = JSON.stringify(res.body) + '\n' + String(res.text || '');
      expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
      expect(raw).not.toMatch(/QC-[A-Za-z0-9-]{16,}/);
      expect(raw).not.toContain('at Object.');
      expect(raw).not.toContain('/Users/');
      expect(raw).not.toContain('node_modules');
      expect(raw).not.toContain('process.env');
    }
  }, 60_000);

  it('/api/health 与 /api/templates 里没有密钥字段', async () => {
    for (const url of ['/api/health', '/api/templates']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
      expect(raw).not.toMatch(/QC-[A-Za-z0-9-]{16,}/);
      // 字段名里连 "key" 都不该出现（安全测试用 /"key"/ 扫）
      expect(raw).not.toMatch(/"apiKey"|"api_key"|"secret"/i);
    }
  }, 30_000);
});

/* ================================================================== *
 * 攻击 6：限流（契约 §5.7）
 * ================================================================== */
describe('攻击：限流边界', () => {
  it('POST /api/jobs 第 11 次 → 429，且带 Retry-After', async () => {
    let now = 1_000_000;
    const { createRateLimiter, RATE_RULES } = await import('../../src/server.js');
    const limiter = createRateLimiter({ rules: RATE_RULES, now: () => now });
    const limitedApp = createApp({ limiter });
    const codes = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await request(limitedApp).post('/api/jobs').send({ goal: `限流测试 ${i}`, demo: true });
      codes.push(res.status);
      if (res.status === 429) {
        expect(res.body.error.code).toBe('RATE_LIMITED');
        expect(res.headers['retry-after']).toBeDefined();
      }
    }
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes[10]).toBe(429);
    limiter.dispose();
  }, 60_000);

  it('限流窗口过期后恢复；GET 不受限流影响', async () => {
    let now = 5_000_000;
    const { createRateLimiter, RATE_RULES } = await import('../../src/server.js');
    const limiter = createRateLimiter({ rules: RATE_RULES, windowMs: 60_000, now: () => now });
    const limitedApp = createApp({ limiter });
    for (let i = 0; i < 10; i += 1) {
      await request(limitedApp).post('/api/jobs').send({ goal: `窗口测试 ${i}`, demo: true });
    }
    expect((await request(limitedApp).post('/api/jobs').send({ goal: '第 11 次', demo: true })).status).toBe(429);
    // GET 不在规则里
    for (let i = 0; i < 30; i += 1) expect((await request(limitedApp).get('/api/jobs')).status).toBe(200);
    // 窗口过期
    now += 61_000;
    expect((await request(limitedApp).post('/api/jobs').send({ goal: '过期后', demo: true })).status).toBe(201);
    limiter.dispose();
  }, 60_000);
});
