# 变更记录

本文件按**模块**归类，不逐条抄 commit message。原始提交历史：

```
5f74ff4 fix: grade 字段入详情接口 + 质检员防止过度严苛 + research 阶段克制策略
4c2813d fix: 修复 QA 登记的 6 个缺陷 + 长文本协议 + 崩溃恢复（端到端首次全部通过）
f1a8535 feat(core): 提示词库、流水线引擎、8 个场景模板、网关语义收敛
59f00f5 chore: 冻结工程契约 v1.0 与项目骨架
```

> **版本快照说明：** 这份记录整理时，代码仍在被并行修改（我读的 40 分钟里 `src/prompts/index.js`
> 从 598 行长到 621 行、`src/pipeline/engine.js` 从 1119 行长到 1127 行、多了一个提交 `5f74ff4`、
> `tests/e2e/pipeline.test.js` 被重写、`docs/PLAYBOOK.md` 从不存在变成 213 行）。
> 本文所有论断都在最后一次读取上复核过；**凡是引用同事报告的地方，报告可能比代码旧**。

---

## [0.1.0] - 2026-09-12

首个可用版本。目标：普通人说一句人话，一支可见的 AI 团队把它变成能直接用的文档。

### 新增

**契约与骨架**（`59f00f5`）
- `docs/CONTRACT.md` v1.0：仓库结构、HTTP API、Job 形状、SSE 事件、流水线契约、安全契约、验收标准。文件所有权一人一文件，防止并行开发互相覆盖。
- `docs/BRIEF.md`：子代理入口简报。
- `.env.example`、`.gitignore`、`package.json`（Node ≥22.5，3 个依赖）。

**模型层**（`f1a8535` + `4c2813d`）
- `src/llm/gateway.js`：四层保护的 `callModel()`——超时、重试、5 级降级链、总时间预算。超时与用户取消通过 `timeoutFlag` 区分。
- `src/llm/providers.js`：provider 定义 + 三级密钥解析（显式 → 环境变量 → Cherry Studio 只读 sqlite）。`baseURL` 为固定常量（防 SSRF）。
- `src/llm/schema-check.js`：自写 Schema 校验（不引 ajv）+ **语义收敛**（`0.95`→`high`、删多余字段、形状对齐）+ 把硬性约束渲染进提示词。
- `src/llm/json-repair.js`：五级 JSON 抢救（剥围栏 → 括号配对 → 机械修复 → 补闭合）。
- `src/llm/errors.js`：错误码 + `AppError` + `redactSecrets()`。
- `src/llm/text-protocol.js`：**长文本定界符协议**解析器（`<<<ARTIFACT>>>` / `<<<ASSUMPTIONS>>>` / `<<<END>>>`）+ 截断检测 `looksTruncated()` + 复审协议 `parseIssueBlocks()`。

**流水线**（`f1a8535` + `4c2813d`）
- `src/pipeline/engine.js`：编排核心。`startJob` 立即返回、流水线后台跑；`intake`/`plan` 硬编码在主流程；`normalizeStages` 自动修正阶段编排；`buildArtifacts` 在 deliverableId 对不上时按顺序兜底**绝不丢内容**；`validateDelivery` 与 `gradeDelivery` 实现分层验收；`sendMessage`/`retryJob`/`cancelJob`。
- `src/pipeline/stages.js`：8 个阶段定义与执行器、`normalizeStages` 的 6 类修正规则、`callForArtifacts`（长文本路径 + 截断补写 + JSON 退路 + 无定界符退路）。
- `src/prompts/index.js`：8 个角色的提示词、8 份 JSON Schema、虚拟员工名册 `TEAM`、token 预算 `MAX_TOKENS`、`wrapUntrusted` 可注入实现。
- `templates/*.json`：8 个场景模板（合同审查、投诉信、健康准备、求职、人生决策、理财、学习计划、教学材料）。
- `src/demo/fixtures.js`：749 行离线演示数据 + `runDemoPipeline`，形状严格对齐契约。

**服务层**（`f1a8535` + `4c2813d`）
- `src/server.js`：`createApp()`（顶层不 listen）、`.env` 之外的配置读取、自写滑动窗口限流（10/min、20/min）、256kb 体积上限、健康检查、模板加载、SPA 兜底、全局错误处理、进程守卫。
- `src/routes/jobs.js`：任务 CRUD + 下载端点 + 输入校验 + 文件名清洗（防响应头注入、目录回溯、Windows 保留名）+ RFC 5987 中文文件名。
- `src/routes/stream.js` + `src/util/sse.js`：SSE 补发、去重、心跳、清理。
- `src/store/json-store.js`：原子写（`.tmp` + fsync + rename）、per-id 串行队列、200 条内存 LRU、30 秒磁盘同步、路径穿越双重校验。
- `src/store/events.js`：事件总线 + `seq` 游标日志 + `newId()`。

**安全**（`f1a8535` + `4c2813d`）
- `src/security/guard.js`：约 30 条中英文注入检测规则、NFKC + 零宽归一化、标签逃逸防护、特殊 token 打断、PII / 密钥 / 危险指令 / HTML 输出审计、base64 夹带检测。

**前端**（零依赖、零构建）
- `public/index.html` / `app.js` / `ui.js` / `api.js` / `styles.css`：hash 路由四视图、`JobView` 局部 patch、自写 markdown 渲染器（逐段先转义）、链接协议白名单、断线重连横幅、骨架屏、深浅色、360px 移动端、可访问性。

**工程设施**
- `tests/`：8 个测试文件、316 个用例（含 5 个 `it.fails` 缺陷登记）。
- `tests/helpers/mock-llm.js`、`tests/helpers/e2e-harness.js`：手写假 fetch / 假 sleep / 剧本模型（不引 nock、msw）。
- `scripts/dry-run.js`（真打模型，按契约 §7 逐条打勾）、`scripts/smoke.js`（一键冒烟，起真服务 + 自清理）。
- `README.md`、`docs/SECURITY.md`、`docs/TESTING.md`、`docs/reports/S4/S5/S6/S8`。

### 修复

提交 `4c2813d` 集中修掉 QA 登记的 6 个缺陷，`5f74ff4` 补上质量分级与提示词调优，两条都在代码里留下 ⚠️ 教训注释：

- **可选依赖加载静默返回 null**：`optional(spec, exportName)` 的四个调用点都不传 `exportName`，导致 store/demo/guard 全部加载成 `null`。后果是**演示模式整个是坏的、数据只落内存重启即丢、安全审查静默不跑**。修复后不传 `exportName` 时返回整个 namespace，并记录加载失败原因。
- **语义收敛把整份输出改成布尔 `true`**：`coerceInPlace` 返回布尔 `changed`，调用方当成替换值赋回 → `{artifacts: true}`。修复后改用 `NO_MATCH` 哨兵 + `changed` 输出参数，并让 `normalizeEnum` 只处理标量。
- **交付物正文没送到前端**：`publicJob()` 剥掉了 `content`，成果面板空白、复制下载都是空的。修复后详情接口带正文。
- **SSE 首帧快照不是全量**：`summarize()` 只有 `stageCount`，刷新页面后团队区一直显示"正在集结"。修复后带上完整 `stages`，同时剥掉几万字的 `stage.output`。
- **draft 输出被截断在半句话上**：`MAX_TOKENS.draft` 从 8000 提到 24000（"按实际用量计费，没写满的部分不要钱，宁可给太多绝不给不够"），并新增 `looksTruncated` 检测 + 补写一轮。
- **SSE 首字节延迟 15 秒**：加了立即下发的 `: connected` 注释帧。
- **SSE 用 `Set` 去重导致内存泄漏**：改成单调游标 `lastSent`。
- **Express 5 中路由之后注册的中间件不执行**：限流曾因此完全失效（11 次请求全部 201）。限流器改为在 `createApp()` 内部、挂路由之前注册。
- **`redactSecrets()` 大小写敏感导致大写密钥泄漏**：guard 内部补了一遍大小写不敏感的打码，并让检测按原文/全小写/全大写三种形态各判一次。
- **PII 正则漏检与撞车**：`\b` 在中文旁边不成立（`手机138…` 漏检）、身份证里会匹配出第二个"手机号"。改用前后非字母数字断言。
- **HTML 实体绕过**（`&#60;script&#62;`）与 **base64 夹带注入**：分别加实体解码和一层 base64 解码检测。
- **`rm -rf` 变体漏检**：补齐 `rm -fr /`、`rm -r -f /`、`--no-preserve-root`、中文紧贴写法。
- **500 个字面空格被算作有效产出**：`auditJob` 改数去掉空白后的字符数。
- **NFKC 归一化污染用户正文**：中文标点被收敛成半角。改为**检测用归一化副本、返回用原文副本**。
- **前端 store 订阅者的路由守卫写错**，导致历史页永远停在骨架屏；**SSE 快照未校验任务身份**，导致整页被别的任务顶掉；**SSE 元信息快照冲掉已拿到的交付物正文**。三条都是"单测全绿、真机才暴露"。
- **markdown 渲染顺序错误**：先整行转义导致代码块永远认不出来；占位符用 NUL 被 `stripControlChars` 自己吃掉（改用私用区 `\uE000`）。
- **`optional()` 之外的崩溃恢复**：新增 `markInterruptedJobs()`，启动时把上次被强杀留下 `running`/`queued` 的任务标成可重试的 `failed`（`code: INTERRUPTED`），避免用户对着一个**永远不会再往前走的进度条**干等。
- **`HANDOFF_DEMO` 环境变量全仓没人读**：新增 `src/runtime-flags.js`，把整站演示模式接上（README 里承诺过）。
- **端口/主机读错了变量名**：曾用通用的 `PORT`/`HOST`，按文档设 `HANDOFF_PORT` 却监听 3000。改为优先读 `HANDOFF_*`。
- **`POST /message` 字段名不一致**：契约写 `{text}`、前端发 `{message}`，追加要求/回答澄清 100% 返回 400。后端改为两个名字都收。
- **取消任务被标成 `failed`**：demo 路径抛的是 `name: 'AbortError'` 的普通 Error，引擎只看 `err.code`。判定改为同时接受 `err.name === 'AbortError'`。
- **端口被占用时报 `TypeError`**：`app.listen` 的回调不看参数、失败时也被 resolve，随后 `address().port` 抛错。改为检查 error 参数。

提交 `5f74ff4` 补齐的三处：

- **`grade`（交付质量的一句话结论）进了详情接口**。之前 `gradeDelivery()` 只出现在 SSE 事件里，用户刷新页面走 `GET /api/jobs/:id` 时拿不到，界面就不知道该怎么提示"质检提了几条意见"。`publicJob()` 现在带 `grade`。
- **质检员被明确要求区分"不够完美"和"不能用"**。原提示词写着"不要轻易给 pass"，实测矫枉过正：用户等了几分钟、拿到能用的东西，却因为"缺少用户没提供的信息"被判 `needs_revision`。新提示词要求只判**执行团队自己造成的**问题——"放水不对，但**过度严苛同样是失职**"。checklist 下限从 3 条提到 4 条。
- **`research` 阶段的取舍标准写清楚了**：涉及法规/医疗/税务/劳动纠纷才查；纯写作、纯算数、用户已给全材料的任务不查（"它很花时间，用户要多等半分钟"）。
- **`routes/jobs.js` 的 engine 导入改成 namespace + 运行时兜底**。原因是测试会 `vi.mock()` 整个 engine 模块，具名导入会变成 `undefined` 并在调用处崩；而 `vi.mock()` 的 Proxy 让 `typeof x === 'function'` 判断本身就会抛错，所以必须真的 `try/catch`。注释里写着："这个坑很隐蔽：单测全绿、e2e 全绿，只有'有人 mock 了这个模块'时才炸。"

### 已知问题

**这一版不是无 bug 的版本。** 以下是导出时仍然成立的问题，按严重度排。

#### 交付不过关（产品能不能用）

- **真实模式跑不到 `done`（缺陷 #10，未修）**。慢阶段被"超时 → 重试 → 降级"放大：`timeoutMs` 默认 120s、`MAX_ATTEMPTS = 2`、5 个 provider，最坏十几分钟才失败。实测 `critique` 阶段 632 秒、`attempts: 15`、整任务 712 秒后 `failed`。已从 3 次尝试缩到 2 次，但 engine **完全不传** `timeoutMs`/`budgetMs`，问题没有真正解决。附带：失败尝试不计入 `usage.calls`，用户看到的用量严重偏低。

#### 契约违反

- **长文本协议下 artifacts 不校验也不收敛（缺陷 #11，未修）**。`draft`/`revise` 走 `schema: null`，`confidence: "0.95"` 会直接进 `job.artifacts`，违反"只能是 high/medium/low"。JSON 退路同样原样收下。前端徽章映射表没有这个值 → 徽章静默消失。
- **`pickLevel` 把密钥泄漏判成 `blocked`**，与 `guard.js` 明确的"`blocked` 只留给完全没产出"相反。
- **验收标准 §7.3 未按契约字面实现**：`verdict === 'needs_revision'` 不再判失败，改为交付并标注（这是有意的产品决策，见 `docs/DECISIONS.md` ADR-016）。
- **契约 §4 与代码不一致**：契约说"重试 2 次（共 3 次）"，代码是 2 次尝试；契约的降级链是 4 级，代码是 5 级；契约说 `maxTokens` 默认 4000，`draft`/`revise` 实际传 24000。**以代码为准。**

#### 测试与文档的红灯

- **测试套件全绿，但 5 条 `it.fails` 是"已知缺陷登记"，不是通过**。当前实测：`310 passed | 5 expected fail | 1 skipped (316)`，8 个文件全过。这 5 条 expected fail 覆盖的是**仍然坏的**行为（超时放大、长文本协议下的 confidence 校验等）——**它们绿着恰恰说明缺陷还在**。修好任何一条，对应的 `it.fails` 会变红，提醒你改成 `it(...)`。
- **`.env` 文件根本不会被加载**。没有 `dotenv`，脚本里也没有 `--env-file`。README 和 `.env.example` 都让用户"复制成 `.env` 自己填"——实测把 `HANDOFF_PORT=59999` 写进 `.env` 后启动，**监听的是 8787**。所有配置只能靠真实环境变量（`HANDOFF_PORT=59999 npm start` 是有效的）。
- **`AIPING_BASE_URL` 没有任何代码读它**（`.env.example` 里列了）。provider 的 `baseURL` 是硬编码常量——这本身是防 SSRF 的正确设计，但 `.env.example` 会误导人。
- **`docs/PLAYBOOK.md` 曾经不存在**（`README.md` 的文档表格把它列为第一项，却没人写它）。**在我整理这份记录期间已被补上**（213 行）。这条留在这里是因为它说明了一类问题：**文档表格里的承诺需要有人对着 `ls` 核一遍**。
- **契约 §1 提到的 `src/util/ids.js` 不存在**（`newId` 在 `src/store/events.js`；`BRIEF.md` 第 49 行已声明该文件作废，契约没同步）。
- **`docs/CONTRACT.md` §6 第一行"首页(亮亮亮)"** 疑似笔误。

#### 安全（诚实说明）

- **`redactSecrets()` 大小写敏感**：`SK-abcdef…` 不会被打码。guard 内部自己绕过了，但**其他所有直接调用点（日志、HTTP 错误、SSE）仍带着这个洞**。
- **leetspeak 与同形字绕过未修**（`Ign0re previ0us…`、西里尔 `іgnore`）——假阳性代价高于收益，刻意不修。
- **base64 只解一层**，且只认"长 ≥24 且解码后可读"的候选段。多层编码、URL-safe 变体仍能绕过（这是刻意的 DoS 上限）。
- **注入检测本质上是关键词 + 语序匹配，会被同义改写绕过**。真正的防线是 `<user_input>` 结构隔离，不是规则表。
- **`describeSecurity()` 只覆盖已知的 6 种 kind**，新增 kind 会从文案里静默消失。

#### 架构与运维

- **运行态是单进程内存 Map**：重启即丢；多实例部署互相看不见。重启时正在跑的任务会永远停在 `running`（已用 `markInterruptedJobs` 缓解为"标成可重试的失败"）。
- **事件日志在内存里，进程重启即空**，每 job 上限 500 条。"刷新页面不丢状态"只在同一进程内成立。
- **限流是进程内 Map**，且 `trust proxy` 硬编码 `false`。反向代理后面所有用户共用一个 IP，限流退化。
- **任务列表固定 50 条、无分页**；内存最多 200 个 job。
- **崩溃安全没有真演练过**：`store` 的原子写有单测，但"写盘写到一半被 kill -9"没有真跑（`docs/TESTING.md` 盲区 4）。
- **`HANDOFF_LLM_TIMEOUT_MS` 在两处实现**：`src/runtime-flags.js` 的 `llmTimeoutMs()` 新增后**没有任何地方 import**（死导出），gateway 仍在自己读 `process.env`。

#### 演示模式与真实模式不一致

- **缺陷 #9**：demo 的 stage 形状严格对齐契约，**没有** `name/emoji/order/index`；真实模式有。按这些字段渲染的界面代码会"真实模式好用、演示时空白"。
- demo 跑得极快（毫秒级），与真实模式的耗时体验完全不同，容易让人误判性能。

#### 健康检查与诊断

- **`optionalLoadIssues` 是死导出**：注释说"记录加载失败的原因供 `/api/health` 查看"，但 `/api/health` 从来不读它。可选依赖失败仍然不可见——正是这个数组当初要解决的问题。
- **`auditJob` 的 `security` 参数永远是 `undefined`**：`runSecurityAudit` 少传一个参数，导致 `guard.js` 里"把输入阶段的注入 finding 带进最终 `job.security`"那段是死代码。
- **前端 `friendlyError()` 映射了后端不产生的错误码**（`VALIDATION_ERROR`/`JOB_NOT_FOUND`/`LLM_ALL_PROVIDERS_FAILED`），而后端最常抛的 `LLM_NO_PROVIDER` 和崩溃恢复的 `INTERRUPTED` **不在表里** → 用户看到英文错误码原文。

---

## 版本号说明

`package.json` 与 `src/server.js` 的 `VERSION` 都是 `1.0.0`，而 `docs/CONTRACT.md` 自称 v1.0。
本文用 `0.1.0` 记录**首次可用**，理由：交付物质量仍不过关（真实模式跑不到 `done`），
按语义化版本不该是 1.x。**要发布前请先把两个地方统一，别让"1.0.0"变成一个没人信的承诺。**
