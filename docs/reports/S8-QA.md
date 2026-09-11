# S8（QA 工程师）工作报告 — 第 1 轮

时间：2026-09-12 02:55
职责：**这个项目里唯一能对产品说「不行」的人。**
本轮重点不是写多少测试，而是把「看起来对」的地方真的跑一遍 —— 包括跑真模型、跑真服务、跑真并发。

---

## 交付

| 文件 | 行数 | 状态 |
|---|---|---|
| `src/demo/fixtures.js` | 749 | ✅ 头号交付物：离线演示数据，严格符合 CONTRACT §2，8 阶段全跑完 |
| `tests/unit/gateway.test.js` | 661 | ✅ 42 个用例，全部 mock，绝不打真网络 |
| `tests/unit/fixtures.test.js` | 349 | ✅ 演示数据形状 + 自洽性校验（额外交付） |
| `tests/e2e/pipeline.test.js` | 545 | ✅ demo / 真实 / 失败边界 三段 |
| `tests/helpers/mock-llm.js` | 163 | ✅ 假 fetch / 假 sleep / 降级链（额外交付） |
| `tests/helpers/e2e-harness.js` | 243 | ✅ 剧本模型 + 临时数据目录 + 轮询等待（额外交付） |
| `scripts/smoke.js` | 253 | ✅ 一键冒烟，退出码 0/1，成功失败都自清理 |
| `docs/TESTING.md` | 129 | ✅ 测试指南 + 诚实列出 8 条测试盲区 |
| `docs/reports/S8-QA.md` | 本文件 | ✅ |

> 额外加的 `tests/unit/fixtures.test.js`、`tests/helpers/e2e-harness.js` 都是我自己的文件，
> 没有覆盖任何人的工作。`tests/e2e/pipeline.test.js` 后来被其他同学改过（把已修缺陷翻成正断言），
> 我本轮结束时把它跑通并做了最终校对。

---

## 我实际运行的验证（真实命令 + 真实输出）

### 1. 我负责的两个测试文件（完成标准 1）

```
$ npx vitest run tests/unit/gateway.test.js tests/e2e/pipeline.test.js
 ✓ tests/unit/gateway.test.js (42 tests) 366ms
 ✓ tests/e2e/pipeline.test.js (25 tests | 1 skipped) 35s
 Test Files  2 passed (2)
      Tests  58 passed | 5 expected fail | 1 skipped (64)
```

`it.fails` 的 5 条 = 已登记、**尚未修复**的缺陷（下面清单里的 #4 #5 #6 以及网关错误码那组），
每条都带 `【缺陷 #N】` 前缀；修好后会变红提醒你改成 `it(...)` 正断言。

### 2. 全仓测试（确认我没把别人的东西弄坏）

```
$ npx vitest run          # 连续跑两次都一样，已经稳定
 Test Files  8 passed (8)
      Tests  309 passed | 6 expected fail | 1 skipped (316)
```

### 3. 一键冒烟（完成标准 3）

```
$ node scripts/smoke.js
[smoke 0.0s] 使用端口 52052（非默认端口）
[smoke 0.1s] 健康检查：ok=true version=1.0.0 jobs=0
──────────────────────────────────────────────────────────────────
  冒烟结果摘要
──────────────────────────────────────────────────────────────────
  目标          帮我把这份租房合同看一遍，我怕有坑
  最终状态      done
  阶段          8/8 完成
  交付物        3 份
     · 合同风险清单（1955 字）
     · 给你的行动建议（1223 字）
     · 怎么用这份报告（640 字）
  质检结论      pass_with_notes
  安全等级      notice
  模型用量      9 次调用 / 18640+8240 tokens
  端到端耗时    5895 ms
  验收结论      ✅ 通过（CONTRACT §7 五条全满足）
──────────────────────────────────────────────────────────────────
[smoke 5.9s] 冒烟通过 ✅        EXIT=0
```

失败路径也验证过（故意占住端口）：`EXIT=1`，服务已关、临时目录已删、残留目录数 0。

### 4. 真实模式（完成标准 2）—— **默认 300 秒预算跑不完，如实报告**

```
$ HANDOFF_INTEGRATION=1 npx vitest run tests/e2e/pipeline.test.js -t "真实 goal"
 × 真实 goal → 跑到 done，至少 1 个交付物且正文 > 80 字  290537ms
   Error: 等待任务 job_5d9dea2e2ab242d3 超时（290000ms），最后一帧：status:"running"
 Test Files  1 failed (1)
```

同一时刻我从磁盘上抓到了它的真实进度（另一个 20 分钟的观测进程）：

```
status: running   （第 3 分钟时）
  intake   done  13.6s
  plan     done  10.9s
  draft    done  54.5s
  critique running —— 已跑 130+ 秒仍未产出（单次调用上限是 120 秒）
usage: { calls: 3, promptTokens: 3727, completionTokens: 7624, ms: 78924 }
```

结论：**真实流水线的耗时远超预期**，不是测试写错了。详见缺陷 #10（产品级风险）。
我把预算做成了可覆盖的（默认仍是任务书要求的 300 秒）：

```
HANDOFF_INTEGRATION_TIMEOUT_MS=1200000 HANDOFF_INTEGRATION=1 npx vitest run tests/e2e/pipeline.test.js
```

### 5. 演示数据自洽性（我额外验的，因为很多人依赖它）

```
$ npx vitest run tests/unit/fixtures.test.js
 ✓ 顶层字段与契约完全一致（不多不少）
 ✓ security 结论能被 src/security/guard.js 独立复算出来（fixture 没有撒谎）
 ✓ 满足 CONTRACT §7 的全部 5 条验收标准
 ✓ 每次调用都是全新对象 + 全新 id（并发创建演示任务不会互相污染）
```

---

# 我发现的真实缺陷清单

规则：**每条都能复现。** 已修复的保留在这里（附回归测试），因为「修过的东西再坏一次」是最常见的退化方式。

## A. 仍然是坏的（请 owner 认领）

### 🔴 #4 [高] 用户主动取消 → 任务被标成「失败」而不是「已取消」

**影响**：用户点取消，界面显示「失败了」并附一条错误信息。用户会以为是自己操作错了。
契约 §3 硬规则 4 要求「收到取消信号立刻停止并置 `cancelled`」。

**根因**：`src/pipeline/engine.js:293`
```js
const cancelled = err?.code === ERR.LLM_ABORTED || err?.code === ERR.PIPELINE_CANCELLED;
```
demo 路径按约定抛的是 `name:'AbortError'` 的普通 Error（没有 `code`），所以 `cancelled=false` → `job.status='failed'`。
真实模式走网关，抛的是带 code 的 AppError，所以只有 demo 路径中招。

**复现**：`npx vitest run tests/e2e/pipeline.test.js -t "取消"`
（`取消任务 → ...` 绿：断言现状是 `failed`、错误信息含「取消」；`【缺陷 #4】...应为 cancelled` 红）

**修法**：判定加一条 `|| err?.name === 'AbortError'`。**不要**改 fixtures 去抛 AppError —— 契约给我的接口就是抛 AbortError。

---

### 🔴 #5 [高] 「中途追加要求 / 回答澄清」100% 失败：前端发的字段名后端不认

**影响**：这是产品核心回路之一（补充要求 → 从 draft 重做；`awaiting_input` → 回答澄清）。
前端一发就是 400「消息内容不能为空。」，功能完全不可用。

**根因**：`public/api.js:136` 发 `{ message: ... }`；`src/routes/jobs.js:292` 读 `req.body?.text`。

**复现**：
```bash
npx vitest run tests/e2e/pipeline.test.js -t "字段名"
# 断言 {message:'...'} → 400，{text:'...'} → 200（这就是现状）
```
**修法**：后端同时接受 `text` 和 `message`（前端不用改，也不会再撞）；或统一改一侧。

---

### 🟠 #6 [中] 明明什么都没改，却告诉用户「已自动修正格式偏差」（修 #1b 时引入的回归）

**影响**：`notices` 是**给用户看的解释**（「诚实」是产品的四条差异化之一）。
现在每一次结构化模型调用都会推一条「已自动修正模型输出中的个别格式偏差（例如把 0.95 归一为 high）」，
哪怕输出完全合规。日志和用户提示都变得不可信。

**根因**：`src/llm/schema-check.js` 修好后，`coerceInPlace()` 的返回值改成
「哨兵 `NO_MATCH` 或替换值」，且**总是返回 `NO_MATCH`**（Symbol，真值）；
而 `src/llm/gateway.js:314` 仍然 `const changed = coerceInPlace(json, schema); if (changed) { notice(...) }` → 恒为真。
schema-check 里已经提供了正确的包装 `coerce(value, schema) → {value, changed}`，网关没用它。

**复现**：
```bash
npx vitest run tests/unit/gateway.test.js -t "已自动修正"
# 现状：「完全合规的输出」也会收到这条通知
```
**修法**：`gateway.js` 改用 `const { value, changed } = coerce(json, schema)`，`json = value`，`if (changed)` 再发通知。

---

### 🟠 #11 [中] 长文本协议改变后，draft/revise 的产物结构**没人校验了** → `confidence: "0.95"` 直接进交付物

**背景（这个改动本身是对的）**：draft/revise 现在走「定界符长文本协议」（`stages.js:133 callForArtifacts`，
`schema: null`）。原因写在注释里且我认同：让模型把 2000 字中文 markdown 塞进 JSON 字符串，
转义失败率高、要重试三四轮、跨两三个模型、100~300 秒 —— 对普通人就是「卡住了」。

**但代价是**：`schema: null` 意味着网关**完全跳过结构校验和语义收敛**，
而 `stages.js` 这边只检查了 `content.length > 80`。于是：

- `stages.js:171` 的「退路一」（模型偶尔还是输出 JSON 时）直接
  `return { artifacts: jsonAttempt.artifacts, ... }` —— **原样收下，不校验、不收敛**；
- 定界符路径（`stages.js:160`）也是直接把块里的 `confidence` 抄下来。

**实测（走真实网关，只替换 HTTP 传输层）**：
```
json.artifacts[0].confidence = "0.95"     ← 存进了 job，违反契约（只能是 high|medium|low）
draft.output = {"artifacts":[{...,"confidence":"0.95"}],"changeLog":[],"_protocol":"json"}
```
**影响**：前端 `public/app.js` 的 confidence 徽章映射表只有 `high/medium/low` → 徽章静默消失；
任何按契约读 `artifact.confidence` 的代码（包括我的 `fixtures.test.js` 断言）都会拿到非法值。
**注意**：同一份输出如果走 JSON 协议（`schema: SCHEMAS.draft`），网关是**能**把它收敛成 `high` 的
（我直接调网关验证过 ✅）—— 说明丢的是「长文本协议这条路径上的校验」。

**复现**：`npx vitest run tests/e2e/pipeline.test.js -t "confidence"`
（现状记录断言 `confidence === '0.95'`；`【缺陷 #11】...应为 high` 是 `it.fails`）

**修法（二选一，推荐第一条）**：
1. 在 `callForArtifacts` 收下 artifacts 的地方做一次**统一归一化**：
   `confidence: normalizeConfidence(b.confidence)`（`schema-check.js` 已经导出了 `mapConfidence`），
   `deliverableId` 也顺手兜底（`buildArtifacts` 目前有兜底，但更早挡住更省事）；
2. 或者在 `buildArtifacts` 落库前统一跑一次 `coerce(artifact, ARTIFACT_SCHEMA)`。

---

### 🟡 #7 [低] 端口被占用时，启动报的是 `TypeError` 而不是「端口被占用了」

**影响**：看到 `Cannot read properties of null (reading 'port')` 根本猜不到是端口冲突。

**根因（已定位到 Express 源码）**：`node_modules/express/lib/application.js:598-606` ——
Express 5 的 `app.listen(port, host, cb)` 会额外挂 `server.once('error', done)`，
**绑定失败时它会调用你传进来的那个「成功」回调，并把 error 当第一个参数传过去，然后被 `once` 吃掉**。
`src/server.js:305` 写的是 `app.listen(port, host, () => resolve(s))`（回调不看参数），
于是 promise 在**失败时被 resolve**，拿到一个 `address() === null` 的 server，随后 `.port` 抛 TypeError。

**复现（两条命令）**：
```bash
node -e "require('net').createServer().listen(8899,'127.0.0.1')" &
PORT=8899 node src/server.js
# 实际：[server] 启动失败：TypeError: Cannot read properties of null (reading 'port')  EXIT=1
# 期望：[server] 启动失败：EADDRINUSE: address already in use 127.0.0.1:8899（并提示换端口）
```
**修法**（一行）：
```js
const s = app.listen(port, host, (err) => (err ? reject(err) : resolve(s)));
```
**附带**：`PORT=0`（内核分配空闲端口）会被 `Number(process.env.PORT) || 8787` 吃掉、静默回落到 8787，
测试/多实例很容易撞端口。我的 smoke 脚本因此改成自己探一个空闲端口。

---

### 🟡 #8 [低] `.env.example` 里有变量没人读

`HANDOFF_DEMO=1`（写着「完全不调模型，用内置样例数据跑通全流程」）→ 全仓没有任何地方读它，
想演示只能走请求体 `{demo:true}`。
（`HANDOFF_LLM_TIMEOUT_MS` 本轮已被网关接上，`HANDOFF_PORT`/`HANDOFF_HOST` 也已被 server.js 接上 —— 这两条已修复。）

**复现**：`grep -rn "HANDOFF_DEMO" src/ scripts/ public/` → 无结果。
**修法**：实现它（作为默认 demo 开关），或从 `.env.example` 删掉。两者都行，必须选一个。

---

### ⚪ #9 [低·观察] 引擎的 Job 记录比契约冻结的形状「多字段」，且 demo 与真实模式的 stages 形状不同

- `src/pipeline/engine.js:121 buildJobRecord()` 比 CONTRACT §2 多了
  `templateTitle / audience / tone / deadline / demo / userMessages / amendedCount`；
  `makeStageRecord()` 多给阶段 `name / emoji / order / index`；`review` 多了 `reviewedAt`。
- 目前**没炸**（前端只用 `role / key / title / reason`），但有一个真实的不一致：
  我的 `fixtures.js` 是**严格契约形状**（任务书要求），所以 **demo 模式的 stages 少了 `name/emoji/order/index`**。
  将来谁写「按 `stage.order` 排序」「用 `stage.emoji` 当头像」，就会只在真实模式好用、**演示时一片空白**——
  这类 bug 最难查。
- 建议：要么给契约补 §2.1「引擎扩展字段」，要么让引擎记录回归契约形状。**契约是冻结的，我不改，请 main 决定。**

---

### 🔴 #10 [高] 真实任务跑 12 分钟后**彻底失败**：一个慢阶段被「超时 → 重试 → 降级」放大成 15 次尝试

这一条是我本轮最有价值的发现：**demo 模式一切正常，真实模式却拿不到交付物。**

**实测记录（真打模型，goal = 「用三句话解释什么是复利，给一个初中生看」）**：

| 阶段 | 结果 | 耗时 |
|---|---|---|
| intake | done | 13.6s |
| plan | done | 10.9s |
| draft | done（产出 2 份交付物，1342/1499 字） | 54.5s |
| **critique** | **failed** | **632.2s（10.5 分钟）** |
| revise / verify / deliver | 从未开始 | — |

```
整任务耗时：712.7 秒（11.9 分钟）
最终状态：failed
usage: { calls: 3, promptTokens: 3727, completionTokens: 7624, ms: 78924 }
error: { code: "LLM_NO_PROVIDER",
         message: "所有模型都没能完成任务。最后一次的失败原因：模型响应超时（120 秒）。",
         attempts: 15 }
```

**发生了什么**（`attempts: 15` 是决定性证据）：
1. critique 这一次调用**顶到了 120 秒的单次上限**（`gateway.js:216` 默认 `timeoutMs = 120000`）；
2. 网关把**超时也当成网络抖动来重试** —— 同一个 provider 连试 3 次（每次 120 秒）；
3. 然后沿降级链换下一个 provider，再试 3 次……5 个 provider × 3 次 = **15 次尝试**；
4. 全部超时 → 抛 `LLM_NO_PROVIDER` → 第 5 个阶段失败 → **整个任务 failed**。

**为什么这是「高」而不是「产品建议」**：
- 用户是**普通人**：他等了 12 分钟，得到的是一句「所有模型都没能完成任务」，
  前面 draft 已经写好的两份交付物也没被呈现给他（job 状态是 failed）。
- 触发条件是**任何一次大输出的调用变慢**，而 critique/revise 天生要读全部产物、写大量内容 ——
  这不是小概率事件，是**结构性风险**：把「慢」放大成「失败」。
- 我自己写的集成测试（300 秒预算）因此**必红**；把预算放到 1200 秒后，
  跑出来的是「204 秒后 failed」——**不是测试的问题，是流水线过不去**。

**建议（需要 S1 + S3 一起定，我建议全做）**：
1. **超时不要重试 3 次**：超时通常意味着这次就是慢，重试只会再等一遍 120 秒。
   最多重试一次，或者直接换 provider。
2. **大生成阶段单独给 timeoutMs**（例如 300–600 秒），别让 120 秒卡住正常的 2000 字中文输出；
   engine 现在根本不传 `timeoutMs`，全是默认值。
3. **给阶段设总时长上限 + 让用户看见**：`while (超时)` 的循环里必须能告诉用户
   「这一步已经花了 10 分钟，我们在换模型」，而不是沉默。
4. （长期）critique/revise 改用流式输出或更小的 `maxTokens`，别让单次调用承担全部内容。

**复现**：
```bash
HANDOFF_INTEGRATION=1 HANDOFF_INTEGRATION_TIMEOUT_MS=1200000 \
  npx vitest run tests/e2e/pipeline.test.js -t "真实 goal"
# 观察：204 秒后 failed（更早的一次：712 秒后 failed，error.attempts = 15）
```

**附带的记账问题（低）**：`usage.calls` 只有 3 —— 15 次失败尝试一次都没记账，
用户看到的「模型用量」严重偏低，排查时也会误判。

---

## B. 本轮发现、并已被对应 owner 修复（附回归测试，防复发）

### ✅ #1 [严重] 引擎的 `optional()` 把 store / demo / guard 全加载成 null

**当时的实测证据**：
```
deps.saveJob : null    deps.getJob : null    deps.demo : null    deps.guard : null
```
**三个后果**（全都随修复消失）：
1. `demo:true` 的任务 3ms 内 `failed`，错误「演示模式暂时不可用」—— **离线演示能力整个是坏的**；
2. 引擎退回内存 Map、**不落盘**：`GET /api/jobs/:id` 永远返回创建时的空快照（阶段 0 个）；
3. `deps.guard` 为 null → `sanitizeUserInput` / `auditJob` 全跳过，**安全审查静默不跑**，
   `job.security` 恒为 null，而 CONTRACT §7.4 要拿它判验收。

**现状**：`src/pipeline/engine.js:46` 已修（不传 exportName 时返回整个 namespace，并记录加载失败原因）。
**回归测试**：`tests/e2e/pipeline.test.js` → `回归：引擎依赖装载` 两条（依赖全就绪 + 任务真的写到磁盘）。

### ✅ #1b [严重] 语义收敛把整份输出改成 `true`（自家「救命」功能变成「杀手」）

draft 阶段的 schema 就是 `artifacts[].confidence ∈ {high,medium,low}`，
而模型（代码注释里就写着 DeepSeek-V4.1-Flash）会把 confidence 写成 `"0.95"` ——
一写成这样，`coerceInPlace` 就把**整个 artifacts 数组替换成布尔 `true`**：

```js
coerceInPlace({artifacts:[{name:'清单',confidence:'0.95'},{name:'建议',confidence:'high'}]}, draftSchema)
→ json 变成 {"artifacts": true} → 校验报「类型应为 array，实际是 boolean」
```
这是真实流水线的必经之路，**每个真任务都可能当场失败**。
**现状**：`src/llm/schema-check.js` 已修（返回值语义 = 哨兵 + `changed` 输出参数）。
**回归测试**：
- `tests/unit/gateway.test.js` → `回归：语义收敛不能损坏同级字段`（3 条）；
- `tests/e2e/pipeline.test.js` → `回归：模型把 confidence 写成 "0.95" → 自动收敛成 high，任务照常 done`
  （走**真实网关**，只替换 HTTP 传输层；8 阶段全跑完、正文 1955 字）。

### ✅ #2 [严重] 交付物正文没送到前端 → 成果面板空白

**当时**：`publicJob()` 把 artifacts 剥成元信息（无 `content`/`assumptions`/`basedOn`），
而 `public/app.js:976/945/950` 只读 `art.content` → 交付物正文空白、复制和下载都是空的；
`app.js:897` 的变更签名用 content 长度（恒 0）→ 重渲染也不触发。CONTRACT §2 明确要求全量。
**现状**：已修（详情接口现在带正文；事件里的快照用轻量元信息 + `bytes`，两不耽误）。
**回归测试**：`回归（缺陷 #2 已修复）：GET /api/jobs/:id 的 artifacts 带 content`。

### ✅ #3 [中] SSE 首帧快照不是全量 → 刷新页面后流水线视图重建不出来

契约 §2 要求「连接时先补发全量快照（含完整 stages）」，实际首帧只有 `stageCount`，
前端 `app.js:630` 的 `Array.isArray(incoming.stages)` 判断直接把它忽略了。
**现状**：已修（`summarize()` 现在带回 `stages`，且刻意不带阶段产出正文）。
**回归测试**：`SSE 补发的 job 快照应含完整 stages` + `快照里不能夹带阶段产出正文`（后一条是 S3/S4 加进我文件的，我保留并校对过）。

---

## 需要别人配合的事

| 找谁 | 事 |
|---|---|
| S3（engine） | **#4** 取消判定（一行）、**#10**（最高优先）大生成阶段的超时/重试策略、**#11** artifacts 归一化 |
| S2（prompts） | **#10/#11**：critique/revise 的提示词与 maxTokens 是否过大、长文本协议的产物校验 |
| S4（routes） | **#5** `message`/`text` 字段名；**#7** `startServer` 的 listen 回调（一行） |
| S1（llm） | **#6** 把网关接到新的 `coerce()` 上；**#10** 超时与重试 |
| S5（前端） | **#5** 配合字段名；**#10** 给用户「还要多久」的预期 |
| main | **#9** 契约形状的决定；**#8** `HANDOFF_DEMO` 实现或删除 |

---

## 下一轮我建议做什么

1. **先修 #10**：现在真实模式**跑不到 done**，这是「产品能不能用」的问题，比任何单测都重要。
   修完请跑 `HANDOFF_INTEGRATION=1` 复测，我可以把结果补进报告。
2. **把剩下 6 条 `it.fails` 逐条翻正**：红着的用例是待办清单，不是噪音。
   谁修完谁把 `it.fails` 改成 `it`（注释里写了怎么改）。
3. **把 #10 变成可测的数字**：给每个阶段记录耗时，加一条「端到端 < N 分钟」的回归门槛。
   现在只有「能不能跑完」，没有「跑多久算合格」。
3. **补 SSE 断线重连的真实验证**：`Last-Event-ID` 补发 + 15 秒心跳 + 代理后断网，
   现在只验了协议形状（见 TESTING.md 盲区 2）。
4. **交付物「有用性」抽检**：现在只断言 `length > 80`。建议加关键要素检查
   （合同审查必须出现「押金/维修/违约金」），成本很低，能挡住「正确的废话」。
5. **一次真的 `kill -9` 断电演练**，确认 `json-store` 的原子写不留半截 JSON。
6. **并发压一压**：现在只测 5 个 demo 任务；建议 20 个任务，看事件日志上限（500/任务）
   和内存上限（200 个 job）先在哪里爆。

---

## 附一：本轮的一个流程观察（对收尾有用）

开发是并行进行的，**文件在被改的同时被我测试**，我至少遇到 3 次
「跑全仓测试红、单独跑同一个文件绿」的情况（每次都是别人正在写那个文件）。
这不是 bug，但收尾时要注意：

- 交接前请**冻结代码 5 分钟**，再跑一次 `npx vitest run` + `node scripts/smoke.js`；
- 本轮最后我跑到的是：我负责的两个文件 **61 passed / 6 expected fail / 1 skipped**；
  全仓 8 个文件 **309 passed / 6 expected fail / 1 skipped**，连续两次一致。
- 过程中我自己也踩到一个 flake 并修掉了：持久化是「内存对象先变、磁盘写入异步」，
  断言 `existsSync` 会偶发失败 —— 已改成给落盘 5 秒等待窗口。
  （顺带一个小观察：`GET /api/jobs/:id` 读的是内存缓存里那个**活对象**，
  所以客户端可能在落盘完成前就看到终态。单进程下不影响正确性，但崩溃时会有「界面说好了、
  文件里没有」的窗口，建议终态先落盘再对外可见。严重度低，记录在此。）

## 附二：真实模式实跑记录

**第一轮（JSON 协议时期，默认 300 秒预算）**：
```
status:   running（290 秒时仍在 critique 阶段，未跑完）
intake:   done 13597ms
plan:     done 10867ms
draft:    done 54480ms
critique: running（130+ 秒，单次调用上限 120 秒）
usage:    { calls: 3, promptTokens: 3727, completionTokens: 7624, ms: 78924 }
```
**第二轮（定界符长文本协议之后，1200 秒预算）**：见下方实测输出。

**第二轮（定界符长文本协议之后，1200 秒预算）**：
```
× 真实 goal → 跑到 done，至少 1 个交付物且正文 > 80 字   204.48s
  AssertionError: expected 'failed' to be 'done'
```
在同一份代码上用观测脚本复跑（打印全部阶段与 error）得到：
```
critique: failed（632s）  error.attempts = 15  error.message = 模型响应超时（120 秒）
```
**第三轮（当前代码，观测脚本，只统计到卡住为止）**：
```
intake done 8.6s | plan done 13.1s | draft done 32.5s（比 JSON 协议快了不少 ✅）
critique running —— 158 秒仍未产出，usage.calls 停在 3（= 又进入了超时-重试链）
```
三轮结论一致：**真实模式目前跑不到 done**，卡在第 5 个阶段（critique）的超时重试链上。
（顺带确认：长文本协议确实让 draft 从 54.5s 降到 32.5s，这个改动的方向是对的；
卡点只剩 critique —— 它仍然是 JSON schema 阶段，要读全部产物还要写大段内容。）
