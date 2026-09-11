import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import * as engine from '../src/pipeline/engine.js';
import { events } from '../src/store/events.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe4-'));
process.env.HANDOFF_DATA_DIR = dir;
const app = createApp({ rateLimit: false });
await engine.loadOptionalDeps();
const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
const J = (r) => `${r.status} ${JSON.stringify(r.body).slice(0,140)}`;

// 1. 100MB body
try {
  const big = 'x'.repeat(100*1024*1024);
  const r = await request(app).post('/api/jobs').set('content-type','application/json').send(JSON.stringify({goal:big}));
  console.log('1 100MB:', J(r));
} catch (e) { console.log('1 100MB THREW:', e.message.slice(0,120)); }

// 2. text/plain with JSON body
{
  const r = await request(app).post('/api/jobs').set('content-type','text/plain').send(JSON.stringify({goal:'hello world', demo:true}));
  console.log('2 text/plain json body:', J(r));
}
// 3. text/plain with non-json
{
  const r = await request(app).post('/api/jobs').set('content-type','text/plain').send('goal=hi');
  console.log('3 text/plain raw:', J(r));
}
// 4. no content-type
{
  const r = await request(app).post('/api/jobs').send({goal:'x'.repeat(10), demo:true});
  console.log('4 default:', J(r));
}
// 5. templateId traversal variants
for (const t of ['../../../etc/passwd','..%2F..%2F','a'.repeat(200), null, 123, {a:1}, ['x'], true, 'CON', '../../etc/passwd', '....//....//etc/passwd']) {
  const r = await request(app).post('/api/jobs').send({goal:'模板攻击', templateId: t, demo:true});
  console.log('5 templateId', JSON.stringify(t)?.slice(0,30), '→', r.status, JSON.stringify(r.body.job?.templateId ?? r.body.error?.message));
  if (r.body.job?.id) await request(app).delete(`/api/jobs/${r.body.job.id}`);
}
// 6. goal edge cases
for (const [label, g] of [
  ['4000 emoji', '😀'.repeat(4000)],
  ['4001 emoji', '😀'.repeat(4001)],
  ['4000 newlines', '\n'.repeat(4000)],
  ['pure NUL', '\u0000'.repeat(100)],
  ['only spaces', ' '.repeat(50)],
  ['tabs only', '\t\n\r '.repeat(10)],
  ['number', 12345],
  ['bool', true],
  ['array', ['a']],
  ['object', {a:1}],
]) {
  const r = await request(app).post('/api/jobs').send({goal: g, demo:true});
  console.log('6 goal', label, '→', r.status, r.body.job ? `len=${r.body.job.goal.length}` : JSON.stringify(r.body.error?.message));
  if (r.body.job?.id) await request(app).delete(`/api/jobs/${r.body.job.id}`);
}
// 7. artifact download path traversal + header injection (engine 直接造 job 落盘)
{
  const bad = [
    '正常名字',
    'a"b\r\nX-Injected: yes',
    'x%00y',
    'newline\nname',
    '\r\n\r\n<script>',
    '../../../etc/passwd',
    'CON',
    '.',
    '..',
    '😀' .repeat(200),
  ];
  for (const name of bad) {
    const job = { id: `job_${Math.random().toString(16).slice(2,18)}`, goal:'g', status:'done', createdAt:1, updatedAt:1, stages:[], artifacts:[{id:'art_x', deliverableId:'d1', name, format:'markdown', content:'# hi', assumptions:[], confidence:'high', basedOn:[], createdAt:1}], review:null, security:null, usage:{}, clarifyQuestions:[], error:null };
    const { saveJob } = await import('../src/store/json-store.js');
    await saveJob(job);
    const r = await request(app).get(`/api/jobs/${job.id}/artifacts/art_x/download`);
    console.log('7 name', JSON.stringify(name).slice(0,40), '→ CD:', JSON.stringify(r.headers['content-disposition']));
  }
}
// 8. artifactId traversal
{
  const c = await request(app).post('/api/jobs').send({goal:'下载穿越', demo:true});
  const id = c.body.job.id;
  await wait(9000);
  for (const aid of ['../../../../etc/passwd','..%2F..%2Fetc%2Fpasswd','%00','.','art_x']) {
    const r = await request(app).get(`/api/jobs/${id}/artifacts/${encodeURIComponent(aid)}/download`);
    console.log('8 artifactId', aid, '→', r.status, (r.text||'').slice(0,40).replace(/\n/g,' '));
  }
}
// 9. static traversal
for (const p of ['/../src/server.js','/%2e%2e/%2e%2e/src/server.js','/..%2F..%2Fsrc%2Fserver.js','/public/../src/server.js','/index.html.bak']) {
  const r = await request(app).get(p);
  console.log('9 static', p, '→', r.status, (r.text||'').slice(0,40).replace(/\n/g,' '));
}
process.exit(0);
