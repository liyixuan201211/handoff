import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import * as store from '../src/store/json-store.js';
import * as engine from '../src/pipeline/engine.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe2-'));
process.env.HANDOFF_DATA_DIR = dir;
const app = createApp({ rateLimit: false });
await engine.loadOptionalDeps();
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const fileOf = (id) => path.join(dir, 'jobs', `${id}.json`);
const stat = (id) => { try { const j = JSON.parse(fs.readFileSync(fileOf(id),'utf8')); return `status=${j.status} stages=${j.stages.length} arts=${j.artifacts.length}`; } catch (e) { return `NO-FILE(${e.code})`; } };

// DELETE 竞态：在不同时刻删，看之后文件是否复活
for (const t of [1000, 2000, 3000, 3500, 4000, 5000]) {
  const c = await request(app).post('/api/jobs').send({ goal: `删除竞态@${t}`, demo: true });
  const id = c.body.job.id;
  await wait(t);
  const before = stat(id);
  const d = await request(app).delete(`/api/jobs/${id}`);
  const imm = stat(id);
  await wait(8000);
  const after = stat(id);
  const g = await request(app).get(`/api/jobs/${id}`);
  const l = await request(app).get('/api/jobs');
  console.log(`t=${t}ms DELETE=${d.status} | before[${before}] imm[${imm}] after8s[${after}] GET=${g.status} inList=${l.body.jobs.some(j=>j.id===id)}`);
}

// 内存缓存上限：直接写 205 个 job
{
  for (let i = 0; i < 205; i++) {
    await store.saveJob({ id: `job_${String(i).padStart(12,'0')}`, goal: `批量 ${i}`, status:'done', createdAt: 1, updatedAt: 1000 + i, stages: [], artifacts: [] });
  }
  const l = await request(app).get('/api/jobs');
  const ids = l.body.jobs.map(j=>j.id);
  console.log('CAP list length:', l.body.jobs.length, 'contains job_000000000000:', ids.includes('job_000000000000'));
  const g = await request(app).get('/api/jobs/job_000000000000');
  console.log('CAP GET oldest evicted id:', g.status, 'disk file exists:', fs.existsSync(fileOf('job_000000000000')));
  const h = await request(app).get('/api/health');
  console.log('CAP health jobs:', h.body.jobs);
}
process.exit(0);
