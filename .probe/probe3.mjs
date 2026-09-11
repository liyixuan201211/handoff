import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe3-'));
const PORT = 8877;
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));

function start() {
  const p = spawn(process.execPath, ['src/server.js'], {
    cwd: '/Users/imac/260912/handoff',
    env: { ...process.env, HANDOFF_PORT: String(PORT), HANDOFF_DATA_DIR: dir, HANDOFF_HOST: '127.0.0.1' },
    stdio: ['ignore','pipe','pipe'],
  });
  p.stdout.on('data', d => process.stdout.write('[srv] '+d));
  p.stderr.on('data', d => process.stdout.write('[srv-err] '+d));
  return p;
}
async function up() {
  for (let i=0;i<80;i++) { try { const r = await fetch(base+'/api/health'); if (r.ok) return true; } catch {} await sleep(100); }
  return false;
}
const srv = start();
console.log('up:', await up());
const c = await fetch(base+'/api/jobs', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ goal:'断电演练：帮我看租房合同', demo:true }) });
const { job } = await c.json();
const id = job.id;
console.log('created', id);
await sleep(2500);
const mid = await (await fetch(base+`/api/jobs/${id}`)).json();
console.log('MID status:', mid.job.status, 'stages seen by API:', mid.job.stages.length);
console.log('MID disk:', fs.existsSync(path.join(dir,'jobs',`${id}.json`)) ? JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir,'jobs',`${id}.json`),'utf8')).status) : 'NO FILE');
console.log('--- kill -9 ---');
srv.kill('SIGKILL');
await sleep(500);
const onDisk = JSON.parse(fs.readFileSync(path.join(dir,'jobs',`${id}.json`),'utf8'));
console.log('AFTER KILL disk status:', onDisk.status, 'stages:', onDisk.stages.length, 'arts:', onDisk.artifacts.length);

const srv2 = start();
console.log('up2:', await up());
const after = await (await fetch(base+`/api/jobs/${id}`)).json();
console.log('AFTER RESTART status:', after.job.status, 'stages:', after.job.stages.length, 'arts:', after.job.artifacts.length);
const retry = await fetch(base+`/api/jobs/${id}/retry`, { method:'POST' });
console.log('retry:', retry.status, JSON.stringify((await retry.json()).error ?? 'ok'));
await sleep(9000);
const fin = await (await fetch(base+`/api/jobs/${id}`)).json();
console.log('after retry status:', fin.job.status, 'stages:', fin.job.stages.length, 'arts:', fin.job.artifacts.length);
const msg = await fetch(base+`/api/jobs/${id}/message`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({text:'补充一句'}) });
console.log('message after restart:', msg.status);
const del = await fetch(base+`/api/jobs/${id}`, { method:'DELETE' });
console.log('delete:', del.status);
srv2.kill('SIGKILL');
process.exit(0);
