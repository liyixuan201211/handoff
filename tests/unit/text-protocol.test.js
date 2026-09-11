/**
 * 长文本协议解析器的单元测试。
 *
 * 这个解析器是「交付物能不能成型」的最后一道关口，而且它的输入是
 * 一个不太听话的模型的自由文本输出。所以这里的用例要**故意刁难它**：
 * 漏 END、中文引号、无引号属性、大小写混乱、多余空白、模型固执地输出 JSON……
 */
import { describe, it, expect } from 'vitest';
import {
  parseArtifactBlocks,
  parseIssueBlocks,
  ARTIFACT_PROTOCOL_SPEC,
  CRITIQUE_PROTOCOL_SPEC,
} from '../../src/llm/text-protocol.js';

const wrap = (block) => `${ARTIFACT_PROTOCOL_SPEC}\n${block}`;

describe('parseArtifactBlocks —— 标准用法', () => {
  it('单个块，正文与假设都能正确切出来', () => {
    const text = `<<<ARTIFACT id="risk-list" confidence="high">>>
# 风险清单

- 押金偏高

第二段内容，用来超过长度阈值。
<<<ASSUMPTIONS>>>
- 假定你是承租方
- 假定合同为中文
<<<END>>>`;
    const r = parseArtifactBlocks(text);
    expect(r.found).toBe(true);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].deliverableId).toBe('risk-list');
    expect(r.blocks[0].confidence).toBe('high');
    expect(r.blocks[0].content).toContain('# 风险清单');
    expect(r.blocks[0].content).toContain('第二段内容');
    // 假设段不能混进正文
    expect(r.blocks[0].content).not.toContain('假定你是承租方');
    expect(r.blocks[0].assumptions).toEqual(['假定你是承租方', '假定合同为中文']);
  });

  it('两个块，id 与正文各自独立（不能串）', () => {
    const text = `<<<ARTIFACT id="a" confidence="high">>>
第一份的正文 AAA
<<<END>>>
<<<ARTIFACT id="b" confidence="low">>>
第二份的正文 BBB
<<<END>>>`;
    const r = parseArtifactBlocks(text);
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[0].deliverableId).toBe('a');
    expect(r.blocks[0].content).toBe('第一份的正文 AAA');
    expect(r.blocks[0].confidence).toBe('high');
    expect(r.blocks[1].deliverableId).toBe('b');
    expect(r.blocks[1].content).toBe('第二份的正文 BBB');
    expect(r.blocks[1].confidence).toBe('low');
  });

  it('<<<END>>> 之后的文字不能混进正文（END 就是硬切点）', () => {
    // 这是真实会遇到的情况：模型写完了还多一句"以上就是全部内容"。
    // 那句话绝不能进交付物 —— 用户看到会莫名其妙。
    const text = `好的，我来写。
<<<ARTIFACT id="a">>>
正文
<<<END>>>
以上就是全部内容。`;
    const r = parseArtifactBlocks(text);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].content).toBe('正文');
    expect(r.blocks[0].content).not.toContain('以上就是全部内容');
    expect(r.rest).not.toContain('正文');
    expect(r.rest).toContain('好的，我来写');
  });

  it('markdown 里的特殊字符原样保留（这是不用 JSON 的全部意义）', () => {
    const body = [
      '# 标题',
      '',
      '```js',
      'const x = "带引号的字符串";',
      '```',
      '',
      '| 列 A | 列 B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '> 引用，含 **粗体** 和 `行内代码`',
      '',
      '反斜杠 \\ 和美元 $ 和百分号 %',
    ].join('\n');
    const r = parseArtifactBlocks(`<<<ARTIFACT id="x">>>\n${body}\n<<<END>>>`);
    expect(r.blocks[0].content).toBe(body);
  });
});

describe('parseArtifactBlocks —— 模型不听话时的容错', () => {
  it('漏写 <<<END>>> 也能切出来', () => {
    const r = parseArtifactBlocks(`<<<ARTIFACT id="a">>>\n正文内容\n`);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].content).toBe('正文内容');
  });

  it('中文引号包属性也认', () => {
    const r = parseArtifactBlocks(`<<<ARTIFACT id=“risk-list” confidence=“high”>>>\n正文\n<<<END>>>`);
    expect(r.blocks[0].deliverableId).toBe('risk-list');
    expect(r.blocks[0].confidence).toBe('high');
  });

  it('属性不加引号也认', () => {
    const r = parseArtifactBlocks(`<<<ARTIFACT id=risk-list confidence=high>>>\n正文\n<<<END>>>`);
    expect(r.blocks[0].deliverableId).toBe('risk-list');
    expect(r.blocks[0].confidence).toBe('high');
  });

  it('标签内有空格、大小写混乱、缺属性，都不崩', () => {
    const r = parseArtifactBlocks(`< < < ARTIFACT id="a" > > >\n正文\n< < < END > > >`);
    // 允许这种写法解析不出块（返回 found:false），但**绝不能抛异常**
    expect(() => parseArtifactBlocks(`< < < ARTIFACT > > >`)).not.toThrow();
    expect(Array.isArray(r.blocks)).toBe(true);
  });

  it('confidence 非法值 → 回落成 medium（而不是丢掉整块）', () => {
    const r = parseArtifactBlocks(`<<<ARTIFACT id="a" confidence="非常高">>>\n正文\n<<<END>>>`);
    expect(r.blocks[0].confidence).toBe('medium');
  });

  it('confidence 大写 → 归一成小写', () => {
    const r = parseArtifactBlocks(`<<<ARTIFACT id="a" confidence="HIGH">>>\n正文\n<<<END>>>`);
    expect(r.blocks[0].confidence).toBe('high');
  });

  it('完全没有定界符 → found:false，rest 是原文（调用方据此走退路）', () => {
    const r = parseArtifactBlocks('# 直接就是 markdown 正文\n\n没有任何定界符。');
    expect(r.found).toBe(false);
    expect(r.blocks).toHaveLength(0);
    expect(r.rest).toContain('直接就是 markdown 正文');
  });

  it('空输入、null、undefined 都不崩', () => {
    for (const input of ['', null, undefined, 0, false]) {
      expect(() => parseArtifactBlocks(input)).not.toThrow();
      expect(parseArtifactBlocks(input).blocks).toEqual([]);
    }
  });

  it('CRLF 换行也能处理（有些模型会输出 \\r\\n）', () => {
    const r = parseArtifactBlocks('<<<ARTIFACT id="a">>>\r\n第一行\r\n第二行\r\n<<<END>>>');
    expect(r.blocks[0].content).toBe('第一行\n第二行');
  });

  it('假设段的圆点/数字/星号列表标记都能剥掉', () => {
    const r = parseArtifactBlocks(
      `<<<ARTIFACT id="a">>>\n正文\n<<<ASSUMPTIONS>>>\n- 一\n* 二\n1. 三\n2、四\n· 五\n<<<END>>>`,
    );
    expect(r.blocks[0].assumptions).toEqual(['一', '二', '三', '四', '五']);
  });

  it('假设段为空 → assumptions 是空数组，不是 [""]', () => {
    const r = parseArtifactBlocks(`<<<ARTIFACT id="a">>>\n正文\n<<<ASSUMPTIONS>>>\n\n<<<END>>>`);
    expect(r.blocks[0].assumptions).toEqual([]);
  });
});

describe('parseIssueBlocks —— 审查意见', () => {
  it('标准格式：问题 + 怎么改 + 严重度 + 位置', () => {
    const text = `<<<ISSUE severity="high" where="风险清单第 2 段">>>
问题：这句话是空话，没有任何信息量
怎么改：删掉，或者改成具体数字
<<<END>>>
<<<ISSUE severity="low">>>
问题：错别字
怎么改：把"的"改成"得"
<<<END>>>
<<<OVERALL>>>
整体能用，但空话偏多。
<<<END>>>`;
    const r = parseIssueBlocks(text);
    expect(r.issues).toHaveLength(2);
    expect(r.issues[0].severity).toBe('high');
    expect(r.issues[0].where).toBe('风险清单第 2 段');
    expect(r.issues[0].problem).toContain('空话');
    expect(r.issues[0].fix).toContain('删掉');
    expect(r.issues[1].severity).toBe('low');
    expect(r.overall).toContain('整体能用');
  });

  it('英文标签也认（problem / fix / 建议）', () => {
    const text = `<<<ISSUE severity="medium">>>
problem: The second paragraph is vague
fix: Replace it with concrete numbers
<<<END>>>`;
    const r = parseIssueBlocks(text);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].problem).toContain('vague');
    expect(r.issues[0].fix).toContain('concrete');
  });

  it('严重度用中文/大写/近义词都能映射', () => {
    const cases = [
      ['严重', 'high'],
      ['critical', 'high'],
      ['HIGH', 'high'],
      ['中等', 'medium'],
      ['minor', 'low'],
      ['轻微', 'low'],
      ['乱七八糟', 'medium'],
    ];
    for (const [raw, expected] of cases) {
      const r = parseIssueBlocks(`<<<ISSUE severity="${raw}">>>\n问题：x\n怎么改：y\n<<<END>>>`);
      expect(r.issues[0].severity, `severity=${raw}`).toBe(expected);
    }
  });

  it('没写「怎么改」时，用问题本身兜底（不能让 fix 是空的）', () => {
    const r = parseIssueBlocks(`<<<ISSUE severity="high">>>\n问题：这里漏了押金退还时间\n<<<END>>>`);
    expect(r.issues[0].fix).toBeTruthy();
  });

  it('一个问题都没有 → 空数组（调用方据此记 warn，不影响交付）', () => {
    const r = parseIssueBlocks('内容很好，没问题。');
    expect(r.issues).toEqual([]);
  });

  it('空输入不崩', () => {
    for (const input of ['', null, undefined]) {
      expect(() => parseIssueBlocks(input)).not.toThrow();
      expect(parseIssueBlocks(input).issues).toEqual([]);
    }
  });

  it('问题/怎么改过长时被截断到 400 字以内（防止把 SSE 撑爆）', () => {
    const long = '啊'.repeat(2000);
    const r = parseIssueBlocks(`<<<ISSUE severity="high">>>\n问题：${long}\n怎么改：${long}\n<<<END>>>`);
    expect(r.issues[0].problem.length).toBeLessThanOrEqual(400);
    expect(r.issues[0].fix.length).toBeLessThanOrEqual(400);
  });
});

describe('协议说明文本本身', () => {
  it('ARTIFACT_PROTOCOL_SPEC 里含模型必须抄的定界符', () => {
    expect(ARTIFACT_PROTOCOL_SPEC).toContain('<<<ARTIFACT');
    expect(ARTIFACT_PROTOCOL_SPEC).toContain('<<<END>>>');
    expect(ARTIFACT_PROTOCOL_SPEC).toContain('confidence');
  });
  it('CRITIQUE_PROTOCOL_SPEC 里含模型必须抄的定界符', () => {
    expect(CRITIQUE_PROTOCOL_SPEC).toContain('<<<ISSUE');
    expect(CRITIQUE_PROTOCOL_SPEC).toContain('<<<OVERALL>>>');
  });
  it('协议说明不要出现 markdown 代码围栏（会被模型照抄进正文）', () => {
    expect(ARTIFACT_PROTOCOL_SPEC).not.toContain('```');
    expect(CRITIQUE_PROTOCOL_SPEC).not.toContain('```');
  });
  it('用 wrap() 拼出来的提示词是合法的（防止结构写错）', () => {
    expect(wrap('<<<ARTIFACT id="a">>>正文<<<END>>>')).toContain('<<<ARTIFACT');
  });
});
