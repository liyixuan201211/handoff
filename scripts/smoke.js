/**
 * 一键冒烟：`node scripts/smoke.js`
 *
 * 它回答一个问题：**「现在这份代码，普通人点一下能不能拿到东西？」**
 *
 * 做四件事：
 *   1. 用非默认端口起一个真服务（子进程），数据目录用临时目录，绝不碰 ./data
 *   2. 创建一个 demo 任务（demo:true，不调模型、不需要网络和 Key）
 *   3. 轮询到终态，逐条核对 CONTRACT §7 的验收标准，顺便把交付物正文下载回来验长度
 *   4. 打印摘要，退出码 0/1；**无论成功失败都自清理**（关服务、删临时目录）
 *
 * 端口为什么要自己选一个空闲的：服务端用 `Number(env) || 默认值` 读端口，
 * `PORT=0`（内核分配）会被当成「没配」而回落到 8787 —— 那个端口很容易被占用。
 * 所以这里先用 net 探一个空闲端口，再显式传进去。
 *
 * 为什么用子进程 + 真 HTTP，而不是直接 import：
 *   因为「装不起来 / 顶层副作用 / 端口读错」这类问题只有真的起一次服务才会暴露。
 *   端口用 PORT=0 让内核分配（必然是非默认端口），再从子进程 stdout 里读出真实端口，
 *   这样永远不会和别人抢 8787/3000。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const GOAL = '帮我把这份租房合同看一遍，我怕有坑';
const START_TIMEOUT_MS = 20_000;
const JOB_TIMEOUT_MS = 90_000;

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...args) => console.log(`[smoke ${elapsed()}]`, ...args);

let child = null;
let dataDir = null;
let exitCode = 1;
/** 子进程 stderr 累积（失败时打出来，否则排查全靠猜） */
let stderr = '';

/** 逐条核对 CONTRACT §7 */
function checkAcceptance(job, contents) {
  const problems = [];
  if (job.status !== 'done') problems.push(`最终状态是 ${job.status}，不是 done`);

  if (!Array.isArray(job.artifacts) || job.artifacts.length < 1) {
    problems.push('没有任何交付物');
  } else {
    for (const art of job.artifacts) {
      const text = contents.get(art.id) ?? '';
      if (text.length <= 80) problems.push(`交付物「${art.name}」正文只有 ${text.length} 字（要求 > 80）`);
    }
  }

  if (!job.review) problems.push('缺少验收结果（review 为空）');
  else if (job.review.verdict === 'needs_revision') problems.push('质检判定 needs_revision');

  if (!job.security) problems.push('缺少安全审查结果（security 为空）');
  else if (job.security.level === 'blocked') problems.push('安全检查拦截了本次交付');

  const deliver = (job.stages ?? []).find((s) => s.key === 'deliver' && s.status === 'done');
  if (!deliver) problems.push('deliver 阶段没有完成');
  else if (!JSON.stringify(deliver.output ?? {}).includes('howToUse')) {
    problems.push('deliver 阶段没有产出「怎么用」说明');
  }

  const stages = job.stages ?? [];
  const notDone = stages.filter((s) => s.status !== 'done');
  if (stages.length < 4) problems.push(`阶段数只有 ${stages.length}，流水线明显没跑起来`);
  if (notDone.length) problems.push(`有 ${notDone.length} 个阶段没跑完：${notDone.map((s) => s.key).join(',')}`);

  return problems;
}

/** 探一个空闲端口（临时占用再释放，拿到的一定不是默认端口） */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function main() {
  // ── 0. 前置检查：别人负责的模块必须都在 ──────────────────────
  for (const rel of ['src/server.js', 'src/pipeline/engine.js', 'src/demo/fixtures.js']) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      throw new Error(`缺少 ${rel} —— 冒烟脚本需要完整的服务与引擎才能跑`);
    }
  }

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-smoke-'));
  log(`临时数据目录：${dataDir}`);

  // 允许用 HANDOFF_SMOKE_PORT 指定端口（CI 里想固定端口时用；默认自动挑空闲端口）
  const port = Number(process.env.HANDOFF_SMOKE_PORT) || (await pickFreePort());
  log(`使用端口 ${port}（非默认端口）`);

  // ── 1. 起服务 ────────────────────────────────────────────────
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HANDOFF_PORT: String(port),
      HOST: '127.0.0.1',
      HANDOFF_HOST: '127.0.0.1',
      HANDOFF_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let baseUrl = null;
  const urlPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务 ${START_TIMEOUT_MS}ms 内没打印出监听地址`)), START_TIMEOUT_MS);
    child.stdout.on('data', (buf) => {
      stdout += buf.toString();
      const m = stdout.match(/已启动：(http:\/\/[^\s]+)/);
      if (m && !baseUrl) {
        baseUrl = m[1];
        clearTimeout(timer);
        resolve(baseUrl);
      }
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出（code=${code}）：${stderr.slice(-400)}`));
    });
  });

  baseUrl = await urlPromise;
  log(`服务已起：${baseUrl}`);

  // ── 2. 健康检查 ──────────────────────────────────────────────
  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  log(`健康检查：ok=${health.ok} version=${health.version} jobs=${health.jobs}`);
  if (!health.ok) throw new Error('健康检查没有返回 ok');

  // ── 3. 创建 demo 任务 ────────────────────────────────────────
  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal: GOAL, demo: true }),
  });
  const createdBody = await created.json().catch(() => ({}));
  if (created.status !== 201) {
    throw new Error(`创建任务失败：HTTP ${created.status} ${JSON.stringify(createdBody).slice(0, 300)}`);
  }
  const jobId = createdBody.job.id;
  log(`任务已创建：${jobId}（status=${createdBody.job.status}）`);

  // ── 4. 等它跑完 ──────────────────────────────────────────────
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let job = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}`);
    job = (await res.json()).job;
    if (['done', 'failed', 'cancelled', 'awaiting_input'].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!job || !['done', 'failed', 'cancelled', 'awaiting_input'].includes(job.status)) {
    throw new Error(`任务 ${JOB_TIMEOUT_MS}ms 内没有跑完（最后状态 ${job?.status}）`);
  }
  const jobMs = Date.now() - t0;

  // ── 5. 把交付物正文下载回来验证（detail 接口不返回正文，见缺陷 #2）──
  const contents = new Map();
  for (const art of job.artifacts ?? []) {
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}/artifacts/${art.id}/download`);
    contents.set(art.id, res.ok ? await res.text() : '');
  }

  // ── 6. 验收 ──────────────────────────────────────────────────
  const problems = checkAcceptance(job, contents);
  const stagesDone = (job.stages ?? []).filter((s) => s.status === 'done').length;

  console.log('');
  console.log('─'.repeat(66));
  console.log('  冒烟结果摘要');
  console.log('─'.repeat(66));
  console.log(`  目标          ${job.goal}`);
  console.log(`  最终状态      ${job.status}`);
  console.log(`  阶段          ${stagesDone}/${(job.stages ?? []).length} 完成`);
  console.log(`  交付物        ${(job.artifacts ?? []).length} 份`);
  for (const art of job.artifacts ?? []) {
    console.log(`     · ${art.name}（${(contents.get(art.id) ?? '').length} 字）`);
  }
  console.log(`  质检结论      ${job.review?.verdict ?? '（缺失）'}`);
  console.log(`  安全等级      ${job.security?.level ?? '（缺失）'}`);
  console.log(`  模型用量      ${job.usage?.calls ?? 0} 次调用 / ${job.usage?.promptTokens ?? 0}+${job.usage?.completionTokens ?? 0} tokens`);
  console.log(`  端到端耗时    ${jobMs} ms`);
  console.log(`  验收结论      ${problems.length === 0 ? '✅ 通过（CONTRACT §7 五条全满足）' : '❌ 不通过'}`);
  for (const p of problems) console.log(`     ✗ ${p}`);
  console.log('─'.repeat(66));
  console.log('');

  if (problems.length) throw new Error(`验收未通过：${problems.join('；')}`);
  log('冒烟通过 ✅');
  exitCode = 0;
}

/** 自清理：关服务（先 SIGTERM，3 秒不退就 SIGKILL）+ 删临时数据目录 */
async function cleanup() {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const forced = setTimeout(() => {
      if (child.exitCode === null) {
        log('服务没有响应 SIGTERM，改用 SIGKILL');
        child.kill('SIGKILL');
      }
    }, 3000);
    forced.unref?.();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
    clearTimeout(forced);
  }
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      log(`临时数据目录已删除：${dataDir}`);
    } catch (err) {
      console.warn(`[smoke] 临时目录删除失败（不影响退出码）：${err.message}`);
    }
  }
}

try {
  await main();
} catch (err) {
  console.error('');
  console.error(`[smoke ${elapsed()}] ❌ 失败：${err.message}`);
  if (stderr.trim()) {
    console.error('[smoke] 服务端最后输出：');
    console.error(stderr.trim().slice(-600));
  }
  exitCode = 1;
} finally {
  await cleanup();
}

process.exit(exitCode);
