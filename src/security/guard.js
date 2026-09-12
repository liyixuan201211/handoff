/**
 * [S6] 安全防线 —— 输入净化 / 提示词注入检测 / 输出审计
 *
 * 设计哲学（写给未来的维护者，也写给普通人）：
 *   我们的用户是不懂技术的普通人。他们会把合同、病历、成绩单、网上抄来的"提示词"
 *   整段粘进输入框。绝大多数情况下，那些看起来像攻击的文字，只是他们**引用**的内容。
 *
 *   所以本模块的第一原则是：**挡住风险，但绝不挡用户的路。**
 *   - 注入特征 → 记录 + 加强隔离，**不阻断**
 *   - 超长输入 → 截断 + 记录，**不阻断**
 *   - 疑似身份证/手机号/密钥 → 打码后记录（level=notice），**不阻断、不删用户内容**
 *   - 只有一种情况 blocked：「什么产出都没有」
 *
 * 本文件是纯确定性代码，不调用模型，不读环境变量，不做任何 I/O。
 */

import { looksLikeSecret, redactSecrets } from '../llm/errors.js';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** goal 的默认长度上限，与 docs/CONTRACT.md §2 保持一致（1..4000） */
export const DEFAULT_MAX_LENGTH = 4000;

/** 非 goal 字段（如粘贴的合同正文）允许更长 */
export const LONG_FIELD_MAX_LENGTH = 20000;

/** 「完全没有产出」的判定阈值：每个产物内容都短于这个长度 */
export const MIN_ARTIFACT_LENGTH = 80;

/** 零宽 / 方向控制字符：常被用来把关键词拆开以绕过检测 */
const ZERO_WIDTH_RE = /[\u200B-\u200D\u200E\u200F\u2060-\u2064\uFEFF]/g;

/** 控制字符（保留 \t \n \r，它们是正常排版） */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * 用 `<|` 打断特殊 token 的字节序列。零宽空格（U+200B）插在中间后，
 * 模型的 tokenizer 不会再把它识别为 `<|im_start|>` 这类控制 token。
 */
export const TOKEN_BREAK = '<\u200b|';

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

/**
 * 归一化：NFKC + 剥离零宽字符。
 *
 * 为什么必须先归一化再检测：
 *   1. 全角绕过 —— `ｉｇｎｏｒｅ　ｐｒｅｖｉｏｕｓ　ｉｎｓｔｒｕｃｔｉｏｎｓ`
 *      NFKC 之后才变回 `ignore previous instructions`。
 *   2. 零宽绕过 —— `ig<ZWSP>nore previous instructions`，
 *      不剥离就永远匹配不到 `ignore`。
 * 这是攻击者真实使用的技巧，不是教科书假设。
 *
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeForScan(input) {
  let s = String(input ?? '');
  try {
    s = s.normalize('NFKC');
  } catch {
    /* 极端畸形字符串：Normalization 抛错就退化为不归一化，绝不因此让请求失败 */
  }
  return s.replace(ZERO_WIDTH_RE, '');
}

/* ------------------------------------------------------------------ *
 * 提示词注入特征
 * ------------------------------------------------------------------ */

/**
 * 每条规则只负责"命中"，给人看的说明由 KIND_TEXT 统一生成，
 * 避免同一个 kind 出现互相矛盾的文案。
 */
const INJECTION_RULES = [
  // —— 英文：忽略指令 ——
  { id: 'en-ignore', re: /ignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|preceding|earlier|foregoing)\s+(?:instruction|prompt|rule|direction|message|context)/i },
  // 注意 `(?:previous|...|directives?)?` 必须可选：`disregard prior directives` 里
  // "prior" 修饰的是 directives，早期写法强制了 the 导致这条真实变形漏检（测试 A3 抓到的）
  { id: 'en-disregard', re: /disregard\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|foregoing)?\s*(?:instruction|prompt|rule|direction|directive|guideline|constraint)s?/i },
  { id: 'en-forget', re: /forget\s+(?:everything|all|your)\s*(?:previous|prior|above|instructions?|rules?|prompts?)?/i },
  { id: 'en-override', re: /\boverride\s+(?:your\s+|all\s+|the\s+)?(?:instructions?|rules?|settings?|system\s*prompt|constraints?|guardrails?)\b/i },
  { id: 'en-system-prompt', re: /\b(?:system|initial|original|hidden|developer)\s+prompt\b/i },
  { id: 'en-output-prompt', re: /\b(?:reveal|show|print|repeat|dump|output|display|give\s+me|tell\s+me)\b[^.\n]{0,40}\b(?:your\s+)?(?:system\s+prompt|instructions|rules|prompt|configuration)\b/i },
  { id: 'en-you-are-now', re: /\byou\s+are\s+now\b/i },
  { id: 'en-new-instructions', re: /\bnew\s+instructions?\s*[:：]/i },
  { id: 'en-jailbreak', re: /\bjail\s*break\b|\bjailbroken\b/i },
  { id: 'en-dan', re: /\bDAN\s+mode\b|\bdo\s+anything\s+now\b/i },
  { id: 'en-roleplay-unrestricted', re: /\b(?:act|behave|roleplay|pretend|imagine)\b[^.\n]{0,60}\b(?:unrestricted|unfiltered|without\s+(?:any\s+)?(?:restrictions?|limitations?|filters?|rules?))\b/i },

  // —— 中文：忽略指令 ——
  { id: 'zh-ignore', re: /忽[略视]\s*(?:掉|了)?\s*(?:以上|之前|前面|上面|先前|此前|所有|全部)?\s*(?:的)?\s*(?:所有|全部|一切)?\s*(?:指令|指示|命令|要求|规则|设定|提示词|提示)/ },
  { id: 'zh-disregard', re: /(?:无视|不必理会|不要理会|别管|不用管)\s*(?:上述|以上|之前|前面|上面|这些|那些|的)?\s*(?:的|所有|全部)?\s*(?:指令|指示|命令|要求|规则|设定|限制|提示词)/ },
  { id: 'zh-system-prompt', re: /(?:你的|你的全部|完整的)?\s*系统提示词|系统\s*prompt|system\s*prompt/ },
  // 中文可以把宾语提前："把你的规则打印出来" —— 纯动词在前的写法抓不到（测试 A9 抓到的）
  { id: 'zh-reveal', re: /(?:输出|告诉|打印|重复|复述|展示|显示|泄露|透漏|透露|背诵|念)\s*(?:一下|一遍)?\s*(?:你的|你上面的)?\s*(?:系统)?\s*(?:设定|规则|提示词|提示语|指令|初始设定|人设)|把\s*(?:你的|你上面的)?\s*(?:系统)?\s*(?:设定|规则|提示词|提示语|指令|人设)\s*(?:输出|告诉|打印|重复|复述|展示|显示|发出来|念出来)/ },
  { id: 'zh-new-role', re: /现在你(?:是|将|要扮演)|从现在开始你(?:是|就是)|你现在(?:是|就是|开始|起)|你开始扮演/ },
  { id: 'zh-unrestricted', re: /不受(?:任何)?\s*(?:限制|约束|规则限制)|没有(?:任何)?\s*(?:限制|约束|道德)|无(?:需)?\s*遵守\s*(?:任何)?\s*(?:规则|限制)/ },
  { id: 'zh-jailbreak', re: /越狱模式|越狱\s*(?:prompt|提示词)|解除(?:你的)?(?:所有)?限制/ },
  { id: 'zh-override', re: /(?:不要|不必|无需|不用)\s*(?:再)?\s*(?:遵守|遵循|按照|理会|执行)\s*(?:上述|以上|之前|前面|原来的|之前所有)?\s*(?:的)?\s*(?:指令|指示|命令|要求|规则|限制)/ },
  { id: 'zh-follow-new', re: /(?:请|现在)?\s*(?:遵守|遵循|执行|按照)\s*(?:以下|下面|新的|接下来的)\s*(?:新)?\s*(?:指令|指示|命令|要求|规则)/ },
  // 下面三条来自我自己的攻击探测："忘掉你收到的全部设定" 这类同义改写
  // 不在最早的规则表里，是真实漏检（报告里记了攻击过程）
  { id: 'zh-forget', re: /(?:忘掉|忘记|清空|抹掉|删掉)\s*(?:你)?\s*(?:收到|之前|前面|上面|原本)?\s*(?:的)?\s*(?:全部|所有|一切)?\s*(?:设定|指令|指示|规则|要求|提示词|人设|身份)/ },
  { id: 'zh-void', re: /(?:作废|不算数|无效|撕掉|丢掉)\s*(?:了|的)?|(?:以上|上述|之前|前面|上面)[^。\n]{0,8}(?:全部)?(?:作废|不算数|无效)/ },
  { id: 'zh-abandon-role', re: /(?:脱离|抛开|放弃|放下)\s*(?:你)?\s*(?:原本|原来|当前|现在)?\s*(?:的)?\s*(?:身份|角色|人设|设定)/ },
  { id: 'zh-ignore-obj-first', re: /(?:上面|以上|上述|前面|之前)[^。\n]{0,6}(?:那些|这些)?(?:话|内容|要求|指令|指示)[^。\n]{0,6}(?:不算数|作废|不要管|别管|不用管|忽略)/ },

  // —— 伪造对话轮次 / 特殊 token ——
  { id: 'fake-turn', re: /^(?:system|assistant|human|user|系统|助手|用户)\s*[:：]/im },
  { id: 'sys-heading', re: /#{2,}\s*(?:system|assistant|human|系统|助手)\s*[:：]?/i },
];

/** 特殊 token：无法用"说明文案"统一表达，单独列出并原样回显命中片段（已转义） */
const SPECIAL_TOKEN_RULES = [
  { id: 'tok-im-start', re: /<\|im_start\|>/gi },
  { id: 'tok-im-end', re: /<\|im_end\|>/gi },
  { id: 'tok-system', re: /<\|system\|>/gi },
  { id: 'tok-user', re: /<\|user\|>/gi },
  { id: 'tok-assistant', re: /<\|assistant\|>/gi },
  { id: 'tok-endoftext', re: /<\|endoftext\|>/gi },
  { id: 'tok-inst', re: /\[\/?(?:INST|SYS)\]/gi },
];

/** 每种 finding 的固定文案，保证对外一致、可测试 */
const KIND_TEXT = {
  prompt_injection: {
    detail: '这段内容里出现了「试图改变 AI 指令」的文字，我们已经把它当成**数据**而不是命令来处理。',
    action: '已把这段内容标记为不可信数据，并加强指令隔离',
  },
  oversized: {
    detail: '内容偏长，我们只处理了前面一段。',
  },
  pii: {
    detail: '产物里出现了疑似身份证号 / 手机号 / 银行卡号，可能是你自己的资料在交付物里。',
    action: '已标记提醒，但没有替你删除（可能是你需要的内容）',
  },
  secret_leak: {
    detail: '产物里出现了疑似 API Key / 密钥的内容，已打码显示。',
    action: '已打码并标记，请检查交付物里是否不该出现密钥',
  },
  unsafe_output: {
    detail: '产物里有让人直接复制到终端执行的命令，如果照做可能有风险。',
    action: '已标记，请先确认这条命令是干什么的再执行',
  },
  malformed: {
    detail: '产物内容不完整或基本为空。',
    action: '已标记为内容不足',
  },
};

function finding(kind, { severity = 'medium', where, detail, action } = {}) {
  const base = KIND_TEXT[kind] ?? { detail: '检测到异常内容。', action: '已标记' };
  return {
    kind,
    detail: detail ?? base.detail,
    action: action ?? base.action ?? '已标记',
    severity,
    ...(where ? { where } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * 1. 输入净化 + 注入检测
 * ------------------------------------------------------------------ */

/**
 * 净化用户输入，并检测提示词注入特征。
 *
 * **命中注入不阻断**：普通人可能只是在引用一段从网上抄来的文字。
 * 我们做的是"标记为不可信 + 加强隔离"，把判断权留给流程，而不是替用户拒绝。
 *
 * @param {unknown} raw 用户原始输入
 * @param {{maxLength?:number, field?:string}} [opts]
 * @returns {{text:string, truncated:boolean, findings:Array, ok:boolean, reason?:string}}
 */
export function sanitizeUserInput(raw, { maxLength = DEFAULT_MAX_LENGTH, field = 'goal' } = {}) {
  const findings = [];
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : DEFAULT_MAX_LENGTH;

  // 强制字符串化：null/undefined/数字/对象都不能让下游崩
  let text = String(raw ?? '');

  // 1) 剥离控制字符（保留 \t \n \r，它们是正常排版）与零宽字符
  text = text.replace(CONTROL_RE, '').replace(ZERO_WIDTH_RE, '');

  // 2) 归一化只作用于**检测副本**（NFKC），不作用于用户看到的正文。
  //
  //    为什么分开：NFKC 会把全角标点收敛成半角 ——
  //    「，」→「,」、「：」→「:」、「？」→「?」。对中文用户来说，
  //    把他们的合同正文改得标点全变，是**可见的产品缺陷**：
  //    交付物会原样引用这些文字，用户会以为自己打错了。
  //
  //    但归一化对安全检测又是必须的：攻击者把 "ignore previous instructions"
  //    打成全角 ｉｇｎｏｒｅ 就能绕过关键词匹配（这是真实技巧，测试 A11 验证过）。
  //
  //    所以策略是：**检测用归一化副本，返回用原文副本**。
  //    两者都由同一份输入派生，不存在"检测的和使用的不是同一份"的隐患。
  //    （全角 ASCII 字母/数字/空格会被 NFKC 收敛，这一点对模型完全无害，
  //      因为模型读全角 "ｉｇｎｏｒｅ" 和半角 "ignore" 是同一个词。）
  const scanText = normalizeForScan(text);

  // 3) 空判定：只有空白（含全角空格）视为空
  if (scanText.trim().length === 0) {
    return {
      text: '',
      truncated: false,
      findings: [
        finding('malformed', {
          severity: 'low',
          where: field,
          detail: '输入内容为空或只有空白字符。',
          action: '已拒绝处理，等待用户补充内容',
        }),
      ],
      ok: false,
      reason: '内容为空',
    };
  }

  // 4) 超长 → 截断，但**不阻断**（用户粘贴长合同是正常需求）
  let truncated = false;
  if (scanText.length > limit) {
    // 归一化只会缩短或等长（全角→半角、去零宽），所以按原文字符数截断后再夹一次
    text = text.slice(0, limit);
    truncated = true;
    findings.push(
      finding('oversized', {
        severity: 'low',
        where: field,
        detail: `内容超过 ${limit} 字，已只处理前面 ${limit} 字。`,
        action: `截断到 ${limit} 字`,
      }),
    );
  }

  // 5) 注入特征检测：在**完整**归一化副本上跑，而不是截断后的部分 ——
  //    否则把注入藏在第 4000 字之后，就能既"不被检测到"、又"不被使用"。
  //    看似无害，但安全报告会漏掉一次真实攻击尝试，等于放弃可观测性。
  const hits = detectInjection(scanText);
  if (hits.length > 0) {
    // 只写一条汇总 finding：给人看的信息比"命中 12 条规则"更有用
    findings.push(
      finding('prompt_injection', {
        severity: 'medium',
        where: field,
        detail: `${KIND_TEXT.prompt_injection.detail}（命中特征：${summarizeHits(hits)}）`,
        action: KIND_TEXT.prompt_injection.action,
      }),
    );
  }

  return { text, truncated, findings, ok: true };
}

export function detectInjection(text) {
  const s = normalizeForScan(text);
  const hits = [];
  for (const rule of INJECTION_RULES) {
    if (safeTest(rule.re, s)) hits.push(rule.id);
  }
  for (const rule of SPECIAL_TOKEN_RULES) {
    if (safeTest(rule.re, s)) hits.push(rule.id);
  }
  return hits;
}

/** 带 lastIndex 复位的 test，避免 /g 正则跨调用状态污染（真实踩过的坑） */
function safeTest(re, text) {
  re.lastIndex = 0;
  const r = re.test(text);
  re.lastIndex = 0;
  return r;
}

function summarizeHits(hits) {
  const zh = hits.filter((h) => h.startsWith('zh-')).length;
  const en = hits.filter((h) => h.startsWith('en-')).length;
  const fake = hits.filter((h) => h === 'fake-turn' || h === 'sys-heading').length;
  const tok = hits.filter((h) => h.startsWith('tok-')).length;
  const parts = [];
  if (zh) parts.push(`${zh} 处中文指令改写`);
  if (en) parts.push(`${en} 处英文指令改写`);
  if (fake) parts.push(`${fake} 处伪造对话轮次`);
  if (tok) parts.push(`${tok} 处特殊 token`);
  return parts.join('、') || `${hits.length} 处`;
}

/* ------------------------------------------------------------------ *
 * 2. 隔离包裹
 * ------------------------------------------------------------------ */

/**
 * 把用户内容包进隔离标签，供提示词使用。
 *
 * 防逃逸：如果用户内容里已经出现 `</user_input>`，不转义的话他可以提前闭合标签，
 * 让后面的文字跑到"数据区"外面被模型当成指令——这是真实存在的攻击面。
 * 我们把它改写成 `<\/user_input>`（JSON 风格的斜杠转义），
 * 标签对不上了，但人还能读懂，模型也不会有歧义。
 *
 * @param {unknown} text
 * @param {string} label
 * @returns {string}
 */
export function wrapUntrusted(text, label = 'user_input') {
  // label 只允许安全字符，否则标签本身可以被构造
  const tag = String(label ?? 'user_input').replace(/[^A-Za-z0-9_-]/g, '') || 'user_input';
  const close = `</${tag}>`;

  let body = String(text ?? '');
  // 1) 打断用户伪造的同名闭合标签（大小写不敏感，并容忍标签内空白）
  body = body.replace(new RegExp(`<\\s*\\/\\s*${tag}\\s*>`, 'gi'), `<\\/${tag}>`);
  // 2) 打断特殊 token 的字节序列
  body = body.replace(/<\|/g, TOKEN_BREAK);

  return `<${tag}>\n${body}\n</${tag}>`;
}

/* ------------------------------------------------------------------ *
 * 输出审计
 * ------------------------------------------------------------------ */

const PII_PATTERNS = [
  // 用「前后不是字母数字」代替 \b：
  //   - \b 在中文旁边不成立（"手机13800000000" 里中文是非单词字符，
  //     而 1 也是非单词字符，中间没有边界 → 漏检）；
  //   - 同时必须禁止子串匹配："110105199003074219" 里出现 "19900307421"
  //     是撞车而不是手机号。
  // 这两点都是测试 D4 抓出来的真实缺陷。
  { id: 'phone', re: /(?<![0-9A-Za-z])1[3-9]\d{9}(?![0-9A-Za-z])/g, label: '手机号' },
  {
    id: 'idcard',
    re: /(?<![0-9])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9])/g,
    label: '身份证号',
  },
  { id: 'bankcard', re: /(?<![0-9])62\d{14,17}(?![0-9])/g, label: '银行卡号' },
];

/** 危险指令：引导用户把东西粘进终端 / 破坏性命令 */
const DANGEROUS_PATTERNS = [
  { id: 'paste-terminal', re: /(?:粘贴|复制|输入)[^。\n]{0,20}(?:到|进|入)\s*(?:你的)?\s*(?:终端|命令行|cmd|powershell|Terminal|shell|控制台)/i, label: '引导用户把命令粘贴到终端' },
  // 必须容忍三种真实写法：`rm -rf /`、`rm -fr /`、`rm -r -f /`
  // 以及 `sudo rm -rf --no-preserve-root /`（最初的分支漏了 --long-option）
  // 前缀不能写死成 [\s;&|(]：中文里会出现「第一步：rm -rf /」这种紧贴的写法。
  // 用 (?<![\w-]) 保证左边不是单词字符/连字符即可（`xrm`、`/bin/rm` 都能正确区分）。
  { id: 'rm-rf', re: /(?<![\w-])(?:sudo\s+)?rm\s+-(?:[a-zA-Z]*[rf][a-zA-Z]*|r\s+-\s*f|f\s+-\s*r)\b[^\n]{0,60}?(?:--\S+\s+)*(?:\/|~|\*|\$)/i, label: 'rm -rf 删除命令' },
  { id: 'curl-sh', re: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba)?sh\b/i, label: 'curl | sh 管道执行远程脚本' },
  { id: 'chmod-777', re: /\bchmod\s+(?:-R\s+)?777\b/i, label: 'chmod 777 放开全部权限' },
  { id: 'mkfs-dd', re: /\bmkfs(?:\.\w+)?\b|\bdd\s+if=.{0,40}\bof=\/dev\//i, label: '格式化 / 覆写磁盘设备' },
  { id: 'forkbomb', re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, label: 'fork 炸弹' },
];

/** 可执行内容标记：前端必须转义，这里做第二道保险 */
const UNSAFE_HTML_PATTERNS = [
  { id: 'script-tag', re: /<\s*\/?\s*script\b/i, label: '<script> 标签' },
  { id: 'event-handler', re: /\bon(?:error|load|click|mouseover|focus|submit|animationstart)\s*=/i, label: '内联事件处理器（onerror= 等）' },
  { id: 'javascript-url', re: /javascript\s*:/i, label: 'javascript: 协议链接' },
  { id: 'iframe-srcdoc', re: /<\s*iframe\b|srcdoc\s*=/i, label: 'iframe / srcdoc 嵌入' },
  { id: 'data-html', re: /data:text\/html/i, label: 'data:text/html 链接' },
];

/**
 * 收集一段文本里的所有检测结果（不含"完全没产出"这类整体判断）。
 * @param {unknown} text
 * @param {string} where
 * @returns {Array}
 */
function scanText(text, where) {
  const out = [];
  const s = String(text ?? '');
  if (s.length === 0) return out;

  // 1) 密钥：detail 里**绝不能出现原文**，只报数量 + 打码后的形态
  //    `looksLikeSecret()` 来自 src/llm/errors.js（S1 的文件，不能改），它的规则区分大小写，
  //    所以这里用「原文 + 小写副本」各判一次 —— `SK-...` / `BEARER ...` 是真实配置写法，
  //    只靠原文会漏（测试 C8）。这是不改别人文件的规避写法。
  //    原文 / 全小写 / 全大写 三种形态各判一次：像 `Qc-…` 这种混合大小写，
  //    既不是全大写也不是全小写，只看那两种仍会漏（测试 C8）。
  if (looksLikeSecret(s) || looksLikeSecret(s.toLowerCase()) || looksLikeSecret(s.toUpperCase())) {
    //    ⚠️ 重要：S1 的 redactSecrets() 区分大小写，`SK-abcdef…` 它**不会**打码。
    //    如果这里直接用它的结果做预览，大写密钥就会原样写进 findings → 进 SSE → 被分享。
    //    所以先补一遍大小写不敏感的打码，再取预览（测试 C8 专门盯这一点）。
    const redacted = redactCaseInsensitive(redactSecrets(s));
    const masked = countSecrets(s);
    out.push(
      finding('secret_leak', {
        severity: 'high',
        where,
        detail: `${KIND_TEXT.secret_leak.detail}（发现 ${masked} 处，打码预览：${previewRedacted(redacted)}）`,
        action: KIND_TEXT.secret_leak.action,
      }),
    );
  }

  // 2) PII：只报"发现 N 处"，不写原文（写入 findings 的内容会进 SSE，会被分享）
  const pii = collectPii(s);
  if (pii.total > 0) {
    const labels = pii.kinds.map((k) => `${k.label} ${k.count} 处`).join('、');
    out.push(
      finding('pii', {
        severity: 'medium',
        where,
        detail: `${KIND_TEXT.pii.detail}（发现 ${pii.total} 处：${labels}）`,
        action: KIND_TEXT.pii.action,
      }),
    );
  }

  // 3) 编码后夹带的注入：base64 是真实会被用来"把指令藏起来"的手法。
  //    只做一层解码，且解码产物不再递归解码（避免解码链 DoS / 无限递归）。
  const encoded = decodeBase64Chunks(s);
  if (encoded.length > 0) {
    const encodedHits = detectInjection(encoded);
    if (encodedHits.length > 0) {
      out.push(
        finding('prompt_injection', {
          severity: 'medium',
          where,
          detail: `${KIND_TEXT.prompt_injection.detail}（这段内容是 base64 编码的，解码后命中：${summarizeHits(encodedHits)}）`,
          action: KIND_TEXT.prompt_injection.action,
        }),
      );
    }
  }

  // 4) 危险指令
  const danger = DANGEROUS_PATTERNS.filter((p) => safeTest(p.re, s)).map((p) => p.label);
  if (danger.length > 0) {
    out.push(
      finding('unsafe_output', {
        severity: 'high',
        where,
        detail: `${KIND_TEXT.unsafe_output.detail}（${danger.join('、')}）`,
        action: KIND_TEXT.unsafe_output.action,
      }),
    );
  }

  // 5) HTML / 脚本
  // 先解码 HTML 实体再匹配：`&#60;script&#62;` 是真实存在的绕过手法
  // （浏览器会把实体还原成 <script>，只看原字符会漏）。测试 E5 覆盖这一点。
  const decoded = decodeHtmlEntities(s);
  const html = UNSAFE_HTML_PATTERNS.filter((p) => safeTest(p.re, s) || safeTest(p.re, decoded)).map((p) => p.label);
  if (html.length > 0) {
    out.push(
      finding('unsafe_output', {
        severity: 'medium',
        where,
        detail: `产物里有可执行的网页内容（${html.join('、')}）。前端渲染时会转义显示，请不要直接粘贴到网页里运行。`,
        action: '已标记；渲染层必须转义（第二道保险）',
      }),
    );
  }

  return out;
}

/**
 * 从文本里挑出"像 base64 的长串"并解码，拼成一段用于检测的文本。
 *
 * 为什么需要：攻击者可以把 `ignore all previous instructions` 编码成
 * `aWdub3JlIGFsbCBwcmV2aW91cyBpbnN0cnVjdGlvbnM=` 塞进文档，
 * 表面上完全无害。测试 A19 覆盖这一点。
 *
 * 防 DoS：最多看 8 段、每段最多 2000 字符、解码总长上限 8000 字符。
 */
export function decodeBase64Chunks(text, { maxChunks = 8, maxChunk = 2000, maxTotal = 8000 } = {}) {
  const s = String(text ?? '');
  const re = /[A-Za-z0-9+/]{24,}={0,2}/g;
  let m;
  const parts = [];
  let total = 0;
  while ((m = re.exec(s)) !== null && parts.length < maxChunks) {
    const chunk = m[0].slice(0, maxChunk);
    try {
      if (typeof Buffer === 'undefined') return '';
      const buf = Buffer.from(chunk, 'base64');
      const decoded = buf.toString('utf8');
      // 必须能还原成可读文本，否则说明只是普通的长数字/长单词
      if (!decoded || decoded.length < 8) continue;
      // 必须能还原成"像人写的文本"：
      //   1) 控制字符要少（U+FFFD 替换符不算控制字符，所以还要第 2 条）
      //   2) 落在 ASCII / 中日韩 / 常用标点之外的字符要少 ——
      //      否则纯数字长串（订单号、时间戳）经 base64 解码出乱码后也会被当成"内容"
      const printable = decoded.replace(/[^\P{C}]/gu, '').length / decoded.length;
      if (printable < 0.85) continue;
      const readable = decoded.replace(/[\u0000-\u007F\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF\u2000-\u206F]/g, '').length / decoded.length;
      if (readable > 0.3) continue;
      parts.push(decoded);
      total += decoded.length;
      if (total > maxTotal) break;
    } catch {
      /* 不是合法 base64：忽略 */
    }
  }
  return parts.join('\n').slice(0, maxTotal);
}

/** 统计疑似密钥数量（与 errors.js 的 SECRET_PATTERNS 同一套规则，只数不改） */
function countSecrets(text) {
  let n = 0;
  for (const re of SECRET_PATTERNS_SAFE()) {
    // 同一段文字里出现同一条规则的不同大小写形态时，只算一次（避免重复计数）
    const m = String(text).match(re);
    if (m && m.length > 0) n += m.length;
  }
  return n;
}

/**
 * 大小写不敏感的打码（补 redactSecrets 的漏洞）。
 * 只在 guard 内部用于生成对外文本，不改动 S1 的文件。
 */
function redactCaseInsensitive(input) {
  let out = String(input ?? '');
  for (const re of SECRET_PATTERNS_SAFE()) {
    re.lastIndex = 0;
    out = out.replace(re, '[已隐去密钥]');
    re.lastIndex = 0;
  }
  return out;
}

/** 打码后的短预览：只取被替换成 [已隐去密钥] 的上下文，确保不含原文 */
function previewRedacted(redacted) {
  const idx = redacted.indexOf('[已隐去密钥]');
  if (idx < 0) return '（已隐去）';
  const start = Math.max(0, idx - 8);
  const snippet = redacted.slice(start, idx + '[已隐去密钥]'.length);
  return snippet.replace(/\s+/g, ' ').slice(0, 40);
}

/** 重新构造一份与 errors.js 一致的密钥规则（避免共享 /g 正则的 lastIndex 状态） */
function SECRET_PATTERNS_SAFE() {
  return [
    // 全部加 i：`SK-...` / `sk-...` / `Qc-...` 在真实配置里都出现过（测试 C8）
    /QC-[A-Za-z0-9-]{16,}/gi,
    /sk-[A-Za-z0-9_-]{12,}/gi,
    /AKIA[0-9A-Z]{16}/gi,
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gi,
  ];
}

/** 常见 HTML 实体 → 字符。只用于"是否含可执行网页内容"的判断，不改写用户内容。 */
const NAMED_ENTITIES = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', tab: '\t', newline: '\n',
  sol: '/', colon: ':', equals: '=', lpar: '(', rpar: ')', num: '#', perc: '%', semi: ';',
};

/**
 * 解码 HTML 实体（数字实体 + 常见命名实体）。
 * 防御性：码点越界或 fromCodePoint 抛错时保留原样，绝不让输入打崩服务。
 */
export function decodeHtmlEntities(input) {
  const s = String(input ?? '');
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9A-Fa-f]{1,8}|[A-Za-z]{2,10});?/g, (m, body) => {
    try {
      if (body[0] === '#') {
        const isHex = body[1] === 'x' || body[1] === 'X';
        const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
        return String.fromCodePoint(code);
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named ?? m;
    } catch {
      return m;
    }
  });
}

function collectPii(text) {
  const kinds = [];
  let total = 0;
  for (const p of PII_PATTERNS) {
    p.re.lastIndex = 0;
    const m = text.match(p.re);
    p.re.lastIndex = 0;
    if (m && m.length > 0) {
      kinds.push({ id: p.id, label: p.label, count: m.length });
      total += m.length;
    }
  }
  return { total, kinds };
}

/** 从 artifact / review / plan 里抽出全部可读文本并标注位置 */
function extractArtifactText(art, i) {
  if (art === null || art === undefined) return [];
  if (typeof art === 'string') return [{ where: `artifacts[${i}]`, text: art }];
  if (typeof art !== 'object') return [{ where: `artifacts[${i}]`, text: String(art) }];
  const where = art.id ? `artifact:${art.id}` : `artifacts[${i}]`;
  const fields = ['content', 'name', 'title', 'body', 'text', 'summary', 'markdown'];
  const parts = [];
  for (const f of fields) {
    if (typeof art[f] === 'string' && art[f].length > 0) parts.push({ where: `${where}.${f}`, text: art[f] });
  }
  return parts;
}

function extractReviewText(review) {
  if (!review || typeof review !== 'object') return [];
  const parts = [];
  for (const [i, issue] of (Array.isArray(review.issues) ? review.issues : []).entries()) {
    const t = [issue?.problem, issue?.fix, issue?.detail].filter((x) => typeof x === 'string').join('\n');
    if (t) parts.push({ where: `review.issues[${i}]`, text: t });
  }
  for (const [i, c] of (Array.isArray(review.checklist) ? review.checklist : []).entries()) {
    const t = [c?.item, c?.note].filter((x) => typeof x === 'string').join('\n');
    if (t) parts.push({ where: `review.checklist[${i}]`, text: t });
  }
  if (typeof review.summary === 'string' && review.summary) {
    parts.push({ where: 'review.summary', text: review.summary });
  }
  return parts;
}

function extractPlanText(plan) {
  if (!plan || typeof plan !== 'object') return [];
  const parts = [];
  for (const f of ['title', 'intent']) {
    if (typeof plan[f] === 'string' && plan[f]) parts.push({ where: `plan.${f}`, text: plan[f] });
  }
  for (const f of ['assumptions', 'risks']) {
    for (const [i, v] of (Array.isArray(plan[f]) ? plan[f] : []).entries()) {
      if (typeof v === 'string' && v) parts.push({ where: `plan.${f}[${i}]`, text: v });
    }
  }
  return parts;
}

/** 产物里"有内容"的字符数（去掉所有空白），用于判断是否真的产出了东西 */
function nonWhitespaceLength(artifacts) {
  let total = 0;
  for (const [i, art] of (Array.isArray(artifacts) ? artifacts : []).entries()) {
    for (const p of extractArtifactText(art, i)) {
      total += p.text.replace(/\s+/g, '').length;
    }
  }
  return total;
}

function sumArtifactLength(artifacts) {
  let total = 0;
  for (const [i, art] of (Array.isArray(artifacts) ? artifacts : []).entries()) {
    for (const p of extractArtifactText(art, i)) total += p.text.length;
  }
  return total;
}

/** 把 findings 归并成 level：blocked > notice > clean */
function levelOf(findings) {
  if (findings.some((f) => f.severity === 'high' && f.kind === 'malformed')) return 'blocked';
  return findings.length > 0 ? 'notice' : 'clean';
}

/* ------------------------------------------------------------------ *
 * 3. 单段输出审计（模型的一次回复）
 * ------------------------------------------------------------------ */

/**
 * 审计模型输出。
 *
 * 注意 level 的语义：**blocked 只留给"完全没产出"**。
 * 我们的产品是帮普通人办事的，动不动就 blocked 就是失败的产品。
 * 密钥/PII/危险指令一律 notice —— 用户可能是自己贴的、自己需要的。
 *
 * @param {unknown} text
 * @returns {{level:'clean'|'notice'|'blocked', findings:Array}}
 */
export function auditOutput(text) {
  const s = String(text ?? '');
  if (s.trim().length === 0) {
    return {
      level: 'blocked',
      findings: [
        finding('malformed', {
          severity: 'high',
          where: 'output',
          detail: '模型这次什么内容都没返回。',
          action: '已标记为无产出',
        }),
      ],
    };
  }
  const findings = scanText(s, 'output');
  return { level: levelOf(findings), findings };
}

/* ------------------------------------------------------------------ *
 * 4. 整个 job 的产物审计
 * ------------------------------------------------------------------ */

/**
 * 审计整个 job 的最终产物集合。
 *
 * @param {{artifacts?:Array, review?:object|null, plan?:object|null, security?:object|null}} [job]
 * @returns {{level:'clean'|'notice'|'blocked', findings:Array}}
 */
export function auditJob({ artifacts = [], review = null, plan = null, security = null } = {}) {
  const findings = [];

  // 0) 把输入阶段已经标记过的注入 finding 带进来（否则 job.security 会漏掉它）
  if (security && Array.isArray(security.findings)) {
    for (const f of security.findings) {
      if (f && f.kind === 'prompt_injection') findings.push(f);
    }
  }

  const list = Array.isArray(artifacts) ? artifacts : [];

  // 1) 完全空的产物 → blocked（这是唯一的 blocked 场景）
  if (list.length === 0) {
    return {
      level: 'blocked',
      findings: [
        ...findings,
        finding('malformed', {
          severity: 'high',
          where: 'artifacts',
          detail: '这次没有产出任何交付物。',
          action: '已标记为无产出',
        }),
      ],
    };
  }

  // 只数"有内容的字符"：500 个字面空格不该被算成有效产出
  const totalLen = nonWhitespaceLength(list);
  if (totalLen < MIN_ARTIFACT_LENGTH) {
    return {
      level: 'blocked',
      findings: [
        ...findings,
        finding('malformed', {
          severity: 'high',
          where: 'artifacts',
          detail: `所有交付物加起来只有 ${totalLen} 字，基本等于没产出。`,
          action: '已标记为无产出',
        }),
      ],
    };
  }

  // 2) 逐产物扫描
  for (const [i, art] of list.entries()) {
    for (const p of extractArtifactText(art, i)) findings.push(...scanText(p.text, p.where));
  }
  for (const p of extractReviewText(review)) findings.push(...scanText(p.text, p.where));
  for (const p of extractPlanText(plan)) findings.push(...scanText(p.text, p.where));

  // 3) 重复 finding 收敛：同 kind + 同 where 只留一条
  const seen = new Set();
  const deduped = [];
  for (const f of findings) {
    const key = `${f.kind}|${f.severity}|${f.where ?? ''}|${f.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  return { level: levelOf(deduped), findings: deduped };
}

/* ------------------------------------------------------------------ *
 * 5. 给调用方的小工具
 * ------------------------------------------------------------------ */

/**
 * 把 security 对象压成给普通人看的一句话（前端/交付物都能用）。
 * @param {{level?:string, findings?:Array}} [security]
 * @returns {string}
 */
export function describeSecurity(security) {
  const level = security?.level ?? 'clean';
  const findings = Array.isArray(security?.findings) ? security.findings : [];
  if (level === 'blocked') return '这次没有产出可交付的内容，我们已经标记出来，建议重试一次。';
  if (level === 'clean' || findings.length === 0) return '安全检查通过：没有发现异常内容。';
  const kinds = new Set(findings.map((f) => f.kind));
  const notes = [];
  if (kinds.has('prompt_injection')) notes.push('输入里有试图改变 AI 指令的文字，已按"资料"处理');
  if (kinds.has('pii')) notes.push('发现疑似身份证号 / 手机号，分享前请自己确认');
  if (kinds.has('secret_leak')) notes.push('发现疑似密钥，已打码');
  if (kinds.has('unsafe_output')) notes.push('有需要复制到终端的命令，请先确认真伪');
  if (kinds.has('oversized')) notes.push('输入太长，只处理了前面一段');
  if (kinds.has('malformed')) notes.push('有内容不完整');
  return `安全检查发现 ${findings.length} 处需要你知道的情况：${notes.join('；')}。`;
}
