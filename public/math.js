/**
 * 轻量数学公式渲染 —— 把 LaTeX 变成人能看的 HTML。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它：AI 写"算一笔账""对比方案""推导过程"时**一定**会输出 LaTeX
 * （`\frac{a}{b}`、`x^2`、`\sum`）。不处理的话，用户看到的是一堆反斜杠 ——
 * 而他正是为了"看懂数字"才来的。
 *
 * 为什么不用 KaTeX / MathJax：
 *   1. 它们是几百 KB 的库 + 字体文件，要 CDN 或打包。这个项目的承诺是
 *      **零构建、零 CDN、离线可用**。为了渲染公式破坏这三条不值得。
 *   2. 我们不需要出版级排版。需要的是"普通人能看懂"。
 *      一个分数显示成 `(a) / (b)` 完全够用，甚至比竖式分数更好读。
 *
 * 所以这里做**保守转换**：认识常见记号，不认识的**原样保留 LaTeX**。
 * 原样保留比渲染错好 —— 用户至少能把它粘到别处去看。
 *
 * ⚠️ 输入必须是**已转义的 HTML**（调用方先 escapeHtml）。
 * 这个模块只负责插标签，绝不做转义 —— 两件事分开才不会漏。
 * ══════════════════════════════════════════════════════════════════
 */

/** 希腊字母 → 符号（普通人认得 α β π，比 `\alpha` 友好） */
const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

/** 运算符 / 关系符 → 符号 */
const SYMBOLS = {
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
  equiv: '≡', propto: '∝', infty: '∞', partial: '∂', nabla: '∇',
  sum: '∑', prod: '∏', int: '∫', oint: '∮',
  forall: '∀', exists: '∃', in: '∈', notin: '∉', subset: '⊂', supset: '⊃',
  cup: '∪', cap: '∩', emptyset: '∅', therefore: '∴', because: '∵',
  rightarrow: '→', to: '→', leftarrow: '←', Rightarrow: '⇒', Leftrightarrow: '⇔',
  leftrightarrow: '↔', mapsto: '↦',
  ldots: '…', cdots: '⋯', dots: '…',
  angle: '∠', perp: '⊥', parallel: '∥', triangle: '△', square: '□',
  degree: '°', prime: '′', circ: '∘',
};

/**
 * 把一段 LaTeX 转成可读 HTML。
 *
 * @param {string} tex **已 escapeHtml** 的 LaTeX 源
 * @returns {string} HTML（只含我们插入的标签，文本部分已由调用方转义）
 */
export function texToHtml(tex) {
  let s = String(tex ?? '').trim();
  if (!s) return '';

  // 1) 去掉排版指令（它们只影响间距，删掉不影响可读性）
  // 用 [A-Za-z]* 收尾而不是 \b —— \b 在 \( 这类"命令名后面跟符号"的写法上不成立，
  // 而且 `\b?` 是非法量词（Nothing to repeat），V8 会直接抛语法错误。
  // 这里匹配"反斜杠 + 命令名 + 后面的空白"，包括 \left( 这种（空白可能没有）。
  s = s.replace(/\\(?:displaystyle|textstyle|scriptstyle|limits|nolimits|left|right|quad|qquad)\s*/g, ' ');
  // 转义的特殊字符：`\%` → `%`、`\&` → `&`、`\_` → `_`。
  // 注意这里面**不能**包括 `\,` `\;` `\:` —— 那几个是"加一点间距"，
  // 显示成空格更自然；而 `\%` 是要保留符号本身的。
  s = s.replace(/\\([%&#_$])/g, '$1');
  s = s.replace(/\\(?:[!,;:])/g, ' ');

  // 2) \text{...} / \mathrm{...} / \operatorname{...} → 直接取里面的字
  s = s.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname|mbox)\s*\{([^{}]*)\}/g, '$1');

  // 3) 分数：\frac{a}{b} / \dfrac / \tfrac → (a)/(b)，多层时递归处理
  //    普通人对"a 除以 b"的读法就是斜杠，比竖式分数更直白。
  s = replaceWithBraces(s, /\\(?:frac|dfrac|tfrac)\s*\{/, (parts) => {
    if (parts.length < 2) return null;
    const num = texToHtml(parts[0]);
    const den = texToHtml(parts[1]);
    const wrap = (x) => (/^[\w.]+$/.test(x.replace(/<[^>]+>/g, '')) ? x : `(${x})`);
    return `<span class="tex-frac">${wrap(num)}</span><span class="tex-sep">/</span><span class="tex-frac">${wrap(den)}</span>`;
  });

  // 4) 根号
  s = s.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, (m, n, body) => `<sup>${n}</sup>√(${texToHtml(body)})`);
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, (m, body) => `√(${texToHtml(body)})`);

  // 5) 上标 / 下标：x^{2} 、x^2 、x_{i}
  s = s.replace(/\^\s*\{([^{}]*)\}/g, (m, body) => `<sup>${texToHtml(body)}</sup>`);
  s = s.replace(/\^\s*([0-9A-Za-z+\-])/g, (m, c) => `<sup>${c}</sup>`);
  s = s.replace(/_\s*\{([^{}]*)\}/g, (m, body) => `<sub>${texToHtml(body)}</sub>`);
  s = s.replace(/_\s*([0-9A-Za-z+\-])/g, (m, c) => `<sub>${c}</sub>`);

  // 6) 符号与希腊字母
  s = s.replace(/\\([A-Za-z]+)\b/g, (m, name) => {
    if (GREEK[name]) return GREEK[name];
    if (SYMBOLS[name]) return SYMBOLS[name];
    // 不认识的命令：保留命令名（去掉反斜杠），比留一串反斜杠好读
    return name;
  });

  // 7) 大括号只用于分组，显示时去掉
  s = s.replace(/[{}]/g, '');

  // 8) 压缩多余空白
  s = s.replace(/\s{2,}/g, ' ').trim();

  return s;
}

/**
 * 处理 `\cmd{a}{b}` 这种"一个命令吃两个花括号参数"的情况（`\frac` 就是这样）。
 *
 * ⚠️ 这里踩过一个坑，值得记下来：
 * 匹配模式里已经包含了开括号（`/\\frac\s*\{/`），所以 match 结束后**光标正好落在
 * 第一个花括号的内容起点**。我第一版还在检查"下一个字符是不是 `{`"，
 * 于是永远判定失败，`\frac{a}{b}` 原样变成了 `fracab`（命令名被当普通文本留下、
 * 花括号被最后一步删掉）—— 看起来"没崩"，其实完全没渲染。
 *
 * @param {string} src
 * @param {RegExp} opener 匹配"命令名 + 第一个开括号"（开括号在 match 末尾）
 * @param {(groups:string[]) => string|null} build 返回 null 表示放弃转换、保留原文
 */
function replaceWithBraces(src, opener, build) {
  let out = '';
  let i = 0;
  const re = new RegExp(opener.source, 'g');

  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, m.index);

    // 开括号已被 m[0] 吃掉，光标在第一个参数的内容起点
    let cursor = m.index + m[0].length;
    const groups = [];
    let ok = true;
    for (let g = 0; g < 2; g += 1) {
      // 第 0 个参数：开括号已被 m[0] 吃掉，所以内容起点就是 cursor，
      //   但 matchBrace 需要**开括号的位置**去数括号深度 → cursor - 1。
      // 第 1 个参数：cursor 还停在 '}' 之后的空白上，
      //   先跳过空白，跳过一个 '{'，此时 cursor 指向内容起点；
      //   matchBrace 需要的开括号位置就是 cursor - 1。
      //
      // ⚠️ 这里我踩过一个很隐蔽的坑：第 1 个参数我错写成了 `cursor - 0`，
      // 也就是把**开括号的位置**当成内容起点传进去。matchBrace 从那里开始数括号，
      // 数到的是 `{a}` 而不是 `{b}` —— 结果是它返回了**第一个**闭括号之后的位置，
      // 切出来的内容多了一个字符，然后 ok=false 整段放弃，`\frac{a}{b}` 原样留下。
      // 最终显示成 `fracab`（命令名被当普通文本留下、花括号被最后一步删掉），
      // 看起来"没报错"，其实完全没渲染。
      if (g > 0) {
        while (cursor < src.length && /\s/.test(src[cursor])) cursor += 1;
        if (src[cursor] !== '{') { ok = false; break; }
        cursor += 1;
      }
      const end = matchBrace(src, cursor - 1);
      if (end < 0) { ok = false; break; }
      groups.push(src.slice(cursor, end));
      cursor = end + 1;
    }

    if (!ok) {
      out += src.slice(m.index, cursor);
      i = cursor;
      continue;
    }
    const built = build(groups);
    if (built === null || built === undefined) {
      out += src.slice(m.index, cursor);
    } else {
      out += built;
    }
    i = cursor;
  }
  return out;
}

/** 找与 src[openIndex] 的 `{` 配对的 `}`，返回其下标；找不到返回 -1 */
function matchBrace(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; } // 跳过转义字符
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 从已转义文本里抽出数学片段，替换成占位符。
 *
 * 支持的定界符（按优先级）：
 *   $$...$$   块级公式
 *   \[...\]   块级公式
 *   \(...\)   行内公式
 *   $...$     行内公式（**要小心**：金额 "$5"、"$100" 不能被当成公式）
 *
 * ⚠️ 关于 `$` 的误判：中文内容里 `$` 主要出现在"美元金额"和"代码"里。
 * 所以对 `$...$` 加了三重限制，见 isLikelyMoneyOrNoise。
 *
 * @param {string} escaped 已 escapeHtml 的文本
 * @param {{blocks:string[], spans:string[]}} tables 占位符表
 * @param {string} MARKER 占位符字符
 * @returns {string}
 */
export function extractMath(escaped, tables, MARKER) {
  let s = String(escaped ?? '');

  // 1) 块级：$$...$$ 与 \[...\]
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, body) => {
    const html = texToHtml(body);
    if (!html) return m;
    // ⚠️ 用 'b'（blocks 表）而不是自定义的 'm' ——
    // ui.js 的 restorePlaceholders 只认 `\uE000[bc]\d+\uE000` 两种前缀，
    // 用 'm' 的话占位符永远不会被还原，用户会看到字面的 "m0"。
    // 这类"自己发明了一种标记但还原器不认识"的 bug 特别隐蔽：
    // 渲染不报错，只是内容消失了。
    const ph = MARKER + 'b' + tables.blocks.length + MARKER;
    tables.blocks.push(`<span class="tex-block">${html}</span>`);
    return ph;
  });
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m, body) => {
    const html = texToHtml(body);
    if (!html) return m;
    // ⚠️ 用 'b'（blocks 表）而不是自定义的 'm' ——
    // ui.js 的 restorePlaceholders 只认 `\uE000[bc]\d+\uE000` 两种前缀，
    // 用 'm' 的话占位符永远不会被还原，用户会看到字面的 "m0"。
    // 这类"自己发明了一种标记但还原器不认识"的 bug 特别隐蔽：
    // 渲染不报错，只是内容消失了。
    const ph = MARKER + 'b' + tables.blocks.length + MARKER;
    tables.blocks.push(`<span class="tex-block">${html}</span>`);
    return ph;
  });

  // 2) \(...\)：明确是公式，直接转
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, body) => {
    const html = texToHtml(body);
    if (!html) return m;
    // 行内公式用 'c'（spans 表）
    const ph = MARKER + 'c' + tables.spans.length + MARKER;
    tables.spans.push(`<span class="tex-inline">${html}</span>`);
    return ph;
  });

  // 3) $...$：只在"看起来确实是公式"时转
  s = s.replace(/\$([^$\n]{1,200})\$/g, (whole, body) => {
    if (!looksLikeFormula(body)) return whole;
    const html = texToHtml(body);
    if (!html || html === body.trim()) return whole; // 没转出任何东西就别动
    // 行内公式用 'c'（spans 表）
    const ph = MARKER + 'c' + tables.spans.length + MARKER;
    tables.spans.push(`<span class="tex-inline">${html}</span>`);
    return ph;
  });

  return s;
}

/**
 * 判断 `$...$` 里的内容是不是真公式（而不是美元金额）。
 *
 * 判定规则（宁可漏判，不可误判 —— 误判会把 "$100 到 $200" 渲染成一段乱码）：
 *  · 纯数字/千分位/小数 + 可选"元/万/亿" → 是金额，不转
 *  · 含 LaTeX 特征（反斜杠命令、^、_、{}）→ 是公式
 *  · 含数学运算符（= + - × / < > ≤ ≥ 括号）且含字母 → 是公式
 *  · 其他 → 不转（保守）
 */
export function looksLikeFormula(body) {
  const s = String(body ?? '').trim();
  if (!s) return false;
  // 金额：100 / 1,000 / 12.5 / 100万
  if (/^[\d,.\s]+(元|万|亿|块|美元)?$/.test(s)) return false;
  // 明确的 LaTeX 特征
  if (/\\[A-Za-z]+|\^|_|\{|\}/.test(s)) return true;
  // 数学运算符 + 至少一个字母（a+b、x = 2y、P(A|B)）
  if (/[A-Za-z]/.test(s) && /[=+\-*/<>±×÷≤≥≠√∑∫()（）]/.test(s)) return true;
  // 单个字母（x、n）也算 —— 常见于正文里的变量
  if (/^[A-Za-z]$/.test(s)) return true;
  return false;
}
