/**
 * json-store 单元测试。
 *
 * 重点不是「能不能存」，而是三个会真出事的点：
 *  - 路径穿越（安全工程师会重点打这里）
 *  - 并发读-改-写（流水线多阶段并行写同一个 job）
 *  - 损坏文件 / 残留 .tmp（崩溃之后的自我恢复）
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TMP_BASE = path.join(os.tmpdir(), `handoff-test-store-${process.pid}-${Date.now()}`);
process.env.HANDOFF_DATA_DIR = TMP_BASE;

const store = await import('../../src/store/json-store.js');
const { newId } = await import('../../src/store/events.js');

const jobsDir = () => path.join(TMP_BASE, 'jobs');

function makeJob(overrides = {}) {
  const now = Date.now();
  return {
    id: newId('job'),
    goal: '帮我把这份租房合同看一遍，我怕有坑',
    templateId: null,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    plan: null,
    stages: [],
    artifacts: [],
    review: null,
    security: null,
    usage: { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 },
    clarifyQuestions: [],
    error: null,
    ...overrides,
  };
}

beforeEach(async () => {
  store.resetStore();
  await fs.rm(TMP_BASE, { recursive: true, force: true });
  await fs.mkdir(jobsDir(), { recursive: true });
});

afterAll(async () => {
  store.stopSyncTimer();
  store.resetStore();
  await fs.rm(TMP_BASE, { recursive: true, force: true });
});

describe('路径与 id 安全', () => {
  it('拒绝路径穿越 id（saveJob / getJob / updateJob / deleteJob 全部挡住）', async () => {
    const evil = [
      '../../etc/passwd',
      '../evil',
      'job_../../x',
      'job_aaaaaaaaaaaaaaaa/..',
      'job_ABC12345678',
      'job_short',
      '',
      '/tmp/x',
      'job_0123456789abcdef.json',
    ];
    for (const id of evil) {
      expect(store.isValidJobId(id)).toBe(false);
      await expect(store.saveJob(makeJob({ id }))).rejects.toThrow();
      await expect(store.getJob(id)).resolves.toBeNull();
      await expect(store.updateJob(id, () => {})).resolves.toBeNull();
      await expect(store.deleteJob(id)).resolves.toBe(false);
    }
    // 真目录里没被写出任何东西
    const names = await fs.readdir(jobsDir());
    expect(names).toEqual([]);
  });

  it('接受合法 id（job_ + 8..32 位小写字母数字）', () => {
    expect(store.isValidJobId(newId('job'))).toBe(true);
    expect(store.isValidJobId('job_0123456789abcdef')).toBe(true);
    expect(store.isValidJobId(`job_${'a'.repeat(32)}`)).toBe(true);
    expect(store.isValidJobId(`job_${'a'.repeat(33)}`)).toBe(false);
    expect(store.isValidJobId('Job_0123456789abcdef')).toBe(false);
    expect(store.isValidJobId('job_0123456789ABCDEF')).toBe(false);
  });

  it('dataDir 落在 HANDOFF_DATA_DIR 指定的临时目录里', () => {
    expect(store.getDataDir()).toBe(TMP_BASE);
    expect(store.getJobsDir()).toBe(jobsDir());
  });
});

describe('基本读写', () => {
  it('保存 → 读取 → 列出（最新在前）', async () => {
    const a = makeJob({ id: newId('job'), goal: 'A' });
    const b = makeJob({ id: newId('job'), goal: 'B' });
    const c = makeJob({ id: newId('job'), goal: 'C' });
    await store.saveJob(a);
    await store.saveJob(b);
    await store.saveJob(c);

    const got = await store.getJob(b.id);
    expect(got.goal).toBe('B');
    expect(await store.countJobs()).toBe(3);

    // saveJob 会用「写入时刻」刷新 updatedAt（这是想要的语义：最近动过的排前面）。
    // 排序规则本身在这里用固定时间戳单独验证：直接改盘再重新加载。
    const stamp = (job, t) => {
      job.updatedAt = t;
      return fs.writeFile(path.join(jobsDir(), `${job.id}.json`), JSON.stringify(job), 'utf8');
    };
    await stamp(c, 2000);
    await stamp(a, 1000);
    await stamp(b, 3000);
    store.resetStore();
    await store.loadFromDisk();

    const list = await store.listJobs(50);
    expect(list.map((j) => j.goal)).toEqual(['B', 'C', 'A']);
    expect(list).toHaveLength(3);
  });

  it('listJobs 尊重 limit，且默认 50', async () => {
    for (let i = 0; i < 5; i += 1) await store.saveJob(makeJob());
    expect(await store.listJobs(2)).toHaveLength(2);
    expect(await store.listJobs()).toHaveLength(5);
    expect(await store.listJobs(0)).toHaveLength(5); // 非法 limit 退回默认值
    expect(await store.listJobs(-3)).toHaveLength(5);
  });

  it('getJob 未命中返回 null，不抛错', async () => {
    expect(await store.getJob(newId('job'))).toBeNull();
  });

  it('saveJob 落盘的是完整 JSON（能被独立进程解析）', async () => {
    const job = makeJob();
    await store.saveJob(job);
    const raw = await fs.readFile(path.join(jobsDir(), `${job.id}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(job.id);
    expect(parsed.goal).toBe(job.goal);
    expect(parsed.updatedAt).toBeGreaterThan(0);
  });

  it('重启后能从磁盘把 job 读回内存（模拟服务重启）', async () => {
    const job = await store.saveJob(makeJob());
    store.resetStore(); // 相当于进程重启
    const list = await store.listJobs(10);
    expect(list.map((j) => j.id)).toContain(job.id);
    const got = await store.getJob(job.id);
    expect(got.goal).toBe(job.goal);
  });
});

describe('updateJob 原子性', () => {
  it('20 个并发 updateJob 后计数精确为 20（无丢失更新）', async () => {
    const job = makeJob({ usage: { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 } });
    await store.saveJob(job);

    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.updateJob(job.id, (j) => {
          j.usage.calls += 1;
        }),
      ),
    );

    const after = await store.getJob(job.id);
    expect(after.usage.calls).toBe(20);

    // 磁盘上也是 20（不是只在内存里对）
    const onDisk = JSON.parse(await fs.readFile(path.join(jobsDir(), `${job.id}.json`), 'utf8'));
    expect(onDisk.usage.calls).toBe(20);
  });

  it('并发往数组里 push：50 条一个不少', async () => {
    const job = makeJob();
    await store.saveJob(job);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => store.updateJob(job.id, (j) => j.stages.push({ n: i }))),
    );
    const after = await store.getJob(job.id);
    expect(after.stages).toHaveLength(50);
  });

  it('updateJob 对不存在的 job 返回 null', async () => {
    expect(await store.updateJob(newId('job'), () => {})).toBeNull();
  });

  it('mutator 抛错不会污染已有数据，也不会留下坏 promise', async () => {
    const job = await store.saveJob(makeJob({ status: 'running' }));
    await expect(
      store.updateJob(job.id, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await store.getJob(job.id);
    expect(after.status).toBe('running');
    // 队列没被卡死：后续写还能成功
    await store.updateJob(job.id, (j) => {
      j.status = 'done';
    });
    expect((await store.getJob(job.id)).status).toBe('done');
  });
});

describe('原子写与崩溃恢复', () => {
  it('写完不留 .tmp 残留', async () => {
    for (let i = 0; i < 10; i += 1) await store.saveJob(makeJob());
    const names = await fs.readdir(jobsDir());
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(names.filter((n) => n.endsWith('.json'))).toHaveLength(10);
  });

  it('损坏的 json 被跳过，服务照常启动', async () => {
    const good = await store.saveJob(makeJob());
    await fs.writeFile(path.join(jobsDir(), 'job_deadbeefdeadbeef.json'), '{ 这不是 json', 'utf8');
    await fs.writeFile(path.join(jobsDir(), 'job_0000000000000000.json'), '[1,2,3]', 'utf8');

    store.resetStore();
    const list = await store.listJobs(50);
    expect(list.map((j) => j.id)).toEqual([good.id]);
    expect(await store.getJob('job_deadbeefdeadbeef')).toBeNull();
  });

  it('非法文件名的 json 文件被忽略', async () => {
    await fs.writeFile(path.join(jobsDir(), 'evil-name.json'), JSON.stringify({ id: 'evil-name' }), 'utf8');
    store.resetStore();
    expect(await store.listJobs(50)).toEqual([]);
  });

  it('sweepTmpFiles 清掉上次崩溃留下的 .tmp', async () => {
    await fs.writeFile(path.join(jobsDir(), 'job_aaaaaaaaaaaaaaaa.json.tmp'), 'half', 'utf8');
    expect(await store.sweepTmpFiles()).toBe(1);
    expect((await fs.readdir(jobsDir())).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('删除', () => {
  it('删除后文件与缓存都没了', async () => {
    const job = await store.saveJob(makeJob());
    expect(await store.deleteJob(job.id)).toBe(true);
    expect(await store.getJob(job.id)).toBeNull();
    expect(await store.listJobs(50)).toEqual([]);
    await expect(fs.access(path.join(jobsDir(), `${job.id}.json`))).rejects.toThrow();
  });

  it('删不存在的返回 false；删非法 id 也返回 false 而不是抛', async () => {
    expect(await store.deleteJob(newId('job'))).toBe(false);
    expect(await store.deleteJob('../../etc/passwd')).toBe(false);
  });
});

describe('内存上限', () => {
  it('磁盘上有 210 个时，内存只留 updatedAt 最新的 200 个', async () => {
    const base = Date.now() - 1_000_000;
    // 直接写盘（绕过 saveJob，因为 saveJob 会把 updatedAt 改成 now，顺序就没法区分了）
    for (let i = 0; i < 210; i += 1) {
      const job = makeJob({ goal: `g${i}`, updatedAt: base + i * 1000 });
      await fs.writeFile(path.join(jobsDir(), `${job.id}.json`), JSON.stringify(job), 'utf8');
    }
    store.resetStore();
    const list = await store.listJobs(500);
    expect(list).toHaveLength(200);
    expect(list[0].goal).toBe('g209'); // 最新
    expect(list[199].goal).toBe('g10'); // 最旧的那批（g0..g9）被淘汰
    expect(list.map((j) => j.goal)).not.toContain('g0');
  });
});
