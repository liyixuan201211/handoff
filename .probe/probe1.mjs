import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, startServer } from '../src/server.js';
import * as store from '../src/store/json-store.js';
import * as engine from '../src/pipeline/engine.js';
import { events } from '../src/store/events.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe1-'));
process.env.HANDOFF_DATA_DIR = dir;
const app = createApp({ rateLimit: false });
await engine.loadOptionalDeps();
console.log('deps:', typeof engine.deps.saveJob, typeof engine.deps.demo?.runDemoPipeline);

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- A) DELETE while running ----------
{
  const c = await request(app).post('/api/jobs').send({ goal: '删除竞态测试', demo: true });
  const id = c.body.job.id;
  await wait(2500); // 跑到中途
  const d = await request(app).delete(`/api/jobs/${id}`);
  console.log('A DELETE:', d.status, JSON.stringify(d.body));
  const g1 = await request(app).get(`/api/jobs/${id}`);
  console.log('A GET right after delete:', g1.status);
  await wait(9000);
  const g2 = await request(app).get(`/api/jobs/${id}`);
  console.log('A GET 9s later:', g2.status, g2.body?.job?.status);
  console.log('A file exists:', fs.existsSync(path.join(dir,'jobs',`${id}.json`)));
  const onDisk = fs.existsSync(path.join(dir,'jobs',`${id}.json`)) ? JSON.parse(fs.readFileSync(path.join(dir,'jobs',`${id}.json`),'utf8')) : null;
  console.log('A onDisk status:', onDisk?.status, 'stages:', onDisk?.stages?.length, 'arts:', onDisk?.artifacts?.length);
  const l = await request(app).get('/api/jobs');
  console.log('A appears in history list:', l.body.jobs.some(j=>j.id===id));
}

// ---------- B) awaiting_input memory ----------
{
  const orig = engine.deps.callModel;
  engine.deps.callModel = async (o) => {
    if (o.purpose === 'intake') return { text:'{}', json:{ intent:'test', restated:'test', ambiguities:[], missingInfo:[], clarifyQuestions:['你要审查的是哪一份合同？','你希望我重点看什么？'] }, usage:{promptTokens:1,completionTokens:1}, ms:1, provider:'probe', model:'probe', degraded:false, attempts:1 };
    throw new Error('不该走到这里');
  };
  const c = await request(app).post('/api/jobs').send({ goal: '看看合同' });
  const id = c.body.job.id;
  await wait(500);
  const g = await request(app).get(`/api/jobs/${id}`);
  console.log('B status:', g.body.job.status, 'questions:', JSON.stringify(g.body.job.clarifyQuestions));
  console.log('B running.has:', engine.__internals.running.has(id), 'running.size:', engine.__internals.running.size);
  engine.deps.callModel = orig;
}

// ---------- C) concurrent retry ----------
{
  const c = await request(app).post('/api/jobs').send({ goal: '并发重试测试', demo: true });
  const id = c.body.job.id;
  await wait(6000);
  const [r1, r2] = await Promise.all([
    request(app).post(`/api/jobs/${id}/retry`),
    request(app).post(`/api/jobs/${id}/retry`),
  ]);
  console.log('C retry statuses:', r1.status, r2.status);
  await wait(1000);
  console.log('C running.has after both:', engine.__internals.running.has(id));
}

// ---------- D) concurrent message ----------
{
  const c = await request(app).post('/api/jobs').send({ goal: '并发消息测试', demo: true });
  const id = c.body.job.id;
  await wait(6000);
  const [m1, m2] = await Promise.all([
    request(app).post(`/api/jobs/${id}/message`).send({ text: '第一种要求' }),
    request(app).post(`/api/jobs/${id}/message`).send({ text: '第二种要求' }),
  ]);
  console.log('D message statuses:', m1.status, m2.status, JSON.stringify([m1.body?.error?.code, m2.body?.error?.code]));
  await wait(1000);
  const g = await request(app).get(`/api/jobs/${id}`);
  console.log('D userMessages:', JSON.stringify(g.body.job.userMessages));
}
console.log('DONE');
process.exit(0);
