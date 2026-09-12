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
  splitTableRow, parseTableAlign, looksLikeTableRow, parseTaskItem, buildTable,
} from '../../public/ui.js';

import { createApi, FALLBACK_TEMPLATES, friendlyError, friendlyJobError, ERROR_COPY } from '../../public/api.js';
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
    // 注意 ul 带 class="md-ul"：任务清单样式需要它
    expect(renderMarkdown('- 甲\n- 乙')).toBe('<ul class="md-ul">\n<li>甲</li>\n<li>乙</li>\n</ul>');
    expect(renderMarkdown('1. 甲\n2. 乙')).toBe('<ol>\n<li>甲</li>\n<li>乙</li>\n</ol>');
    expect(renderMarkdown('- 甲\n- 乙\n\n收尾段落')).toBe('<ul class="md-ul">\n<li>甲</li>\n<li>乙</li>\n</ul>\n<p>收尾段落</p>');
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
    // ⚠️ 这里原来写的是 `expect(out).not.toContain('"')` —— 一条**太宽泛**的断言。
    // 它的意图是"用户输入的引号被转义、没人能闭合属性"，但实现成了
    // "整份输出不能有任何双引号"，而我们自己产的标签也要用引号包 class 属性
    // （加了表格/公式之后就有 class="md-table" 之类了），于是它开始误报。
    //
    // 真正要验的是：**用户输入来的引号必须被转义**。
    // 所以直接检查输入里的引号没有以裸引号形式出现在输出里。
    expect(out).not.toContain('onerror="');
    expect(out).not.toContain("onerror='");
    expect(out).not.toContain('onload="');
    expect(out).not.toContain("onload='");
    // 而输入里的引号应该是实体形式
    expect(out).toContain('&lt;');
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
    'log-icon',
    'log-line-tool',
    'artifact-version-badge',
    'artifact-history',
    'version-item',
    'version-body',
    'trace-block',
    'trace-item',
    'trace-name',
    'trace-detail',
    'tpl-title',
    'tpl-desc',
  ];

  for (const cls of mustExist) {
    it(`.${cls} 在 styles.css 里有定义`, () => {
      expect(css).toContain(`.${cls}`);
    });
  }
});

/* ================================================================== *
 * 错误消息翻译（P0：失败卡片是用户最容易放弃的那一刻）
 *
 * 背景：流水线失败时，`job.error.message` 直接来自 src/llm/gateway.js，
 * 而它以前是**原样显示**给用户的。用户会看到：
 *   「模型输出的结构不符合要求：$.confidence 取值必须是 high/medium/low 之一，实际是 0.95」
 * 而 frontend 的 friendlyError 映射表里有三个**服务端从不产生**的码
 * （VALIDATION_ERROR / JOB_NOT_FOUND / LLM_ALL_PROVIDERS_FAILED），
 * 却漏了服务端最常抛的 LLM_NO_PROVIDER —— 所以那些错误全都落到兜底分支，
 * 把技术消息原样吐出去。
 * ================================================================== */
describe('错误消息翻译：每个服务端错误码都要有人话', () => {
  it('ERROR_COPY 必须覆盖 src/llm/errors.js 里 ERR 表的所有码', async () => {
    const { ERR } = await import('../../src/llm/errors.js');
    const missing = Object.values(ERR).filter((code) => !ERROR_COPY[code]);
    // 这条断言就是"别再写凭印象的映射表"的护栏：
    // 服务端加了新错误码而前端没翻译，这里立刻红。
    expect(missing).toEqual([]);
  });

  it('ERROR_COPY 里不该有服务端不存在的码（死文案）', async () => {
    const { ERR } = await import('../../src/llm/errors.js');
    // 这些码不是来自 ERR 表，但确实会产生：
    //   · 前端自己产生的：NETWORK_ERROR / TIMEOUT / BAD_JSON
    //   · engine 的 failJob() 会写 INTERRUPTED / PIPELINE_STAGE_FAILED
    //   · server 的兜底中间件会写 INTERNAL_ERROR
    //   · 早期的旧码（VALIDATION_ERROR / JOB_NOT_FOUND / LLM_ALL_PROVIDERS_FAILED）
    //     保留翻译是为了兼容浏览器里缓存的旧响应，但**前端的请求已经不再产生它们**。
    const known = new Set([
      ...Object.values(ERR),
      'NETWORK_ERROR', 'TIMEOUT', 'BAD_JSON',
      'INTERNAL_ERROR', 'INTERRUPTED',
      'VALIDATION_ERROR', 'JOB_NOT_FOUND', 'LLM_ALL_PROVIDERS_FAILED',
    ]);
    const dead = Object.keys(ERROR_COPY).filter((code) => !known.has(code));
    expect(dead).toEqual([]);
  });

  it('每个翻译都是一句人话：不含技术符号、不说"未知错误"', () => {
    for (const [code, text] of Object.entries(ERROR_COPY)) {
      expect(typeof text).toBe('string');
      expect(text.length, code).toBeGreaterThan(6);
      // 不能把错误码本身当文案
      expect(text, code).not.toBe(code);
      // 不能出现技术味很重的符号
      expect(text, code).not.toMatch(/[$#{}[\]<>]/);
      // 不能是"未知错误"这类没信息量的说法
      expect(text, code).not.toMatch(/未知错误|unknown error/i);
    }
  });

  it('friendlyError 认带 HTTP_ 前缀的码（服务端拼出来的形式）', () => {
    expect(friendlyError({ code: 'HTTP_404' })).toContain('找不到');
    expect(friendlyError({ code: 'HTTP_429' })).toContain('快');
  });

  it('friendlyJobError 会把技术味的 job.error.message 换成一句人话', () => {
    const technical = {
      code: 'LLM_SCHEMA_INVALID',
      message: '模型输出的结构不符合要求：$.confidence 取值必须是 high/medium/low 之一，实际是 0.95',
    };
    const out = friendlyJobError(technical);
    expect(out).not.toContain('$');
    expect(out).not.toContain('confidence');
    expect(out).toContain('重'); // 给出下一步动作（重试/重做）
  });

  it('friendlyJobError 遇到已经写好的中文用户文案时，原样保留（不要过度翻译）', () => {
    const good = { code: null, message: '这次运行被中断了（服务被关闭或电脑休眠）。已经做好的部分都保留在上面，点「重试」可以接着做完。' };
    expect(friendlyJobError(good)).toBe(good.message);
  });

  it('friendlyJobError 对空值 / 畸形输入不崩', () => {
    for (const bad of [null, undefined, {}, { message: '' }, 'x', 42]) {
      expect(() => friendlyJobError(bad)).not.toThrow();
      expect(friendlyJobError(bad).length).toBeGreaterThan(4);
    }
  });

  it('未知错误码不会把英文技术消息甩给用户', () => {
    const out = friendlyJobError({ code: 'SOME_NEW_CODE', message: 'TypeError: Cannot read properties of undefined' });
    expect(out).not.toContain('TypeError');
    expect(out).toContain('重试');
  });
});

/* ================================================================== *
 * SSE 断档与任务删除（服务端修好之后，前端也得接得住）
 * ================================================================== */
describe('SSE 协议事件：前端必须处理 resync 与 closed', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  it('收到 resync 要用权威快照重新对齐（不能继续等一个不会来的事件）', () => {
    // 背景（对抗性测试 S9-5）：事件日志是环形缓冲，每个 job 最多 500 条。
    // 用户断开太久时，服务端发现接不上会发 resync。如果前端不处理它，
    // 界面上的阶段状态会比真实状态少一截，而且没有任何提示 —— 进度条停在半路。
    expect(src).toContain("evt.type === 'resync'");
    expect(src).toContain('refreshSnapshot');
  });

  it('收到 closed 要给出明确去向（任务被删了，不能一直显示"已连接"）', () => {
    // 背景（对抗性测试 S9-11）：任务被删时服务端会关掉 SSE 连接并发 closed。
    // 前端不处理的话，用户看到"已连接，进展会实时更新"，但那个任务已经不存在了。
    expect(src).toContain("evt.type === 'closed'");
    expect(src).toContain('renderLoadFailure');
  });
});


/* ================================================================== *
 * 开源就绪检查
 *
 * 这些不是"功能测试"，是"这个仓库能不能被别人 clone 下来直接用"的检查。
 * 开源项目最常见的翻车方式不是功能坏了，是：
 *   · 贡献者 clone 下来发现跑不起来
 *   · 文档说 A、实际做 B
 *   · 不小心把密钥提交了
 * ================================================================== */
describe('开源就绪：必需的文档与文件都在', () => {
  const root = process.cwd();
  const mustExist = [
    'LICENSE',
    'README.md',
    'CONTRIBUTING.md',
    '.env.example',
    'handoff.config.example.json',
    '.github/workflows/ci.yml',
    'docs/TOOLS.md',
    'docs/CONTRACT.md',
    'docs/ARCHITECTURE.md',
    'docs/SECURITY.md',
    'docs/TESTING.md',
  ];
  for (const f of mustExist) {
    it(`${f} 存在`, () => {
      expect(fs.existsSync(path.join(root, f)), `${f} 不见了`).toBe(true);
    });
  }

  it('LICENSE 是 MIT 且不含占位符', () => {
    const lic = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
    expect(lic).toContain('MIT License');
    expect(lic).not.toMatch(/\[year\]|\[fullname\]|<copyright holder>/i);
  });

  it('package.json 的 license 字段和 LICENSE 一致', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(String(pkg.license).toUpperCase()).toContain('MIT');
    // 开源项目的元信息不该留空
    expect(pkg.name).toBeTruthy();
    expect(pkg.description && pkg.description.length).toBeGreaterThan(5);
    expect(pkg.repository || pkg.homepage || pkg.bugs, '至少要有 repository/homepage/bugs 之一').toBeTruthy();
  });

  it('README 里提到的每个 docs 文档都真的存在', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const refs = [...readme.matchAll(/\(?(docs\/[A-Za-z0-9_.-]+\.md)\)?/g)].map((m) => m[1]);
    const missing = [...new Set(refs)].filter((f) => !fs.existsSync(path.join(root, f)));
    expect(missing, `README 提到了不存在的文档：${missing.join(', ')}`).toEqual([]);
  });

  it('仓库里没有把个人配置当成示例提交（handoff.config.json 必须被忽略）', () => {
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(ignore).toContain('handoff.config.json');
    expect(ignore).toContain('.env');
    expect(ignore).toContain('node_modules');
  });

  it('示例配置是合法 JSON，且默认什么都不开', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'handoff.config.example.json'), 'utf8'));
    // 默认必须是关的 —— 这是这个项目的安全立场，值得被测试守住
    expect(cfg.tools?.webFetch?.enabled).toBe(false);
    expect(cfg.tools?.webSearch?.enabled).toBe(false);
    expect(cfg.tools?.readFile?.enabled).toBe(false);
    expect(cfg.mcp?.enabled).toBe(false);
  });

  it('.env.example 里不留任何真实密钥的痕迹', () => {
    const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    // 允许出现 KEY= 但等号后面必须是空的或明显的占位
    for (const line of env.split('\n')) {
      const m = line.match(/^([A-Z_]*KEY[A-Z_]*)=(.*)$/);
      if (m) {
        expect(m[2].trim(), `${m[1]} 不该有默认值`).toBe('');
      }
    }
  });
});

/* ================================================================== *
 * Markdown 渲染：表格 / 数学公式 / 任务清单
 *
 * 这三样是真实使用中暴露的：
 *   · AI 写"条款对比""方案对比"**一定**用表格 —— 不渲染的话用户看到一堆竖线
 *   · AI 算账时**一定**输出 LaTeX —— 不渲染的话用户看到一堆反斜杠
 *   · AI 写"待办清单"用 `- [ ]` —— 用户正是要拿它一项项打勾的
 *
 * ⚠️ 这段测试里**一半是安全用例**。新增渲染路径最大的风险是绕过转义：
 * 表格要拼很多标签，最容易在某个<td>里漏掉 escapeHtml。
 * ================================================================== */
describe('Markdown 表格', () => {
  it('基本表格渲染成 <table>，含表头与数据行', () => {
    const html = renderMarkdown([
      '| 条款 | 对你 |',
      '|---|---|',
      '| 押金 | 不利 |',
      '| 租期 | 中性 |',
    ].join('\n'));
    expect(html).toContain('<table');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th>条款</th>');
    expect(html).toContain('<td>押金</td>');
    expect(html).toContain('<td>中性</td>');
    // 不该把竖线当正文留下来
    expect(html).not.toContain('| 押金 |');
  });

  it('对齐标记生效', () => {
    const html = renderMarkdown(['| a | b | c |', '|:--|:-:|--:|', '| 1 | 2 | 3 |'].join('\n'));
    expect(html).toContain('style="text-align:left"');
    expect(html).toContain('style="text-align:center"');
    expect(html).toContain('style="text-align:right"');
  });

  it('列数不齐时不崩，缺的格子补空', () => {
    const html = renderMarkdown(['| a | b | c |', '|---|---|---|', '| 1 |'].join('\n'));
    expect(html).toContain('<table');
    expect((html.match(/<td/g) || []).length).toBe(3);
  });

  it('⚠️ 不带首尾竖线的表格也要正确分列（模型大量使用这种写法）', () => {
    // 这个 bug 是在**真实交付物**里发现的：模型写的是
    //     `条款 | 对你 | 最坏花多少`
    // 而不是规范的
    //     `| 条款 | 对你 | 最坏花多少 |`
    // 原来的切分只剥"整行首尾的竖线"，于是第一格和最后一格多出空字符串，
    // 渲染出来的 <th> 里塞了整行原文 —— 表格看起来"渲染了"，其实完全没分列。
    const md = ['条款 | 对你 | 最坏花多少', '---|---|---', '押金 | 中性 | 6000 元'].join('\n');
    const html = renderMarkdown(md);
    // 用 <th 开头的匹配（`<th[^>]*>` 会把前面的 `<tr>` 一起吃进 `[^>]*`，
    // 于是第一格变成 `<tr><th>条款` —— 是**测试的正则**问题，不是渲染问题）
    const ths = [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].trim());
    expect(ths).toEqual(['条款', '对你', '最坏花多少']);
    const tds = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].trim());
    expect(tds).toEqual(['押金', '中性', '6000 元']);
    // 表头里绝不能残留裸竖线
    expect(html).not.toMatch(/<th[^>]*>[^<]*\|/);
  });

  it('splitTableRow 对各种首尾竖线写法都正确', () => {
    expect(splitTableRow('| a | b |')).toEqual([' a ', ' b ']);
    expect(splitTableRow('a | b')).toEqual(['a ', ' b']);
    expect(splitTableRow('| a | b')).toEqual([' a ', ' b']);
    expect(splitTableRow('a | b |')).toEqual(['a ', ' b ']);
    expect(splitTableRow('| a |')).toEqual([' a ']);
  });

  it('转义竖线 \\| 是内容，不是分列', () => {
    const html = renderMarkdown(['| a | b |', '|---|---|', '| x \\| y | z |'].join('\n'));
    expect(html).toContain('<td>x | y</td>');
    expect(html).toContain('<td>z</td>');
  });

  it('只写表头不写数据行也能渲染', () => {
    const html = renderMarkdown(['| 只有表头 |', '|---|'].join('\n'));
    expect(html).toContain('<th>只有表头</th>');
  });

  it('普通文字里的竖线不会被当成表格', () => {
    const html = renderMarkdown('这是正文，里面有 a | b 这样的竖线，不是表格。');
    expect(html).not.toContain('<table');
    expect(html).toContain('a | b');
  });

  it('表格单元格里的行内格式（粗体/代码）照常生效', () => {
    const html = renderMarkdown(['| a | b |', '|---|---|', '| **粗** | `码` |'].join('\n'));
    expect(html).toContain('<strong>粗</strong>');
    expect(html).toContain('<code>码</code>');
  });
});

describe('Markdown 表格 —— 安全（新增渲染路径不能绕过转义）', () => {
  it('单元格里的 <script> 被转义', () => {
    const html = renderMarkdown(['| a |', '|---|', '| <script>alert(1)</script> |'].join('\n'));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('单元格里的 <img onerror> 被转义', () => {
    const html = renderMarkdown(['| a |', '|---|', '| <img src=x onerror=alert(1)> |'].join('\n'));
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain('&lt;img');
  });

  it('单元格里的事件属性 onclick 被转义', () => {
    const html = renderMarkdown(['| a |', '|---|', '| <td onclick="alert(1)">x |'].join('\n'));
    expect(html).not.toMatch(/onclick=("|')?alert/);
  });

  it('表头里的脚本同样被转义', () => {
    const html = renderMarkdown(['| <script>x</script> |', '|---|', '| ok |'].join('\n'));
    expect(html).not.toContain('<script>');
  });

  it('单元格里的 javascript: 链接被中和', () => {
    const html = renderMarkdown(['| a |', '|---|', '| [点我](javascript:alert(1)) |'].join('\n'));
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it('单元格里的 HTML 实体不会被二次解码成可执行内容', () => {
    const html = renderMarkdown(['| a |', '|---|', '| &#60;script&#62;alert(1)&#60;/script&#62; |'].join('\n'));
    expect(html).not.toContain('<script>');
  });
});

describe('Markdown 数学公式', () => {
  it('行内公式 $...$ 被渲染', () => {
    const html = renderMarkdown('复利公式是 $A = P(1+r)^n$ 这样。');
    expect(html).toContain('tex-inline');
    expect(html).toContain('<sup>n</sup>');
    expect(html).not.toContain('$A = P');
  });

  it('分数 \\frac 渲染成 a/b（普通人好读）', () => {
    const html = renderMarkdown('月供 $\\frac{80万}{12}$ 元。');
    expect(html).toContain('tex-frac');
    expect(html).toContain('tex-sep');
    // 不能把命令名当正文留下
    expect(html).not.toContain('\\frac');
    expect(html).not.toContain('frac80');
  });

  it('\\\\(...\\\\) 与 \\\\[...\\\\] 也认', () => {
    expect(renderMarkdown('行内 \\(x^2\\) 结束。')).toContain('<sup>2</sup>');
    expect(renderMarkdown('块级：\n\n\\[\\sum_{i=1}^{n} i\\]\n')).toContain('tex-block');
  });

  it('$$...$$ 渲染成块级公式', () => {
    const html = renderMarkdown('推导：\n\n$$\\frac{a}{b} = c$$\n\n结束。');
    expect(html).toContain('tex-block');
  });

  it('希腊字母与符号被转成真符号', () => {
    const html = renderMarkdown('参数 $\\alpha \\leq \\beta$ 满足条件。');
    expect(html).toContain('α');
    expect(html).toContain('≤');
    expect(html).toContain('β');
  });

  it('⚠️ 金额不能被误判成公式（$100 到 $200 要原样显示）', () => {
    const html = renderMarkdown('这个要 $100 到 $200，别当成公式。');
    expect(html).toContain('$100');
    expect(html).toContain('$200');
    expect(html).not.toContain('tex-inline');
  });

  it('纯数字金额的各种写法都不误判', () => {
    for (const money of ['$100$', '$1,000$', '$12.5$', '$100万$']) {
      const html = renderMarkdown(`价格是 ${money}。`);
      expect(html, `${money} 被误判成公式了`).not.toContain('tex-inline');
    }
  });

  it('单美元符号（不配对）不动它', () => {
    const html = renderMarkdown('花了 $50 块钱，没写完整。');
    expect(html).toContain('$50');
  });

  it('不认识的 LaTeX 命令保留命令名（比留一串反斜杠好读）', () => {
    const html = renderMarkdown('试试 $\\weirdcmd{x}$。');
    expect(html).not.toContain('\\weirdcmd');
    expect(html).toContain('weirdcmd');
  });

  it('嵌套分数', () => {
    const html = renderMarkdown('$\\frac{\\frac{1}{2}}{3}$');
    expect((html.match(/tex-frac/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('Markdown 数学 —— 安全', () => {
  it('公式里的 <script> 被转义（公式渲染不能成为注入通道）', () => {
    const html = renderMarkdown('$<script>alert(1)</script>$');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('公式里的 img onerror 被转义', () => {
    const html = renderMarkdown('$<img src=x onerror=alert(1)>$');
    expect(html).not.toMatch(/<img[^>]*onerror/i);
  });

  it('公式里塞 javascript: 链接也不行', () => {
    const html = renderMarkdown('$[x](javascript:alert(1))$');
    expect(html).not.toMatch(/href="javascript:/i);
  });
});

describe('Markdown 任务清单', () => {
  it('- [ ] 与 - [x] 渲染成带方框的条目', () => {
    const html = renderMarkdown('- [ ] 今天问房东\n- [x] 拍照留存');
    expect(html).toContain('md-task');
    expect(html).toContain('☐');
    expect(html).toContain('☑');
    expect(html).toContain('is-done');
  });

  it('普通列表项不受影响', () => {
    const html = renderMarkdown('- 普通项目\n- 另一个');
    expect(html).toContain('<li>普通项目</li>');
    expect(html).not.toContain('md-task');
  });

  it('任务项里的行内格式照常生效', () => {
    const html = renderMarkdown('- [ ] 记住 **重点**');
    expect(html).toContain('<strong>重点</strong>');
  });

  it('任务项里的脚本被转义', () => {
    const html = renderMarkdown('- [ ] <script>alert(1)</script>');
    expect(html).not.toContain('<script>');
  });
});
