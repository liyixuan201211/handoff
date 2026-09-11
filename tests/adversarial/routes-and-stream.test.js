/**
 * S9 对抗性测试 · 路由健壮性 / SSE 补发 / 界面的"静默失败"
 *
 * 这一组攻击的是"看起来一切正常、其实用户被坑了"的地方：
 *   · 前端路由收到畸形 URL 时抛异常
 *   · 断线重连补发不足时客户端毫不知情
 *   · 任务多了以后历史列表悄悄少东西
 *   · 加载失败时界面显示"正在加载…"，让用户分不清"还没有"和"出错了"
 *
 * 浏览器实证（真实 Chrome + 真实服务）见 docs/reports/S9-对抗性测试.md。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { parseRoute, routeHash, renderMarkdown, escapeHtml, safeHref } from '../../src/../public/ui.js';
import { resolveSince, sseHandler, HEARTBEAT_MS } from '../../src/util/sse.js';
import { events } from '../../src/store/events.js';
import * as store from '../../src/store/json-store.js';

let dataDir = null;
const newJobId = () => `job_${crypto.randomBytes(8).toString('hex')}`;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-adv-routes-'));
  process.env.HANDOFF_DATA_DIR = dataDir;
  await store.loadFromDisk({ force: true });
}, 30_000);

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/* ================================================================== *
 * 攻击 1：前端路由收到畸形 hash
 * ================================================================== */
describe('攻击：前端路由的畸形输入', () => {
  it('常见 hash 都能得到确定的界面（不白屏）', () => {
    expect(parseRoute('#/')).toMatchObject({ name: 'home' });
    expect(parseRoute('')).toMatchObject({ name: 'home' });
    expect(parseRoute('#/new')).toMatchObject({ name: 'new' });
    expect(parseRoute('#/history')).toMatchObject({ name: 'history' });
    expect(parseRoute('#/job/')).toMatchObject({ name: 'home' }); // 没有 id → 回首页
    expect(parseRoute('#/job')).toMatchObject({ name: 'home' });
    expect(parseRoute('#/job/job_abc')).toMatchObject({ name: 'job', params: { id: 'job_abc' } });
    expect(parseRoute('#/../etc/passwd')).toMatchObject({ name: 'notfound' });
    expect(parseRoute('#/nosuchroute')).toMatchObject({ name: 'notfound' });
    expect(parseRoute(null)).toMatchObject({ name: 'home' });
    expect(parseRoute(12345)).toMatchObject({ name: 'home' });
  });

  // 【缺陷 S9-3 已修复】`decodeURIComponent` 对畸形百分号编码会抛 URIError。
  // 真实浏览器里这个异常冒出路由处理函数，导致**后续所有路由都不再重渲染** ——
  // 用户看到的是"点了没反应"，而根因是一个拼错的地址。
  // 修法：解不开的片段当字面量用（一行 try/catch）。
  it('回归（缺陷 S9-3 已修复）：畸形百分号编码的 hash 不能让 parseRoute 抛异常', () => {
    const raws = ['#/job/%E4%B8', '#/job/%', '#/%ZZ', '#/job/a%', '#/%E0%A4%A'];
    const thrown = [];
    for (const raw of raws) {
      try {
        const r = parseRoute(raw);
        thrown.push({ raw, route: r.name });
      } catch (err) {
        thrown.push({ raw, threw: String(err && err.name) });
      }
    }
    expect(thrown.filter((t) => t.threw)).toEqual([]);
  });

  it('routeHash 生成的链接一定能被 parseRoute 还原（中文 / 特殊字符 id）', () => {
    for (const id of ['job_abc', '不存在的id', 'a b', 'a/b', 'a%2Fb', 'job_"quoted"']) {
      const hash = routeHash('job', { id });
      const r = parseRoute(hash);
      expect(r.name).toBe('job');
      expect(r.params.id).toBe(id);
    }
  });
});

/* ================================================================== *
 * 攻击 2：markdown 渲染里被中和的链接
 * ================================================================== */
describe('攻击：markdown 链接与标签', () => {
  it('javascript: / 大小写 / 实体 / 制表符 全部不会变成可点链接', () => {
    const cases = [
      '[点我](javascript:alert(1))',
      '[点我](jAvAsCrIpT:alert(1))',
      '[点我](java&#115;cript:alert(1))',
      '[点我](java\tscript:alert(1))',
      '[点我](data:text/html,<script>alert(1)</script>)',
      '[点我](vbscript:msgbox(1))',
      '[点我](file:///etc/passwd)',
      '[点我](blob:http://x/y)',
    ];
    for (const md of cases) {
      const html = renderMarkdown(md);
      expect(html.toLowerCase()).not.toContain('href="javascript');
      expect(html.toLowerCase()).not.toContain('href="data:');
      expect(html.toLowerCase()).not.toContain('href="vbscript');
      expect(html.toLowerCase()).not.toContain('href="file:');
      expect(html.toLowerCase()).not.toContain('href="blob:');
      // 只能剩下纯文本
      expect(html).toContain('点我');
      expect(html).not.toContain('<a ');
    }
  });

  it('http/https/mailto 仍然可用', () => {
    for (const [md, want] of [
      ['[x](https://example.com/a)', 'https://example.com/a'],
      ['[x](http://example.com/a)', 'http://example.com/a'],
      ['[x](mailto:a@b.com)', 'mailto:a@b.com'],
    ]) {
      expect(renderMarkdown(md)).toContain(want);
    }
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('javascript:alert(1)')).toBe(null);
  });

  it('裸 HTML 标签、script、事件属性全部被转义', () => {
    const md = '<script>window.__X=1</script>\n\n<img src=x onerror="window.__X=1">\n\n<div onmouseover="x">t</div>';
    const html = renderMarkdown(md);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    // 事件处理器不能作为真实属性出现（文本里出现 "onerror=" 是转义后的普通文字，安全）
    expect(html).not.toMatch(/<[a-z][^>]*\son(error|mouseover|load|click)\s*=/i);
    expect(html).toContain('&lt;script&gt;');
    expect(escapeHtml('<b>"x"</b>')).toBe('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  });

  it('代码块与行内代码里的事件处理器不会逃出 <code>', () => {
    const html = renderMarkdown('```html\n<script>window.__X=1</script>\n```\n\n`<img src=x onerror=alert(1)>`');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<[a-z][^>]*\son(error|mouseover|load|click)\s*=/i);
    expect(html).toContain('&lt;script&gt;');
  });
});

/* ================================================================== *
 * 攻击 3：SSE 补发语义
 * ================================================================== */
describe('攻击：SSE 断线重连的补发', () => {
  const mkRes = () => {
    const res = new EventEmitter();
    res.chunks = [];
    res.write = (c) => { res.chunks.push(c); return true; };
    res.flush = () => {};
    res.status = () => res;
    res.setHeader = () => res;
    res.flushHeaders = () => {};
    return res;
  };
  const mkReq = (headers = {}, query = {}) => {
    const req = new EventEmitter();
    req.headers = headers;
    req.query = query;
    return req;
  };
  const frames = (res) => res.chunks.filter((c) => c.startsWith('id: ')).length;

  it('Last-Event-ID 取负数 / 非数字 / 科学计数法时不会崩（归 0 或按数字解析）', () => {
    expect(resolveSince(mkReq({ 'last-event-id': '-5' }))).toBe(0);
    expect(resolveSince(mkReq({ 'last-event-id': 'abc' }))).toBe(0);
    expect(resolveSince(mkReq({ 'last-event-id': '9e99' }))).toBe(9); // parseInt 的"科学计数法"语义
    expect(resolveSince(mkReq({ 'last-event-id': '99999999999999999999' }))).toBeGreaterThan(0);
    expect(resolveSince(mkReq({}))).toBe(0);
    expect(resolveSince(mkReq({}, { since: '7' }))).toBe(7);
    // query 与 header 取较大者
    expect(resolveSince(mkReq({ 'last-event-id': '3' }, { since: '9' }))).toBe(9);
  });

  it('补发上限 500：断线太久的客户端只能拿到最后一截', () => {
    const id = newJobId();
    events.drop(id);
    for (let i = 1; i <= 700; i += 1) events.publish(id, { type: 'log', stageId: 's', text: `#${i}`, at: Date.now() });
    expect(events.cursor(id)).toBe(700);
    expect(events.since(id, 0).length).toBe(500);
    expect(events.since(id, 0)[0].text).toBe('#201');

    const req = mkReq({ 'last-event-id': '1' });
    const res = mkRes();
    const cleanup = sseHandler({ jobId: id, req, res });
    expect(frames(res)).toBe(500); // 201..700，中间的 2..200 永久丢失
    cleanup();
    events.drop(id);
  });

  // 【缺陷 S9-5】客户端要求的 seq 已经被环形缓冲挤掉时，服务端静默少发，
  // 前端也没有"事件断档"检测 —— 用户会看到进度卡在一半，而且没有任何提示
  it('回归（缺陷 S9-5 已修复）：补发不齐时必须告诉客户端"你漏了事件"', () => {
    const id = newJobId();
    events.drop(id);
    for (let i = 1; i <= 700; i += 1) events.publish(id, { type: 'log', stageId: 's', text: `#${i}`, at: Date.now() });
    const req = mkReq({ 'last-event-id': '1' }); // 客户端只看到第 1 条就断线了
    const res = mkRes();
    const cleanup = sseHandler({ jobId: id, req, res });
    const body = res.chunks.join('');
    // 修复后：先发一条 resync 事件说明"你漏了 199 条"，再补发剩下的。
    // 前端收到 resync 就知道该用权威快照重新对齐，而不是继续等一个不会来的事件。
    expect(body).toMatch(/resync|"type":"job"|gap/i);
    expect(body).toContain('resync');
    cleanup();
    events.drop(id);
  });

  it('每个 job 的事件日志上限是 500（长跑任务不会把内存吃光）', () => {
    const id = newJobId();
    events.drop(id);
    for (let i = 0; i < 1200; i += 1) events.publish(id, { type: 'log', text: `${i}` });
    expect(events.since(id, 0).length).toBe(500);
    events.drop(id);
  });

  it('断连 100 次后监听器归零（服务端不泄漏）', () => {
    const id = newJobId();
    events.drop(id);
    for (let i = 0; i < 100; i += 1) {
      const req = mkReq({});
      const res = mkRes();
      const cleanup = sseHandler({ jobId: id, req, res });
      cleanup(); // 等价于连接立刻断开
    }
    expect(events.listenerCount(id)).toBe(0);
    events.drop(id);
  });

  // 【缺陷 S9-11】任务被删除后，连接和心跳定时器都还活着：
  // 用户看到"已连接，进展会实时更新"，实际上永远不会再收到任何业务事件。
  it('回归（缺陷 S9-11 已修复）：任务被删除时，属于它的 SSE 连接必须被关掉', async () => {
    const id = newJobId();
    events.drop(id);
    events.publish(id, { type: 'job', job: { id } });
    const req = mkReq({});
    const res = mkRes();
    let closedByServer = false;
    res.write = (c) => { if (c === '') closedByServer = true; res.chunks.push(c); return true; };
    const origEnd = res.end;
    res.end = (...args) => { closedByServer = true; return origEnd ? origEnd.apply(res, args) : res; };
    const cleanup = sseHandler({ jobId: id, req, res });

    events.drop(id);
    await new Promise((r) => setTimeout(r, 50));

    // 1) 服务端主动关掉了连接
    expect(closedByServer).toBe(true);

    // 2) 关掉之后**不许再有任何写入**。
    // 注意：这里不能再手工调 `res.write` 来"模拟心跳" —— 那是我们在测试里
    // 绕过内部定时器直接写，无论实现对不对都会让 chunks 变长，测不出东西。
    // 真正要验的是"连接已关闭"这个状态本身：send/写入必须被 short-circuit。
    const chunksAfterDrop = res.chunks.length;
    events.publish(id, { type: 'log', text: '删完之后的事件不该再被发出去' });
    await new Promise((r) => setTimeout(r, 30));
    expect(res.chunks.length).toBe(chunksAfterDrop);

    cleanup();
  });

  it('心跳间隔是 15 秒（契约外的实现细节，但改了要知道）', () => {
    expect(HEARTBEAT_MS).toBe(15_000);
  });
});

/* ================================================================== *
 * 攻击 4：历史列表的可见性
 * ================================================================== */
describe('攻击：任务多了以后历史列表的可见性（缺陷 S9-10 的证据）', () => {
  it('内存上限 200：更早的任务从列表里消失，但仍然能按 id 打开', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-adv-cap-'));
    const prev = process.env.HANDOFF_DATA_DIR;
    process.env.HANDOFF_DATA_DIR = dir;
    store.resetStore();
    try {
      for (let i = 0; i < 205; i += 1) {
        await store.saveJob({
          id: `job_${String(i).padStart(12, '0')}`,
          goal: `容量测试 ${i}`, status: 'done', createdAt: 1, updatedAt: 1000 + i,
          stages: [], artifacts: [],
        });
      }
      const list = await store.listJobs(200);
      expect(list.length).toBe(200);
      expect(list.some((j) => j.id === 'job_000000000000')).toBe(false);
      // 用户以为"没了"，其实还在：直接按 id 访问仍然 200（真实 HTTP 行为见报告）
      const evicted = await store.getJob('job_000000000000');
      expect(evicted).not.toBe(null);
      expect(evicted.goal).toBe('容量测试 0');
      // 磁盘上的文件一直在
      expect(fs.existsSync(path.join(dir, 'jobs', 'job_000000000000.json'))).toBe(true);
    } finally {
      process.env.HANDOFF_DATA_DIR = prev;
      store.resetStore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('listJobs 的 limit 被夹在 200 以内（防止一次拉全库）', async () => {
    expect((await store.listJobs(9999)).length).toBeLessThanOrEqual(200);
    expect((await store.listJobs(0)).length).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
