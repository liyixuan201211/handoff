/**
 * 从模型输出里抢救出 JSON。
 *
 * 真实世界的模型会给你这些花样：
 *   ```json\n{...}\n```      围栏
 *   "好的，这是结果：{...}"   前后废话
 *   {...,}                    尾逗号
 *   {...                      被 max_tokens 截断（缺右括号）
 *
 * 这个模块是纯函数，必须能被单测全覆盖 —— 它是整条流水线最脆弱的一环。
 */

/** 去掉 ``` 围栏 */
export function stripFence(text) {
  let s = String(text ?? '').trim();
  const fence = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/;
  const m = s.match(fence);
  if (m) return m[1].trim();
  // 只有开头围栏没有结尾（被截断）
  const openOnly = s.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*)$/);
  if (openOnly) return openOnly[1].trim();
  return s;
}

/** 取第一个 { / [ 到最后一个对应闭合符之间的内容 */
export function extractBalanced(text) {
  const s = String(text ?? '');
  const startObj = s.indexOf('{');
  const startArr = s.indexOf('[');
  let start = -1;
  let open = '';
  let close = '';
  if (startObj === -1 && startArr === -1) return null;
  if (startObj === -1 || (startArr !== -1 && startArr < startObj)) {
    start = startArr;
    open = '[';
    close = ']';
  } else {
    start = startObj;
    open = '{';
    close = '}';
  }

  // 逐字符扫描，跳过字符串内部（含转义），保证嵌套正确
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  // 没闭合：返回从 start 到结尾，交给修复阶段补括号
  return s.slice(start);
}

/** 常见脏数据的机械修复 */
export function mechanicalFix(text) {
  let s = String(text ?? '');
  // 中文全角标点当结构符
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // 去掉 JSON 里不允许的注释
  s = s.replace(/^\s*\/\/.*$/gm, '');
  // 尾逗号
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Python 风格的字面量
  s = s.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
  // 单引号键 → 双引号（保守：只处理 key 位置）
  s = s.replace(/([{,]\s*)'([^'\n]+)'(\s*:)/g, '$1"$2"$3');
  return s;
}

/** 补齐未闭合的括号/引号 */
export function closeOpenStructures(text) {
  const s = String(text ?? '');
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  if (inString) out += '"';
  // 若以逗号结尾，先去掉再补闭合
  out = out.replace(/,\s*$/, '');
  while (stack.length) out += stack.pop();
  return out;
}

/**
 * 主入口：尽最大努力把一段模型文本变成对象。
 * @returns {{ok:true, value:any, strategy:string} | {ok:false, raw:string, error:string}}
 */
export function repairJson(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { ok: false, raw, error: '模型返回了空内容' };

  const attempts = [
    ['direct', () => raw.trim()],
    ['strip-fence', () => stripFence(raw)],
    ['extract-balanced', () => extractBalanced(stripFence(raw))],
    ['mechanical-fix', () => mechanicalFix(extractBalanced(stripFence(raw)) ?? stripFence(raw))],
    [
      'close-structures',
      () =>
        closeOpenStructures(
          mechanicalFix(extractBalanced(stripFence(raw)) ?? stripFence(raw)),
        ),
    ],
  ];

  let lastError = '未知解析错误';
  for (const [strategy, produce] of attempts) {
    let candidate;
    try {
      candidate = produce();
    } catch {
      continue;
    }
    if (candidate === null || candidate === undefined) continue;
    try {
      const value = JSON.parse(candidate);
      return { ok: true, value, strategy };
    } catch (e) {
      lastError = e.message;
    }
  }
  return { ok: false, raw, error: lastError };
}
