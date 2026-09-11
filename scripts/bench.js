#!/usr/bin/env node
/**
 * 交接 Handoff —— 性能与可靠性基准（S10）。
 *
 * 一句话：**证明这个产品在真实使用强度下会变慢、会泄漏、会崩**，并且留下可复跑的证据。
 *
 * 为什么判定标准不是「能扛多少 QPS」：
 *   本产品的目标用户是**一个人在自己电脑上跑**。所以真正要回答的是四个问题：
 *     1. 同时开 10 个任务会不会卡？
 *     2. 用得越久内存会不会越来越大？（普通人会以为电脑坏了）
 *     3. 打开一个已完成任务要多久？（超过 1 秒用户就觉得「卡」）
 *     4. 服务会不会莫名退出 / 任务会不会永远卡在「运行中」？
 *   基准里的每一条判定都对应上面某一条，判定依据写在每行后面。
 *
 * 用法：
 *   node scripts/bench.js              # 全部
 *   node scripts/bench.js memory       # 只跑内存与泄漏
 *   node scripts/bench.js latency      # 只跑 HTTP 端点延迟
 *   node scripts/bench.js disk         # 只跑磁盘 I/O 与持久化缺陷
 *   node scripts/bench.js startup      # 只跑启动 / 持久化规模
 *   node scripts/bench.js sse          # 只跑 SSE 连接代价
 *   node scripts/bench.js crash        # 只跑 kill -9 崩溃恢复
 *
 * 纪律（重要）：
 *   1. **绝不在真实 data/ 上跑**。本脚本自己在 os.tmpdir() 里建临时目录，结束时删掉。
 *      下面有 assertSafeDataDir() 硬拦截。
 *   2. 不写网络。用测试目录里已有的「剧本模型」（tests/helpers/e2e-harness.js）驱动真实流水线。
 *   3. 演示模式默认把阶段步进间隔从 700ms 调到 0ms，这样 200 轮才跑得完。
 *      这不改变任何数据结构与代码路径，脚本里用「保真度校验」实测证明两者的产物一致。
 *   4. 每个指标都要有判定（✅/⚠️/🔴）和判定依据。没有依据的数字不算结论。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ================================================================== *
 * 0. 自举：拿到 --expose-gc，否则堆数字全是未回收的垃圾
 * ================================================================== */

if (typeof global.gc !== 'function' && !process.env.HANDOFF_BENCH_CHILD) {
  const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, HANDOFF_BENCH_CHILD: '1' },
  });
  process.exit(r.status ?? 1);
}

/* ================================================================== *
 * 1. 临时数据目录（绝不碰真实 data/）
 * ================================================================== */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-bench-'));

function assertSafeDataDir(dir) {
  const real = path.resolve(ROOT, 'data');
  const target = path.resolve(dir);
  if (target === real || target.startsWith(real + path.sep)) {
    throw new Error(`基准脚本拒绝在真实数据目录上运行：${target}`);
  }
  if (!target.startsWith(path.resolve(os.tmpdir()))) {
    throw new Error(`基准脚本只允许在系统临时目录里跑：${target}`);
  }
}
assertSafeDataDir(DATA_DIR);
process.env.HANDOFF_DATA_DIR = DATA_DIR;

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* 清不掉就算了，别让基准因为清理失败而失败 */
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

/* ================================================================== *
 * 2. 输出工具（人看得懂的表格）
 * ================================================================== */

const OK = '✅ 可接受';
const WARN = '⚠️ 偏慢';
const BAD = '🔴 有问题';

/** 全角字符按 2 列算，否则中文表格会歪 */
const width = (s) =>
  [...String(s)].reduce(
    (a, c) =>
      a + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(c) ? 2 : 1),
    0,
  );
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - width(s))) + String(s);

/** 所有指标集中收集，最后打一张总表（报告里直接贴） */
const SUMMARY = [];
function metric({ section, name, value, verdict, basis }) {
  SUMMARY.push({ section, name, value, verdict, basis });
  const v = verdict ? ` ${verdict}` : '';
  console.log(`  ${pad(name, 46)} ${padL(value, 18)}${v}`);
  if (basis) console.log(`  ${' '.repeat(46)} ${'↳ ' + basis}`);
}
function section(title) {
  console.log('');
  console.log(`\x1b[1m== ${title} ==\x1b[0m`);
}
function note(text) {
  console.log(`  \x1b[2m· ${text}\x1b[0m`);
}
function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))));
  const line = (cells) => '  ' + cells.map((c, i) => pad(c ?? '', widths[i])).join('  ');
  console.log(line(headers));
  console.log('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

/* ================================================================== *
 * 3. 通用工具
 * ================================================================== */

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const gcNow = () => {
  if (global.gc) {
    global.gc();
    global.gc();
  }
};
const heapMB = () => process.memoryUsage().heapUsed / 1048576;
const rssMB = () => process.memoryUsage().rss / 1048576;

/** 百分位（输入必须是**已排序**的升序数组） */
function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0],
    p50: pct(s, 50),
    p95: pct(s, 95),
    p99: pct(s, 99),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}
const fmtMs = (v) => (v >= 100 ? `${v.toFixed(0)} ms` : v >= 10 ? `${v.toFixed(1)} ms` : `${v.toFixed(2)} ms`);
const fmtMB = (v) => `${v.toFixed(2)} MB`;

/** 延迟判定：普通人对「点一下等多久」的容忍 */
function judgeLatency(p50, p95) {
  if (p95 >= 1000) return BAD;
  if (p95 >= 300 || p50 >= 100) return WARN;
  return OK;
}

/* ------------------------------------------------------------------ *
 * 模块（动态 import：必须在 HANDOFF_DATA_DIR 设好之后）
 * ------------------------------------------------------------------ */

const { createApp, VERSION } = await import(path.join(ROOT, 'src/server.js'));
const engine = await import(path.join(ROOT, 'src/pipeline/engine.js'));
const store = await import(path.join(ROOT, 'src/store/json-store.js'));
const { events } = await import(path.join(ROOT, 'src/store/events.js'));
const harness = await import(path.join(ROOT, 'tests/helpers/e2e-harness.js'));

/* ------------------------------------------------------------------ *
 * 服务器
 * ------------------------------------------------------------------ */

async function startApp(opts = {}) {
  await store.loadFromDisk();
  const app = createApp({ rateLimit: false, ...opts });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { app, server, base: `http://127.0.0.1:${server.address().port}` };
}
function closeApp(s) {
  return new Promise((r) => s.server.close(r));
}

async function httpJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text, bytes: Buffer.byteLength(text) };
}

const postJson = (base, p, obj) =>
  httpJson(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });

/** 轮询到终态（和 e2e 里 waitForJob 同一个判据） */
async function waitJob(base, id, { timeoutMs = 60_000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await httpJson(`${base}/api/jobs/${id}`);
    last = r.body?.job ?? null;
    if (last && ['done', 'failed', 'cancelled', 'awaiting_input'].includes(last.status)) return last;
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
  throw new Error(`等待任务 ${id} 超时，最后一帧：${JSON.stringify(last)?.slice(0, 200)}`);
}

/* ------------------------------------------------------------------ *
 * SSE 客户端
 * ------------------------------------------------------------------ */

async function sseOpen(base, jobId, { since = 0 } = {}) {
  const ac = new AbortController();
  const t0 = process.hrtime.bigint();
  const url = `${base}/api/jobs/${jobId}/stream${since ? `?since=${since}` : ''}`;
  const res = await fetch(url, { signal: ac.signal, headers: { accept: 'text/event-stream' } });
  const reader = res.body.getReader();
  const state = { ac, reader, bytes: 0, frames: 0, text: '', ttfbMs: null, status: res.status };
  state.pump = (async () => {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        if (state.ttfbMs === null) state.ttfbMs = ms(t0);
        state.bytes += value.length;
        const chunk = dec.decode(value, { stream: true });
        state.text += chunk;
        state.frames += (chunk.match(/\n\n/g) ?? []).length;
      }
    } catch {
      /* abort 之后必然抛，属于正常路径 */
    }
  })();
  return state;
}
async function sseClose(s) {
  try {
    s.ac.abort();
  } catch {
    /* ignore */
  }
  try {
    await s.reader.cancel();
  } catch {
    /* ignore */
  }
  await s.pump.catch(() => {});
}

/* ------------------------------------------------------------------ *
 * 引擎装配（脱网）
 * ------------------------------------------------------------------ */

let depsReady = false;
async function wireDeps() {
  if (depsReady) return;
  await harness.wireEngineDeps();
  await store.loadFromDisk();
  depsReady = true;
}

/** 演示模式加速：只改进度条的步进间隔，不改任何数据结构 */
let FAST_DEMO = true;
const DEMO_STEP_MS_FAST = 0;
const DEMO_STEP_MS_REAL = 700;

async function installDemo(stepMs) {
  await wireDeps();
  const fixtures = await import(path.join(ROOT, 'src/demo/fixtures.js'));
  engine.deps.demo = {
    ...fixtures,
    runDemoPipeline: (goal, emit, opts = {}) => fixtures.runDemoPipeline(goal, emit, { ...opts, stepMs }),
  };
  return fixtures;
}

/* ------------------------------------------------------------------ *
 * 剧本模型：驱动**真实**的 8 阶段流水线（研究磁盘写入、真实任务内存时用）
 * ------------------------------------------------------------------ */

function filler(n, seed) {
  let s = '';
  let i = 0;
  while (s.length < n) {
    i += 1;
    s += `\n\n## 第 ${i} 节\n这是交付物 ${seed} 的第 ${i} 段内容，用于把正文撑到目标长度；` +
      `它必须是像样的中文 markdown，而且结尾要有句号，否则引擎会误判成被截断。\n`;
  }
  return s.slice(0, Math.max(1, n - 1)) + '。';
}

function artifactBlocks(ids, perArtifactChars) {
  return ids
    .map((id) => {
      const body = filler(perArtifactChars, id);
      return `<<<ARTIFACT id="${id}" confidence="high">>>\n# 交付物 ${id}\n${body}\n<<<ASSUMPTIONS>>>\n- 基准脚本生成的假设\n<<<END>>>`;
    })
    .join('\n\n');
}

/**
 * 造一个「像真模型一样」的 callModel。
 * - 有 schema 的阶段：返回结构化 JSON（和真网关契约一致）
 * - 没有 schema 的阶段（draft / revise / critique）：返回**文本协议**（真网关在这种情况下 json=null）
 */
function makeScriptedModel({ deliverableIds = ['d1', 'd2', 'd3'], perArtifactChars = 3000 } = {}) {
  const outputs = harness.stageOutputs({ deliverableIds });
  const ok = (json, purpose) => ({
    text: JSON.stringify(json),
    json,
    usage: { promptTokens: 120, completionTokens: 60 },
    ms: 3,
    provider: 'bench',
    providerLabel: '基准剧本模型',
    model: 'bench',
    degraded: false,
    notices: [],
    attempts: 1,
    purpose,
  });
  const textual = (text) => ({
    text,
    json: null,
    usage: { promptTokens: 120, completionTokens: 900 },
    ms: 3,
    provider: 'bench',
    providerLabel: '基准剧本模型',
    model: 'bench',
    degraded: false,
    notices: [],
    attempts: 1,
  });
  const callModel = async (o = {}) => {
    if (o.schema) {
      const json = outputs[o.purpose];
      if (!json) throw new Error(`基准模型没有为 ${o.purpose} 准备输出`);
      return ok(json, o.purpose);
    }
    if (o.purpose === 'draft' || o.purpose === 'revise') {
      return textual(artifactBlocks(deliverableIds, perArtifactChars));
    }
    if (o.purpose === 'critique') {
      return textual(
        '<<<ISSUE severity="medium" where="d1">>>\n问题：违约金只算了一种情形。\n怎么改：补一个通用计算公式。\n<<<END>>>\n' +
          '<<<OVERALL>>>\n整体可用，建议补一个通用公式。\n<<<END>>>',
      );
    }
    throw new Error(`基准模型不会处理 purpose=${o.purpose}`);
  };
  return { callModel, outputs };
}

/** 跑一个**真实模式**任务（脱网 + 剧本模型），等它到终态 */
async function runRealJob(base, { goal = '帮我把这份租房合同看一遍，我怕有坑', perArtifactChars = 3000 } = {}) {
  await wireDeps();
  const { callModel } = makeScriptedModel({ perArtifactChars });
  const original = engine.deps.callModel;
  engine.deps.callModel = callModel;
  try {
    const created = await postJson(base, '/api/jobs', { goal });
    if (created.status !== 201) throw new Error(`创建失败：${created.status} ${created.text.slice(0, 200)}`);
    const id = created.body.job.id;
    const job = await waitJob(base, id);
    // 终态是从**内存**看到的：最后一次 saveJob 可能还在 fsync。
    // 不 settle 的话，量到的「最终文件大小」会比真实值小一截。
    await new Promise((r) => setTimeout(r, 200));
    return { id, job };
  } finally {
    engine.deps.callModel = original;
  }
}

/** 按 id 精确回收事件日志，避免基准之间互相污染 */
function dropAll(ids) {
  for (const id of ids) events.drop(id);
}

/** 用公开 API 量出 events 内部为这些 job 常驻了多少字节 */
function eventsRetainedBytes(ids) {
  let bytes = 0;
  let count = 0;
  for (const id of ids) {
    const evs = events.since(id, 0);
    if (!evs.length) continue;
    count += evs.length;
    bytes += Buffer.byteLength(JSON.stringify(evs));
  }
  return { bytes, count };
}

/* ================================================================== *
 * 基准 1：内存与泄漏
 * ================================================================== */

async function benchMemory() {
  section('1. 内存与泄漏（最重要）');
  note(`全部任务都在临时目录 ${DATA_DIR}；每轮做完就删，和不删两种口径都测。`);

  await installDemo(FAST_DEMO ? DEMO_STEP_MS_FAST : DEMO_STEP_MS_REAL);
  const { server, base } = await startApp();
  const seen = [];

  try {
    /* --- 1.0 保真度校验：加速的演示流水线 == 真实节奏的演示流水线 --- */
    await installDemo(DEMO_STEP_MS_REAL);
    const tReal0 = process.hrtime.bigint();
    const realCreated = await postJson(base, '/api/jobs', { goal: '保真度校验：真实节奏', demo: true });
    const realId = realCreated.body.job.id;
    const realJob = await waitJob(base, realId);
    const realWall = ms(tReal0);
    const realEvents = Buffer.byteLength(JSON.stringify(events.since(realId, 0)));

    await installDemo(DEMO_STEP_MS_FAST);
    const tFast0 = process.hrtime.bigint();
    const fastCreated = await postJson(base, '/api/jobs', { goal: '保真度校验：加速节奏', demo: true });
    const fastId = fastCreated.body.job.id;
    const fastJob = await waitJob(base, fastId);
    const fastWall = ms(tFast0);
    const fastEvents = Buffer.byteLength(JSON.stringify(events.since(fastId, 0)));
    seen.push(realId, fastId);

    table(
      ['节奏', '整任务耗时', '状态', '阶段数', '产物数', '产物字符数', '事件条数', '事件字节'],
      [
        [
          '真实（700ms/阶段）',
          fmtMs(realWall),
          realJob.status,
          String(realJob.stages.length),
          String(realJob.artifacts.length),
          String(realJob.artifacts.reduce((a, x) => a + x.content.length, 0)),
          String(events.since(realId, 0).length),
          String(realEvents),
        ],
        [
          '加速（0ms/阶段）',
          fmtMs(fastWall),
          fastJob.status,
          String(fastJob.stages.length),
          String(fastJob.artifacts.length),
          String(fastJob.artifacts.reduce((a, x) => a + x.content.length, 0)),
          String(events.since(fastId, 0).length),
          String(fastEvents),
        ],
      ],
    );
    const sameShape =
      realJob.status === fastJob.status &&
      realJob.stages.length === fastJob.stages.length &&
      realJob.artifacts.length === fastJob.artifacts.length &&
      realJob.artifacts.reduce((a, x) => a + x.content.length, 0) ===
        fastJob.artifacts.reduce((a, x) => a + x.content.length, 0);
    metric({
      section: '内存',
      name: '演示模式加速的保真度（结构与产物体积一致）',
      value: sameShape ? '一致' : '不一致',
      verdict: sameShape ? OK : BAD,
      basis: '加速只改进度条步进间隔，不改变 job 形状；不一致说明脚本测的不是产品本身',
    });
    note(`演示任务单次事件日志 ≈ ${(realEvents / 1024).toFixed(1)} KB，产物合计 ≈ ${realJob.artifacts.reduce((a, x) => a + x.content.length, 0)} 字符`);

    /* --- 1.1 规定的 200 轮：建 → 跑完 → GET → SSE 连一下断开 → DELETE --- */
    for (const id of seen) events.drop(id);
    seen.length = 0;
    gcNow();
    const baseHeap = heapMB();
    const curve = [];
    const t0 = process.hrtime.bigint();

    const ROUNDS = 200;
    for (let i = 1; i <= ROUNDS; i += 1) {
      const created = await postJson(base, '/api/jobs', { goal: `第 ${i} 轮：帮我把这份租房合同看一遍`, demo: true });
      const id = created.body.job.id;
      seen.push(id);
      await waitJob(base, id);
      const detail = await httpJson(`${base}/api/jobs/${id}`);
      if (detail.status !== 200) throw new Error(`GET 详情失败 ${detail.status}`);
      const s = await sseOpen(base, id);
      await new Promise((r) => setTimeout(r, 2));
      await sseClose(s);
      await httpJson(`${base}/api/jobs/${id}`, { method: 'DELETE' });

      if (i % 20 === 0 || i === 1) {
        gcNow();
        curve.push({
          round: i,
          heap: heapMB(),
          rss: rssMB(),
          eventBytes: eventsRetainedBytes(seen).bytes,
          listeners: seen.reduce((a, x) => a + events.listenerCount(x), 0),
          chains: store.pendingLocks(),
          cache: await store.countJobs(),
          running: engine.__internals.running.size,
        });
      }
    }
    const loopWall = ms(t0);
    gcNow();
    const endHeap = heapMB();

    table(
      ['轮次', 'heapUsed', 'RSS', 'events 常驻', 'SSE 监听器', 'chains', 'cache', 'running'],
      curve.map((c) => [
        String(c.round),
        c.heap.toFixed(1) + ' MB',
        c.rss.toFixed(0) + ' MB',
        (c.eventBytes / 1048576).toFixed(3) + ' MB',
        String(c.listeners),
        String(c.chains),
        String(c.cache),
        String(c.running),
      ]),
    );
    note(`${ROUNDS} 轮总耗时 ${(loopWall / 1000).toFixed(1)} s（平均 ${(loopWall / ROUNDS).toFixed(0)} ms/轮，已加速演示节奏）`);

    const heapDelta = endHeap - baseHeap;
    const lastChains = curve.at(-1).chains;
    const lastListeners = curve.at(-1).listeners;
    const lastRunning = curve.at(-1).running;
    const lastEventBytes = curve.at(-1).eventBytes;

    metric({
      section: '内存',
      name: `200 轮「建→跑→取→SSE→删」后 heapUsed 变化`,
      value: `${heapDelta >= 0 ? '+' : ''}${heapDelta.toFixed(2)} MB`,
      verdict: heapDelta < 16 ? OK : heapDelta < 48 ? WARN : BAD,
      basis: '单用户常驻内存应当稳定；持续单调增长 = 泄漏（阈值 16MB/200 轮）',
    });
    metric({
      section: '内存',
      name: '200 轮删除后 events 日志残留',
      value: `${(lastEventBytes / 1048576).toFixed(3)} MB`,
      verdict: lastEventBytes < 1024 ? OK : BAD,
      basis: 'DELETE /api/jobs/:id 调了 events.drop()，删干净应当 ≈ 0 字节',
    });
    metric({
      section: '内存',
      name: '200 轮后 SSE 监听器残留',
      value: `${lastListeners} 个`,
      verdict: lastListeners === 0 ? OK : BAD,
      basis: '断开连接必须退订；>0 就是每次刷新页面泄漏一个监听器',
    });
    metric({
      section: '内存',
      name: '200 轮后 json-store pendingLocks 残留',
      value: `${lastChains} 条`,
      verdict: lastChains === 0 ? OK : WARN,
      basis: '写队列必须自清理（json-store.js:97-100）',
    });
    metric({
      section: '内存',
      name: '200 轮后 engine.running 残留',
      value: `${lastRunning} 条`,
      verdict: lastRunning === 0 ? OK : BAD,
      basis: '终态任务必须从 running Map 移除，否则每个任务泄漏一个 AbortController',
    });

    /* --- 1.2 保留口径：用户不删任务时，内存涨到哪 --- */
    dropAll(seen);
    seen.length = 0;
    await store.resetStore();
    await store.loadFromDisk();
    gcNow();
    const retainBase = heapMB();

    const RETAIN = 200;
    for (let i = 1; i <= RETAIN; i += 1) {
      const created = await postJson(base, '/api/jobs', { goal: `保留口径第 ${i} 轮`, demo: true });
      const id = created.body.job.id;
      seen.push(id);
      await waitJob(base, id);
    }
    gcNow();
    const retainHeap = heapMB();
    const retained = eventsRetainedBytes(seen);
    const diskBytes = fs
      .readdirSync(path.join(DATA_DIR, 'jobs'))
      .filter((n) => n.endsWith('.json'))
      .reduce((a, n) => a + fs.statSync(path.join(DATA_DIR, 'jobs', n)).size, 0);

    table(
      ['口径', '任务数', 'heapUsed', 'events 常驻字节', '事件条数', '磁盘字节'],
      [
        [
          '删除后（应回到基线）',
          '0',
          baseHeap.toFixed(1) + ' MB',
          '0 B',
          '0',
          '0',
        ],
        [
          '全部保留',
          String(RETAIN),
          retainHeap.toFixed(1) + ' MB',
          fmtMB(retained.bytes / 1048576),
          String(retained.count),
          `${(diskBytes / 1024).toFixed(0)} KB`,
        ],
      ],
    );
    const perJobEvents = retained.bytes / RETAIN;
    const perJobHeap = (retainHeap - retainBase) / RETAIN;
    metric({
      section: '内存',
      name: '每个「保留下来没删」的任务常驻事件字节',
      value: `${(perJobEvents / 1024).toFixed(1)} KB`,
      verdict: perJobEvents > 200 * 1024 ? BAD : WARN,
      basis: 'events.js:14 #logs 每个 job 的条目永不回收（只按 500 条封顶），随「进程生命周期内建过的任务数」线性增长',
    });
    metric({
      section: '内存',
      name: '保留口径 heap 增量 / 任务',
      value: `${(perJobHeap * 1024).toFixed(0)} KB`,
      verdict: perJobHeap * 1024 < 256 ? OK : perJobHeap * 1024 < 1024 ? WARN : BAD,
      basis: '用来估算「跑一晚上涨多少」：新增任务数 × 该值',
    });

    const overnightTasks = 60; // 一个人一晚上大约提多少个任务（保守：每 8 分钟一个 × 8 小时）
    metric({
      section: '内存',
      name: `推算：一晚（8h / 约 ${overnightTasks} 个任务）内存增量`,
      value: `≈ ${((perJobHeap * overnightTasks)).toFixed(1)} MB`,
      verdict: perJobHeap * overnightTasks < 32 ? OK : perJobHeap * overnightTasks < 128 ? WARN : BAD,
      basis: `保留口径实测 ${(perJobHeap * 1024).toFixed(0)} KB/任务 × ${overnightTasks}；注意这部分内存**永不归还**，且任务越多越大`,
    });

    /* --- 1.3 真实（非演示）任务的事件日志规模 --- */
    const realIds = [];
    for (let i = 0; i < 20; i += 1) {
      const { id } = await runRealJob(base, { goal: `真实口径第 ${i + 1} 轮`, perArtifactChars: 3000 });
      realIds.push(id);
    }
    const realRetained = eventsRetainedBytes(realIds);
    const realJobs = [];
    for (const id of realIds) realJobs.push(await store.getJob(id));
    const perRealJobEvents = realRetained.bytes / realIds.length;
    const perRealJobFile =
      realJobs.reduce((a, j) => a + JSON.stringify(j, null, 2).length, 0) / realIds.length;
    table(
      ['口径', '任务数', '事件/任务', '事件常驻合计', 'job 文件/任务'],
      [
        [
          '真实 8 阶段（剧本模型）',
          String(realIds.length),
          `${(perRealJobEvents / 1024).toFixed(1)} KB`,
          fmtMB(realRetained.bytes / 1048576),
          `${(perRealJobFile / 1024).toFixed(1)} KB`,
        ],
      ],
    );
    metric({
      section: '内存',
      name: '真实任务事件日志 / 任务（实测）',
      value: `${(perRealJobEvents / 1024).toFixed(1)} KB`,
      verdict: perRealJobEvents < 256 * 1024 ? OK : WARN,
      basis: '真实模式事件条数实测；理论上限 = events.js:13 MAX_LOG_PER_JOB(500) 条',
    });
    metric({
      section: '内存',
      name: 'json-store 内存缓存上限（常驻风险）',
      value: `200 个任务 × ${(perRealJobFile / 1024).toFixed(0)} KB ≈ ${((perRealJobFile * 200) / 1048576).toFixed(0)} MB`,
      verdict: (perRealJobFile * 200) / 1048576 < 64 ? OK : (perRealJobFile * 200) / 1048576 < 256 ? WARN : BAD,
      basis: 'json-store.js:20 MAX_MEMORY_JOBS=200，缓存里存的是**带交付物正文的完整 job**；500KB 级任务 → 100MB 常驻',
    });
    dropAll(realIds);

    /* --- 1.4 限流 Map 与 SSE 断开后的订阅 --- */
    gcNow();
    const limiterBase = heapMB();
    note(`真实服务带限流（server.js:39 createRateLimiter），基准里前面关掉了，这里单独测。`);
    const limited = await startApp({ rateLimit: true });
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      const r = await postJson(limited.base, '/api/jobs', { goal: `限流探测 ${i + 1}`, demo: true });
      statuses.push(r.status);
      if (r.body?.job?.id) seen.push(r.body.job.id);
    }
    const hits = limited.app.locals.rateLimiter?.hits;
    table(
      ['第几次 POST /api/jobs', 'HTTP 状态'],
      statuses.map((s, i) => [String(i + 1), String(s)]),
    );
    const firstLimit = statuses.indexOf(429);
    metric({
      section: '内存',
      name: '单机单用户连续建任务的限流阈值',
      value: firstLimit >= 0 ? `第 ${firstLimit + 1} 次被 429` : '未触发',
      verdict: firstLimit < 0 ? OK : WARN,
      basis: 'CONTRACT §5.7：每 IP 每分钟 10 次。目标是「单机一个人用」，一分钟内开第 11 个任务会被拒 —— 对普通人是「它坏了」',
    });
    note(`限流 Map 大小 = ${hits?.size ?? 'n/a'}（键 = 规则名|IP；本机只有 1 个 IP，未见无限增长）`);
    await closeApp(limited);

    void limiterBase;
  } finally {
    dropAll(seen);
    await closeApp({ server });
  }
}

/* ================================================================== *
 * 基准 2：HTTP 端点延迟
 * ================================================================== */

async function benchLatency() {
  section('2. HTTP 端点延迟（每个端点 200 次请求）');
  await installDemo(FAST_DEMO ? DEMO_STEP_MS_FAST : DEMO_STEP_MS_REAL);
  const { server, base } = await startApp();
  const created = [];

  try {
    /* --- 准备数据：一个小任务 + 一个 3×3000 字的「大」任务 --- */
    const smallCreated = await postJson(base, '/api/jobs', { goal: '延迟基准：小任务', demo: true });
    const smallId = smallCreated.body.job.id;
    created.push(smallId);
    await waitJob(base, smallId);

    const { id: bigId, job: bigJob } = await runRealJob(base, {
      goal: '延迟基准：含 3 份 3000 字交付物的任务',
      perArtifactChars: 3000,
    });
    created.push(bigId);
    const bigArtifact = bigJob.artifacts.find((a) => a.deliverableId !== '__handoff_guide__');
    const bigBytes = Buffer.byteLength(JSON.stringify(bigJob));

    note(`大任务：${bigJob.artifacts.length} 份产物 / 正文合计 ${bigJob.artifacts.reduce((a, x) => a + x.content.length, 0)} 字符 / 详情响应 ${(bigBytes / 1024).toFixed(1)} KB`);

    /* --- 造 50 个任务（走 store，绕开 429；429 的行为在上面单独测过） --- */
    const manyIds = [];
    const manyJob = await store.getJob(bigId);
    for (let i = 0; i < 49; i += 1) {
      const clone = JSON.parse(JSON.stringify(manyJob));
      clone.id = `job_${String(i).padStart(4, '0')}${'abcdefghijkl'.slice(0, 12)}`;
      clone.goal = `规模基准 ${i}`;
      clone.updatedAt = Date.now() - i * 1000;
      await store.saveJob(clone);
      manyIds.push(clone.id);
    }
    note(`已额外写入 49 个任务文件（同一份大任务内容），加上前面的共 ${await store.countJobs()} 个在内存里`);

    const endpoints = [
      { name: 'GET /api/health', url: `${base}/api/health` },
      { name: 'GET /api/templates', url: `${base}/api/templates` },
      { name: 'GET /api/jobs（小规模）', url: `${base}/api/jobs` },
      { name: 'GET /api/jobs/:id（小任务）', url: `${base}/api/jobs/${smallId}` },
      { name: 'GET /api/jobs/:id（3×3000 字）', url: `${base}/api/jobs/${bigId}` },
      {
        name: 'GET …/artifacts/:id/download',
        url: `${base}/api/jobs/${bigId}/artifacts/${bigArtifact.id}/download`,
      },
      { name: 'GET /api/jobs（50+ 任务后）', url: `${base}/api/jobs` },
    ];

    const N = 200;
    const rows = [];
    const results = [];
    for (const ep of endpoints) {
      // 预热 20 次，避免把 JIT / 首字节的冷启动算进 p50
      for (let i = 0; i < 20; i += 1) await fetch(ep.url).then((r) => r.arrayBuffer());
      const samples = [];
      let bytes = 0;
      for (let i = 0; i < N; i += 1) {
        const t = process.hrtime.bigint();
        const res = await fetch(ep.url);
        const buf = await res.arrayBuffer();
        if (i === 0) bytes = buf.byteLength;
        samples.push(ms(t));
      }
      const s = stats(samples);
      results.push({ ep, s, bytes });
      rows.push([
        ep.name,
        fmtMs(s.p50),
        fmtMs(s.p95),
        fmtMs(s.p99),
        fmtMs(s.max),
        `${(bytes / 1024).toFixed(1)} KB`,
        judgeLatency(s.p50, s.p95),
      ]);
    }

    table(['端点', 'p50', 'p95', 'p99', 'max', '响应体积', '判定'], rows);

    for (const { ep, s } of results) {
      metric({
        section: '延迟',
        name: ep.name,
        value: `p50 ${fmtMs(s.p50)} / p95 ${fmtMs(s.p95)} / p99 ${fmtMs(s.p99)}`,
        verdict: judgeLatency(s.p50, s.p95),
        basis: '普通人对「点一下」的容忍约 1 秒；p95 > 300ms 就开始有「卡顿感」，> 1s 就是「坏了」',
      });
    }

    /* --- 50 个任务后 /api/jobs/:id 的变化 --- */
    const smallBefore = results.find((r) => r.ep.name.includes('小任务'));
    note('对比：加入 49 个任务后，详情页/列表页是否变慢（同一进程内前后对照）');
    const after = [];
    for (const ep of [
      { name: 'GET /api/jobs（50+ 任务后·复测）', url: `${base}/api/jobs` },
      { name: 'GET /api/jobs/:id（小任务·50+ 任务后）', url: `${base}/api/jobs/${smallId}` },
    ]) {
      for (let i = 0; i < 20; i += 1) await fetch(ep.url).then((r) => r.arrayBuffer());
      const samples = [];
      for (let i = 0; i < N; i += 1) {
        const t = process.hrtime.bigint();
        await fetch(ep.url).then((r) => r.arrayBuffer());
        samples.push(ms(t));
      }
      const s = stats(samples);
      after.push([ep.name, fmtMs(s.p50), fmtMs(s.p95), fmtMs(s.p99), judgeLatency(s.p50, s.p95)]);
    }
    table(['端点（任务数变多后）', 'p50', 'p95', 'p99', '判定'], after);
    const listAfterSamples = [];
    for (let i = 0; i < N; i += 1) {
      const t = process.hrtime.bigint();
      await fetch(`${base}/api/jobs`).then((r) => r.arrayBuffer());
      listAfterSamples.push(ms(t));
    }
    const listAfter = stats(listAfterSamples);
    metric({
      section: '延迟',
      name: '任务数从 1 → 50 后 GET /api/jobs 的 p95 变化',
      value: `${fmtMs(results.find((r) => r.ep.name.startsWith('GET /api/jobs（小规模')).s.p95)} → ${fmtMs(listAfter.p95)}`,
      verdict: listAfter.p95 < 300 ? OK : WARN,
      basis: '列表页读的是内存缓存（json-store cache），任务数增加不该显著变慢；变慢说明在反复排序/读盘',
    });
    void smallBefore;
    dropAll(created);
    dropAll(manyIds);
  } finally {
    await closeApp({ server });
  }
}

/* ================================================================== *
 * 基准 3：磁盘 I/O 与持久化缺陷
 * ================================================================== */

async function benchDisk() {
  section('3. 磁盘 I/O（全量写盘 + 原子写）');
  await installDemo(FAST_DEMO ? DEMO_STEP_MS_FAST : DEMO_STEP_MS_REAL);
  const { server, base } = await startApp();
  const created = [];

  try {
    /* --- 3.1 一个真实 8 阶段任务到底写盘多少次、多少字节 --- */
    await wireDeps();
    let saves = 0;
    let writeBytes = 0;
    let saveMsTotal = 0;
    const perSaveMs = [];
    const realSave = store.saveJob;
    engine.deps.saveJob = async (job) => {
      const text = JSON.stringify(job, null, 2);
      const t = process.hrtime.bigint();
      const r = await realSave(job);
      const took = ms(t);
      perSaveMs.push(took);
      saveMsTotal += took;
      saves += 1;
      writeBytes += Buffer.byteLength(text);
      return r;
    };
    const { id: runId, job: runJob } = await runRealJob(base, {
      goal: '磁盘基准：一个完整的 8 阶段任务',
      perArtifactChars: 3000,
    });
    created.push(runId);
    engine.deps.saveJob = realSave;
    const finalFile = path.join(DATA_DIR, 'jobs', `${runId}.json`);
    const finalBytes = fs.statSync(finalFile).size;
    const ss = stats(perSaveMs);

    table(
      ['指标', '实测'],
      [
        ['阶段数 / 产物数', `${runJob.stages.length} / ${runJob.artifacts.length}`],
        ['交付物正文字符', String(runJob.artifacts.reduce((a, x) => a + x.content.length, 0))],
        ['saveJob 调用次数', String(saves)],
        ['写入 JSON 字节合计', `${(writeBytes / 1024).toFixed(1)} KB`],
        ['最终文件大小', `${(finalBytes / 1024).toFixed(1)} KB`],
        ['写放大（写入量 / 最终大小）', `${(writeBytes / finalBytes).toFixed(1)} ×`],
        ['每次 saveJob 耗时 p50 / p95 / max', `${fmtMs(ss.p50)} / ${fmtMs(ss.p95)} / ${fmtMs(ss.max)}`],
        ['saveJob 占用时间合计', `${saveMsTotal.toFixed(0)} ms`],
      ],
    );
    metric({
      section: '磁盘',
      name: '一个 8 阶段任务的 saveJob 次数',
      value: `${saves} 次`,
      verdict: saves > 40 ? BAD : saves > 20 ? WARN : OK,
      basis: '引擎每个阶段边界都全量重写整个 job 文件（json-store.js:296 / 352）；次数 × 文件大小 = 实际写入量',
    });
    metric({
      section: '磁盘',
      name: '单任务写入量 / 写放大',
      value: `${(writeBytes / 1024).toFixed(0)} KB / ${(writeBytes / finalBytes).toFixed(1)}×`,
      verdict: writeBytes / finalBytes > 20 ? BAD : writeBytes / finalBytes > 8 ? WARN : OK,
      basis: '需要新增写盘次数的场景（长交付物）放大更严重：每次 save 都把全部正文重写一遍',
    });
    metric({
      section: '磁盘',
      name: '每次 saveJob 的 p95（含 fsync）',
      value: fmtMs(ss.p95),
      verdict: ss.p95 < 20 ? OK : ss.p95 < 50 ? WARN : BAD,
      basis: 'json-store.js:115 每次都 handle.sync()（fsync）后才 rename，保证掉电不损坏，代价是每次落盘都等磁盘',
    });

    /* --- 3.2 500KB 级任务的单次写盘成本 --- */
    const bigJob = JSON.parse(JSON.stringify(runJob));
    bigJob.id = 'job_' + 'b'.repeat(16);
    // 目标：最终 JSON ≈ 500KB。中文 markdown 在 UTF-8 下约 3 字节/字符。
    const bigPerArtifact = Math.round((500 * 1024) / 4 / 3);
    bigJob.artifacts = bigJob.artifacts.map((a, i) => ({ ...a, content: filler(bigPerArtifact, `big${i}`) }));
    const bigText = JSON.stringify(bigJob, null, 2);
    const bigSize = Buffer.byteLength(bigText);
    const bigSamples = [];
    bigJob.updatedAt = Date.now();
    const BIG_N = 40;
    for (let i = 0; i < BIG_N; i += 1) {
      const t = process.hrtime.bigint();
      await store.saveJob(bigJob);
      bigSamples.push(ms(t));
    }
    const bs = stats(bigSamples);
    table(
      ['job 文件大小', 'saveJob p50', 'p95', 'max', '吞吐'],
      [
        [
          `${(bigSize / 1024).toFixed(0)} KB`,
          fmtMs(bs.p50),
          fmtMs(bs.p95),
          fmtMs(bs.max),
          `${(bigSize / 1024 / (bs.p50 / 1000) / 1024).toFixed(1)} MB/s`,
        ],
      ],
    );
    metric({
      section: '磁盘',
      name: `约 500KB 任务的单次全量写盘（实测 ${(bigSize / 1024).toFixed(0)} KB）`,
      value: fmtMs(bs.p50),
      verdict: bs.p50 < 20 ? OK : bs.p50 < 60 ? WARN : BAD,
      basis: '这个体积的项目每次 save 都要重新序列化 + fsync 整个文件；一个任务 save 20+ 次 → 写放大数十倍',
    });
    metric({
      section: '磁盘',
      name: '500KB 任务整任务理论写入量',
      value: `≈ ${((bigSize * saves) / 1048576).toFixed(1)} MB`,
      verdict: (bigSize * saves) / 1048576 < 8 ? OK : (bigSize * saves) / 1048576 < 32 ? WARN : BAD,
      basis: `按实测 ${saves} 次 saveJob 推算；对 SSD 寿命和「任务跑完时磁盘忙」都有影响`,
    });

    /* --- 3.3 sweepTmpFiles 竞态：会删掉正在写的临时文件，让任务失败 --- */
    section('3b. 持久化竞态：sweepTmpFiles 删掉正在写的 .tmp');
    const raceJob = { ...bigJob, id: 'job_' + 'c'.repeat(16) };
    const p = store.saveJob(raceJob);
    await new Promise((r) => setTimeout(r, 3));
    const tmpBefore = fs.readdirSync(path.join(DATA_DIR, 'jobs')).filter((n) => n.endsWith('.tmp'));
    const swept = await store.sweepTmpFiles();
    let raceErr = null;
    try {
      await p;
    } catch (e) {
      raceErr = e;
    }
    table(
      ['步骤', '观测'],
      [
        ['saveJob 进行中的 .tmp', tmpBefore.join(', ') || '(无)'],
        ['sweepTmpFiles() 删掉的文件数', String(swept)],
        ['saveJob 的结局', raceErr ? `${raceErr.code}: ${String(raceErr.message).slice(0, 70)}…` : '成功'],
      ],
    );
    metric({
      section: '磁盘',
      name: 'sweepTmpFiles() 是否会删掉并发写入的 .tmp',
      value: raceErr ? `会（${raceErr.code}）` : '不会',
      verdict: raceErr ? BAD : OK,
      basis: 'json-store.js:135 无条件 unlink 所有 *.json.tmp；调用点 json-store.js:230（loadFromDisk 每次 force 重载都会跑）→ startSyncTimer 每 30s 一次',
    });

    /* --- 3.4 真实服务里的有机复现：把同步周期压短，看任务会不会因此失败 --- */
    note('只改「每 30 秒重载磁盘」的周期（不改任何产品代码），看真实任务会不会因此失败：');

    async function raceTrial(intervalMs, n) {
      store.stopSyncTimer();
      await store.loadFromDisk({ force: true });
      store.startSyncTimer(intervalMs);
      const bucket = { ok: 0, enoent: 0, other: 0, examples: [] };
      const realError = console.error;
      console.error = (...args) => {
        const line = args.map(String).join(' ');
        if (line.includes('ENOENT')) {
          bucket.examples.push(line.slice(0, 120));
          return; // 这条已经在计数里了，不再刷屏
        }
        realError(...args);
      };
      try {
        for (let i = 0; i < n; i += 1) {
          const c = await postJson(base, '/api/jobs', { goal: `竞态复现 ${i}`, demo: true });
          if (c.status !== 201) {
            // 连「创建任务」都失败：用户在界面上看到的就是一个红色错误
            if (c.text.includes('ENOENT')) bucket.enoent += 1;
            else bucket.other += 1;
            continue;
          }
          const id = c.body.job.id;
          created.push(id);
          let j = null;
          try {
            j = await waitJob(base, id, { timeoutMs: 8000 });
          } catch {
            bucket.other += 1;
            continue;
          }
          if (j.status === 'done') bucket.ok += 1;
          else if (String(j.error?.message ?? '').includes('ENOENT')) bucket.enoent += 1;
          else bucket.other += 1;
        }
      } finally {
        console.error = realError;
        store.stopSyncTimer();
      }
      return bucket;
    }

    const RACE_N = 50;
    const trials = [];
    for (const interval of [30, 100, 300, 1000]) {
      const b = await raceTrial(interval, RACE_N);
      trials.push({ interval, ...b });
    }
    table(
      ['同步周期（真实值 30000ms）', '任务数', 'done', '因 ENOENT 失败', '其他失败', '失败率'],
      trials.map((t) => [
        `${t.interval} ms`,
        String(RACE_N),
        String(t.ok),
        String(t.enoent),
        String(t.other),
        `${((t.enoent / RACE_N) * 100).toFixed(0)} %`,
      ]),
    );
    if (trials[0].examples[0]) note(`服务端真实日志（节选）：${trials[0].examples[0]}`);

    /* 真实周期下的发生率：用「一次任务里 .tmp 存在的总时长 / 同步周期」估算。
       .tmp 存在时长 ≈ 单次 saveJob 的 p50（fsync 占绝大部分），次数 = 实测 saveJob 次数。 */
    const windowMs = saves * ss.p50;
    const realRate = Math.min(1, windowMs / 30_000);
    metric({
      section: '磁盘',
      name: '同步与写盘竞态导致的真实任务失败（周期 30ms 实测）',
      value: `${trials[0].enoent}/${RACE_N}（${((trials[0].enoent / RACE_N) * 100).toFixed(0)} %）`,
      verdict: trials[0].enoent === 0 ? OK : BAD,
      basis: '机制 100% 是 json-store.js:135 sweepTmpFiles 无条件删 .tmp；用户看到的是「新建任务」直接 500，或任务跑到一半莫名失败',
    });
    metric({
      section: '磁盘',
      name: '真实 30s 周期下的发生率（按窗口估算，非实测）',
      value: `≈ ${(realRate * 100).toFixed(2)} %/任务`,
      verdict: realRate < 0.001 ? OK : realRate < 0.01 ? WARN : BAD,
      basis: `估算式 = 单任务 saveJob 次数(${saves}) × 单次 .tmp 存活时长(p50 ${ss.p50.toFixed(1)}ms) / 30000ms = ${windowMs.toFixed(0)}ms/30s。真实周期太长，基准跑不出统计量，只能估算`,
    });
  } finally {
    store.stopSyncTimer();
    dropAll(created);
    await closeApp({ server });
  }
}

/* ================================================================== *
 * 基准 4：启动与持久化规模
 * ================================================================== */

async function benchStartup() {
  section('4. 启动与持久化规模');
  await installDemo(FAST_DEMO ? DEMO_STEP_MS_FAST : DEMO_STEP_MS_REAL);
  await wireDeps();

  const seed = await startApp();
  const created = [];
  try {
    // 用一条真实的 8 阶段任务当模板（形状最贴近真实数据）
    const r = await runRealJob(seed.base, { goal: '规模基准模板任务', perArtifactChars: 3000 });
    created.push(r.id);
    const template = JSON.parse(JSON.stringify(await store.getJob(r.id)));

    const cases = [
      { n: 200, perArtifact: 700, label: '200 个任务（小型 ~2KB）' },
      { n: 2000, perArtifact: 700, label: '2000 个任务（小型 ~2KB）' },
      { n: 200, perArtifact: 3000, label: '200 个任务（3×3000 字 ~42KB）' },
      { n: 2000, perArtifact: 3000, label: '2000 个任务（3×3000 字 ~42KB）' },
    ];

    const rows = [];
    for (const c of cases) {
      const dir = path.join(DATA_DIR, 'jobs');
      await fsp.mkdir(dir, { recursive: true });
      // 注意：清理时也要容忍「读到的名字在 unlink 之前被改名走了」——
      // 这正是被 .tmp 竞态暴露出来的现象，基准脚本自己要稳。
      for (const name of await fsp.readdir(dir)) await fsp.unlink(path.join(dir, name)).catch(() => {});

      const job = JSON.parse(JSON.stringify(template));
      job.artifacts = (job.artifacts?.length ? job.artifacts : [{ id: 'a', name: 'a', format: 'markdown' }]).map(
        (a, i) => ({ ...a, id: `art_${i}`, content: filler(c.perArtifact, `s${i}`) }),
      );
      const fileBytes = Buffer.byteLength(JSON.stringify(job, null, 2));
      const tWrite = process.hrtime.bigint();
      for (let i = 0; i < c.n; i += 1) {
        const one = { ...job, id: `job_${String(i).padStart(6, '0')}${'e'.repeat(8)}`, updatedAt: Date.now() - i * 1000 };
        await fsp.writeFile(path.join(dir, `${one.id}.json`), JSON.stringify(one, null, 2));
      }
      const writeMs = ms(tWrite);

      gcNow();
      const heapBefore = heapMB();
      const t0 = process.hrtime.bigint();
      store.resetStore();
      await store.loadFromDisk();
      const coldMs = ms(t0);
      gcNow();
      const heapAfter = heapMB();

      // 第二次：模拟 startSyncTimer 每 30s 的 force 重载
      const t1 = process.hrtime.bigint();
      await store.loadFromDisk({ force: true });
      const reloadMs = ms(t1);

      const cached = await store.countJobs();
      rows.push([
        c.label,
        `${(fileBytes / 1024).toFixed(0)} KB`,
        `${((fileBytes * c.n) / 1048576).toFixed(1)} MB`,
        fmtMs(coldMs),
        fmtMs(reloadMs),
        `${cached} 个`,
        `+${(heapAfter - heapBefore).toFixed(1)} MB`,
      ]);
      metric({
        section: '启动',
        name: `冷启动加载 ${c.label}`,
        value: fmtMs(coldMs),
        verdict: coldMs < 1000 ? OK : coldMs < 3000 ? WARN : BAD,
        basis: '这是 npm start 到「能打开页面」的固定延迟（server.js:301 先等 loadFromDisk 再 listen）；超过 2-3 秒普通人会以为没启动起来',
      });
      metric({
        section: '启动',
        name: `每 30 秒的后台重载（${c.label}）`,
        value: fmtMs(reloadMs),
        verdict: reloadMs < 200 ? OK : reloadMs < 1000 ? WARN : BAD,
        basis: 'json-store.js:251 startSyncTimer 每 30s 把整个目录重读一遍（顺序读 + 逐个 JSON.parse）；期间抢 CPU 与磁盘，且会顺带跑 sweepTmpFiles()',
      });
      note(`造这 ${c.n} 个文件本身花了 ${(writeMs / 1000).toFixed(1)} s（一次性准备，不计入判定）`);
    }

    table(['规模', '单文件', '占磁盘', '冷启动', '后台重载', '内存缓存', '堆增量'], rows);
    note('内存缓存上限是 200（json-store.js:20）：2000 个任务时仍然**全部读一遍并 parse**，只是只留 200 个在内存。');
    note('也就是说：任务攒得越多，「每 30 秒一次」的后台重载越贵，而它对用户没有任何可见收益。');
  } finally {
    await closeApp(seed);
    dropAll(created);
    const dir = path.join(DATA_DIR, 'jobs');
    for (const name of await fsp.readdir(dir).catch(() => [])) await fsp.unlink(path.join(dir, name)).catch(() => {});
    store.resetStore();
    await store.loadFromDisk();
  }
}

/* ================================================================== *
 * 基准 5：SSE 连接的代价
 * ================================================================== */

async function benchSse() {
  section('5. SSE 连接的代价（同一个 job 上开 50 条连接）');
  await installDemo(FAST_DEMO ? DEMO_STEP_MS_FAST : DEMO_STEP_MS_REAL);
  const { server, base } = await startApp();
  const created = [];

  try {
    const { id, job } = await runRealJob(base, { goal: 'SSE 基准任务', perArtifactChars: 3000 });
    created.push(id);

    gcNow();
    const heapBefore = heapMB();
    const CONNS = 50;
    const t0 = process.hrtime.bigint();
    const sessions = await Promise.all(Array.from({ length: CONNS }, () => sseOpen(base, id)));
    const openMs = ms(t0);
    const listenersDuring = events.listenerCount(id);

    // 已完成的 job 连上去会先补发全量历史 + 快照
    await new Promise((r) => setTimeout(r, 300));
    const ttfb = stats(sessions.map((s) => s.ttfbMs ?? 0));
    const frames = sessions.map((s) => s.frames);

    // 让所有连接同时收到一条广播，量「一条事件到 50 个客户端的延迟」
    const tBroadcast = process.hrtime.bigint();
    events.publish(id, { type: 'log', stageId: null, level: 'info', text: 'SSE 基准广播', at: Date.now() });
    const before = sessions.map((s) => s.frames);
    await new Promise((r) => setTimeout(r, 200));
    const delivered = sessions.filter((s, i) => s.frames > before[i]).length;
    const broadcastMs = ms(tBroadcast);

    gcNow();
    const heapDuring = heapMB();

    await Promise.all(sessions.map(sseClose));
    await new Promise((r) => setTimeout(r, 200));
    const listenersAfter = events.listenerCount(id);
    gcNow();
    const heapAfter = heapMB();

    table(
      ['指标', '实测'],
      [
        [`${CONNS} 条连接全部建立耗时`, fmtMs(openMs)],
        ['首字节 p50 / p95 / max', `${fmtMs(ttfb.p50)} / ${fmtMs(ttfb.p95)} / ${fmtMs(ttfb.max)}`],
        ['补发帧数（每条连接）', frames[0] === frames[frames.length - 1] ? String(frames[0]) : `${Math.min(...frames)}~${Math.max(...frames)}`],
        ['建立期间的 SSE 监听器数', String(listenersDuring)],
        ['断开后的 SSE 监听器数', String(listenersAfter)],
        ['50 条连接额外占用的堆', fmtMB(heapDuring - heapBefore)],
        ['断开后回收', fmtMB(heapDuring - heapAfter)],
        ['一条广播送达 50 个客户端的耗时', fmtMs(broadcastMs)],
        ['收到广播的客户端数', `${delivered}/${CONNS}`],
      ],
    );
    metric({
      section: 'SSE',
      name: `同一 job 上 ${CONNS} 条 SSE 连接的建立耗时`,
      value: fmtMs(openMs),
      verdict: openMs < 1000 ? OK : WARN,
      basis: '「同时开 10 个标签页看同一个任务」是真实场景；每条连接都要补发历史日志',
    });
    metric({
      section: 'SSE',
      name: '断开 50 条连接后监听器残留',
      value: `${listenersAfter} 个`,
      verdict: listenersAfter === 0 ? OK : BAD,
      basis: 'sseHandler 必须幂等退订（src/util/sse.js:100-111）；>0 意味着反复刷新页面会稳定泄漏',
    });
    metric({
      section: 'SSE',
      name: '一条事件广播到 50 个客户端的延迟',
      value: fmtMs(broadcastMs),
      verdict: broadcastMs < 100 ? OK : WARN,
      basis: '前端「实时看见进度」的体感下限；100ms 以内肉眼无感',
    });
    metric({
      section: 'SSE',
      name: `${CONNS} 条连接的额外堆占用`,
      value: fmtMB(heapDuring - heapBefore),
      verdict: heapDuring - heapBefore < 8 ? OK : WARN,
      basis: `每条连接一个监听器 + 一个 15s 心跳定时器；${CONNS} × 3 个标签页仍在本机可承受范围`,
    });
    note(`连接期间事件日志条数 ${events.since(id, 0).length}（每个连接都要把这段补发一遍）`);
    void job;
  } finally {
    dropAll(created);
    await closeApp({ server });
  }
}

/* ================================================================== *
 * 基准 6：kill -9 崩溃恢复
 * ================================================================== */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function spawnServer(dataDir, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
    env: { ...process.env, HANDOFF_DATA_DIR: dataDir, HANDOFF_PORT: String(port), HANDOFF_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.on('data', (d) => (child.stdoutText += d.toString()));
  child.stderr.on('data', (d) => (child.stderrText += d.toString()));
  return child;
}

async function waitForPort(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function benchCrash() {
  section('6. 崩溃恢复：任务跑到一半被 kill -9');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-bench-crash-'));
  assertSafeDataDir(dir);
  const statusBefore = (j) => j?.status ?? 'n/a';
  let child = null;
  let child2 = null;

  try {
    const port = await freePort();
    child = spawnServer(dir, port);
    if (!(await waitForPort(port))) throw new Error(`服务没起来：${child.stderrText.slice(0, 300)}`);
    const base = `http://127.0.0.1:${port}`;

    // 用**真实节奏**的演示任务（5.6 秒），这样能在中途杀掉
    const created = await postJson(base, '/api/jobs', { goal: '崩溃恢复：跑到一半被杀掉的任务', demo: true });
    const id = created.body.job.id;
    await new Promise((r) => setTimeout(r, 2000)); // 停在流水线中段

    const before = await httpJson(`${base}/api/jobs/${id}`);
    const stagesBefore = (before.body?.job?.stages ?? []).map((s) => `${s.key}:${s.status}`);

    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    // 盘上留下了什么
    const file = path.join(dir, 'jobs', `${id}.json`);
    const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'));
    const stagesOnDisk = (onDisk.stages ?? []).map((s) => `${s.key}:${s.status}`);

    // 重启（同一个数据目录）
    const port2 = await freePort();
    child2 = spawnServer(dir, port2);
    if (!(await waitForPort(port2))) throw new Error(`重启后服务没起来：${child2.stderrText.slice(0, 300)}`);
    const base2 = `http://127.0.0.1:${port2}`;

    const t0 = process.hrtime.bigint();
    const after = await httpJson(`${base2}/api/jobs/${id}`);
    const loadMs = ms(t0);
    const statusAfter = after.body?.job?.status;
    const stagesAfter = (after.body?.job?.stages ?? []).map((s) => `${s.key}:${s.status}`);

    // 用户打开这个页面会看到什么：SSE 挂 1.5 秒，数收到多少帧
    const s = await sseOpen(base2, id);
    await new Promise((r) => setTimeout(r, 1500));
    const sseBytes = s.bytes;
    const sseFrames = s.frames;
    const sseText = s.text.slice(0, 200);
    await sseClose(s);

    // 再等 3 秒，看有没有任何机制把它从 running 里救出来
    await new Promise((r) => setTimeout(r, 3000));
    const later = await httpJson(`${base2}/api/jobs/${id}`);

    table(
      ['观测点', '结果'],
      [
        ['杀之前（内存里）', statusBefore(before.body?.job) + ' | ' + stagesBefore.join(' ')],
        ['杀之后（盘上文件）', `${onDisk.status} | ${stagesOnDisk.join(' ')}`],
        ['重启后 GET /api/jobs/:id', `${after.status} → ${statusAfter} | ${stagesAfter.join(' ')}`],
        ['重启后首次读该任务的耗时', fmtMs(loadMs)],
        ['SSE 挂 1.5 秒收到', `${sseFrames} 帧 / ${sseBytes} 字节（${JSON.stringify(sseText.slice(0, 60))}）`],
        ['再等 3 秒后状态', later.body?.job?.status],
        ['错误字段', JSON.stringify(after.body?.job?.error)],
      ],
    );

    const stuck = statusAfter === 'running';
    metric({
      section: '崩溃',
      name: 'kill -9 后重启，未完成任务的状态',
      value: `${statusAfter}${statusAfter === 'running' ? '（永远卡住）' : ''}`,
      verdict: stuck ? BAD : OK,
      basis: '启动时没有任何代码把 running 改成 interrupted/failed（grep 全仓无此逻辑）；running 的 Map 是纯内存的，重启即丢',
    });
    metric({
      section: '崩溃',
      name: '重启后用户打开这个页面的体感',
      value: `SSE ${sseFrames} 帧，无任何进度`,
      verdict: sseFrames <= 1 ? BAD : OK,
      basis: '事件日志也在内存里（events.js #logs），重启即空 → 补发 0 条，只剩心跳；界面会永远显示「运行中」',
    });
    metric({
      section: '崩溃',
      name: '任务卡在 running 时的可恢复性',
      value: after.body?.job?.stages?.some((x) => x.status === 'running') ? '需要用户手动点「重试」' : 'n/a',
      verdict: stuck ? WARN : OK,
      basis: 'POST /api/jobs/:id/retry 可用（没有 failed 阶段时会从 intake 整条重跑），但界面不会主动提示，普通用户不会知道',
    });
  } finally {
    for (const c of [child, child2]) {
      if (c && c.exitCode === null) {
        c.kill('SIGKILL');
        await new Promise((r) => c.once('exit', r));
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/* ================================================================== *
 * 汇总与入口
 * ================================================================== */

function printSummary(totalMs) {
  section('总表（报告里直接贴这一张）');
  const rows = SUMMARY.map((m) => [m.section, m.name, m.value, m.verdict ?? '—', m.basis]);
  table(['类别', '指标', '实测值', '判定', '依据'], rows);

  const bad = SUMMARY.filter((m) => m.verdict === BAD).length;
  const warn = SUMMARY.filter((m) => m.verdict === WARN).length;
  const ok = SUMMARY.filter((m) => m.verdict === OK).length;
  console.log('');
  console.log(`  ✅ ${ok}   ⚠️ ${warn}   🔴 ${bad}      总耗时 ${(totalMs / 1000).toFixed(1)} s`);
  console.log(`  数据目录 ${DATA_DIR}（已删除）`);
}

const COMMANDS = {
  memory: benchMemory,
  latency: benchLatency,
  disk: benchDisk,
  startup: benchStartup,
  sse: benchSse,
  crash: benchCrash,
};

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
  if (flags.has('--real-timing')) FAST_DEMO = false;

  const cmd = argv[0] ?? 'all';
  if (cmd !== 'all' && !COMMANDS[cmd]) {
    console.error(`未知子命令：${cmd}`);
    console.error(`可用：all ${Object.keys(COMMANDS).join(' ')}`);
    process.exit(2);
  }

  console.log('');
  console.log('\x1b[1m交接 Handoff — 性能与可靠性基准（S10）\x1b[0m');
  console.log(`  Node ${process.version} · 平台 ${process.platform}/${process.arch} · 版本 ${VERSION}`);
  console.log(`  数据目录 ${DATA_DIR}（临时，结束即删）`);
  console.log(`  GC ${global.gc ? '已启用（--expose-gc）' : '未启用 —— 堆数字会偏高'}`);
  console.log(`  演示节奏 ${FAST_DEMO ? '加速（0ms/阶段，仅影响进度条间隔）' : '真实（700ms/阶段）'}`);

  const t0 = process.hrtime.bigint();
  const list = cmd === 'all' ? Object.keys(COMMANDS) : [cmd];
  const failed = [];
  for (const name of list) {
    try {
      await COMMANDS[name]();
    } catch (err) {
      failed.push({ name, err });
      console.log('');
      console.log(`\x1b[31m  [${name}] 基准执行失败：${err?.stack ?? err}\x1b[0m`);
    }
  }
  printSummary(ms(t0));

  if (failed.length) {
    console.log('');
    console.log(`\x1b[31m  ${failed.length} 个基准段落执行失败：${failed.map((f) => f.name).join(', ')}\x1b[0m`);
    process.exitCode = 1;
  }
}

await main();
cleanup();
