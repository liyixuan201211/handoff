import { extractMath } from './math.js';
/**
 * Handoff — UI 纯函数层（[S5] 前端工程师）
 *
 * 硬约束：本文件**绝不允许**出现顶层 DOM / window / document 访问。
 * 原因：测试要在 Node 里 `import` 它（tests/unit/frontend.test.js）。
 * 所有 DOM 操作都必须放在函数体内，并用 `typeof document !== 'undefined'` 保护。
 *
 * 导出分四块：
 *   1. 安全层：escapeHtml / safeHref / stripControlChars
 *   2. markdown 渲染器：renderMarkdown（先按行处理 → 逐段 escapeHtml → 再插标签）
 *   3. 状态工具：statusLabel / statusTone / roleMeta / formatElapsed / hash 路由解析
 *   4. store：极简订阅式状态容器（无全局散落变量）
 */

/* ------------------------------------------------------------------ *
 * 1. 安全层
 * ------------------------------------------------------------------ */

/**
 * HTML 转义。任何进入 DOM 的动态文本都必须先过这里。
 * 转义 & < > " ' ` = 六个字符，足以阻断标签注入与属性逃逸。
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

/** 剥掉控制字符（含 \u0000-\u001f，保留 \n \t），用于不可信文本进日志/URL 前。 */
export function stripControlChars(value) {
  if (value === null || value === undefined) return '';
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/**
 * 链接白名单。只有 http / https / mailto 允许成为 href。
 * 其余（javascript:、data:、vbscript:、file: …）一律返回 null，
 * 调用方必须把它当纯文本渲染。
 * 额外防御：去掉协议名里的控制字符/空白（`java\nscript:` 这种绕过手法）。
 * @param {unknown} raw
 * @returns {string|null}
 */
export function safeHref(raw) {
  if (raw === null || raw === undefined) return null;
  let url = String(raw).trim();
  if (!url) return null;
  // 去掉所有控制字符与内嵌空白后再判定协议，防 `java\tscript:` / `java\nscript:`
  const probe = url.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
  if (probe.startsWith('javascript:') || probe.startsWith('data:') ||
      probe.startsWith('vbscript:') || probe.startsWith('file:') ||
      probe.startsWith('blob:')) {
    return null;
  }
  if (/^https?:\/\//i.test(url)) return stripControlChars(url);
  if (/^mailto:/i.test(url)) return stripControlChars(url);
  return null;
}

/* ------------------------------------------------------------------ *
 * 2. 最小 markdown 渲染器
 * ------------------------------------------------------------------ */

// Unicode 私用区哨兵：控制字符会被 stripControlChars 剥掉，所以不能用 NUL；
// U+E000 正常文本里不会出现，而且渲染前会把它从输入里删掉，用户无法伪造占位符。
const MARKER = '\uE000';

/**
 * 行内渲染。输入是**已经 escapeHtml 过**的文本，但里面可能含有代码占位符
 * （`行内代码` 与 ``` 代码块 都是从**原始源码**先摘出来、再换成占位符的：
 *   escapeHtml 会把反引号变成 &#96;，先转义就再也认不出代码了）。
 *
 * 本函数只负责：还原占位符 → 加粗体 / 链接 / 斜体标签。
 *
 * @param {string} escapedText 已转义的单行/段落文本
 * @param {{blocks:Array<string>, spans:Array<string>}} tables 占位符 -> 安全 HTML
 */
function inline(escapedText, tables) {
  let out = restorePlaceholders(escapedText, tables);

  // **粗体** / __粗体__
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // [文本](链接) —— href 过白名单；不合法就保持纯文本
  out = out.replace(/\[([^\]]*)\]\((\S+?)\)/g, (whole, label, href) => {
    const safe = safeHref(unescapeBasic(href));
    if (!safe) return whole;
    return '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer nofollow">' + label + '</a>';
  });

  // *斜体*（不跨行、不吞掉列表符号）
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');

  return restorePlaceholders(out, tables);
}

/**
 * 把已转义文本里的占位符换回**已构建好的安全 HTML**。
 * 占位符形如 U+E000 + ('b'|'c') + 序号 + U+E000；序号只用来查表，不拼进 HTML。
 */
function restorePlaceholders(input, tables) {
  if (!tables || (tables.blocks.length === 0 && tables.spans.length === 0)) return String(input);
  return String(input).replace(/\uE000([bc])(\d+)\uE000/g, (whole, kind, digits) => {
    const table = kind === 'c' ? tables.spans : tables.blocks;
    const html = table[Number(digits)];
    return html === undefined ? '' : html;
  });
}

/** 把已经 escapeHtml 过的属性值还原成近似原文，仅用于链接白名单判定（不用于输出）。 */
function unescapeBasic(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#96;/g, '`');
}

/**
 * 渲染 markdown 为**已转义**的 HTML 字符串。
 *
 * 流程（顺序不可颠倒）：
 *   1. 剥掉控制字符与占位符哨兵（用户无法伪造占位符）
 *   2. ``` 围栏内的内容**从原文取出**，escapeHtml 后放进 <pre><code>；原文位置留占位符
 *   3. `行内代码` 同样从原文取出，escapeHtml 后放进 <code>
 *   4. 其余每一段文本**先 escapeHtml**，再包裹标签
 * 绝不"先拼 HTML 再转义"。
 *
 * @param {unknown} src
 * @returns {string} 可安全交给 innerHTML 的字符串
 */
/**
 * 表格：判断一行是不是分隔行（`|---|---|` 或 `| :--- | ---: |`）并取出对齐方式。
 *
 * ⚠️ 分隔行必须满足"只有 | - : 空格"这几种字符。
 * 否则 `| 押金 | 6000 |` 这种普通数据行会被误判成分隔行，表格结构就乱了。
 * @returns {string[]|null} 对齐数组（'left'|'center'|'right'|''），不是分隔行返回 null
 */
export function parseTableAlign(sepLine) {
  const raw = String(sepLine ?? '').trim();
  if (!raw.includes('-')) return null;
  if (!/^\|?[\s:|-]+\|?$/.test(raw)) return null;
  const cells = splitTableRow(raw);
  if (!cells.length) return null;
  const out = [];
  for (const c of cells) {
    const t = c.trim();
    if (!/^:?-{1,}:?$/.test(t)) return null; // 每一格都必须是 --- 或 :--: 之类
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    out.push(left && right ? 'center' : right ? 'right' : left ? 'left' : '');
  }
  return out;
}

/**
 * 切一行表格。要处理 `\|`（转义竖线）—— 内容里出现竖线是常见的
 * （比如 `a \| b`），不能把它当成列分隔。
 */
export function splitTableRow(line) {
  const raw = String(line ?? '').trim();

  const cells = [];
  let cur = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\' && raw[i + 1] === '|') {
      cur += '|'; // 转义的竖线是内容，不是分列
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);

  // ⚠️ 首尾的竖线是"边框"，不是空列。
  //
  // 这里踩过一个会让**表头整个塌成一列**的 bug：
  //   原实现只处理"整行以 | 开头/结尾"的情况（Markdown 规范写法 `| a | b |`），
  //   但模型（和真实看到的那份交付物）大量使用**不带首尾竖线**的写法：
  //       `条款 | 对你 | 最坏花多少`
  //   于是第一格和最后一格各多出一个空字符串，
  //   渲染出来的 `<th>` 里塞了整行原文（`<th>条款 | 对你 | 最坏花多少`），
  //   表格看起来"渲染了"，其实完全没分列 —— 比不渲染还糟。
  //   修法：按"有没有被竖线围起来"来剥，而不是只看整行首尾。
  if (cells.length > 1 && cells[0].trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

/** 一行看起来像表格行吗（至少有一个未转义的 |） */
export function looksLikeTableRow(line) {
  const s = String(line ?? '').trim();
  if (!s.includes('|')) return false;
  return /(^|[^\\])\|/.test(s);
}

/** 任务清单：`- [ ] 待办` / `- [x] 已完成` */
export function parseTaskItem(text) {
  const m = String(text ?? '').match(/^\s*\[[\s xX✓]\]\s+(.*)$/);
  if (!m) return null;
  return { done: /[xX✓]/.test(String(text).match(/^\s*\[([\s xX✓])\]/)[1]), text: m[1] };
}

/**
 * 拼一张表格。
 *
 * ⚠️ 安全：每个单元格的文本都经过 renderText（内部先 escapeHtml），
 * 我们只是把**已经安全**的片段放进 `<td>`。绝不能在这里直接拼原始文本 ——
 * 模型输出是不可信内容，表格是最容易漏掉转义的地方（因为要拼很多标签）。
 *
 * @param {string[]} header 表头单元格（原始文本）
 * @param {string[][]} rows 数据行
 * @param {string[]} align 每列对齐
 * @param {(raw:string)=>string} renderText 行内渲染函数（已含转义）
 */
export function buildTable(header, rows, align, renderText) {
  const cols = Math.max(header.length, ...rows.map((r) => r.length), align.length);
  const alignAttr = (i) => (align[i] ? ` style="text-align:${align[i]}"` : '');

  const parts = ['<div class="md-table-wrap"><table class="md-table">'];
  if (header.length) {
    parts.push('<thead><tr>');
    for (let i = 0; i < cols; i += 1) {
      const cell = header[i] ?? '';
      parts.push(`<th${alignAttr(i)}>${renderText(cell.trim())}</th>`);
    }
    parts.push('</tr></thead>');
  }
  parts.push('<tbody>');
  for (const row of rows) {
    // 全空行跳过（模型偶尔会多留一个空行）
    if (row.every((c) => !String(c ?? '').trim())) continue;
    parts.push('<tr>');
    for (let i = 0; i < cols; i += 1) {
      parts.push(`<td${alignAttr(i)}>${renderText(String(row[i] ?? '').trim())}</td>`);
    }
    parts.push('</tr>');
  }
  parts.push('</tbody></table></div>');
  return parts.join('');
}

export function renderMarkdown(src) {
  if (src === null || src === undefined) return '';
  const text = stripControlChars(String(src)).replace(/\uE000/g, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';

  // 每次调用独立一份表，保证可重入
  const tables = { blocks: [], spans: [] };
  const lines = text.split('\n');
  const out = [];

  /* ---- 第 2 步：抽出围栏代码块（用原文，此时不转义） ---- */
  const stage = [];
  for (let i = 0; i < lines.length; i += 1) {
    const opener = lines[i].match(/^\s*(```+|~~~+)\s*([A-Za-z0-9+#._-]*)\s*$/);
    if (!opener) { stage.push(lines[i]); continue; }
    const fenceChar = opener[1][0];
    const lang = opener[2] || '';
    const body = [];
    i += 1;
    while (i < lines.length && !new RegExp('^\\s*' + fenceChar + '{3,}\\s*$').test(lines[i])) {
      body.push(lines[i]);
      i += 1;
    }
    // 未闭合也安全：循环自然结束，剩下的都当代码
    const cls = lang ? ' class="lang-' + escapeHtml(lang).replace(/[^A-Za-z0-9_-]/g, '') + '"' : '';
    const placeholder = MARKER + 'b' + tables.blocks.length + MARKER;
    tables.blocks.push('<pre><code' + cls + '>' + escapeHtml(body.join('\n')) + '</code></pre>');
    stage.push(placeholder);
  }

  /* ---- 第 3 步：行内代码同样从原文取出 ---- */
  const extract = (raw) => String(raw).replace(/`([^`\n]+)`/g, (whole, body) => {
    const placeholder = MARKER + 'c' + tables.spans.length + MARKER;
    tables.spans.push('<code>' + escapeHtml(body) + '</code>');
    return placeholder;
  });

  /* ---- 第 4 步：逐行解析，每段文本先 escapeHtml 再插标签 ---- */
  let para = [];
  let listType = null;   // 'ul' | 'ol'
  let quote = [];

  // 渲染一段行内文本。顺序很重要：
  //   extract(代码) → escapeHtml(整个文本) → extractMath(数学) → inline(粗斜体/链接)
  // 数学必须在 escapeHtml **之后**做：它要插 `<sup>` 这类标签，
  // 如果放在转义之前，我们插的标签会被转义掉。
  const renderText = (raw) => {
    const escaped = escapeHtml(extract(raw));
    const withMath = extractMath(escaped, tables, MARKER);
    return inline(withMath, tables);
  };
  const flushPara = () => {
    if (!para.length) return;
    out.push('<p>' + para.map(renderText).join('<br>') + '</p>');
    para = [];
  };
  const flushList = () => {
    if (listType) { out.push('</' + listType + '>'); listType = null; }
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push('<blockquote>' + quote.map(renderText).join('<br>') + '</blockquote>');
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  // 用索引循环：表格要向前看（下一行是不是分隔行），要一次吃多行
  for (let idx = 0; idx < stage.length; idx += 1) {
    const raw = stage[idx];
    const line = raw.replace(/\s+$/, '');

    // 代码块 / 块级公式占位符：单独成段时用块级样式
    if (/^\uE000b\d+\uE000$/.test(line)) {
      flushAll();
      const ph = line;
      const m = line.match(/^\uE000b(\d+)\uE000$/);
      const html = tables.blocks[Number(m[1])];
      // 块级公式在独立成段时升级成 div（更好看、可横向滚动）；
      // 出现在表格单元格里时不会被走到这里（单元格走 renderText）。
      out.push(typeof html === 'string' && html.startsWith('<span class="tex-block">')
        ? html.replace('<span class="tex-block">', '<div class="tex-block">').replace(/<\/span>$/, '</div>')
        : ph);
      continue;
    }

    if (!line.trim()) { flushAll(); continue; }

    // ── 表格 ────────────────────────────────────────────────────
    // 必须在"分隔线"之前判断：`|---|---|` 里的 `---` 也长得像分隔线。
    if (looksLikeTableRow(line)) {
      const next = stage[idx + 1];
      const align = next !== undefined ? parseTableAlign(next) : null;
      if (align) {
        flushAll();
        const header = splitTableRow(line);
        const rows = [];
        idx += 2; // 跳过表头和分隔行
        while (idx < stage.length && looksLikeTableRow(stage[idx])) {
          // 下一行也可能是分隔行（极少见），跳过它
          if (parseTableAlign(stage[idx])) { idx += 1; continue; }
          rows.push(splitTableRow(stage[idx]));
          idx += 1;
        }
        out.push(buildTable(header, rows, align, renderText));
        idx -= 1; // for 循环会再 +1
        continue;
      }
    }

    // 分隔线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

    // 标题
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      flushAll();
      const level = h[1].length;
      out.push('<h' + level + '>' + renderText(h[2].replace(/\s+#+\s*$/, '')) + '</h' + level + '>');
      continue;
    }

    // 引用
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }

    // 有序列表
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) {
      flushPara(); flushQuote();
      if (listType !== 'ol') { flushList(); out.push('<ol>'); listType = 'ol'; }
      out.push('<li>' + renderText(ol[2]) + '</li>');
      continue;
    }

    // 无序列表（含任务清单 `- [ ]` / `- [x]`）
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara(); flushQuote();
      if (listType !== 'ul') { flushList(); out.push('<ul class="md-ul">'); listType = 'ul'; }
      const task = parseTaskItem(ul[1]);
      if (task) {
        // 任务清单渲染成带方框的条目 —— AI 写"待办清单"时常用这个语法，
        // 而用户正是要拿它一项项去打勾的。
        out.push(
          '<li class="md-task' + (task.done ? ' is-done' : '') + '">' +
          '<span class="md-checkbox" aria-hidden="true">' + (task.done ? '☑' : '☐') + '</span> ' +
          renderText(task.text) + '</li>',
        );
      } else {
        out.push('<li>' + renderText(ul[1]) + '</li>');
      }
      continue;
    }

    flushList(); flushQuote();
    para.push(line);
  }

  flushAll();
  /* ---- 最后：把占位符换回已构建好的安全 HTML ---- */
  return restorePlaceholders(out.join('\n'), tables);
}

/* ------------------------------------------------------------------ *
 * 3. 状态 / 文案 / 时间 / 路由
 * ------------------------------------------------------------------ */

export const ROLE_BY_STAGE = {
  intake: '接待员',
  plan: '项目经理',
  research: '调研员',
  draft: '执行专员',
  critique: '审查员',
  revise: '执行专员',
  verify: '质检员',
  deliver: '交付专员',
};

export const STAGE_TITLE_BY_KEY = {
  intake: '理解需求',
  plan: '制定方案',
  research: '查资料',
  draft: '动手做',
  critique: '挑毛病',
  revise: '改稿',
  verify: '验收',
  deliver: '打包交付',
};

const JOB_STATUS = {
  queued: { label: '排队中', tone: 'wait' },
  running: { label: '进行中', tone: 'work' },
  awaiting_input: { label: '等待你的回答', tone: 'ask' },
  done: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'bad' },
  cancelled: { label: '已取消', tone: 'wait' },
};

const STAGE_STATUS = {
  pending: { label: '等待中', tone: 'wait' },
  running: { label: '工作中', tone: 'work' },
  done: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'bad' },
  skipped: { label: '已跳过', tone: 'wait' },
};

/** @returns {{label:string, tone:string}} */
export function statusLabel(status) {
  return JOB_STATUS[status] || { label: '未知状态', tone: 'wait' };
}

/** @returns {{label:string, tone:string}} */
export function stageStatusLabel(status) {
  return STAGE_STATUS[status] || { label: '等待中', tone: 'wait' };
}

/** 由阶段 key 推断虚拟员工角色（planner 未提供 role 时的兜底）。 */
export function roleMeta(stage) {
  const s = stage || {};
  const role = s.role || ROLE_BY_STAGE[s.key] || '团队成员';
  const name = '小' + Array.from(role)[0];
  return { role, name, initial: Array.from(role)[0] || '员' };
}

/** 稳定的员工色块配色（按角色固定，不用随机数，避免每次重渲染跳色）。 */
const ROLE_HUES = {
  接待员: 210, 项目经理: 258, 调研员: 190,
  执行专员: 160, 审查员: 28, 质检员: 340, 交付专员: 130,
};
export function roleHue(role) {
  if (ROLE_HUES[role] !== undefined) return ROLE_HUES[role];
  let h = 0;
  for (const ch of Array.from(String(role))) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/**
 * 耗时格式化。
 * @param {number|null} ms 已确定的总耗时
 * @param {number|null} startedAt 进行中的开始时间戳
 * @param {number} now 当前时间戳（便于测试注入）
 */
export function formatElapsed(ms, startedAt, now) {
  let value = typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  if (value === null && typeof startedAt === 'number' && Number.isFinite(startedAt)) {
    value = Math.max(0, (typeof now === 'number' ? now : startedAt) - startedAt);
  }
  if (value === null) return '';
  if (value < 1000) return (value / 1000).toFixed(1) + ' 秒';
  if (value < 60000) return (value / 1000).toFixed(1) + ' 秒';
  const total = Math.round(value / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return m + ' 分 ' + s + ' 秒';
  const h = Math.floor(m / 60);
  return h + ' 小时 ' + (m % 60) + ' 分';
}

/** 相对时间（历史列表用）。 */
export function formatRelative(ts, now) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const base = typeof now === 'number' ? now : ts;
  const diff = Math.max(0, base - ts);
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return Math.floor(diff / 86400000) + ' 天前';
}

/** 目标摘要：超长截断，避免卡片被撑爆。 */
export function summarize(text, max) {
  const limit = typeof max === 'number' ? max : 60;
  const s = stripControlChars(String(text === null || text === undefined ? '' : text)).replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length <= limit) return s;
  return chars.slice(0, limit).join('') + '…';
}

/** 严重度 / 安全等级 → 中文与色调。 */
export function severityMeta(severity) {
  const map = {
    high: { label: '严重', tone: 'bad' },
    medium: { label: '中等', tone: 'warn' },
    low: { label: '轻微', tone: 'info' },
  };
  return map[severity] || { label: '提示', tone: 'info' };
}

export function securityMeta(level) {
  const map = {
    clean: { label: '没有发现问题', tone: 'ok', hint: '这次的内容我们检查过了，没有可疑指令，也没有泄露你的隐私信息。' },
    notice: { label: '有几处提醒', tone: 'warn', hint: '内容里有需要你留意的地方，不影响使用，看一眼下面就好。' },
    blocked: { label: '已拦截', tone: 'bad', hint: '这次请求里有不能照做的内容，我们已经拦截下来，没有执行。' },
  };
  return map[level] || { label: '未检查', tone: 'wait', hint: '这次任务还没有做安全检查。' };
}

export function reviewMeta(verdict) {
  const map = {
    pass: { label: '验收通过', tone: 'ok' },
    pass_with_notes: { label: '通过，但有几条提醒', tone: 'warn' },
    needs_revision: { label: '需要返工', tone: 'bad' },
  };
  return map[verdict] || { label: '尚未验收', tone: 'wait' };
}

/* ------------------------------ 路由 ------------------------------ */

export const ROUTES = ['home', 'new', 'job', 'history', 'notfound'];

/**
 * 解析 hash 路由。纯函数，可测。
 *   '#/'            -> { name:'home',    params:{} }
 *   '#/new'         -> { name:'new',     params:{} }
 *   '#/job/job_abc' -> { name:'job',     params:{ id:'job_abc' } }
 *   '#/history'     -> { name:'history', params:{} }
 *   其它/空         -> { name:'home' }（首页兜底，绝不白屏）
 * @param {unknown} hash
 */
export function parseRoute(hash) {
  let raw = typeof hash === 'string' ? hash : '';
  const qIndex = raw.indexOf('?');
  let query = '';
  if (qIndex >= 0) { query = raw.slice(qIndex + 1); raw = raw.slice(0, qIndex); }
  raw = raw.replace(/^#/, '');

  // ⚠️ `decodeURIComponent` 对畸形百分号编码（例如 `#/job/%E4%B8`）会抛 URIError。
  // 这个函数在路由分发的最前面被调用，**没有外层 try/catch**，
  // 所以一个畸形的 URL 就能让整个路由卡死 —— 之后连正常的路由也一直报错，
  // 用户看到的是"点了没反应"。一个字符的容错就能解决：
  // 解不开的片段就当字面量用，至少界面还能正常导航。
  const safeDecode = (seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  };
  const parts = raw
    .split('/')
    .filter((p) => p.length > 0)
    .map((p) => safeDecode(p));

  let route;
  if (parts.length === 0) route = { name: 'home', params: {} };
  else if (parts[0] === 'new') route = { name: 'new', params: {} };
  else if (parts[0] === 'history') route = { name: 'history', params: {} };
  else if (parts[0] === 'job') {
    // '#/job' 或 '#/job/' 没有 id：回首页，绝不去请求 /api/jobs/undefined
    route = parts[1] ? { name: 'job', params: { id: parts[1] } } : { name: 'home', params: {} };
  } else route = { name: 'notfound', params: { path: raw } };

  if (query) route.query = Object.fromEntries(new URLSearchParams(query));
  return route;
}

/** 生成 hash 链接。 */
export function routeHash(name, params) {
  const p = params || {};
  if (name === 'job' && p.id) return '#/job/' + encodeURIComponent(p.id);
  if (name === 'new') return '#/new';
  if (name === 'history') return '#/history';
  return '#/';
}

/* ------------------------------ store ------------------------------ */

/**
 * 极简 store：一个对象 + 订阅。禁止把状态散落成全局变量。
 * 监听器抛错会被吞掉并计数，绝不让一个坏监听器拖垮整个界面。
 */
export function createStore(initialState) {
  const state = Object.assign({}, initialState);
  const subs = new Map();
  let seq = 0;

  return {
    getState() { return state; },
    get(key) { return state[key]; },
    set(patch) {
      Object.assign(state, patch || {});
      this.emit();
    },
    subscribe(handler) {
      if (typeof handler !== 'function') return () => {};
      seq += 1;
      const id = seq;
      subs.set(id, handler);
      return () => { subs.delete(id); };
    },
    emit() {
      const snapshot = Object.assign({}, state);
      for (const handler of Array.from(subs.values())) {
        try { handler(snapshot); } catch (err) { /* 单个监听器出错不影响其它 */ }
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * 4. DOM 渲染（全部在函数体内访问 document，并做 typeof 保护）
 * ------------------------------------------------------------------ */

function doc() {
  return typeof document !== 'undefined' ? document : null;
}

/** 建元素：文本一律走 textContent，属性一律走 setAttribute。 */
export function el(tag, attrs, children) {
  const d = doc();
  if (!d) return null;
  const node = d.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === 'text') { node.textContent = String(value); continue; }
      if (key === 'class') { node.setAttribute('class', String(value)); continue; }
      if (key === 'html') { node.innerHTML = String(value); continue; } // 调用方保证已转义
      if (key === 'dataset') {
        for (const dk of Object.keys(value)) node.dataset[dk] = String(value[dk]);
        continue;
      }
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) { children.forEach((c) => appendChildren(node, c)); return; }
  if (typeof children === 'string' || typeof children === 'number') {
    node.appendChild(node.ownerDocument.createTextNode(String(children)));
    return;
  }
  if (children && typeof children === 'object' && children.nodeType) node.appendChild(children);
}

export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 安全地设置文本。 */
export function setText(node, text) {
  if (!node) return node;
  node.textContent = text === null || text === undefined ? '' : String(text);
  return node;
}

/**
 * 渲染已转义的 markdown HTML。
 * 只接受 renderMarkdown() 的输出（其内部已逐个文本 escapeHtml）。
 */
export function setRenderedMarkdown(node, markdownSource) {
  if (!node) return node;
  node.innerHTML = renderMarkdown(markdownSource);
  return node;
}

/** 状态徽章。 */
export function statusBadge(status) {
  const meta = statusLabel(status);
  return el('span', { class: 'badge tone-' + meta.tone, 'data-status': String(status || '') }, [
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    meta.label,
  ]);
}

/** 虚拟员工头像：姓氏首字圆形色块（不用图片，离线可用）。 */
export function avatarFor(stage) {
  const meta = roleMeta(stage);
  const hue = roleHue(meta.role);
  return el('span', {
    class: 'avatar',
    'aria-hidden': 'true',
    style: '--hue:' + hue,
  }, meta.initial);
}

/** 单个虚拟员工（阶段）卡片。 */
export function stageCard(stage) {
  const meta = roleMeta(stage);
  const st = stageStatusLabel(stage.status);
  const card = el('li', {
    class: 'stage tone-' + st.tone,
    'data-stage-id': String(stage.id || ''),
    'data-status': String(stage.status || 'pending'),
  }, [
    el('button', {
      class: 'stage-head', type: 'button',
      'aria-expanded': 'false',
    }, [
      avatarFor(stage),
      el('span', { class: 'stage-who' }, [
        el('span', { class: 'stage-name' }, meta.name + ' · ' + meta.role),
        el('span', { class: 'stage-title' }, stage.title || STAGE_TITLE_BY_KEY[stage.key] || '工作中'),
      ]),
      el('span', { class: 'stage-right' }, [
        el('span', { class: 'badge tone-' + st.tone, 'data-role': 'status' }, [
          el('span', { class: 'dot', 'aria-hidden': 'true' }),
          st.label,
        ]),
        el('time', { class: 'elapsed mono', 'data-role': 'elapsed' }, ''),
        el('span', { class: 'chev', 'aria-hidden': 'true' }, '▾'),
      ]),
    ]),
    stage.reason ? el('p', { class: 'stage-reason' }, stage.reason) : null,
    el('div', { class: 'stage-log', hidden: true }, [
      el('div', { class: 'log-head' }, '这一阶段发生了什么'),
      el('ul', { class: 'log-list', 'data-role': 'log-list', 'aria-live': 'off' }),
      el('p', { class: 'log-empty', 'data-role': 'log-empty' }, '还没有日志。'),
    ]),
  ]);
  return card;
}

/** 流程线（首页用来说明"我们不是一次问答"）。 */
export function pipelineRibbon(keys) {
  const list = Array.isArray(keys) && keys.length ? keys : Object.keys(STAGE_TITLE_BY_KEY);
  return el('ol', { class: 'ribbon', 'aria-label': 'AI 团队的八个工作步骤' },
    list.map((key, index) => el('li', { class: 'ribbon-item' }, [
      el('span', { class: 'ribbon-num mono' }, String(index + 1)),
      el('span', { class: 'ribbon-role' }, ROLE_BY_STAGE[key] || '团队成员'),
      el('span', { class: 'ribbon-title' }, STAGE_TITLE_BY_KEY[key] || key),
    ])));
}

/** 骨架屏：首屏加载用，避免"转圈圈然后白屏"。 */
export function skeleton(kind) {
  const rows = kind === 'history' ? 3 : kind === 'job' ? 6 : 4;
  const wrap = el('div', { class: 'skeleton', role: 'status', 'aria-live': 'polite' }, [
    el('span', { class: 'sr-only' }, '正在加载…'),
  ]);
  for (let i = 0; i < rows; i += 1) {
    wrap.appendChild(el('div', { class: 'sk-row', style: '--i:' + i }, [
      el('div', { class: 'sk-avatar' }),
      el('div', { class: 'sk-lines' }, [
        el('div', { class: 'sk-line w60' }),
        el('div', { class: 'sk-line w40' }),
      ]),
    ]));
  }
  return wrap;
}

/**
 * 空状态：友善引导 + 直接开始按钮。绝不出现"白页"。
 * @param {{title:string, body:string, cta?:string, onCta?:Function}} opts
 */
export function emptyState(opts) {
  const o = opts || {};
  const cta = typeof o.onCta === 'function'
    ? el('button', { class: 'btn btn-primary', type: 'button' }, o.cta || '开始')
    : null;
  if (cta) cta.addEventListener('click', o.onCta);
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty-mark', 'aria-hidden': 'true' }, '⌘'),
    el('h2', { class: 'empty-title' }, o.title || '这里还是空的'),
    el('p', { class: 'empty-body' }, o.body || ''),
    cta,
  ]);
}

/**
 * 失败状态：说清楚「哪一步失败、为什么、你能做什么」。不要只甩报错。
 */
export function failureState(opts) {
  const o = opts || {};
  const actions = el('div', { class: 'fail-actions' });
  if (typeof o.onRetry === 'function') {
    const retry = el('button', { class: 'btn btn-primary', type: 'button' }, '重试这一步');
    retry.addEventListener('click', o.onRetry);
    actions.appendChild(retry);
  }
  if (typeof o.onNew === 'function') {
    const fresh = el('button', { class: 'btn', type: 'button' }, '换个说法重开一个任务');
    fresh.addEventListener('click', o.onNew);
    actions.appendChild(fresh);
  }
  return el('section', { class: 'fail', role: 'alert' }, [
    el('h2', { class: 'fail-title' }, o.title || '这一步没做成'),
    el('p', { class: 'fail-where' }, o.where ? '卡住的地方：' + o.where : ''),
    el('p', { class: 'fail-why' }, o.why || ''),
    el('p', { class: 'fail-next' }, o.next || '你什么都不用改，直接点下面的按钮再试一次就行。'),
    actions,
  ]);
}

/** 连接中断提示条。 */
export function connectionBanner(state) {
  const map = {
    live: { text: '已连接，进展会实时更新', tone: 'ok' },
    connecting: { text: '正在连接…', tone: 'wait' },
    reconnecting: { text: '连接中断，正在重连…', tone: 'warn' },
    offline: { text: '网络好像断了。检查一下 Wi-Fi，然后点重连。', tone: 'bad' },
  };
  const meta = map[state] || map.connecting;
  const banner = el('div', {
    class: 'conn tone-' + meta.tone,
    'data-state': String(state || ''),
    role: 'status',
    'aria-live': 'polite',
  }, [
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    el('span', { 'data-role': 'conn-text' }, meta.text),
  ]);
  return banner;
}

export default {
  escapeHtml, stripControlChars, safeHref, renderMarkdown,
  statusLabel, stageStatusLabel, roleMeta, roleHue, formatElapsed, formatRelative,
  summarize, severityMeta, securityMeta, reviewMeta,
  parseRoute, routeHash, createStore,
  el, clear, setText, setRenderedMarkdown, statusBadge, avatarFor, stageCard,
  pipelineRibbon, skeleton, emptyState, failureState, connectionBanner,
  ROLE_BY_STAGE, STAGE_TITLE_BY_KEY, ROUTES,
};
