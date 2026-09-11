/**
 * 持久化：一个 job 一个 JSON 文件。
 *
 * 为什么不用数据库？——普通人跑一个任务要几分钟，几千个任务远没到需要数据库的规模。
 * 一个文件一个 job 的好处是「肉眼可查、坏了只坏一个、rm 就是删除」。
 *
 * 但这个简单方案有三个坑，必须在这里堵住：
 *  1. 路径穿越：id 来自 URL，如果不校验，`../../etc/passwd` 就能读任意文件。
 *  2. 半截 JSON：断电/崩溃时写一半，下次启动读到损坏文件。→ 先写 .tmp 再 rename（原子）。
 *  3. 并行覆盖：流水线多个阶段同时改同一个 job，读-改-写会互相吃掉对方的修改。
 *     → 同一个 id 的写操作串行化（promise 队列链），updateJob 是原子读-改-写。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** id 白名单。这是防路径穿越的第一道闸，也是最关键的一道。 */
export const JOB_ID_RE = /^job_[a-z0-9]{8,32}$/;

/**
 * 内存里最多留多少个 job（按 updatedAt 保留最新的）。
 *
 * 性能画像（实测，详见 docs/PERFORMANCE.md）：缓存的是**带交付物正文**的完整 job，
 * 200 个 178KB 的任务 ≈ +66MB 常驻，500KB 级任务推算上限约 185MB。
 *
 * 试过"只让最近 30 个任务保留正文、更早的剥掉、getJob 时读盘补回来"，
 * **已回退** —— 见文件末尾 `cachePut` 附近的注释。原因是那样会出现在
 * "详情页拿到空正文"的路径上：**用户能不能看到自己的成果，不可交易。**
 */

const MAX_MEMORY_JOBS = 200;

/** 内存缓存：id -> job。刷新页面时命中这里，不用读盘。 */
const cache = new Map();

/** per-id 串行队列尾指针：id -> Promise。保证同一 id 的读改写不交叉。 */
const chains = new Map();

/** 启动加载只做一次 */
let loadPromise = null;

/**
 * 记录「这份缓存是对哪个数据目录建的」。
 *
 * ⚠️ 这是个真实的工程坑（被 flaky 测试逼出来的）：
 * 测试框架会把多个测试文件放在**同一个进程**里跑，每个文件都会把
 * `HANDOFF_DATA_DIR` 指到自己的临时目录。如果没有这个守卫，第二个文件调用
 * `loadFromDisk({force:true})` 时会**清空整份缓存**（缓存里是第一、三个文件的任务），
 * 于是别的测试正在等的任务突然"读不到"了 —— 表现为随机失败，很难查。
 *
 * 生产环境不会遇到（进程只服务一个数据目录），但"多个数据目录共用一个进程"
 * 是测试的常态，而且这个守卫本身零成本。
 */
let cacheForDataDir = null;

/** 后台同步定时器（unref，不阻塞进程退出） */
let syncTimer = null;
let loadedOnce = false;

/* ------------------------------------------------------------------ */
/* 路径与校验                                                          */
/* ------------------------------------------------------------------ */

/** 数据根目录。每次调用都重新读 env —— 测试要能换目录，禁止在模块顶层固化。 */
export function getDataDir() {
  return process.env.HANDOFF_DATA_DIR || './data';
}

export function getJobsDir() {
  return path.join(getDataDir(), 'jobs');
}

/** id 是否合法。不合法直接抛，绝不落到文件系统调用上。 */
export function assertValidJobId(id) {
  if (typeof id !== 'string' || !JOB_ID_RE.test(id)) {
    const err = new Error(`非法任务 id：${String(id).slice(0, 64)}`);
    err.code = 'BAD_JOB_ID';
    err.status = 400;
    throw err;
  }
  return id;
}

export function isValidJobId(id) {
  return typeof id === 'string' && JOB_ID_RE.test(id);
}

/** 校验后再拼路径，并且做一次 resolve 兜底（双重保险） */
function jobFilePath(id) {
  assertValidJobId(id);
  const dir = getJobsDir();
  const full = path.resolve(dir, `${id}.json`);
  // rename/resolve 之后必须仍在 jobs 目录里。理论上上面的正则已经挡住了，
  // 但安全这东西不该只有一层。
  if (!full.startsWith(path.resolve(dir) + path.sep)) {
    const err = new Error('非法任务路径');
    err.code = 'BAD_JOB_ID';
    err.status = 400;
    throw err;
  }
  return full;
}

/* ------------------------------------------------------------------ */
/* 并发串行化                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把 fn 排到该 id 的队列尾部。返回 fn 的结果。
 * 前一个任务失败不影响后一个（用 catch 把链上的拒绝吃掉，否则会 unhandledRejection）。
 */
function withLock(id, fn) {
  assertValidJobId(id);
  const prev = chains.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // 链上只保留「完成」信号，不传播错误
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(id, tail);
  tail.then(() => {
    // 队列空了就把表项删掉，否则长跑服务会攒一堆 id
    if (chains.get(id) === tail) chains.delete(id);
  });
  return run;
}

/* ------------------------------------------------------------------ */
/* 原子写盘                                                            */
/* ------------------------------------------------------------------ */

/**
 * 临时文件名的唯一计数器。
 *
 * ⚠️ 这里曾经用**固定名** `${file}.tmp`，并配上一个"清扫所有 *.json.tmp"的
 * `sweepTmpFiles()`，而后者被每 30 秒一次的 `loadFromDisk({force:true})` 调用。
 * 结果：清扫把**正在写**的临时文件删掉 → 随后的 `rename` 报 ENOENT →
 * `saveJob` 失败 → 用户看到「新建任务」直接 500。
 * 性能工程师实测：同步周期压到 30ms 时 100 个任务里 7 个失败；
 * 换算到真实的 30 秒周期，大约每 150 个任务会莫名失败 1 个 ——
 * 这正是"偶发、复现不了、用户觉得是产品不行"的那类 bug。
 *
 * 修法：临时文件名带上 pid 和自增序号，**永远不会和别人重名**。
 * 这样清扫就再也删不到活文件（见 sweepTmpFiles 的时间阈值兜底）。
 */
let tmpSeq = 0;
const uniqueTmpPath = (file) => `${file}.${process.pid}.${(tmpSeq += 1)}.tmp`;

/** 先写唯一名临时文件，fsync，再 rename 覆盖。任何时刻盘上要么是旧版本，要么是新版本。 */
async function atomicWrite(file, text) {
  const tmp = uniqueTmpPath(file);
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    // 让 rename 之前数据真的落到磁盘，避免掉电后 rename 成功但内容为空
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    // rename 失败要自己收拾干净，别留残渣
    try {
      await fs.unlink(tmp);
    } catch {
      /* 已经没了就算了 */
    }
    throw err;
  }
}

/**
 * 清掉**确实是残留**的临时文件。
 *
 * 只删除 5 分钟以前的：正在写的临时文件最多活几十毫秒，
 * 5 分钟这个阈值足够宽松，任何在阈值内的都是真的卡住的残渣。
 * （踩过的坑见上面 uniqueTmpPath 的注释 —— 无条件删除会删活文件。）
 */
const TMP_STALE_MS = 5 * 60 * 1000;

export async function sweepTmpFiles() {
  const dir = getJobsDir();
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  let n = 0;
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    const full = path.join(dir, name);
    try {
      const st = await fs.stat(full);
      if (now - st.mtimeMs < TMP_STALE_MS) continue; // 可能是别人正在写的，别碰
      await fs.unlink(full);
      n += 1;
    } catch {
      /* 删不掉就算了，不影响服务 */
    }
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* 内存缓存                                                            */
/* ------------------------------------------------------------------ */

function isJobLike(v) {
  return v !== null && typeof v === 'object' && typeof v.id === 'string';
}

/** 写入缓存并按 updatedAt 淘汰，最多留 MAX_MEMORY_JOBS 个 */
function cachePut(job) {
  if (!isJobLike(job)) return job;
  cache.set(job.id, job);
  if (cache.size > MAX_MEMORY_JOBS) {
    const sorted = [...cache.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    for (const stale of sorted.slice(MAX_MEMORY_JOBS)) cache.delete(stale.id);
  }
  return job;
}

/**
 * ⚠️ 记录一次被否决的优化（2026-09-12，别再走一遍这条路）
 *
 * 性能工程师实测：缓存里存的是**带交付物正文的完整 job**，
 * 一个 178KB 的任务 200 个就是 +66MB 常驻（500KB 级推算上限 185MB）。
 * 看起来值得优化：只让最近 30 个任务在内存里留正文，更早的剥掉，
 * `getJob` 命中无正文的条目时读盘补回来（一次读盘 p95 只有 4.86ms）。
 *
 * **试过，回退了。**原因：
 *  · 剥离发生在 `cachePut` 里时，会**把正要返回给调用方的那份对象自己剥掉** ——
 *    用户打开一个老任务，交付物是空白。这比多占 60MB 严重得多。
 *  · 把剥离挪到"安全的时机"（loadFromDisk 之后 / listJobs 里）之后，
 *    仍然出现了"详情页拿到空正文"的路径，排查成本已经超过收益。
 *
 * 结论：**"用户能不能看到自己的成果"是不可交易的。**内存上限 200 个任务、
 * 最坏约 185MB 常驻，对这个"单机一个人用"的产品是可接受的代价。
 * 如果你将来真要优化这里，请先补一条测试：
 * **造 40 个带正文的任务，然后断言每一个的 `getJob().artifacts[0].content` 都完整。**
 */

function sortByUpdatedDesc(jobs) {
  return jobs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

async function readFileSafe(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isJobLike(parsed)) {
      console.warn(`[json-store] 跳过形状不对的文件：${path.basename(file)}`);
      return null;
    }
    return parsed;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    // 损坏的 json 只记日志，绝不让服务起不来
    console.warn(`[json-store] 跳过损坏文件 ${path.basename(file)}：${err.message}`);
    return null;
  }
}

/**
 * 启动时把磁盘上所有 job 读进内存（最多 200 个）。
 * 只执行一次；并发调用共享同一个 promise。
 */
export async function loadFromDisk({ force = false } = {}) {
  // 数据目录换了 → 之前那份缓存属于别的目录，必须整体重建
  const dir = getJobsDir();
  if (cacheForDataDir !== null && cacheForDataDir !== dir) {
    cache.clear();
    loadPromise = null;
    loadedOnce = false;
  }
  cacheForDataDir = dir;

  if (force) {
    loadPromise = null;
    loadedOnce = false;
  }
  if (loadedOnce) return cache;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const dir = getJobsDir();
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      console.warn(`[json-store] 建目录失败：${err.message}`);
      loadedOnce = true;
      return cache;
    }

    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      console.warn(`[json-store] 读目录失败：${err.message}`);
    }

    const jobs = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue; // .tmp 之类直接跳过
      const id = name.slice(0, -'.json'.length);
      if (!isValidJobId(id)) {
        console.warn(`[json-store] 跳过文件名非法的文件：${name}`);
        continue;
      }
      const job = await readFileSafe(path.join(dir, name));
      if (job) jobs.push(job);
    }

    sortByUpdatedDesc(jobs);
    for (const job of jobs) cachePut(job);

    loadedOnce = true;
    // 启动时顺手清掉上次崩溃留下的临时文件
    await sweepTmpFiles();
    return cache;
  })();

  try {
    return await loadPromise;
  } finally {
    // 失败也标记完成，避免每次请求都重试读盘
    loadedOnce = true;
  }
}

/** 确保启动加载跑过一次 */
async function ready() {
  if (!loadedOnce) await loadFromDisk();
}

/**
 * 定期与磁盘同步：外部改动（手工删文件、别的进程写）不会让内存变成永久幻觉。
 * unref() 让这个定时器不阻止进程退出。
 */
export function startSyncTimer(intervalMs = 30_000) {
  if (syncTimer) return syncTimer;
  syncTimer = setInterval(() => {
    const chain = chains.size > 0 ? Promise.all([...chains.values()]) : Promise.resolve();
    chain
      .then(() => loadFromDisk({ force: true }))
      .catch((err) => console.warn(`[json-store] 同步失败：${err.message}`));
  }, intervalMs);
  syncTimer.unref?.();
  return syncTimer;
}

export function stopSyncTimer() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

/**
 * 等待所有**已经在排队的**写盘完成。
 *
 * 为什么这个函数有存在的必要（不只是给测试用）：
 * 内存里的 job 状态先变，落盘是紧随其后的独立异步操作。于是存在一个真实窗口：
 * 「`GET /api/jobs/:id` 已经返回 done」但「磁盘上还是 running」。
 *  · 测试在这个窗口里读盘 → 偶发失败（我们被它折腾了很久）
 *  · 进程在这个窗口里被 kill → 用户丢掉最后一次状态更新
 *  · 关服/重启前如果不排空 → 同上
 *
 * 所以它既是测试的同步点，也是优雅关闭该调用的东西。
 * @returns {Promise<void>}
 */
export async function flushWrites() {
  // chains 里存的是每个 id 的串行队列尾。反复取快照直到不再变化，
  // 因为等待期间可能又有新的写进来。
  for (let round = 0; round < 50; round += 1) {
    const pending = [...chains.values()];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
    // 队列尾自己会在清空后把自己从表里删掉；再取一次看有没有新的
    if (chains.size === 0) return;
    if ([...chains.values()].every((p) => pending.includes(p))) return;
  }
}

/** 测试辅助：清空内存与队列（不动磁盘） */
export function resetStore() {
  cache.clear();
  chains.clear();
  loadPromise = null;
  loadedOnce = false;
}

/* ------------------------------------------------------------------ */
/* 对外 API（engine / routes 用）                                       */
/* ------------------------------------------------------------------ */

/** 原子写盘。返回写进去的 job 对象本身。 */
export async function saveJob(job) {
  if (!isJobLike(job)) {
    const err = new Error('saveJob 需要带 id 的 job 对象');
    err.code = 'BAD_JOB_ID';
    err.status = 400;
    throw err;
  }
  const id = assertValidJobId(job.id);
  return withLock(id, async () => {
    const dir = getJobsDir();
    await fs.mkdir(dir, { recursive: true });
    const file = jobFilePath(id);
    const now = Date.now();
    if (typeof job.createdAt !== 'number') job.createdAt = now;
    job.updatedAt = now;
    await atomicWrite(file, JSON.stringify(job, null, 2));
    cachePut(job);
    return job;
  });
}

/** 读一个 job。内存优先，未命中读盘。不存在返回 null。 */
export async function getJob(id) {
  if (!isValidJobId(id)) return null;
  await ready();
  if (cache.has(id)) return cache.get(id);
  const job = await readFileSafe(jobFilePath(id));
  if (job) cachePut(job);
  return job;
}

/**
 * 磁盘上的**所有**任务（不受内存缓存上限约束）。
 *
 * 为什么需要它：`listJobs()` 只返回内存缓存里的 job，而缓存上限是 200 个。
 * 于是「启动时把跑了一半的任务标记为中断」这种**必须扫全量**的维护操作，
 * 一旦任务数超过 200，第 201 个及更早的中断任务就**永远卡在"运行中"** ——
 * 用户每次打开都看到一个永远不会往前走的进度条，重启多少次都修不好
 * （对抗性测试 S9-8 实测）。
 *
 * 注意：它会读盘，比 listJobs 慢，所以只给启动/维护路径用，不要放进请求热路径。
 * @param {number} [limit] 安全上限，防止目录被塞了几万文件时启动卡死
 */
export async function listAllJobsOnDisk(limit = 5000) {
  await ready();
  const dir = getJobsDir();
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [...cache.values()];
  }
  const jobs = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (jobs.length >= limit) break;
    const id = name.slice(0, -'.json'.length);
    if (!isValidJobId(id)) continue;
    const job = await readFileSafe(jobFilePath(id));
    if (job) jobs.push(job);
  }
  // 保险：把缓存里可能有、但目录里已经不在的也算进来（避免漏）
  for (const job of cache.values()) {
    if (!jobs.some((j) => j.id === job.id)) jobs.push(job);
  }
  return jobs;
}

/** 最新在前（updatedAt 降序），最多 limit 条，默认 50。 */
export async function listJobs(limit = 50) {
  await ready();
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_MEMORY_JOBS) : 50;
  return sortByUpdatedDesc([...cache.values()]).slice(0, n);
}

export async function deleteJob(id) {
  if (!isValidJobId(id)) return false;
  await ready();
  return withLock(id, async () => {
    cache.delete(id);
    try {
      await fs.unlink(jobFilePath(id));
    } catch (err) {
      if (err && err.code === 'ENOENT') return false;
      throw err;
    }
    return true;
  });
}

/**
 * 原子读-改-写。mutator(job) 就地修改即可（返回值忽略）。
 * 并行调用会被串行化，所以「20 个并发 updateJob 后计数正确」是能保证的。
 */
export async function updateJob(id, mutator) {
  if (!isValidJobId(id)) return null;
  if (typeof mutator !== 'function') throw new TypeError('updateJob 需要 mutator 函数');
  await ready();
  return withLock(id, async () => {
    const file = jobFilePath(id);
    const current = cache.has(id) ? cache.get(id) : await readFileSafe(file);
    if (!current) return null;
    await mutator(current);
    const now = Date.now();
    if (typeof current.createdAt !== 'number') current.createdAt = now;
    current.updatedAt = now;
    const dir = getJobsDir();
    await fs.mkdir(dir, { recursive: true });
    await atomicWrite(file, JSON.stringify(current, null, 2));
    cachePut(current);
    return current;
  });
}

/** 当前内存里的 job 数（/api/health 用） */
export async function countJobs() {
  await ready();
  return cache.size;
}

/** 该 id 是否正在排队（测试辅助） */
export function pendingLocks() {
  return chains.size;
}
