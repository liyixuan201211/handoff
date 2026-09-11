/**
 * 离线演示数据（fixtures） —— 没有网络、没有 API Key 也要能完整演示产品。
 *
 * 为什么这个文件重要：
 *   普通人的第一印象来自「一键体验」。如果体验按钮点下去因为我们这边没网、
 *   或者用户没配 Key 就报错，产品再深也没人看得见。
 *   所以这里放着**一条假的但完整的、走完全部 8 个阶段的真实感任务**。
 *
 * 铁律：
 *  1. `demoJob()` 返回的对象**必须严格符合 docs/CONTRACT.md §2 的 Job 形状** ——
 *     字段一个不多、一个不少。校验断言在 tests/unit/fixtures.test.js。
 *  2. 本模块**不发网络请求、不读环境变量、不写文件**（纯数据 + 假延时）。
 *  3. `runDemoPipeline()` 的 emit 参数形状 = `events.publish(jobId, payload)` 的 payload，
 *     所以它可以被 src/pipeline/engine.js 在 `demo:true` 时直接使用。
 */
import { newId } from '../store/events.js';

/** 默认演示目标：一句话就是普通人会说的话 */
export const DEFAULT_DEMO_GOAL = '帮我把这份租房合同看一遍，我怕有坑';

/**
 * 「一键体验」按钮用的示例目标。
 * 选取标准：都来自真实用户会说的话，且都不需要用户额外提供材料就能演示出产物。
 */
export const DEMO_GOALS = [
  DEFAULT_DEMO_GOAL,
  '我想在小区门口开个早餐店，帮我看看要办哪些手续、大概花多少钱',
  '帮我把这学期的家长会讲稿写出来，我面对家长会紧张，要能照着念',
  '我妈高血压，帮我整理一份她能看懂的一周食谱和注意事项',
  '我店里想搞个充值活动，帮我算算送多少不亏本，再写个海报文案',
  '帮我把这份劳动合同看一遍，我怕签了以后被坑',
];

/* ================================================================== *
 * 交付物正文（真正有用、像样的中文 markdown，不是占位符）
 * ================================================================== */

const ARTIFACT_RISK = `# 合同风险清单

> 审的是你发来的这份《房屋租赁合同》。每一条都写清三件事：**合同原文怎么说的**、**对你意味着什么**、**可以怎么改**。
> 我们不是律师事务所，这份清单的作用是让你在签字前「知道自己该问什么」。

## 一句话结论

这份合同整体不算离谱，但有 **3 处明显偏向房东**：押金退还期限缺失、维修责任全部推给你、提前退租违约金过高。
这三条都可以谈，现实中通常也能谈下来。**建议：先谈这 3 条，谈不拢再决定签不签。**

## 一、高风险（签字前建议必须改）

### 1. 押金退还：没写「几天内退」
- 合同原文：「第五条 租赁期满，乙方结清各项费用后，甲方退还押金。」
- 对你不利的地方：**没有约定退还期限**。房东可以拖一个月、半年，你除了反复催没有依据。
- 建议改成：「租赁期满且乙方无违约情形，甲方应于房屋交接之日起 7 个工作日内退还全部押金；逾期每日按押金总额的 0.5% 支付违约金。」
- 现实提醒：这是租房纠纷里最常见的一条，写上「7 个工作日」房东一般不会反对。

### 2. 维修责任：全压在你身上
- 合同原文：「房屋及附属设施的维修由乙方负责，费用由乙方承担。」
- 对你不利的地方：空调、热水器、水管、电路这些**房屋本身的毛病**也要你出钱。换一台空调压缩机可能就是大半个月房租。
- 建议改成：「房屋主体结构、原有家电及管线的自然损坏由甲方负责维修并承担费用；因乙方使用不当造成的损坏由乙方承担。甲方应在接到通知后 3 日内安排维修，逾期乙方可自行维修并从租金中扣除。」
- 一定要加的：**「原有家电清单」**（品牌 + 型号 + 现状照片）。没有它，退房时说不清是不是你弄坏的。

### 3. 提前退租：违约金按「剩余租期总租金」算
- 合同原文：「乙方提前退租的，应支付剩余租期全部租金的 30% 作为违约金。」
- 对你不利的地方：一年合同、月租 4200 元，住满 2 个月想走，剩余租期 10 个月 = 42000 元，违约金 30% 即 **12600 元**，接近 3 个月房租。
- 建议改成：「乙方提前退租应提前 30 日书面通知甲方，并支付 1 个月租金作为违约金；甲方应在 7 日内退还剩余租金及押金。」

## 二、中风险（能争取就争取）

### 4. 涨租条款：写了「甲方有权根据市场情况调整租金」
- 问题：**「根据市场情况」没有标准**，等于给了单方面涨租的口子。固定租期内不应该涨租。
- 建议加上：「租赁期内租金固定不变。租赁期满续租的，租金调整幅度不超过上一年度的 5%。」

### 5. 转租 / 换室友：完全禁止
- 合同原文：「未经甲方书面同意，乙方不得转租、不得增加居住人。」
- 问题：工作变动、室友搬走时你会很被动，而且房东可以借这一条随时主张你违约。
- 建议改成：「乙方经甲方书面同意后可转租；甲方无正当理由不得拒绝。」

### 6. 房屋交付状态：没有交房清单
- 问题：退房时容易因为「墙面有划痕」「地板有印子」被扣押金，而你举证困难。
- 建议：交房当天**双方一起拍视频 + 列清单签字**，各留一份。

## 三、合同里缺的关键条款（建议补进去）

| 缺什么 | 为什么重要 | 建议怎么写 |
|---|---|---|
| 押金退还期限 | 决定你能不能顺利拿回钱 | 房屋交接后 7 个工作日内 |
| 甲方维修义务 | 决定坏了谁出钱 | 自然损坏甲方修，3 日内响应 |
| 提前退租违约金上限 | 决定你走人的成本 | 不超过 1 个月租金 |
| 甲方身份与产权证明 | 防止遇到二房东、假房东 | 签约时核对身份证 + 房产证 |
| 水电燃气过户与结清 | 防止替前任租客交欠费 | 交接当天抄表并写入合同 |

## 附一：这份合同里的关键信息（我们从合同里摘出来的）
- 甲方（出租人）：王某某，联系电话 **13800138000**
- 乙方（承租人）：你
- 房屋地址：某市某区某路 88 号 3 单元 502
- 月租金：4200 元；押一付三；租期 2026-10-01 至 2027-09-30
- 押金：4200 元

## 附二：本次审查用到的假定
这份清单建立在以下假定之上。如果和你的实际情况不符，告诉我们，我们会重做相关部分：
- 假定你是**承租方**（付房租住进去的一方），不是房东；
- 假定这份合同**还没有签字**（如果已经签了，第 1、2 条的处理方式不一样）；
- 假定你拿到的是**完整合同正文**，而不是只有一页或几页；
- 假定你最在意的是**押金、维修责任和提前走人的成本**这三件事。
`;

const ARTIFACT_ADVICE = `# 给你的行动建议

> 这份文件只解决一个问题：**现在，你该做什么。**
> 按顺序做就行，不需要你懂法律。

## 今天就能做的 3 件事（大约 30 分钟）

1. **把上面 3 条高风险条款发给房东**，用下面「直接复制就能用」的话术，一次只提一条。
2. **约一次当面看房**，重点看：空调能不能制冷、热水器出水稳不稳、卫生间有没有渗水痕迹、水压够不够、窗边有没有霉斑。发现问题当场拍照。
3. **要一份房东的身份证 + 房产证照片**（或房产证编号），确认签字的人就是房主本人。对方如果说「我是二房东」，要求出示**原房东同意转租的书面文件**。

## 直接复制就能用的话术

**关于押金退还：**
> 王先生您好，合同我看过了，整体没问题，有几个小地方想跟您确认一下。第五条押金退还，能不能加上「交房后 7 个工作日内退还」？这样咱们双方都清楚，也免得以后麻烦。

**关于维修责任：**
> 第六条维修这块，房屋本身和原有家电的自然损坏，一般是由房东负责的，能不能改成「自然损坏由甲方维修，人为损坏由乙方承担」？我这边也会爱惜房子。

**关于提前退租：**
> 第七条提前退租的违约金，按剩余租期 30% 算金额有点高。能不能改成「提前 30 天通知 + 1 个月租金作为违约金」？这样对双方都合理。

**谈判小技巧：** 一次只提一件事，先提押金（房东最容易同意），同意了再提下一条。
全程用「咱们」「双方都清楚」这种说法，别把对方放到对立面。

## 签字当天必须完成的清单

- [ ] 合同上补上押金退还期限（房屋交接后 7 个工作日）
- [ ] 合同上补上维修责任划分（自然损坏甲方负责）
- [ ] 提前退租违约金改成不超过 1 个月租金
- [ ] 双方身份证号、联系电话写进合同
- [ ] 交房时抄水电燃气表，数字写进合同并双方签字
- [ ] 拍一段交房视频（从门口走到每个房间），和房东互相发一份
- [ ] 家电清单（品牌 + 型号 + 现状）双方签字，各留一份
- [ ] 付款走**银行转账**并备注「XX 房租」，尽量不要给现金

## 如果房东一条都不肯改

按风险分三种情况处理：
- 只是**押金退还期限**不肯写 → 风险可控。但退房时你要**提前 30 天开始书面催**，并保留全部聊天记录。
- **维修责任全部推给你** → 这是明显不公平条款。按《民法典》第七百一十二条，出租人应当履行租赁物的维修义务；这类约定效力存疑，但打官司成本高，**建议换一套房**。
- 对方**拿不出房产证、也不肯视频确认身份** → 直接放弃。这类房子押金被吞的概率很高。

## 后续你可以随时找我

- 「帮我把改好的合同再查一遍」——把新版本发进来就行
- 「房东只肯改第一条，我该怎么办」——我们给你出具体的回复
- 「退房时房东扣押金」——我们帮你整理一份有依据的催告信息
`;

const ARTIFACT_HOWTO = `# 怎么用这份报告

这份报告是给**你**看的，不是给律师看的。三分钟就能读完。

## 你手上现在有两样东西

1. **合同风险清单** —— 这份合同哪里对你不利，原文是什么，改成什么。
2. **给你的行动建议** —— 今天做什么、怎么跟房东说、签字前检查什么。

## 建议的阅读顺序

1. 先看风险清单最上面的「**一句话结论**」。如果只有一分钟，看这一段就够了。
2. 再看「**一、高风险**」的 3 条。这 3 条是真正会让你亏钱的地方。
3. 最后看行动建议里的「**直接复制就能用的话术**」，照着发给房东。

## 关于这份报告的边界（重要）

- 我们**不是律师**，这份报告不构成法律意见。金额较大、或者已经产生纠纷的情况，请咨询执业律师或当地住建部门。
- 报告基于**你提供的合同文本**和**我们替你做的假定**（见风险清单「附二」）。如果你其实是房东、或者合同已经签了，结论会不一样。
- 报告里出现你的个人信息（比如联系电话）是正常的，那是从合同里摘出来给你核对的。**转发给别人之前请自己删掉。** 我们对这类信息做了标记提醒，但没有替你删除，因为它可能是你需要的。
- 我们**没有联网检索具体判例**，法规部分依据《民法典》通用条款。

## 想继续做点什么

直接在对话框里说人话就行，例如：
- 「帮我写一条微信，跟房东说押金条款要改」
- 「房东同意了前两条，第三条不肯改，怎么办」
- 「我已经签了，现在还能补救吗」
`;

/* ================================================================== *
 * 阶段剧本
 * ================================================================== */

/**
 * 8 个阶段的剧本骨架。`key` 必须与 CONTRACT.md §3 的 order 表一致且保序。
 * ms / reason / log / output 都是「演给人看」的，但必须自洽：
 *  - 后面的阶段不能引用前面还没产出的东西
 *  - 数字必须能对上（见 tests/unit/fixtures.test.js 的一致性断言）
 */
const STAGE_SCRIPT = [
  {
    key: 'intake',
    title: '理解需求',
    role: '接待员',
    ms: 1840,
    reason: '先确认你到底想要什么——你说「怕有坑」，我们得把它翻译成一件能检查的事。',
    log: [
      { level: 'info', text: '收到需求，正在理解你的真实意图…' },
      { level: 'info', text: '识别到任务类型：合同 / 协议风险审查（租房场景）' },
      { level: 'info', text: '未发现必须反问你的问题，按「先做，把假设亮出来」处理' },
    ],
    output: () => ({
      restatement:
        '你想知道这份租房合同里有没有对你不利的条款，尤其是会直接让你损失钱的部分（押金、维修、违约金）。',
      ambiguities: ['合同是整份还是节选（按整份处理）', '是否已经签字（按未签字处理）'],
      assumed: ['你是承租方', '合同为中文', '尚未签字'],
      missingInfo: [],
    }),
  },
  {
    key: 'plan',
    title: '制定方案',
    role: '项目经理',
    ms: 2640,
    reason: '决定这次要交付什么、按什么顺序做，避免产出一堆你不需要的东西。',
    log: [
      { level: 'info', text: '拆解交付物：风险清单 + 行动建议 + 使用说明' },
      { level: 'info', text: '编排阶段：查资料 → 逐条审 → 自审 → 改稿 → 验收 → 打包' },
      { level: 'info', text: '确认 8 个阶段对本任务都必要（不跳过任何一步）' },
    ],
    output: () => ({
      deliverableCount: 3,
      stageKeys: ['intake', 'plan', 'research', 'draft', 'critique', 'revise', 'verify', 'deliver'],
      approach: '先查租房合同的高频风险点与法定权利，再逐条对照你的合同，自审一遍后改稿，最后验收打包。',
    }),
  },
  {
    key: 'research',
    title: '查资料',
    role: '调研员',
    ms: 4180,
    reason: '先弄清租房合同里最常见、最容易吃亏的地方，再动手看你的合同，避免只凭感觉挑毛病。',
    log: [
      { level: 'info', text: '整理租房合同高频争议点（押金、维修、违约金、涨租）' },
      { level: 'info', text: '核对相关法条：民法典第七百一十二条（维修义务）、第七百二十二条（欠租解除）' },
      { level: 'warn', text: '本次为离线演示，未联网检索具体判例，法规部分仅依据通用条款' },
    ],
    output: () => ({
      points: [
        '押金退还期限缺失，是租房押金纠纷里最常见的原因',
        '《民法典》第七百一十二条：出租人应当履行租赁物的维修义务（另有约定除外）',
        '提前退租违约金没有约定时，实践中多以 1 个月租金为参考',
        '未核验产权人就签约，是遇到二房东、假房东的主要入口',
      ],
      sourceNote: '依据通用法规与常识整理；演示模式未联网检索判例。',
    }),
  },
  {
    key: 'draft',
    title: '动手做',
    role: '执行专员',
    ms: 9120,
    reason: '真正逐条读这份合同，把风险点和缺失条款写成你一眼能看懂的清单。',
    log: [
      { level: 'info', text: '逐条比对你的合同文本与风险点清单…' },
      { level: 'info', text: '命中 3 条高风险、3 条中风险、5 项关键条款缺失' },
      { level: 'info', text: '正在写初稿：合同风险清单、给你的行动建议' },
    ],
    output: () => ({
      drafts: [
        { deliverableId: 'd1', name: '合同风险清单', chars: ARTIFACT_RISK.length },
        { deliverableId: 'd2', name: '给你的行动建议', chars: ARTIFACT_ADVICE.length },
      ],
    }),
  },
  {
    key: 'critique',
    title: '挑毛病',
    role: '审查员',
    ms: 3150,
    reason: '自己先挑一遍毛病：有没有漏掉的关键条款、有没有说了等于没说的建议。',
    log: [
      { level: 'info', text: '按「用户能不能照着做」这一条标准逐段检查初稿' },
      { level: 'warn', text: '发现 2 处问题：违约金示例只算了单一情形；「拿不出房产证怎么办」没有交代' },
    ],
    output: () => ({
      issues: [
        '违约金示例只列了「住满 2 个月」一种情形，用户可能不会按自己的租期换算',
        '提到要核对产权证明，但没有说明对方拒不出示时该怎么办',
      ],
      verdict: '需要改稿',
    }),
  },
  {
    key: 'revise',
    title: '改稿',
    role: '执行专员',
    ms: 6480,
    reason: '根据挑出来的问题改稿，让每一条建议都能直接照着做，而不是「注意风险」这种空话。',
    log: [
      { level: 'info', text: '补上违约金计算方式与「房东一条都不肯改」的分级处理' },
      { level: 'info', text: '补充 3 段可直接复制发送的谈判话术' },
      { level: 'info', text: '补充 8 项签字当天检查清单' },
    ],
    output: () => ({
      revised: ['违约金示例补上计算方式与分级处理', '补齐可直接复制的话术与签字清单'],
      revisedCount: 2,
      coveredDeliverables: ['d1', 'd2'],
    }),
  },
  {
    key: 'verify',
    title: '验收',
    role: '质检员',
    ms: 2860,
    reason: '对照你最初问的那句话逐项检查，确认我们没有回避你的真实担忧。',
    log: [
      { level: 'info', text: '对照原始需求「我怕有坑」逐项核对：有没有真的指出坑在哪' },
      { level: 'info', text: '检查交付物是否可执行、假设是否写明、边界是否交代' },
      { level: 'warn', text: '结论：通过，但有 3 条需要你知道的遗留说明' },
    ],
    output: () => ({
      verdict: 'pass_with_notes',
      issueCount: 3,
      checklistPassed: 5,
      checklistTotal: 6,
    }),
  },
  {
    key: 'deliver',
    title: '打包交付',
    role: '交付专员',
    ms: 1470,
    reason: '把成果打包成你拿到就能用的东西，并写清楚怎么读、边界在哪里。',
    log: [
      { level: 'info', text: '生成「怎么用这份报告」使用说明' },
      { level: 'info', text: '标注内容边界：不构成法律意见；个人信息转发前请删除' },
      { level: 'info', text: '3 份交付物已就绪，可以下载或直接阅读' },
    ],
    output: () => ({
      howToUse:
        '先看风险清单的「一句话结论」，再看高风险 3 条，最后照行动建议里的现成话术发给房东。全部读完大约 8 分钟。',
      files: ['合同风险清单.md', '给你的行动建议.md', '怎么用这份报告.md'],
      boundary: '本报告不构成法律意见；涉及金额较大或已产生纠纷，请咨询执业律师。',
    }),
  },
];

/** 阶段之间的固定间隔（毫秒），让时间线看起来像真的在跑，而不是几个数字挤在一起 */
const STAGE_GAP_MS = 80;

/* ================================================================== *
 * demoJob()
 * ================================================================== */

/**
 * 一条完整的、走完全部 8 个阶段的示例任务（status: 'done'）。
 *
 * 严格符合 CONTRACT.md §2 的 Job 形状：字段一个不多、一个不少。
 * 每次调用都返回**全新对象**（id 也是新的），可以直接拿去做并发创建测试。
 *
 * @param {string} [goal] 用户目标，默认是那句租房合同的演示目标
 * @param {{jobId?: string}} [opts] 可选：复用外部引擎已经分配好的 job id
 * @returns {object} Job
 */
export function demoJob(goal = DEFAULT_DEMO_GOAL, opts = {}) {
  const goalText = typeof goal === 'string' && goal.trim() ? goal.trim() : DEFAULT_DEMO_GOAL;
  const totalMs = STAGE_SCRIPT.reduce((s, x) => s + x.ms, 0) + STAGE_SCRIPT.length * STAGE_GAP_MS;

  // 让「刚跑完」的任务看起来自然：createdAt 在 totalMs 之前，updatedAt 就是现在。
  const updatedAt = Date.now();
  const createdAt = updatedAt - totalMs;

  const jobId = opts.jobId ?? newId('job');
  const artifactIds = [newId('art'), newId('art'), newId('art')];
  const [riskId, adviceId, howtoId] = artifactIds;

  // ── 阶段 ──────────────────────────────────────────────────────
  const stages = [];
  let cursor = createdAt + 120; // 接到任务后有一点点启动延迟
  STAGE_SCRIPT.forEach((s, i) => {
    const startedAt = cursor;
    const endedAt = startedAt + s.ms;
    cursor = endedAt + STAGE_GAP_MS;
    stages.push({
      id: `stage_${i + 1}`,
      key: s.key,
      title: s.title,
      role: s.role,
      status: 'done',
      startedAt,
      endedAt,
      ms: s.ms,
      reason: s.reason,
      log: s.log.map((l, li) => ({
        // 阶段内的日志按时间均匀铺开，最后一条落在阶段结束前
        at: startedAt + Math.round(((li + 1) / (s.log.length + 1)) * s.ms),
        level: l.level,
        text: l.text,
      })),
      output: s.output(),
      error: null,
    });
  });

  const plan = {
    title: '租房合同风险审查',
    intent: '用户想确认这份租房合同里是否存在对自己不利、会造成实际损失的条款，并希望知道该怎么处理。',
    assumptions: [
      '假定你是承租方（付房租住进去的一方），不是房东',
      '假定这份合同还没有签字（已经签了的话，押金和维修两条的处理方式不同）',
      '假定你拿到的是完整合同正文，而不是只有一页或几页',
      '假定你最在意的是押金、维修责任和提前走人的成本这三件事',
    ],
    risks: [
      '合同缺少押金退还期限，可能长期拿不回押金',
      '维修责任全部约定由承租方承担，与民法典第七百一十二条存在冲突',
      '提前退租违约金按剩余租期总租金的 30% 计算，实际金额可能远超一个月租金',
      '合同未载明出租人产权信息，存在遇到二房东的风险',
    ],
    deliverables: [
      { id: 'd1', name: '合同风险清单', format: 'markdown' },
      { id: 'd2', name: '给你的行动建议', format: 'markdown' },
      { id: 'd3', name: '怎么用这份报告', format: 'markdown' },
    ],
  };

  const artifacts = [
    {
      id: riskId,
      deliverableId: 'd1',
      name: '合同风险清单',
      format: 'markdown',
      content: ARTIFACT_RISK,
      assumptions: [
        '假定你是承租方，且合同尚未签字',
        '假定合同为中文，且你提供的是完整正文',
        '违约金金额按「剩余租期总租金 × 30%」估算',
      ],
      confidence: 'high',
      basedOn: ['stage_1', 'stage_3', 'stage_4', 'stage_6'],
      createdAt: stages[5].endedAt,
    },
    {
      id: adviceId,
      deliverableId: 'd2',
      name: '给你的行动建议',
      format: 'markdown',
      content: ARTIFACT_ADVICE,
      assumptions: [
        '假定你希望自己跟房东沟通，而不是直接走法律程序',
        '谈判话术按「对方是普通房东、不是中介公司」的场景撰写',
      ],
      confidence: 'high',
      basedOn: ['stage_1', 'stage_4', 'stage_6'],
      createdAt: stages[5].endedAt,
    },
    {
      id: howtoId,
      deliverableId: 'd3',
      name: '怎么用这份报告',
      format: 'markdown',
      content: ARTIFACT_HOWTO,
      assumptions: ['假定读者是不熟悉法律文书的普通人'],
      confidence: 'high',
      basedOn: ['stage_8'],
      createdAt: stages[7].endedAt,
    },
  ];

  const review = {
    verdict: 'pass_with_notes',
    issues: [
      {
        severity: 'medium',
        where: adviceId,
        problem: '违约金只给了「住满 2 个月」一个算例，用户可能不会按自己的剩余租期换算。',
        fix: '建议补一句通用公式：「剩余租期月数 × 月租 × 30%」，并给两个不同租期的例子。',
      },
      {
        severity: 'low',
        where: riskId,
        problem: '「中风险」第 6 条要求拍交房视频，但没有说明要拍到什么程度，用户可能拍得太随意，起不到证据作用。',
        fix: '建议写明拍摄要点：从门口进入后逐间走一遍，重点拍家电外观、墙面、地板和卫生间。',
      },
      {
        severity: 'low',
        where: howtoId,
        problem: '使用说明里的个人信息提醒放在较后位置，用户可能没看到就转发出去。',
        fix: '建议在报告开头也放一条「转发前请删除个人信息」的提示。',
      },
    ],
    checklist: [
      { item: '是否回答了用户真实问的问题（这份合同有没有坑）', ok: true, note: '直接给出 3 条高风险条款，并说明每条的损失量级' },
      { item: '是否只说了「有风险」而没有告诉用户怎么办', ok: true, note: '每条风险都配了可直接替换的合同文本和谈判话术' },
      { item: '普通人能不能看懂（避免堆砌法律术语）', ok: true, note: '法条只在必要处出现，并附了白话解释' },
      { item: '是否明确列出了我们替用户做的假设', ok: true, note: '风险清单「附二」列出 4 条假设，使用说明中再次说明' },
      { item: '是否交代了内容边界（不是法律意见）', ok: true, note: '使用说明「关于这份报告的边界」中明确声明' },
      { item: '关键数字是否复核过（违约金算例）', ok: false, note: '只核算了「住满 2 个月退租」一种情形，其余租期需用户按公式自行换算' },
    ],
  };

  // 确定性代码产出的安全审查结果（不是模型生成的）。
  // 交付物里确实出现了一个手机号（合同里的房东联系电话），所以是 notice + pii。
  // tests/unit/fixtures.test.js 会用 src/security/guard.js 的 auditJob() 复算一遍，防止这里写漂。
  const security = {
    level: 'notice',
    findings: [
      {
        kind: 'pii',
        detail:
          '产物里出现了疑似身份证号 / 手机号 / 银行卡号，可能是你自己的资料在交付物里。（发现 1 处：手机号 1 处）',
        action: '已标记提醒，但没有替你删除（可能是你需要的内容）',
      },
    ],
  };

  const usageMs = stages.reduce((s, x) => s + x.ms, 0) - 2340; // 有一部分时间不是模型调用

  return {
    id: jobId,
    goal: goalText,
    templateId: null,
    status: 'done',
    createdAt,
    updatedAt,
    plan,
    stages,
    artifacts,
    review,
    security,
    usage: {
      calls: 9,
      promptTokens: 18640,
      completionTokens: 8240,
      ms: usageMs,
    },
    clarifyQuestions: [],
    error: null,
  };
}

/* ================================================================== *
 * runDemoPipeline()
 * ================================================================== */

const abortError = () => {
  const e = new Error('演示流水线已被取消');
  e.name = 'AbortError';
  return e;
};

/** 可被 signal 打断的 sleep */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** 给 SSE 用的轻量 job 摘要：带完整 stages / plan / review / security，但不带产物正文（事件日志不能被正文撑爆） */
export function demoJobSummary(job) {
  return {
    id: job.id,
    goal: job.goal,
    templateId: job.templateId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    plan: job.plan,
    stages: job.stages.map((s) => ({
      id: s.id,
      key: s.key,
      title: s.title,
      role: s.role,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      ms: s.ms,
      reason: s.reason,
      log: s.log,
      output: s.output,
      error: s.error,
    })),
    artifacts: job.artifacts.map((a) => ({
      id: a.id,
      deliverableId: a.deliverableId,
      name: a.name,
      format: a.format,
      confidence: a.confidence,
      basedOn: a.basedOn,
      createdAt: a.createdAt,
    })),
    review: job.review,
    security: job.security,
    usage: job.usage,
    clarifyQuestions: job.clarifyQuestions,
    error: job.error,
  };
}

/**
 * 用假延时逐阶段「演出」一个 job。
 *
 * emit 的形状与 `events.publish(jobId, payload)` 的 payload 完全一致，
 * 所以 src/pipeline/engine.js 在 `demo:true` 时可以直接：
 *
 *   const job = await runDemoPipeline(goal, (payload) => events.publish(id, payload), { signal });
 *
 * 事件顺序（与 CONTRACT.md §2 的 SSE 事件表对应）：
 *   job(running) → 每个阶段 stage(running) + log… + stage(done) + job(快照)
 *   → artifact…（产物所属阶段结束时）→ review → security → done
 *
 * @param {string} goal 用户目标
 * @param {(event: object) => void} emit 事件回调，收到的是事件 payload 对象
 * @param {{signal?: AbortSignal, stepMs?: number, jobId?: string}} [opts]
 * @returns {Promise<object>} 完成态 Job（status: 'done'）
 * @throws {Error} name === 'AbortError' 当 signal 被触发
 */
export async function runDemoPipeline(goal = DEFAULT_DEMO_GOAL, emit = () => {}, opts = {}) {
  if (typeof emit !== 'function') {
    throw new TypeError('runDemoPipeline 需要 emit 回调函数');
  }
  const { signal = null, stepMs = 700, jobId } = opts;

  const full = demoJob(goal, jobId ? { jobId } : undefined);

  // 演出用的活对象：从「完成态」倒回「刚开始」，再一步步填回来
  const job = structuredClone(full);
  job.status = 'running';
  job.plan = null;
  job.artifacts = [];
  job.review = null;
  job.security = null;
  job.usage = { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 };
  job.updatedAt = job.createdAt;
  for (const st of job.stages) {
    st.status = 'pending';
    st.startedAt = null;
    st.endedAt = null;
    st.ms = null;
    st.log = [];
    st.output = null;
    st.error = null;
  }

  const checkAborted = () => {
    if (signal?.aborted) throw abortError();
  };

  emit({ type: 'job', job: demoJobSummary(job) });

  // 道具：产物在「属于它的最后一个阶段」结束时上场（按基于哪几个阶段产出决定）
  const artifactsByStage = new Map();
  for (const art of full.artifacts) {
    const last = art.basedOn[art.basedOn.length - 1];
    if (!artifactsByStage.has(last)) artifactsByStage.set(last, []);
    artifactsByStage.get(last).push(art);
  }

  for (let i = 0; i < job.stages.length; i += 1) {
    checkAborted();
    const live = job.stages[i];
    const script = full.stages[i];

    live.status = 'running';
    live.startedAt = Date.now();
    job.updatedAt = live.startedAt;
    emit({ type: 'stage', stageId: live.id, status: 'running', title: live.title, role: live.role });

    // 把这一阶段的日志铺在 stepMs 里逐步发出，而不是一口气全推
    const slice = Math.max(1, Math.round(stepMs / (script.log.length + 1)));
    for (const entry of script.log) {
      await sleep(slice, signal);
      checkAborted();
      const logItem = { at: Date.now(), level: entry.level, text: entry.text };
      live.log.push(logItem);
      emit({ type: 'log', stageId: live.id, level: logItem.level, text: logItem.text, at: logItem.at });
    }
    await sleep(slice, signal);
    checkAborted();

    live.status = 'done';
    live.endedAt = Date.now();
    live.ms = Math.max(1, live.endedAt - live.startedAt);
    live.output = script.output;
    live.reason = script.reason;
    job.updatedAt = live.endedAt;

    if (live.key === 'plan') {
      job.plan = structuredClone(full.plan);
    }
    // 用量随阶段推进累积，前端能实时看到「花了多少钱」
    job.usage.calls += live.key === 'plan' ? 2 : 1;
    job.usage.promptTokens += Math.round(full.usage.promptTokens / job.stages.length);
    job.usage.completionTokens += Math.round(full.usage.completionTokens / job.stages.length);
    job.usage.ms += live.ms;

    emit({ type: 'stage', stageId: live.id, status: 'done', title: live.title, role: live.role });

    for (const art of artifactsByStage.get(live.id) ?? []) {
      job.artifacts.push(structuredClone(art));
      emit({
        type: 'artifact',
        artifactId: art.id,
        name: art.name,
        deliverableId: art.deliverableId,
      });
    }

    if (live.key === 'verify') {
      job.review = structuredClone(full.review);
      emit({ type: 'review', review: structuredClone(full.review) });
    }

    emit({ type: 'job', job: demoJobSummary(job) });
  }

  checkAborted();
  job.security = structuredClone(full.security);
  emit({ type: 'security', security: structuredClone(full.security) });

  job.status = 'done';
  job.updatedAt = Date.now();
  emit({ type: 'job', job: demoJobSummary(job) });
  emit({ type: 'done', status: 'done' });

  return job;
}
