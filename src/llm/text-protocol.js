/**
 * 长文本协议 —— 为什么不用 JSON 传输交付物正文？
 *
 * 实测数据（2026-09-12，真实 API）：
 *   让模型把 2000 字中文 markdown 塞进 JSON 字符串字段里，失败率高得离谱。
 *   原因很实在：正文里全是换行、引号、星号、列表符号，模型要在几千个字里
 *   一个不漏地做转义。任何一处漏转义 → JSON.parse 失败 → 重试 → 换模型
 *   → 一个阶段跑 100~300 秒。对普通人来说就是「它卡住了」。
 *
 * 结论：**正文走纯文本，元数据走 JSON。**
 * 模型写 markdown 时最自然（它训练时就是这么写的），我们用明确的定界符切回来。
 *
 * 协议（模型只需照着抄）：
 *
 *   <<<ARTIFACT id="risk-list" confidence="high">>>
 *   （这里直接写 markdown 正文，想怎么写就怎么写）
 *   <<<ASSUMPTIONS>>>
 *   - 假设一
 *   - 假设二
 *   <<<END>>>
 *
 *   多个交付物就重复上面的块。
 *
 * 这个解析器必须是纯函数、可单测、并且**对模型的小幅不听话足够宽容** ——
 * 模型偶尔会漏写 END、把 id 写成中文引号、少写一个 >。这些都要能救回来。
 */

/**
 * 定界符正则。
 *
 * ⚠️ 坑记录（被单测抓出来的真实 bug）：
 * 里面**不能**用 `\s*`，因为 `\s` 包含换行 —— `<<<END>>>` 前面的换行会被一起吞掉，
 * 于是「本块的结束位置」算早一个字符，块内正文尾巴就漏进 `rest`，
 * 表现为「正文里莫名其妙多了一段块外文字」。
 * 这里只用 `[ \t]*`，绝不跨行。
 */
const BLOCK_OPEN = /<<<[ \t]*ARTIFACT\b([^>]*)>>>/gi;
const BLOCK_END = /<<<[ \t]*(?:END|结束)[ \t]*>>>/gi;
const ASSUMPTIONS = /<<<[ \t]*ASSUMPTIONS[ \t]*>>>/gi;

/** 从属性串里取 key="value"（容忍中文引号、无引号、单引号） */
function readAttr(attrs, name) {
  const re = new RegExp(
    `${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|([^\\s>]+))`,
    'i',
  );
  const m = attrs.match(re);
  if (!m) return null;
  const v = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
  return v || null;
}

/** 把一段文本按行切成假设列表 */
function parseBullets(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*·]|\d+[.、)])\s*/, '').trim())
    .filter((l) => l.length > 0);
}

/**
 * 解析长文本协议。
 * @returns {{ blocks: Array<{deliverableId:string|null, confidence:string, content:string, assumptions:string[]}>, rest: string }}
 *          rest = 定界符之外的内容（理论上应该是空的；非空说明模型没按格式写，
 *          调用方可以据此决定要不要退回 JSON 模式）
 */
export function parseArtifactBlocks(text) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const blocks = [];

  // 找出所有 ARTIFACT 开标签的位置
  const opens = [];
  BLOCK_OPEN.lastIndex = 0;
  let m;
  while ((m = BLOCK_OPEN.exec(src)) !== null) {
    opens.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] ?? '' });
  }

  if (opens.length === 0) {
    return { blocks: [], rest: src.trim(), found: false };
  }

  const consumed = [];
  for (let i = 0; i < opens.length; i += 1) {
    const open = opens[i];
    const nextOpen = opens[i + 1]?.start ?? src.length;
    const raw = src.slice(open.end, nextOpen);
    let body = raw;

    // 本块的 END 标记在哪？（相对 raw 的偏移）
    BLOCK_END.lastIndex = 0;
    const endMatch = BLOCK_END.exec(raw);

    // 块内的有效内容 = END 之前的部分。
    //
    // ⚠️ END 是**硬切点**。教训来自单测：一开始只把 END 标记本身 replace 掉，
    // 结果模型写在标记之后的那句"以上就是全部内容"被当成了正文的一部分，
    // 用户打开交付物会看到一句莫名其妙的话。所以这里直接按位置截断。
    if (endMatch) body = raw.slice(0, endMatch.index);

    // 块内可能有 ASSUMPTIONS 段
    let assumptions = [];
    ASSUMPTIONS.lastIndex = 0;
    const aIdx = body.search(ASSUMPTIONS);
    if (aIdx >= 0) {
      const afterMarker = body.slice(aIdx).replace(ASSUMPTIONS, '');
      assumptions = parseBullets(afterMarker);
      body = body.slice(0, aIdx);
    }

    const content = body.trim().replace(/^\n+|\n+$/g, '');
    const confidenceRaw = readAttr(open.attrs, 'confidence');
    const confidence =
      confidenceRaw && ['high', 'medium', 'low'].includes(confidenceRaw.toLowerCase())
        ? confidenceRaw.toLowerCase()
        : 'medium';

    blocks.push({
      deliverableId: readAttr(open.attrs, 'id') ?? readAttr(open.attrs, 'deliverableId'),
      confidence,
      content,
      assumptions,
    });

    // ⚠️ 边界必须算到**真正属于本块**的结束位置，否则块内正文会漏进 rest。
    const blockEnd = endMatch ? open.end + endMatch.index + endMatch[0].length : nextOpen;
    consumed.push([open.start, Math.min(blockEnd, nextOpen)]);
  }

  // rest = 所有块之外的内容
  let rest = '';
  let cursor = 0;
  for (const [s, e] of consumed) {
    rest += src.slice(cursor, s);
    cursor = e;
  }
  rest += src.slice(cursor);

  return { blocks, rest: rest.replace(BLOCK_END, '').trim(), found: true };
}

/** 问模型要这种格式的提示词片段（附在 system 后面） */
export const ARTIFACT_PROTOCOL_SPEC = `
<输出格式>
你不用输出 JSON。请直接按下面的格式写，正文就是 markdown，想怎么写就怎么写：

<<<ARTIFACT id="交付物的id" confidence="high">>>
（这里直接写这个交付物的 markdown 正文）
<<<ASSUMPTIONS>>>
- 这份内容依赖的假设，一条一行
<<<END>>>

每个交付物写一个这样的块，顺序与上面列出的交付物一致。
id 必须用我上面方括号里给的那个 id。confidence 只能填 high、medium、low。
正文写完后必须有 <<<END>>>。不要输出任何解释性的话，也不要用 JSON。
**每一份都要写完整，不能写到一半就停。宁可每份写得简短些，也不要有一份缺半截。**
</输出格式>`;

/**
 * 猜一段落是不是被截断了。
 *
 * 为什么需要：模型输出撞到 max_tokens 上限时，会在**半句话中间**停住。
 * 这种残缺内容如果直接交付，用户看到的是"突然没了"的文档 —— 比报错更让人困惑。
 * 宁可检测出来重试，也不要交一份断一半的东西。
 */
export function looksTruncated(text) {
  const s = String(text ?? '').trimEnd();
  if (s.length < 40) return false;
  const tail = s.slice(-60);
  // 结尾是个明显的未完成标记
  if (/[，,、：:（(【\[]$/.test(s)) return true;
  if (/\|\s*$/.test(s)) return true; // markdown 表格断了
  // 结尾是标题或列表项开头，后面没内容
  if (/(?:^|\n)#{1,6}\s*[^\n]{0,40}$/.test(s)) return true;
  if (/(?:^|\n)\s*[-*]\s*$/.test(s)) return true;
  // 结尾没有句末标点，且最后一行偏短（像是被切断的从句）
  const lastLine = s.split('\n').at(-1) ?? '';
  if (
    lastLine.length > 0 &&
    lastLine.length < 40 &&
    !/[。！？.!?）)】」》…"'\]]$/.test(s) &&
    !/^[-*|>#`]/.test(lastLine) &&
    /[\u4e00-\u9fa5]/.test(lastLine)
  ) {
    return true;
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────
 * 复审协议（审查员 / 质检员也用文本，避免长正文进 JSON）
 * ──────────────────────────────────────────────────────────────── */

/**
 * 解析「挑毛病」的文本输出。
 *   <<<ISSUE severity="high" where="风险清单">>>
 *   问题：……
 *   怎么改：……
 *   <<<END>>>
 *   <<<OVERALL>>>
 *   一句话总评
 */
export function parseIssueBlocks(text) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const issues = [];
  const re = /<<<[ \t]*ISSUE\b([^>]*)>>>([\s\S]*?)(?=<<<[ \t]*(?:ISSUE|OVERALL)\b|$)/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const attrs = m[1] ?? '';
    const body = (m[2] ?? '').replace(/<<<[ \t]*END[ \t]*>>>/gi, '').trim();
    const problemMatch = body.match(/(?:问题|problem)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:怎么改|fix|建议)\s*[:：]|$)/i);
    const fixMatch = body.match(/(?:怎么改|fix|建议)\s*[:：]\s*([\s\S]*)$/i);
    const severityRaw = (readAttr(attrs, 'severity') ?? 'medium').toLowerCase();
    const severity = ['high', 'medium', 'low'].includes(severityRaw)
      ? severityRaw
      : /严重|高|critical|high/.test(severityRaw)
        ? 'high'
        : /轻微|低|low|minor/.test(severityRaw)
          ? 'low'
          : 'medium';
    const problem = (problemMatch?.[1] ?? body).trim();
    const fix = (fixMatch?.[1] ?? '').trim();
    if (problem || fix) {
      issues.push({
        severity,
        where: readAttr(attrs, 'where') ?? '',
        problem: problem.slice(0, 400),
        fix: (fix || problem).slice(0, 400),
      });
    }
  }
  const overall =
    src.match(/<<<[ \t]*OVERALL[ \t]*>>>([\s\S]*?)(?=<<<|$)/i)?.[1]?.replace(/<<<[ \t]*END[ \t]*>>>/gi, '').trim() ??
    '';
  return { issues, overall: overall.slice(0, 500) };
}

export const CRITIQUE_PROTOCOL_SPEC = `
<输出格式>
你不用输出 JSON。请按下面的格式写：

<<<ISSUE severity="high" where="哪份交付物的哪一段">>>
问题：具体是什么毛病
怎么改：具体怎么改
<<<END>>>

每个问题写一个块，问题多的写 5-10 个，少的写 1-3 个。
没问题的就一个块都不写。
最后写一段总评：

<<<OVERALL>>>
一两句话说清整体水平
<<<END>>>

不要输出任何解释性的话，也不要用 JSON。
</输出格式>`;

export const __internals = { readAttr, parseBullets };
