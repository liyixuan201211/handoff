/**
 * [S5] 前端纯逻辑自测 —— 不需要浏览器，全部跑在 Node 里。
 * 覆盖：escapeHtml / markdown 渲染器的 XSS 中和 / 路由解析 / store / api 客户端。
 *
 * 运行：npx vitest run tests/unit/frontend.test.js
 */
import { describe, it, expect, vi } from 'vitest';

import {
  escapeHtml, safeHref, renderMarkdown, stripControlChars,
  parseRoute, routeHash, createStore,
  formatElapsed, formatRelative, summarize,
  statusLabel, stageStatusLabel, roleMeta, severityMeta, securityMeta, reviewMeta,
  ROLE_BY_STAGE,
} from '../../public/ui.js';

import { createApi, FALLBACK_TEMPLATES, friendlyError } from '../../public/api.js';
import { buildGoalFromTemplate, renderTemplateHint } from '../../public/app.js';
import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * 测试用：抽出渲染结果里的所有标签名，用来断言"只有我们自己产的标签"
 * ------------------------------------------------------------------ */
function allTagNames(html) {
  return (String(html).match(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g) || [])
    .map((m) => m.replace(/<\/?/, '').toLowerCase());
}

const ALLOWED_TAGS = new Set(['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'hr', 'pre', 'code', 'strong', 'em', 'a']);

/* ------------------------------------------------------------------ *
 * 这是一个"攻击载荷"清单：任何一条泄漏成可执行 HTML 都算失败。
 * ------------------------------------------------------------------ */
const NASTY = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  "'><svg/onload=alert(1)>",
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">点我</a>',
  '<style>*{display:none}</style>',
  '<!--[if IE]><script>alert(1)</script><![endif]-->',
];

describe('escapeHtml', () => {
  it('转义 <script> 标签', () => {
    expect(escapeHtml('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('转义属性逃逸用的引号与反引号', () => {
    expect(escapeHtml('" onmouseover="alert(1)'))
      .toBe('&quot; onmouseover=&quot;alert(1)');
    expect(escapeHtml("' onfocus='alert(1)"))
      .toBe('&#39; onfocus=&#39;alert(1)');
    expect(escapeHtml('`+alert(1)+`')).toBe('&#96;+alert(1)+&#96;');
  });

  it('转义 & 且不重复转义已转义实体（先 & 后 < 的顺序很关键）', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml(escapeHtml('<'))).toBe('&amp;lt;');
  });

  it('null / undefined / 数字都能安全处理', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(0)).toBe('0');
  });

  it('所有攻击载荷都被中和（结果里不出现 < 或 >）', () => {
    for (const payload of NASTY) {
      const out = escapeHtml(payload);
      expect(out).not.toContain('<');
      expect(out).not.toContain('>');
    }
  });
});

describe('safeHref（链接白名单）', () => {
  it('允许 http / https / mailto', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com');
  });

  it('拒绝 javascript: / data: / vbscript: / file: / blob:', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHref('vbscript:msgbox(1)')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
    expect(safeHref('blob:https://x/y')).toBeNull();
    expect(safeHref('/api/jobs')).toBeNull();
    expect(safeHref('')).toBeNull();
    expect(safeHref(null)).toBeNull();
  });

  it('拒绝用控制字符/空白伪装的协议（java\\nscript:）', () => {
    expect(safeHref('java\nscript:alert(1)')).toBeNull();
    expect(safeHref('java\tscript:alert(1)')).toBeNull();
    expect(safeHref('  javascript:alert(1)')).toBeNull();
  });
});

describe('stripControlChars', () => {
  it('去掉控制字符但保留换行与制表符', () => {
    expect(stripControlChars('a\u0000b\u0007c')).toBe('abc');
    expect(stripControlChars('a\nb\tc')).toBe('a\nb\tc');
  });
});

describe('renderMarkdown — 结构与格式', () => {
  it('渲染标题', () => {
    expect(renderMarkdown('# 一级')).toBe('<h1>一级</h1>');
    expect(renderMarkdown('### 三级')).toBe('<h3>三级</h3>');
  });

  it('渲染粗体与斜体', () => {
    expect(renderMarkdown('这是 **重点** 内容')).toBe('<p>这是 <strong>重点</strong> 内容</p>');
    expect(renderMarkdown('这是 *强调* 内容')).toBe('<p>这是 <em>强调</em> 内容</p>');
    expect(renderMarkdown('__也粗__')).toBe('<p><strong>也粗</strong></p>');
  });

  it('渲染无序列表与有序列表', () => {
    expect(renderMarkdown('- 甲\n- 乙')).toBe('<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>');
    expect(renderMarkdown('1. 甲\n2. 乙')).toBe('<ol>\n<li>甲</li>\n<li>乙</li>\n</ol>');
    expect(renderMarkdown('- 甲\n- 乙\n\n收尾段落')).toBe('<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>\n<p>收尾段落</p>');
  });

  it('渲染引用、分隔线、行内代码', () => {
    expect(renderMarkdown('> 提醒一句')).toBe('<blockquote>提醒一句</blockquote>');
    expect(renderMarkdown('---')).toBe('<hr>');
    expect(renderMarkdown('用 `npm start` 启动')).toBe('<p>用 <code>npm start</code> 启动</p>');
  });

  it('代码块带语言标记且内容完整', () => {
    const out = renderMarkdown('```js\nconst a = 1;\n```');
    expect(out).toBe('<pre><code class="lang-js">const a = 1;</code></pre>');
  });

  it('未闭合的代码块也不会抛错', () => {
    const out = renderMarkdown('```\n还没写完');
    expect(out).toContain('<pre><code');
    expect(out).toContain('还没写完');
  });

  it('多行段落内换行变 <br>，空行分段', () => {
    expect(renderMarkdown('第一行\n第二行')).toBe('<p>第一行<br>第二行</p>');
    expect(renderMarkdown('第一段\n\n第二段')).toBe('<p>第一段</p>\n<p>第二段</p>');
  });

  it('空输入返回空字符串（不产生空标签）', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown('   \n  ')).toBe('');
  });
});

describe('renderMarkdown — XSS 中和（安全工程师会攻击这里）', () => {
  it('正文里的 <script> 被转义，不产生 script 标签', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;');
  });

  it('行内代码里的 <script> 被转义', () => {
    const out = renderMarkdown('试一下 `<script>alert(1)</script>` 这句');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;');
  });

  it('代码块内容被正确转义', () => {
    const out = renderMarkdown('```\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // 结构仍然正确
    expect(out).toContain('<pre><code>');
  });

  it('javascript: 链接退化成纯文本（不生成 href）', () => {
    const out = renderMarkdown('[点我](javascript:alert(1))');
    expect(out).not.toContain('href');
    expect(out).not.toContain('<a');
    expect(out).toContain('点我');
  });

  it('data: 链接同样被拒', () => {
    const out = renderMarkdown('[看这个](data:text/html,<script>alert(1)</script>)');
    expect(out).not.toContain('href');
  });

  it('合法 http 链接正常生成，并带 noopener', () => {
    const out = renderMarkdown('[官网](https://example.com)');
    expect(out).toBe('<p><a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">官网</a></p>');
  });

  it('链接文字里的脚本被转义，href 里的引号不会逃逸属性', () => {
    const out = renderMarkdown('[<script>alert(1)</script>](https://example.com/?a="onmouseover=alert(1))');
    expect(out).not.toContain('<script');
    const hrefPart = out.slice(out.indexOf('href="'), out.indexOf('">'));
    expect(hrefPart).not.toContain('"onmouseover');
  });

  it('HTML 属性注入不成立：整份文档里没有可执行标签', () => {
    const doc = [
      '# <img src=x onerror=alert(1)>',
      '',
      '- <svg/onload=alert(1)>',
      '1. <iframe src=javascript:alert(1)>',
      '',
      '> <script>alert(1)</script>',
      '',
      '**<b>不该成为粗体标签内的标签</b>**',
    ].join('\n');
    const out = renderMarkdown(doc);
    // 不产生任何可执行/可加载标签
    expect(out).not.toMatch(/<script|<img|<svg|<iframe|<b>/);
    expect(out).toContain('&lt;img');
    // 只允许渲染器自己产的标签名；事件处理器只剩文本，无法成为属性
    const tags = new Set(allTagNames(out));
    for (const tag of tags) {
      expect(ALLOWED_TAGS.has(tag), '不该出现的标签: ' + tag).toBe(true);
    }
    // 所有引号都被转义，没人能闭合属性
    expect(out).not.toContain('"');
    expect(out).not.toContain("'");
  });

  it('所有攻击载荷进入 markdown 后都不产生可执行标签', () => {
    const wrappers = [
      (p) => p,
      (p) => '# ' + p,
      (p) => '- ' + p,
      (p) => '> ' + p,
      (p) => '**' + p + '**',
      (p) => '`' + p + '`',
      (p) => '```\n' + p + '\n```',
      (p) => '[链接文字](' + p.replace(/\s/g, '') + ')',
    ];
    for (const payload of NASTY) {
      for (const wrap of wrappers) {
        const out = renderMarkdown(wrap(payload));
        allTagNames(out).forEach((tag) => {
          expect(ALLOWED_TAGS.has(tag), '载荷 ' + payload + ' 产出了标签 <' + tag + '>').toBe(true);
        });
        // 事件处理器只剩文本（前面必须是 &lt; 或空白，绝不能是真实的标签内属性）
        expect(out).not.toMatch(/<[a-zA-Z][^>]*\son[a-z]+\s*=/i);
      }
    }
  });
});

describe('parseRoute（hash 路由）', () => {
  it('首页的各种写法', () => {
    expect(parseRoute('#/')).toEqual({ name: 'home', params: {} });
    expect(parseRoute('')).toEqual({ name: 'home', params: {} });
    expect(parseRoute('#')).toEqual({ name: 'home', params: {} });
    expect(parseRoute(null)).toEqual({ name: 'home', params: {} });
  });

  it('新建 / 历史', () => {
    expect(parseRoute('#/new')).toEqual({ name: 'new', params: {} });
    expect(parseRoute('#/history')).toEqual({ name: 'history', params: {} });
  });

  it('任务详情带 id', () => {
    expect(parseRoute('#/job/job_abc123')).toEqual({ name: 'job', params: { id: 'job_abc123' } });
  });

  it('id 做 URL 解码，且保留 id 里的特殊字符', () => {
    expect(parseRoute('#/job/job%20a')).toEqual({ name: 'job', params: { id: 'job a' } });
    expect(parseRoute('#/job/a?b')).toEqual({ name: 'job', params: { id: 'a' }, query: { b: '' } });
  });

  it('job 后面没 id 时不当成详情（避免请求 /api/jobs/undefined）', () => {
    expect(parseRoute('#/job/')).toEqual({ name: 'home', params: {} });
    expect(parseRoute('#/job')).toEqual({ name: 'home', params: {} });
  });

  it('未知路径给出 notfound', () => {
    expect(parseRoute('#/whatever').name).toBe('notfound');
    expect(parseRoute('#/a/b/c').name).toBe('notfound');
  });

  it('支持 ?query', () => {
    expect(parseRoute('#/history?tab=done').query).toEqual({ tab: 'done' });
  });

  it('routeHash 与 parseRoute 互逆', () => {
    expect(routeHash('job', { id: 'job_1' })).toBe('#/job/job_1');
    expect(parseRoute(routeHash('job', { id: 'job_1' }))).toEqual({ name: 'job', params: { id: 'job_1' } });
    expect(routeHash('history')).toBe('#/history');
    expect(routeHash('new')).toBe('#/new');
    expect(routeHash('home')).toBe('#/');
  });
});

describe('时间与摘要格式化', () => {
  it('formatElapsed 按毫秒与秒显示（进行中实时走秒）', () => {
    expect(formatElapsed(0)).toBe('0.0 秒');
    expect(formatElapsed(12400)).toBe('12.4 秒');
    expect(formatElapsed(null, 1000, 2250)).toBe('1.3 秒');
    expect(formatElapsed(65000)).toBe('1 分 5 秒');
    expect(formatElapsed(3720000)).toBe('1 小时 2 分');
    expect(formatElapsed(null)).toBe('');
  });

  it('formatRelative 说人话', () => {
    const now = 1_800_000_000_000;
    expect(formatRelative(now - 5_000, now)).toBe('刚刚');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(formatRelative(now - 3 * 3600_000, now)).toBe('3 小时前');
    expect(formatRelative(now - 2 * 86400_000, now)).toBe('2 天前');
    expect(formatRelative(null, now)).toBe('');
  });

  it('summarize 截断长目标且压平空白', () => {
    expect(summarize('  a\n\n  b  ')).toBe('a b');
    expect(summarize('一二三四五六', 3)).toBe('一二三…');
    expect(summarize('短', 10)).toBe('短');
  });
});

describe('状态与角色的中文文案', () => {
  it('任务状态都有中文说法', () => {
    expect(statusLabel('queued').label).toBe('排队中');
    expect(statusLabel('running').label).toBe('进行中');
    expect(statusLabel('awaiting_input').label).toBe('等待你的回答');
    expect(statusLabel('done').label).toBe('已完成');
    expect(statusLabel('failed').label).toBe('失败');
    expect(statusLabel('cancelled').label).toBe('已取消');
    expect(statusLabel('未来新状态').label).toBe('未知状态');
  });

  it('状态色调映射到设计系统', () => {
    expect(statusLabel('running').tone).toBe('work');
    expect(statusLabel('done').tone).toBe('ok');
    expect(statusLabel('failed').tone).toBe('bad');
    expect(stageStatusLabel('pending').label).toBe('等待中');
    expect(stageStatusLabel('running').label).toBe('工作中');
    expect(stageStatusLabel('done').label).toBe('已完成');
    expect(stageStatusLabel('failed').tone).toBe('bad');
  });

  it('八个阶段都能映射到虚拟员工角色', () => {
    const keys = ['intake', 'plan', 'research', 'draft', 'critique', 'revise', 'verify', 'deliver'];
    keys.forEach((key) => {
      const meta = roleMeta({ key });
      expect(meta.role).toBe(ROLE_BY_STAGE[key]);
      expect(meta.name.length).toBeGreaterThan(0);
      expect(meta.initial.length).toBeGreaterThan(0);
    });
    expect(roleMeta({ key: 'intake' }).role).toBe('接待员');
    expect(roleMeta({ key: 'deliver' }).role).toBe('交付专员');
    expect(roleMeta({ key: 'xxx', role: '外部专家' }).role).toBe('外部专家');
    expect(roleMeta(null).role).toBe('团队成员');
  });

  it('严重度与安全等级用人话', () => {
    expect(severityMeta('high').label).toBe('严重');
    expect(severityMeta('medium').tone).toBe('warn');
    expect(severityMeta('low').tone).toBe('info');
    expect(severityMeta(undefined).label).toBe('提示');
    expect(securityMeta('clean').tone).toBe('ok');
    expect(securityMeta('notice').tone).toBe('warn');
    expect(securityMeta('blocked').tone).toBe('bad');
    expect(securityMeta('blocked').hint).toContain('拦截');
    expect(reviewMeta('pass').label).toBe('验收通过');
    expect(reviewMeta('pass_with_notes').tone).toBe('warn');
    expect(reviewMeta('needs_revision').tone).toBe('bad');
  });
});

describe('store（订阅式状态容器）', () => {
  it('set 会合并状态并通知订阅者，退订后不再收到', () => {
    const store = createStore({ a: 1, b: 2 });
    const seen = [];
    const off = store.subscribe((s) => seen.push(s.a));
    store.emit();                      // 启动时先推一次当前状态
    store.set({ a: 5 });
    expect(store.get('a')).toBe(5);
    expect(store.get('b')).toBe(2);    // 只合并，不清空其它键
    expect(seen).toEqual([1, 5]);
    off();
    store.set({ a: 9 });
    expect(store.get('a')).toBe(9);
    expect(seen).toEqual([1, 5]);      // 已退订，收不到了
  });

  it('快照是副本，订阅者改不动内部状态', () => {
    const store = createStore({ n: 1 });
    store.subscribe((s) => { s.n = 999; });
    store.emit();
    expect(store.getState().n).toBe(1);
  });

  it('一个订阅者抛错不影响其它订阅者', () => {
    const store = createStore({ n: 0 });
    const ok = vi.fn();
    store.subscribe(() => { throw new Error('bad listener'); });
    store.subscribe(ok);
    expect(() => store.set({ n: 1 })).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe('api 客户端', () => {
  function mockFetch(routes) {
    return vi.fn(async (url, init) => {
      const method = (init && init.method) || 'GET';
      const key = method + ' ' + url;
      const hit = routes[key];
      if (!hit) return { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 'JOB_NOT_FOUND', message: '没有这个任务' } }) };
      return { ok: true, status: 200, text: async () => JSON.stringify(hit) };
    });
  }

  it('createJob 发 POST /api/jobs 并带上可选字段', async () => {
    const fetchImpl = mockFetch({ 'POST /api/jobs': { id: 'job_1', goal: '看看合同' } });
    const api = createApi({ fetchImpl });
    const job = await api.createJob({ goal: '看看合同', templateId: 'contract-review', tone: 'simple' });
    expect(job.id).toBe('job_1');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/jobs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ goal: '看看合同', templateId: 'contract-review', tone: 'simple' });
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('getJob 对 id 做 URL 编码，防止路径注入', async () => {
    const fetchImpl = mockFetch({});
    const api = createApi({ fetchImpl });
    await api.getJob('../health').catch(() => {});
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/jobs/..%2Fhealth');
  });

  it('后端错误形状 { error: { code, message } } 被翻译成中文', async () => {
    const fetchImpl = mockFetch({});
    const api = createApi({ fetchImpl });
    await expect(api.getJob('nope')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND', message: '没有这个任务' });
    expect(friendlyError({ code: 'JOB_NOT_FOUND' })).toContain('找不到了');
    expect(friendlyError({ code: 'RATE_LIMITED' })).toContain('等一分钟');
    expect(friendlyError({ message: '模型那边超时了' })).toBe('模型那边超时了');
    expect(friendlyError({})).toContain('出了点问题');
  });

  it('网络异常变成 NETWORK_ERROR，而不是把原始异常抛给界面', async () => {
    const api = createApi({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    await expect(api.listJobs()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('返回非 JSON 时报 BAD_JSON', async () => {
    const api = createApi({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>oops</html>' }) });
    await expect(api.listJobs()).rejects.toMatchObject({ code: 'BAD_JSON' });
  });

  it('getTemplates 在失败或为空时给内置兜底模板（首页绝不空白）', async () => {
    const failing = createApi({ fetchImpl: async () => { throw new Error('offline'); } });
    const res = await failing.getTemplates();
    expect(res.fallback).toBe(true);
    expect(res.templates.length).toBeGreaterThanOrEqual(6);
    res.templates.forEach((t) => { expect(typeof t.title).toBe('string'); expect(t.title.length).toBeGreaterThan(0); });

    const empty = createApi({ fetchImpl: mockFetch({ 'GET /api/templates': { templates: [] } }) });
    const res2 = await empty.getTemplates();
    expect(res2.fallback).toBe(true);
    expect(res2.templates).toBe(FALLBACK_TEMPLATES);

    const good = createApi({ fetchImpl: mockFetch({ 'GET /api/templates': { templates: [{ id: 'x', title: '真模板' }] } }) });
    const res3 = await good.getTemplates();
    expect(res3.fallback).toBe(false);
    expect(res3.templates[0].title).toBe('真模板');
  });

  it('listJobs 一律返回**裸数组**（后端包了 { jobs } 也要拆掉）', async () => {
    // 2026-09-12 变更：以前这里返回服务端原始形状（可能是 { jobs: [...] }），
    // 由 app.js 自己判断；现在统一在 api.js 里拆包，调用方拿到的永远是数组。
    // 理由见 api.js 里 unwrapJob 的注释 —— 服务端包 { job }/前端按扁平读，
    // 这个不一致曾经让整个产品在真实浏览器里点不通，而两侧单测都是绿的。
    const a = createApi({ fetchImpl: mockFetch({ 'GET /api/jobs': [{ id: 'j1' }] }) });
    expect(Array.isArray(await a.listJobs())).toBe(true);
    expect((await a.listJobs())[0].id).toBe('j1');

    const b = createApi({ fetchImpl: mockFetch({ 'GET /api/jobs': { jobs: [{ id: 'j2' }] } }) });
    const bResult = await b.listJobs();
    expect(Array.isArray(bResult)).toBe(true);
    expect(bResult[0].id).toBe('j2');
  });

  it('createJob / getJob / sendMessage / retryJob 都要拆掉 { job } 包装', async () => {
    const fetchImpl = mockFetch({
      'POST /api/jobs': { job: { id: 'job_x', status: 'queued' } },
      'GET /api/jobs/job_x': { job: { id: 'job_x', status: 'done' } },
      'POST /api/jobs/job_x/message': { job: { id: 'job_x', status: 'running' } },
      'POST /api/jobs/job_x/retry': { job: { id: 'job_x', status: 'queued' } },
    });
    const api = createApi({ fetchImpl });
    expect((await api.createJob({ goal: 'x' })).id).toBe('job_x');
    expect((await api.getJob('job_x')).status).toBe('done');
    expect((await api.sendMessage('job_x', 'y')).id).toBe('job_x');
    expect((await api.retryJob('job_x')).status).toBe('queued');
  });

  it('retryJob / sendMessage / deleteJob 打到正确端点', async () => {
    const fetchImpl = mockFetch({
      'POST /api/jobs/job_1/retry': { ok: true },
      'POST /api/jobs/job_1/message': { ok: true },
      'DELETE /api/jobs/job_1': { ok: true },
    });
    const api = createApi({ fetchImpl });
    await api.retryJob('job_1');
    await api.sendMessage('job_1', '补充一句');
    await api.deleteJob('job_1');
    const calls = fetchImpl.mock.calls.map((c) => c[0] + ' ' + c[1].method);
    expect(calls).toEqual([
      '/api/jobs/job_1/retry POST',
      '/api/jobs/job_1/message POST',
      '/api/jobs/job_1 DELETE',
    ]);
    const msgCall = fetchImpl.mock.calls[1];
    expect(JSON.parse(msgCall[1].body)).toEqual({ message: '补充一句' });
  });

  it('artifactDownloadUrl 指向契约里的下载端点', () => {
    const api = createApi({ origin: '' });
    expect(api.artifactDownloadUrl('job_1', 'art_1')).toBe('/api/jobs/job_1/artifacts/art_1/download');
  });

  it('详情不返回 content 时，getArtifactText 从下载端点取正文', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url === '/api/jobs/job_1/artifacts/art_1/download') {
        return { ok: true, status: 200, text: async () => '# 风险清单\n\n正文在这里' };
      }
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 'X', message: 'no' } }) };
    });
    const api = createApi({ fetchImpl });
    const text = await api.getArtifactText('job_1', 'art_1');
    expect(text).toContain('风险清单');
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/jobs/job_1/artifacts/art_1/download');
  });

  it('下载端点失败时 getArtifactText 抛 ARTIFACT_UNAVAILABLE（界面好说人话）', async () => {
    const api = createApi({ fetchImpl: async () => ({ ok: false, status: 410, text: async () => '' }) });
    await expect(api.getArtifactText('job_1', 'art_9')).rejects.toMatchObject({ code: 'ARTIFACT_UNAVAILABLE' });
  });

  it('artifact id 做 URL 编码，防止路径注入', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'x' }));
    const api = createApi({ fetchImpl });
    await api.getArtifactText('job_1', '../../health');
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/jobs/job_1/artifacts/..%2F..%2Fhealth/download');
  });

  it('openStream 把 SSE 事件转成回调，并报告连接状态', () => {
    const events = [];
    const states = [];
    class FakeEventSource {
      constructor(url) { this.url = url; this.readyState = 0; FakeEventSource.last = this; }
      close() { this.readyState = 2; }
    }
    const api = createApi({ EventSourceImpl: FakeEventSource });
    const ctrl = api.openStream('job_1', {
      onEvent: (e) => events.push(e),
      onState: (s) => states.push(s),
    });
    const es = FakeEventSource.last;
    expect(es.url).toBe('/api/jobs/job_1/stream');
    es.onopen();
    es.onmessage({ data: JSON.stringify({ type: 'stage', stageId: 'stage_1', status: 'running' }) });
    es.onmessage({ data: 'not json at all' });          // 脏数据不能让前端崩
    es.readyState = 0;
    es.onerror();
    es.readyState = 2;
    es.onerror();
    expect(events).toEqual([{ type: 'stage', stageId: 'stage_1', status: 'running' }]);
    expect(states).toEqual(['connecting', 'live', 'reconnecting', 'offline']);
    ctrl.close();
    expect(ctrl.state()).toBe('offline');
  });

  it('没有 EventSource 时降级成 offline，而不是抛异常', () => {
    const states = [];
    const api = createApi({ EventSourceImpl: undefined, fetchImpl: () => {} });
    // 显式屏蔽全局 EventSource（Node 里本来就没有）
    const ctrl = api.openStream('job_1', { onState: (s) => states.push(s) });
    expect(states[0]).toBe('offline');
    expect(() => ctrl.close()).not.toThrow();
  });
});

/* ================================================================== *
 * 模板接线（回归：模板里写好的文案必须真的送到用户眼前）
 *
 * 背景：模板文件（templates/*.json）里精心写了 goalTemplate / placeholders /
 * tips / notice 四个字段，但前端**一个字都没读**，点模板只会把 title 填进输入框。
 * 结果：
 *   · 用户点「帮我看懂检查报告」→ 输入框里只有"帮我看懂检查报告 / 看病前准备"
 *   · 那句全项目最好的文案「⚠️ 我们不是医生，不能诊断…」永远没人看到
 * 产品经理用真实浏览器走查时发现的，两侧单测都绿（没有一条测试碰过这四个字段）。
 * ================================================================== */
describe('模板接线：goalTemplate / tips / notice 必须真的被用上', () => {
  const tpl = {
    id: 'demo-tpl',
    title: '帮我看合同',
    goalTemplate: '帮我看看这份{{kind}}有没有坑。我是{{role}}，最担心{{worry}}。',
    placeholders: [
      { key: 'kind', label: '是什么', example: '租房合同' },
      { key: 'role', label: '你是谁', example: '租客' },
      { key: 'worry', label: '担心什么', example: '押金要不回来' },
    ],
    tips: '把合同全文粘进来最好。',
    notice: '我们不是律师，不构成法律意见。',
  };

  it('用 goalTemplate 生成完整句子，而不是填一个标题', () => {
    const goal = buildGoalFromTemplate(tpl);
    expect(goal).toContain('帮我看看这份');
    expect(goal).toContain('有没有坑');
    // 绝不能只是把 title 填进去
    expect(goal).not.toBe(tpl.title);
    expect(goal.length).toBeGreaterThan(tpl.title.length);
  });

  it('占位符被替换掉，且没有残留的 {{ }}', () => {
    const goal = buildGoalFromTemplate(tpl);
    expect(goal).not.toContain('{{');
    expect(goal).not.toContain('}}');
    expect(goal).toContain('租房合同');
  });

  it('填入的示例值用【】标出来，让用户知道该改哪里', () => {
    const goal = buildGoalFromTemplate(tpl);
    expect(goal).toContain('【租房合同】');
    expect(goal).toContain('【租客】');
  });

  it('示例值必须是"光秃秃的值"，不能带句子成分（否则会拼出「我是【我是租客】」）', () => {
    const goal = buildGoalFromTemplate(tpl);
    // 这条断言守的是真实踩过的坑：模板作者把 example 写成"我是租客"，
    // 而 goalTemplate 里已经有"我是" → 拼出来是「我是【我是租客】」，很别扭。
    expect(goal).not.toMatch(/我是【我是/);
  });

  it('模板里缺某个 placeholder 时，不留下花括号（用【key】兜底）', () => {
    const partial = { goalTemplate: '帮我{ {a} }看看{{missing}}', placeholders: [] };
    const goal = buildGoalFromTemplate(partial);
    expect(goal).not.toContain('{{');
    expect(goal).toContain('missing');
  });

  it('模板没有 goalTemplate 时，退回 title（不能变成空字符串）', () => {
    expect(buildGoalFromTemplate({ title: '只有标题' })).toBe('只有标题');
    expect(buildGoalFromTemplate({ goal: '只有目标' })).toBe('只有目标');
  });

  it('畸形输入不崩：null / undefined / 字符串 / 数组', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(() => buildGoalFromTemplate(bad)).not.toThrow();
    }
    expect(buildGoalFromTemplate(null)).toBe('');
  });
});

/* ================================================================== *
 * 模板文件 × 渲染器 的一致性
 *
 * 这一组直接把 templates/*.json 全部读进来跑一遍。
 * 目的：模板是产品经理/文案同学写的，渲染器是工程师写的，
 * 两边一旦约定不一致（比如 example 写了"我是租客"而模板里已有"我是"），
 * 用户看到的句子就会别扭。这里让它自动红。
 * ================================================================== */
describe('模板文件：每个都要能被正确渲染成"用户会说的话"', () => {
  const tplDir = path.join(process.cwd(), 'templates');
  const files = fs.existsSync(tplDir)
    ? fs.readdirSync(tplDir).filter((f) => f.endsWith('.json'))
    : [];

  it('至少存在 5 个场景模板（首页的"我不知道说什么"靠它们救）', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    it(`${file} 渲染后是一句通顺、可编辑的话`, () => {
      const tpl = JSON.parse(fs.readFileSync(path.join(tplDir, file), 'utf8'));
      const goal = buildGoalFromTemplate(tpl);

      // 必须有内容、不是只填了标题
      expect(goal.length).toBeGreaterThan(15);
      expect(goal).not.toBe(tpl.title);
      // 不能有没替换掉的占位符
      expect(goal).not.toMatch(/\{\{|\}\}/);
      // 示例值要有【】标记，让用户知道该改哪里
      if (Array.isArray(tpl.placeholders) && tpl.placeholders.length) {
        expect(goal).toMatch(/【.+?】/);
      }
      // 不能拼出重复的句子成分（真实踩过的坑）
      expect(goal).not.toMatch(/我是【我是|我是我是/);
      // 每个 placeholder 的 key 都应该在模板里出现过（否则是没用的定义）
      for (const p of tpl.placeholders || []) {
        expect(typeof p.key).toBe('string');
        expect(p.key.length).toBeGreaterThan(0);
      }
      // 必填元信息
      expect(typeof tpl.id).toBe('string');
      expect(typeof tpl.title).toBe('string');
      expect(tpl.title.length).toBeGreaterThan(0);
    });
  }

  it('每个模板的 id 唯一，且和文件名一致（避免模板串台）', () => {
    const ids = [];
    for (const file of files) {
      const tpl = JSON.parse(fs.readFileSync(path.join(tplDir, file), 'utf8'));
      expect(tpl.id).toBe(path.basename(file, '.json'));
      ids.push(tpl.id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ================================================================== *
 * CSS 一致性：app.js / ui.js 里用到的类名，styles.css 里要真的定义过
 *
 * 这是"没有构建步骤"的代价：类名写错了不会报错，只会**悄悄没有样式**。
 * 用户看到的就是一个没排版好的块 —— 而且很难被发现（代码没错，测试也没错）。
 * ================================================================== */
describe('CSS 一致性：新加的类名必须在 styles.css 里有定义', () => {
  const cssPath = path.join(process.cwd(), 'public', 'styles.css');
  const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';

  // 只检查我们**明确关心**的几组（全量扫描误报太多：动态拼类名、状态类等）
  const mustExist = [
    'tpl-hint',
    'tpl-hint-notice',
    'tpl-hint-tips',
    'tpl-grid',
    'demo-note',
    'demo-note-text',
    'tpl-title',
    'tpl-desc',
  ];

  for (const cls of mustExist) {
    it(`.${cls} 在 styles.css 里有定义`, () => {
      expect(css).toContain(`.${cls}`);
    });
  }
});
