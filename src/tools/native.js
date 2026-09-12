/**
 * 原生工具：不依赖任何外部服务就能用的能力。
 *
 * 三个原则：
 *  1. **默认全关**。需要外网的、需要读本地文件的，都要用户显式打开
 *     （`handoff.config.json` 或环境变量）。一个刚 clone 下来就能替你
 *     到处抓网页的程序，不是一个可以开源的程序。
 *  2. **失败要给模型可读的原因**。工具失败是常态（404、超时、没配 Key），
 *     把原因写清楚，模型可以换个方式再试。
 *  3. **输出要瘦身**。抓回来的网页原文动辄几十万字，直接塞给模型既贵又没用。
 *     这里做 HTML→文本 + 结构化提取，只把正文给它。
 */
import { registerTool } from './registry.js';
import { checkUrl, checkPath, NetGuardError } from './net-guard.js';
import { clipOutput, MAX_TOOL_OUTPUT_CHARS } from './registry.js';

/* ────────────────────────────────────────────────────────────────
 * HTML → 文本（自写，不引依赖）
 * ──────────────────────────────────────────────────────────────── */

/**
 * 我们的 User-Agent。
 *
 * ⚠️ 必须**纯 ASCII** —— HTTP 头是 ByteString，任何非 Latin-1 字符（比如中文）
 * 都会让 fetch 直接抛 "Cannot convert argument to a ByteString"。
 * 我写第一版时在 UA 里放了中文，结果 web_fetch 100% 失败，
 * 而错误信息里完全看不出跟 UA 有关。
 */
const USER_AGENT = 'HandoffBot/1.0 (+https://github.com/handoff) AI assistant for everyday tasks';

/** 去掉这些标签连同内容（它们不是正文） */
const DROP_WITH_CONTENT = /<(script|style|noscript|svg|canvas|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** 块级标签 → 换行 */
const BLOCK_TAGS =
  /<\/?(p|div|section|article|header|footer|main|nav|aside|h[1-6]|li|tr|table|thead|tbody|blockquote|pre|figure|figcaption|form|ul|ol|dl|dt|dd|br|hr)\b[^>]*>/gi;

/**
 * 一份「够用」的 HTML 转文本。
 *
 * 为什么不用 cheerio/jsdom：多一个依赖就多一份审计面，而我们要的只是
 * "把网页变成模型能读的文本"。这个函数不是浏览器，也不打算是。
 * 它做三件事：扔掉脚本样式、把块级标签变换行、解 HTML 实体。
 */
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' '); // 注释
  s = s.replace(DROP_WITH_CONTENT, ' ');
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' '); // head 里没有正文
  s = s.replace(BLOCK_TAGS, '\n');
  s = s.replace(/<[^>]+>/g, ''); // 剩下的标签全去掉
  s = decodeEntities(s);
  // 压缩空白：连续空行最多留一个
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  mdash: '—', ndash: '–', middot: '·', times: '×', divide: '÷',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±',
  laquo: '«', raquo: '»', bull: '•', dagger: '†',
};

/** 解 HTML 实体（含数字实体）。顺序很重要：&amp; 必须最后解。 */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/&amp;/gi, '&');
}

function safeCodePoint(n) {
  try {
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/** 取出 <title> 和 meta description —— 搜索结果里最有用的一行信息 */
export function extractTitle(html) {
  const m = String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

/* ────────────────────────────────────────────────────────────────
 * web_fetch
 * ──────────────────────────────────────────────────────────────── */

/**
 * 注册网页抓取工具。
 * @param {object} cfg { allowHosts:string[], allowPrivateHosts:boolean, timeoutMs:number, maxBytes:number, fetchImpl?:Function }
 */
export function registerWebFetch(cfg = {}) {
  const {
    // trustedHosts：跳过内网 IP 检查的域名白名单。默认空 = 最严格。
    // 用途见 net-guard.js 里那段注释（有些机器的 /etc/hosts 会改写知名域名）。
    allowHosts = [],
    allowPrivateHosts = false,
    timeoutMs = 15_000,
    maxBytes = 2_000_000,
    fetchImpl = null,
  } = cfg;

  registerTool({
    name: 'web_fetch',
    description:
      '抓取一个网页，返回它的正文文本。当你需要**核实某个具体事实**、查看用户给你的链接、' +
      '或者需要最新的公开信息时用它。只支持 http/https，不能访问内网地址。' +
      '返回的是网页正文（已去掉脚本和样式），可能被截断。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', minLength: 8, maxLength: 2000, description: '要抓取的完整网址' },
        maxChars: {
          type: 'integer',
          minimum: 500,
          maximum: MAX_TOOL_OUTPUT_CHARS,
          description: '最多返回多少字符，默认 8000',
        },
      },
    },
    dangerous: true,
    source: 'native',
    timeoutMs: timeoutMs + 2000,
    async handler(args, ctx) {
      const guard = await checkUrl(args.url, { allowHosts, allowPrivateHosts });
      if (!guard.ok) return { ok: false, text: '', error: guard.error };

      const f = fetchImpl ?? globalThis.fetch;
      if (typeof f !== 'function') {
        return { ok: false, text: '', error: '当前运行环境没有可用的网络请求能力' };
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      timer.unref?.();
      const onAbort = () => ctrl.abort();
      ctx?.signal?.addEventListener?.('abort', onAbort, { once: true });

      try {
        const res = await f(guard.url.href, {
          signal: ctrl.signal,
          redirect: 'follow',
          headers: {
            // 老实说明自己是谁。伪装浏览器既没必要也不礼貌。
            // ⚠️ 必须**纯 ASCII**：HTTP 头是 ByteString，写中文会直接抛
            // "Cannot convert argument to a ByteString"。这个坑我踩过一次。
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          },
        });
        if (!res.ok) {
          return {
            ok: false,
            text: '',
            error: `对方返回了 ${res.status}${res.status === 404 ? '（页面不存在）' : ''}`,
          };
        }

        const ctype = String(res.headers?.get?.('content-type') ?? '');
        // 只处理文本。二进制内容（图片/PDF/压缩包）对模型没有意义。
        if (ctype && !/text\/|application\/(json|xml|xhtml)|application\/x-www-form-urlencoded/i.test(ctype)) {
          return {
            ok: false,
            text: '',
            error: `这个链接不是网页文本（${ctype.split(';')[0]}），我没法读它`,
          };
        }

        const buf = await res.arrayBuffer();
        if (buf.byteLength > maxBytes) {
          return {
            ok: false,
            text: '',
            error: `这个页面太大了（${Math.round(buf.byteLength / 1024)}KB），超过 ${Math.round(maxBytes / 1024)}KB 的上限`,
          };
        }
        const raw = new TextDecoder('utf-8').decode(buf);
        const title = extractTitle(raw);
        const isHtml = /html/i.test(ctype) || /<html|<body|<div/i.test(raw.slice(0, 2000));
        const body = isHtml ? htmlToText(raw) : raw;
        const limit = Number.isFinite(args.maxChars) ? args.maxChars : 8000;

        const header = [
          `来源：${guard.url.href}`,
          title ? `标题：${title}` : '',
        ].filter(Boolean).join('\n');

        return {
          ok: true,
          text: `${header}\n\n${clipOutput(body, limit)}`,
          meta: { url: guard.url.href, title, bytes: buf.byteLength, truncated: body.length > limit },
        };
      } catch (err) {
        const aborted = err?.name === 'AbortError';
        return {
          ok: false,
          text: '',
          error: aborted
            ? `抓取超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`
            : `抓取失败：${String(err?.message ?? err).slice(0, 200)}`,
        };
      } finally {
        clearTimeout(timer);
        ctx?.signal?.removeEventListener?.('abort', onAbort);
      }
    },
  });

  return 'web_fetch';
}

/* ────────────────────────────────────────────────────────────────
 * web_search
 * ──────────────────────────────────────────────────────────────── */

/**
 * 注册网页搜索工具。
 *
 * 两种模式：
 *  · 配了 `searchUrl`（一个返回 JSON 的搜索 API 模板）→ 用它，可靠
 *  · 没配 → 尝试 DuckDuckGo 的免登录 HTML 端点。**这个方式不稳定**，
 *    所以我们把它标注清楚：失败时明确告诉模型"搜索不可用，改用 web_fetch"，
 *    而不是给一份假结果。**宁可说"我查不到"，也不能编。**
 */
export function registerWebSearch(cfg = {}) {
  const {
    searchUrl = '',
    apiKey = '',
    timeoutMs = 15_000,
    fetchImpl = null,
    allowPrivateHosts = false,
  } = cfg;

  registerTool({
    name: 'web_search',
    description:
      '搜索网页，返回若干条结果的标题、链接和摘要。当你需要**找资料**但不知道具体网址时用它。' +
      '找到链接后可以用 web_fetch 读全文。如果搜索不可用，它会明确告诉你，' +
      '这时候不要编造搜索结果。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 300, description: '搜索关键词' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '最多返回几条，默认 5' },
      },
    },
    dangerous: true,
    source: 'native',
    timeoutMs: timeoutMs + 2000,
    async handler(args, ctx) {
      const f = fetchImpl ?? globalThis.fetch;
      if (typeof f !== 'function') {
        return { ok: false, text: '', error: '当前运行环境没有可用的网络请求能力' };
      }
      const limit = Number.isFinite(args.limit) ? args.limit : 5;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      timer.unref?.();
      const onAbort = () => ctrl.abort();
      ctx?.signal?.addEventListener?.('abort', onAbort, { once: true });

      try {
        if (searchUrl) {
          const url = searchUrl
            .replace('{query}', encodeURIComponent(args.query))
            .replace('{limit}', String(limit));
          const guard = await checkUrl(url, { allowPrivateHosts });
          if (!guard.ok) return { ok: false, text: '', error: guard.error };

          const headers = { Accept: 'application/json' };
          if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
          const res = await f(guard.url.href, { signal: ctrl.signal, headers });
          if (!res.ok) {
            return { ok: false, text: '', error: `搜索服务返回了 ${res.status}` };
          }
          const data = await res.json();
          const items = pickSearchItems(data).slice(0, limit);
          if (!items.length) {
            return { ok: true, text: `没有搜到和「${args.query}」相关的结果。可以换个说法再搜。` };
          }
          return { ok: true, text: formatSearchResults(args.query, items), meta: { count: items.length } };
        }

        // 免登录的 DuckDuckGo HTML 端点。它是"尽力而为"，抓不到就说抓不到。
        const ddg = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
        const guard = await checkUrl(ddg, { allowPrivateHosts });
        if (!guard.ok) return { ok: false, text: '', error: guard.error };

        const res = await f(guard.url.href, {
          signal: ctrl.signal,
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html',
          },
        });
        if (!res.ok) {
          return {
            ok: false,
            text: '',
            error: `搜索服务返回了 ${res.status}。这次没搜到，请不要编造搜索结果 —— 可以改用 web_fetch 直接抓你已知的网址。`,
          };
        }
        const html = await res.text();
        const items = parseDuckDuckGo(html).slice(0, limit);
        if (!items.length) {
          return {
            ok: false,
            text: '',
            error:
              '没能从搜索页里解析出结果（对方可能改了页面结构或者限制了访问）。' +
              '**请不要编造搜索结果**：改用 web_fetch 抓你确实知道的网址，或者在交付物里说明这部分没能核实。',
          };
        }
        return { ok: true, text: formatSearchResults(args.query, items), meta: { count: items.length } };
      } catch (err) {
        const aborted = err?.name === 'AbortError';
        return {
          ok: false,
          text: '',
          error: aborted
            ? `搜索超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`
            : `搜索失败：${String(err?.message ?? err).slice(0, 200)}`,
        };
      } finally {
        clearTimeout(timer);
        ctx?.signal?.removeEventListener?.('abort', onAbort);
      }
    },
  });

  return 'web_search';
}

/** 从各种搜索 API 的响应里尽力取出结果数组 */
export function pickSearchItems(data) {
  const candidates = [
    data?.results,
    data?.data,
    data?.items,
    data?.organic,
    data?.web?.results,
    data?.Data,
  ];
  const arr = candidates.find(Array.isArray) ?? [];
  return arr
    .map((r) => ({
      title: String(r?.title ?? r?.name ?? r?.heading ?? '').trim(),
      url: String(r?.url ?? r?.link ?? r?.href ?? '').trim(),
      snippet: String(r?.snippet ?? r?.description ?? r?.summary ?? r?.content ?? '').trim(),
    }))
    .filter((r) => r.url || r.title);
}

/** 解析 DuckDuckGo 的 HTML 结果页 */
export function parseDuckDuckGo(html) {
  const src = String(html ?? '');
  const out = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(src)) !== null && out.length < 12) {
    let url = decodeEntities(m[1]);
    // DDG 会把真实地址藏在 uddg 参数里
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
        /* 保持原样 */
      }
    }
    if (url.startsWith('//')) url = `https:${url}`;
    const title = htmlToText(m[2]);
    if (url && title) out.push({ title, url, snippet: '' });
  }
  // 摘要
  const snippets = [...src.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map(
    (x) => htmlToText(x[1]),
  );
  out.forEach((item, i) => {
    if (snippets[i]) item.snippet = snippets[i].slice(0, 300);
  });
  return out;
}

function formatSearchResults(query, items) {
  const lines = [`搜索「${query}」找到 ${items.length} 条结果：`];
  items.forEach((r, i) => {
    lines.push(`\n${i + 1}. ${r.title || '(无标题)'}`);
    if (r.url) lines.push(`   链接：${r.url}`);
    if (r.snippet) lines.push(`   摘要：${r.snippet}`);
  });
  lines.push('\n（要用某条结果的全文，就用 web_fetch 抓它的链接。）');
  return clipOutput(lines.join('\n'));
}

/* ────────────────────────────────────────────────────────────────
 * read_text_file
 * ──────────────────────────────────────────────────────────────── */

/**
 * 注册"读本地文件"工具。
 *
 * 我只实现了**读**，没有实现写。理由：
 * 这个产品是帮普通人办事的，"AI 自己决定往你硬盘上写文件"不是它该有的能力。
 * 交付物本来就是通过界面给他的，不需要落盘。
 * 少一个写接口，就少一整类"把我文件弄坏了"的事故。
 *
 * @param {object} cfg { allowedRoots:string[], maxBytes:number, fs, path }
 */
export function registerReadFile(cfg = {}) {
  const { allowedRoots = [], maxBytes = 400_000, fs, path: p } = cfg;
  if (!fs || !p) throw new Error('registerReadFile 需要注入 fs 与 path');

  registerTool({
    name: 'read_text_file',
    description:
      '读取本机上一个文本文件的内容。只有当用户明确提到某个文件、' +
      '并且你能确定它的完整路径时才用它。只能读用户配置过的目录里的文件，' +
      '只能读文本（txt/md/csv/json/代码等），不能读图片或二进制文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 1000, description: '文件的完整路径' },
        maxChars: {
          type: 'integer',
          minimum: 500,
          maximum: MAX_TOOL_OUTPUT_CHARS,
          description: '最多返回多少字符，默认 8000',
        },
      },
    },
    dangerous: true,
    source: 'native',
    async handler(args) {
      const guard = await checkPath(args.path, { allowedRoots, fs, path: p });
      if (!guard.ok) return { ok: false, text: '', error: guard.error };

      let stat;
      try {
        stat = await fs.promises.stat(guard.full);
      } catch {
        return { ok: false, text: '', error: `找不到这个文件：${guard.full}` };
      }
      if (!stat.isFile()) {
        return { ok: false, text: '', error: `${guard.full} 不是一个文件（可能是目录）` };
      }
      if (stat.size > maxBytes) {
        return {
          ok: false,
          text: '',
          error: `文件太大了（${Math.round(stat.size / 1024)}KB），超过 ${Math.round(maxBytes / 1024)}KB 上限。可以让用户只把关键部分贴进来。`,
        };
      }

      const buf = await fs.promises.readFile(guard.full);
      // 简单的二进制探测：出现 NUL 就当二进制
      if (buf.subarray(0, 8000).includes(0)) {
        return { ok: false, text: '', error: '这看起来是二进制文件（图片/压缩包等），我读不了' };
      }
      const text = buf.toString('utf8');
      const limit = Number.isFinite(args.maxChars) ? args.maxChars : 8000;
      return {
        ok: true,
        text: `文件：${guard.full}（${Math.round(stat.size / 1024)}KB）\n\n${clipOutput(text, limit)}`,
        meta: { path: guard.full, bytes: stat.size, truncated: text.length > limit },
      };
    },
  });

  return 'read_text_file';
}
