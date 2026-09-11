import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, markInterruptedJobs } from '../src/server.js';
import * as store from '../src/store/json-store.js';
import * as engine from '../src/pipeline/engine.js';
import { events } from '../src/store/events.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe5-'));
process.env.HANDOFF_DATA_DIR = dir;
const app = createApp({ rateLimit: false });
await engine.loadOptionalDeps();
const wait = (ms)=>new Promise(r=>setTimeout(r,ms));

// A) SSE 立刻断开 100 次
{
  const c = await request(app).post('/api/jobs').send({ goal:'SSE泄漏测试', demo:true });
  const id = c.body.job.id;
  await wait(300);
  const before = events.listenerCount(id);
  for (let i=0;i<100;i++) {
    await new Promise((resolve) => {
      const req = request(app).get(`/api/jobs/${id}/stream`).buffer(false)
        .on('response', (res) => { res.destroy(); resolve(); })
        .on('error', () => resolve());
      req.end();
    });
  }
  await wait(500);
  console.log('A listeners before:', before, 'after 100 connects:', events.listenerCount(id));
  await request(app).delete(`/api/jobs/${id}`);
}

// B) Last-Event-ID 畸形
{
  const c = await request(app).post('/api/jobs').send({ goal:'SSE补发测试', demo:true });
  const id = c.body.job.id;
  await wait(8000);
  const cur = events.cursor(id);
  for (const h of ['-5','9999999999999999999999','abc','', 'NaN','1e9',' 12 ']) {
    const r = await request(app).get(`/api/jobs/${id}/stream`).set('Last-Event-ID', h).buffer(false).timeout({response:600});
    const body = r.text ?? '';
    const frames = (body.match(/^id: \d+$/gm) || []).length;
    console.log(`B Last-Event-ID=${JSON.stringify(h)} → status=${r.status} 补发帧数=${frames} cursor=${cur}`);
    r.res?.destroy?.();
  }
  // 超大 since
  for (const s of ['-1','999999999999','abc','1']) {
    const r = await request(app).get(`/api/jobs/${id}/stream?since=${s}`).buffer(false).timeout({response:600});
    const frames = ((r.text??'').match(/^id: \d+$/gm) || []).length;
    console.log(`B since=${s} → ${r.status} frames=${frames}`);
    r.res?.destroy?.();
  }
  await request(app).delete(`/api/jobs/${id}`);
}

// C) 每个 job 事件上限 500
{
  const id = 'job_ffffffffffffffff';
  events.drop(id);
  for (let i=0;i<700;i++) events.publish(id, { type:'log', stageId:'s', level:'info', text:`#${i}`, at: Date.now() });
  const all = events.since(id, 0);
  console.log('C events kept:', all.length, 'first seq:', all[0]?.seq, 'last seq:', all.at(-1)?.seq, 'cursor:', events.cursor(id));
  // 重连补发：客户端说它看到 seq=690，应补 691..700
  const replay = events.since(id, 690);
  console.log('C replay from 690:', replay.length, replay[0]?.text, '→', replay.at(-1)?.text);
  // 客户端很久没来（seq=0）→ 只能拿到最后 500 条，中间断了
  const stale = events.since(id, 0);
  console.log('C stale client (seq=0) gets', stale.length, 'first:', stale[0]?.text, '→ 缺了', 700-stale.length, '条');
  events.drop(id);
}

// D) markInterruptedJobs 只覆盖内存里的 200 个
{
  for (let i = 0; i < 205; i++) {
    await store.saveJob({ id:`job_${String(i).padStart(12,'0')}`, goal:`g${i}`, status: i < 5 ? 'running' : 'done', createdAt: 1, updatedAt: 1000 + i, stages: [], artifacts: [] });
  }
  console.log('D stuck running on disk:', fs.readdirSync(path.join(dir,'jobs')).filter(f=>{ const j = JSON.parse(fs.readFileSync(path.join(dir,'jobs',f),'utf8')); return j.status==='running'; }).length);
  store.resetStore();
  const n = await markInterruptedJobs();
  const still = [];
  for (const f of fs.readdirSync(path.join(dir,'jobs'))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir,'jobs',f),'utf8'));
    if (j.status === 'running') still.push(j.id);
  }
  console.log('D markInterruptedJobs recovered:', n, '仍卡在 running:', JSON.stringify(still));
}
process.exit(0);
