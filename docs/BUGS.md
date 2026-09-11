# 交接 Handoff — 缺陷登记表（BUGS）

> 维护者：**S9 对抗性测试工程师**
> 规则：每条必须有可复现的命令/步骤、真实输出、契约依据、根因代码位置、
> **对普通人的影响（用户会看到什么）**、以及具体到怎么改的建议。
>
> 状态说明：`OPEN` = 当前仍然坏；`FIXED-DURING` = 我在攻击过程中复现到了，
> 但代码在我做别的攻击时被同事改动，现已不能复现（保留原始输出供核对）。
>
> 与 `docs/reports/S8-QA.md` 的去重：S8 已登记的 #4/#5/#6/#7/#8/#9/#10/#11 本文不再重复。
> 本文只写 S8 与 S6 报告里**没有登记**的缺陷。

---

## 快速索引

| 编号 | 严重度 | 一句话 | 状态 |
|---|---|---|---|
| [S9-1](#s9-1) | 严重 | 删除正在跑的任务，流水线把文件写回来，任务在历史里复活 | FIXED-DURING |
| [S9-2](#s9-2) | 严重 | 并发 `retry` 全部 200，同一个任务被多条流水线同时跑 | OPEN |
| [S9-3](#s9-3) | 中等 | 畸形 URL（`#/job/%E4%B8`）抛未捕获 URIError，路由进入"卡死"状态 | OPEN |
| [S9-4](#s9-4) | 中等 | 并发 `message` 全部 200，一条留言变成 5 条 + 5 条并行流水线 | OPEN |
| [S9-5](#s9-5) | 中等 | SSE 补发不齐时静默少发，用户看到的进度会永远停在半路 | OPEN |
| [S9-6](#s9-6) | 中等 | 任务不存在时界面说"网络好像断了"，还让用户去检查 Wi-Fi | OPEN |
| [S9-7](#s9-7) | 低 | 失败后 retry，重跑期间 `job.error` 还是旧错误 | FIXED-DURING |
| [S9-8](#s9-8) | 低 | 第 201 个及更早的中断任务永远不会被恢复，永久卡在"运行中" | OPEN |
| [S9-9](#s9-9) | 低 | `goal` 不做类型校验：数字/布尔/数组/对象都能建任务 | OPEN |
| [S9-10](#s9-10) | 低 | 超过 200 个任务后，更早的任务从历史列表消失（但还在磁盘上） | OPEN |
| [S9-11](#s9-11) | 低 | 删除任务后，服务端心跳仍每 15 秒往已删除任务的连接里发数据 | OPEN |

---

<a id="s9-1"></a>
## S9-1 [严重] 删除正在运行的任务后，任务会「僵尸复活」回到历史列表

**状态**：FIXED-DURING（00:09 复现到，00:18 代码被同事改动后不再复现；测试已改成正向断言钉住）

**复现**（当时的原始探测脚本，03:09 运行）：

```bash
cd /Users/imac/260912/handoff && node .probe/probe2.mjs
```

```js
const c = await request(app).post('/api/jobs').send({ goal: '删除竞态测试', demo: true });
const id = c.body.job.id;
await wait(2000);                    // 流水线跑到中途
const d = await request(app).delete(`/api/jobs/${id}`);
console.log('DELETE:', d.status);
await wait(8000);
const g = await request(app).get(`/api/jobs/${id}`);
console.log('GET:', g.status, g.body.job?.status);
console.log('file:', fs.existsSync(path.join(dir, 'jobs', `${id}.json`)));
```

**实际结果**（原文）：

```
t=1000ms DELETE=200 | before[status=failed stages=0 arts=0] imm[NO-FILE(ENOENT)] after8s[NO-FILE(ENOENT)] GET=404 inList=false
t=2000ms DELETE=200 | before[status=running stages=0 arts=0] imm[NO-FILE(ENOENT)] after8s[status=cancelled stages=0 arts=0] GET=200 inList=true
t=3000ms DELETE=200 | before[status=running stages=0 arts=0] imm[NO-FILE(ENOENT)] after8s[status=cancelled stages=0 arts=0] GET=200 inList=true
t=3500ms DELETE=200 | before[status=running stages=0 arts=0] imm[NO-FILE(ENOENT)] after8s[status=cancelled stages=0 arts=0] GET=200 inList=true
t=4000ms DELETE=200 | before[status=running stages=0 arts=0] imm[NO-FILE(ENOENT)] after8s[status=cancelled stages=0 arts=0] GET=200 inList=true
t=5000ms DELETE=200 | before[status=running stages=0 arts=0] imm[NO-FILE(ENOENT)] after8s[status=cancelled stages=0 arts=0] GET=200 inList=true
```

删除**成功了**（文件那一瞬间确实没了），但 8 秒后任务又回到了磁盘上、`GET` 返回 200、
并且重新出现在历史列表里。

**期望结果**：`DELETE /api/jobs/:id` 成功后该任务永久消失。契约 §2 把 `DELETE` 定义为"删除任务"，
用户点删除之后不该再看到它。

**根因**：`src/routes/jobs.js:314-330` 的删除顺序是
`cancelJob()`（只置 abort 标志）→ `store.deleteJob()` → 返回 200。
而 `cancelJob` 只是让流水线在**下一个阶段边界**抛 `PIPELINE_CANCELLED`；
`src/pipeline/engine.js` 的 `failJob()` 会重新 `load(job)` → 改状态 → `save(job)`，
这个 save 发生在 delete 之后，于是文件被重新写出来。
（`store` 的 per-id 写锁只保证同一个 id 的写不交叉，不保证"删掉之后不再写"。）

**影响**：用户点「删除」，界面提示成功、任务从列表消失；**刷新页面之后它又回来了**，
状态是"已取消"。用户会以为删除功能坏了，或者更糟——以为自己的隐私数据删不掉。

**建议修法**：
1. 让删除变成"先等流水线真的停"再删盘：
   ```js
   cancelJob(job.id);
   await engine.waitForStop(job.id);   // engine 侧导出 running.get(id)?.promise 并 await
   await store.deleteJob(job.id);
   ```
2. 或者给 job 打墓碑标记：`store.deleteJob` 之后把 id 记进一个 `deletedIds` 集合，
   `saveJob` 遇到墓碑 id 直接丢弃写入（`src/store/json-store.js` 的 `withLock` 内部判断）。
3. 补一条回归：`tests/adversarial/state-machine.test.js` → 「DELETE 一个正在跑的任务之后，
   12 秒内它不能被写回来」。

---

<a id="s9-2"></a>
## S9-2 [严重] 并发调用 `POST /api/jobs/:id/retry` 全部成功，同一个任务被多条流水线同时跑

**状态**：OPEN（已在 `tests/adversarial/state-machine.test.js` 用 `it.fails` 固化）

**复现**：

```bash
npx vitest run tests/adversarial/state-machine.test.js -t "S9-2"
```

等价的手工复现（真服务）：

```bash
# 1. 起一个 demo 任务，趁它在跑
curl -s -XPOST localhost:8787/api/jobs -H 'content-type: application/json' \
     -d '{"goal":"并发重试","demo":true}'
# 2. 同时发 5 次 retry
for i in $(seq 5); do curl -s -o /dev/null -w "%{http_code} " -XPOST localhost:8787/api/jobs/$ID/retry & done; wait
```

**实际结果**（原始输出）：

```
retry statuses: 200,200,200,200,200
retry2 statuses: 200,200,200,200,200
retry2 running.has: true
```

契约要求"任务正在执行中"必须 409（`src/pipeline/engine.js:1088` 的
`if (running.has(jobId)) throw 409`），但 5 个并发请求**全部 200**。

**期望结果**：只有 1 个 200，其余 4 个 409。契约 §2 的 `retry` 语义是"从失败阶段重试"，
不是"再开一条流水线"。

**根因**：`retryJob()`（`src/pipeline/engine.js:1084-1105`）是 **check-then-act**：
`await load(jobId)` 之后才 `if (running.has(jobId))`，而 `running.set(jobId, …)`
在更后面（1101 行）。两个请求都能在对方 `running.set` 之前通过检查。
`sendMessage()`（1011 行）有同样的结构。

**影响**：
- 用户手抖双击「重试」，或前端按钮被点了两次 → **同一个任务跑两遍**。
  真实模式下这意味着**模型被调用两遍**（用户按 token 付费，直接多花钱），
  而且两条流水线会互相覆盖 `job.stages` / `job.artifacts`。
- 更糟的是取消不了：`running` Map 里只剩后写进去的那个 controller，
  前一条流水线变成孤儿，`DELETE` 只能 abort 其中一条。
- 交付物可能出现重复条目或"上一轮的产物混进这一轮"。

**建议修法**：把"占位"提前到任何 `await` 之前（Sync 抢占），例如
```js
export async function retryJob(jobId) {
  if (running.has(jobId)) throw new AppError(ERR.BAD_REQUEST, '任务正在执行中。', { status: 409 });
  const controller = new AbortController();
  const claim = { controller, promise: null };
  running.set(jobId, claim);                       // ← 先占位，再 await
  try {
    const job = await load(jobId);
    if (!job) { running.delete(jobId); throw new AppError(ERR.NOT_FOUND, '没找到这个任务。', { status: 404 }); }
    const promise = rerunFrom(job, fromKey, controller.signal).catch((err) => failJob(jobId, err));
    claim.promise = promise;
    return job;
  } catch (err) { running.delete(jobId); throw err; }
}
```
`sendMessage` 同法。另外建议在路由层加一个 per-id 互斥（`json-store` 已经有 `withLock`，
可以复用它做"同一 id 的启动请求串行化"）。

---

<a id="s9-3"></a>
## S9-3 [中等] 畸形 URL 抛未捕获异常，整个路由进入「卡死」状态

**状态**：OPEN（`tests/adversarial/routes-and-stream.test.js` 用 `it.fails` 固化）

**复现**（真实浏览器，Chrome）：

```js
// 地址栏手输（%E4%B8 是一个被截断的 UTF-8 中文）
http://127.0.0.1:8912/#/job/%E4%B8
```

**实际结果**（原始输出，`page.evaluate` 抓到的未捕获异常）：

```
AFTER malformed nav: {"hash":"#/job/%E4%B8","errs":["Uncaught URIError: URI malformed","Uncaught URIError: URI malformed"], ...}
```

随后整个路由失效，而且**不能自愈**：

```
#/job/%     → errs: ["Uncaught URIError: URI malformed"]
#/nosuchroute → errs: ["Uncaught URIError: URI malformed"]   ← 后续正常路由也报错
```

**期望结果**：`parseRoute()` 是纯函数，契约 §6 要求"空状态与失败状态必须好看"、
`public/ui.js` 的注释也写着"其它/空 → 首页兜底，绝不白屏"。畸形编码应当当普通未知路由处理。

**根因**：`public/ui.js:413`：

```js
const parts = raw.split('/').filter((p) => p.length > 0).map((p) => decodeURIComponent(p));
```

`decodeURIComponent('%E4%B8')` 抛 `URIError`。调用方 `public/app.js` 的
`handleRoute()`（≈1433 行）没有 try/catch，`window.onerror` 之外没有任何兜底，
异常从 `hashchange` 监听器里冒出去 → 本次渲染中断 → `currentView` 停在旧视图上。

**影响**：用户从微信/邮件里点开一个被截断的链接（`%` 编码在 IM 里非常容易被截断），
页面停在"上一个任务的界面"或半成品界面，**点什么都没反应**；他不知道要手动改地址栏。
这类"看起来没坏、其实已经死了"的状态比白屏更让人困惑。

**建议修法**（一行 + 一条兜底）：
```js
const decode = (p) => { try { return decodeURIComponent(p); } catch { return p; } };
const parts = raw.split('/').filter((p) => p.length > 0).map(decode);
```
另外给 `handleRoute` 包一层 try/catch，出错时渲染一个"这个地址看不懂，回首页"的空状态。

---

<a id="s9-4"></a>
## S9-4 [中等] 并发 `POST /api/jobs/:id/message` 全部被接受，一条留言变 5 条 + 5 条并行流水线

**状态**：OPEN（`tests/adversarial/state-machine.test.js` 用 `it.fails` 固化）

**复现**：

```bash
npx vitest run tests/adversarial/state-machine.test.js -t "S9-4"
```

手工复现（真服务，5 个并发）：

```
msg setup status: awaiting_input
message statuses: 200,200,200,200,200
message error codes: OK,OK,OK,OK,OK
message final status: running userMessages: 5 amendedCount: 5
message running.has: true
```

**期望结果**：`awaiting_input` 状态下发一次回答就该恢复执行；第二个并发请求应当 409
（`src/pipeline/engine.js:1011` 明确写了"任务正在执行中，请等它跑完再补充要求。"）。

**实际结果**：5 条全部 200，`userMessages` 和 `amendedCount` 都变成 5，
并且开了多条并行流水线（`running.has: true`）。

**根因**：与 S9-2 同源 —— `sendMessage()` 的 `running.has()` 检查发生在
`await load(jobId)` **之后**，而 `running.set()` 在 1036 行。`awaiting_input` 的任务
不在 `running` 里，所以这个窗口特别大。

**影响**：普通用户的真实操作是"在输入框里按了两次回车"或"手机网络卡，用户又点了一次发送"。
结果：他的一句话被当成 5 条要求，任务**被重做 5 遍**。真实模式下就是 5 倍的模型费用；
演示模式下界面会来回跳，用户以为程序疯了。

**建议修法**：同 S9-2 的"先占位再 await"。另外前端 `public/app.js` 的发送按钮应当在
请求发出后立即 `disabled`，直到收到响应（双保险）。

---

<a id="s9-5"></a>
## S9-5 [中等] SSE 补发不齐时静默少发，进度会永远停在半路

**状态**：OPEN（`tests/adversarial/routes-and-stream.test.js` 用 `it.fails` 固化）

**复现**：

```js
// 直连 util/sse.js，700 条事件全部发完
for (let i = 1; i <= 700; i++) events.publish(id, { type:'log', text:`#${i}` });
// 客户端说它只收到第 1 条（比如它在第 2 条到达时断网，10 分钟后才回来）
const req = mkReq({ 'last-event-id': '1' });
const res = mkRes();
sseHandler({ jobId: id, req, res });
```

**实际结果**（原文）：

```
cursor: 700 since(0) len: 500 first seq: 201
Last-Event-ID=1     → 补发 500 帧, 首帧 seq=id: 201
Last-Event-ID=690   → 补发 10 帧,  首帧 seq=id: 691
```

客户端要求从 `seq=1` 补发，服务端只给了 `201..700` —— **第 2..200 条永久丢失**，
而且响应里没有任何"你漏了 X 条"的信号。`events.since()` 注释里也承认这是刻意的上限
（`MAX_LOG_PER_JOB = 500`、`MAX_REPLAY = 500`）。

**期望结果**：契约 §2 承诺"连接时先补发全量快照，这样前端刷新页面不会丢状态"。
补不齐的时候，服务端应当要么**改发一条全量快照**（`{"type":"job","job":{...}}`），
要么发一条明确的 `{"type":"gap"}` 让前端知道要重新拉快照。

**根因**：三条叠加
1. `src/store/events.js:34-36` 环形缓冲上限 500，旧的直接 `splice` 丢弃；
2. `src/util/sse.js:118` `events.since(jobId, cursor).slice(-MAX_REPLAY)` 静默截断；
3. `public/app.js:641` 的 `onEvent` 只处理已知 type，未知 type 直接忽略，没有断档检测。

**影响**：用户把任务详情页开着放到后台（手机锁屏、切到别的 App），回来时
EventSource 自动重连、界面显示"已连接，进展会实时更新"，但**阶段卡片停在半小时前的状态**，
而且永远不会再前进 —— 因为后续增量事件只推新的，丢掉的中间状态没有补。
用户会一直等一个其实早就完成的任务。

**建议修法**：在 `sseHandler` 里比较 `cursor` 与 `events.since(jobId, 0)[0].seq`：
```js
const oldest = events.since(jobId, 0)[0]?.seq ?? 0;
if (cursor > 0 && cursor < oldest - 1) {
  // 补不齐了：明确告诉客户端，让它重新拉一次全量快照
  write(formatSse({ type: 'resync', reason: 'history_truncated', from: cursor, oldest }));
}
```
前端收到 `resync` 就 `refreshSnapshot()`。

---

<a id="s9-6"></a>
## S9-6 [中等] 任务不存在时，界面说「网络好像断了。检查一下 Wi-Fi」——让用户去排查一个根本不存在的问题

**状态**：OPEN（浏览器实证，测试见 `tests/adversarial/input-validation.test.js` 的 404 用例）

**复现**（真实浏览器）：访问一个已经删除（或属于别的 data 目录）的任务：

```
http://127.0.0.1:8912/#/job/doesnotexist
```

**实际结果**（页面正文原文）：

```
首页 / 历史任务 / 任务详情 / 网络好像断了。检查一下 Wi-Fi，然后点重连。 / 重连 /
正在加载… / 你的团队 / 点任意一位，看他具体做了什么。 / 正在读取任务… / 交付物 / 验收 / 安全检查
```

同时确认 API 返回的是**语义明确的 404**，不是网络错误：

```bash
$ curl -s -o /tmp/o.json -w "%{http_code} " http://127.0.0.1:8912/api/jobs/job_doesnotexist1234
404 {"error":{"code":"NOT_FOUND","message":"找不到这个任务。"}}
```

**期望结果**：契约 §6「空状态与失败状态必须好看」，而且**必须说对原因**。
用户看到"网络断了"会去重启路由器、换 Wi-Fi，而他真正需要知道的是
"这个任务不存在（可能已经被删了）"。

**根因**：`public/api.js` 的 `getJob` 把非 2xx 一律抛成 `Error`，
`public/app.js:588-601` 的 `refreshSnapshot()` 的 catch 是空的
（注释写着"快照失败不改界面"），而 `openStream` 的 `onerror` 在
`readyState === 2` 时把连接状态置为 `offline` → 界面就显示"网络好像断了"。
结果：**HTTP 404 被呈现成网络故障**。同时 `'loading'` 状态下的占位文案
（"正在加载…" / "正在读取任务…"）在失败后**永远不消失**。

**影响**：这是"错误归因"型伤害：用户被告知一个错误的排查方向，
反复刷新、换网络都没用，最后认为产品坏了。分享一个已删除任务的链接是常见场景。

**建议修法**：
1. `api.js` 保留状态码：`throw Object.assign(new Error(msg), { status, code })`；
2. `refreshSnapshot` 的 catch 里按状态码分支：404 → 渲染
   "这个任务不存在（可能已经被删掉了）"+「回首页」按钮；其它 → 网络错误文案；
3. SSE `onerror` 时，如果当前 `jobStatus === 'error'`，不要把连接状态也改成 `offline`
   （原因已经说清楚了，不要再叠加一个错误归因）。

---

<a id="s9-7"></a>
## S9-7 [低] 失败后 retry，重跑期间 `job.error` 还是旧错误

**状态**：FIXED-DURING（03:09 复现，03:22 已不复现；测试已改成正向断言）

**复现**（当时的探测脚本 `peek3.mjs`，03:09）：

**实际结果**（原文）：

```
BEFORE retry status: failed error: {"code":"LLM_NO_PROVIDER","message":"第一次必失败。","attempts":null}
BEFORE stages: [{"key":"intake","status":"failed","logs":1,"err":"第一次必失败。"}]
retry: 200
AFTER retry status: running error: null
AFTER stages: [{"key":"intake","status":"running","logs":0,"err":null}]
```

03:09 那次观测到的是「`status: running` 但 `error` 仍是旧错误」，界面会同时显示
"运行中"和一条红色错误。03:22 复测已是 `error: null`、日志归零。

**期望结果**：重跑开始后，`job.error` 必须为 null；被重置阶段的 `log` 清空。
（`rerunFrom()` 只重置 `fromKey` 及其**之后**的阶段 —— 这是有意的，前面阶段的日志要保留。）

**根因（当时）**：`retryJob()` 里先 `job.error = null; await save(job)`，再由
`rerunFrom()` 里 `execute()` 重跑；两者之间如果有界面拿到中间快照，就会看到
"运行中 + 旧错误"。现在 `rerunFrom` 里也统一置 null 了。

**影响**：用户点了重试，界面同时显示"进行中"和"上次失败原因：……"，
会以为重试根本没生效，又点一次（这就撞上 S9-2 的并发缺陷）。

**建议修法**：保持现状即可；补一条回归测试
（`tests/adversarial/state-machine.test.js` → 「retry 之后，旧阶段日志和旧 error 必须清干净」）。

---

<a id="s9-8"></a>
## S9-8 [低] 第 201 个及更早的中断任务永远不会被恢复，永久卡在「运行中」

**状态**：OPEN（`tests/adversarial/state-machine.test.js` 用 `it.fails` 固化）

**复现**：

```bash
npx vitest run tests/adversarial/state-machine.test.js -t "S9-8"
```

```js
// 磁盘上有 205 个 job，其中前 3 个 status='running'（模拟上次进程被杀）
// 重启：内存清空 → listJobs(200) 只拿到最近 200 个
await markInterruptedJobs();
// 检查磁盘上还有没有 status==='running'
```

**实际结果**：

```
D markInterruptedJobs recovered: 0 仍卡在 running: ["job_000000000000","job_000000000001","job_000000000002"]
```

（`src/server.js:302` 用的是 `store.listJobs(200)`，而 `json-store` 的内存上限也是 200，
所以更早的任务根本进不了这次扫描。）

**期望结果**：`markInterruptedJobs()` 的注释写着"上次进程被强杀时，正在跑的任务会永远停在
running —— 比报错更糟，因为他会一直等"。这个承诺必须对**所有**任务成立，
而不是只对最近 200 个。

**根因**：`src/server.js:302` `const jobs = await store.listJobs(200);`
+ `src/store/json-store.js:315` `listJobs` 的 `limit` 被夹在 `MAX_MEMORY_JOBS`(200) 内，
且只遍历内存缓存。磁盘上更早的 job 永远不会被扫到。

**影响**：老用户（攒了 200 个以上任务）重启电脑后，一个早先中断的任务在历史里
一直显示"进行中"，进度条永远不动，点进去也没有重试入口（重试按钮只在 failed 状态出现）。
用户会一直等，或者反复重启服务——而重启永远修不好它。

**建议修法**：`markInterruptedJobs()` 不依赖内存缓存，直接扫磁盘目录
（`fs.readdir(jobsDir)` + `readFileSafe`），或者给 `listJobs` 增加
`{ fromDisk: true }` 分支按文件 mtime 分页扫描。数量不大（一个 job 一个文件），启动时扫全量完全可行。

---

<a id="s9-9"></a>
## S9-9 [低] `goal` 不做类型校验：数字 / 布尔 / 数组 / 对象都能建出任务

**状态**：OPEN（`tests/adversarial/input-validation.test.js` 用 `it.fails` 固化）

**复现**：

```bash
for body in '{"goal":12345}' '{"goal":true}' '{"goal":["a","b"]}' '{"goal":{"a":1}}'; do
  curl -s -XPOST localhost:8787/api/jobs -H 'content-type: application/json' \
       -d "$body" | head -c 120; echo
done
```

**实际结果**（原文，我的探测脚本输出）：

```
6 goal number → 201 len=5
6 goal bool   → 201 len=4
6 goal array  → 201 len=1
6 goal object → 201 len=15
```

对照（同一个请求里存进去的 goal）：

```
goal 是纯对象时，存进去的是 "[object Object]"
```

**期望结果**：契约 §2 定义 `"goal": "..."`（字符串，1..4000 字）。
类型不是字符串时应当 400 —— 与 `templateId`、`tone` 的处理保持一致（那两个是宽容处理，
但方向是"变成 null/默认值"，而 `goal` 是**核心输入**，静默变成 `[object Object]` 是错的）。

**根因**：`src/routes/jobs.js:42` `const goal = stripControlChars(raw).trim();`
→ `String(input).replace(...)`：任何类型都被 `String()` 吃掉，没有 `typeof raw !== 'string'` 的判断。
引擎侧 `src/pipeline/engine.js:172` 也一样是 `String(input?.goal ?? '')`。

**影响**：
- 恶意/脚本客户端能用 `{"goal": {"a":1}}` 建出一个目标是「[object Object]」的任务，
  界面、下载文件、交付物里全是这个字符串；
- 更现实的是**前端 bug 会被掩盖**：如果哪天前端把 `{text, files}` 对象误传成 `goal`，
  用户会得到一个跑得好好的、目标是 `[object Object]` 的任务，而不是一个清晰的 400。
- 这类"垃圾进、正常出"的行为让排查成本极高。

**建议修法**：在 `requireGoal` 首行加
```js
if (typeof raw !== 'string') throw bad('需求描述必须是文字，请把你想做的事用一句话写下来。');
```
引擎侧 `startJob` 同样加一道（防御性，因为引擎也能被直接调用）。

---

<a id="s9-10"></a>
## S9-10 [低] 超过 200 个任务后，更早的任务从历史列表消失（但还在磁盘上）

**状态**：OPEN（`tests/adversarial/routes-and-stream.test.js` 的容量用例固化）

**复现**：

```bash
node -e "…连续 saveJob 205 个…"   # 见 tests/adversarial/routes-and-stream.test.js
curl -s localhost:8787/api/jobs        | jq '.jobs | length'   # 50（契约固定）
curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/api/jobs/job_000000000000
```

**实际结果**（原文）：

```
CAP list length: 50 contains job_000000000000: false
CAP GET oldest evicted id: 200 disk file exists: true
CAP health jobs: 200
```

**期望结果**：`GET /api/jobs` 只承诺"最新 50 条"，这没错；但内存缓存上限 200 是**实现细节**，
不该变成用户可见的"任务消失"。至少要在列表接口明确告诉用户
"只显示最近 N 条，更早的在 data 目录里"，或者提供分页。

**根因**：`src/store/json-store.js:20` `MAX_MEMORY_JOBS = 200` +
`cachePut()`（153-161 行）按 `updatedAt` 淘汰；
`listJobs()`（313 行）只读内存缓存，不回落磁盘。

**影响**：用了一两个月的老用户，历史页里**最早的任务凭空消失**了，
但他去 `data/jobs/` 里还能看到那些文件。用户会怀疑"我的东西是不是被删了"，
而这个产品最核心的卖点之一就是"数据只在你自己的电脑上"。这条缺陷直接伤害信任。

**建议修法**：`listJobs(limit, { offset })` 在缓存不足时回落到磁盘目录扫描
（按文件 mtime 排序），并在响应里带上 `total`；前端历史页加"加载更多"。

---

<a id="s9-11"></a>
## S9-11 [低] 删除任务后，服务端心跳仍每 15 秒往已删除任务的连接里发数据

**状态**：OPEN（`tests/adversarial/routes-and-stream.test.js` 的 drop 用例固化）

**复现**：

```js
const cleanup = sseHandler({ jobId: id, req, res });
events.drop(id);          // 等价于 DELETE /api/jobs/:id 里的那一行
await sleep(15000);
console.log(res.chunks.filter(c => c === ': ping\n\n').length);
```

**实际结果**（原文）：

```
after drop: 连接2 还挂着的监听数 = 0
after drop publish → 连接2 收到帧数: 500
connected 帧仍在，心跳定时器仍然活着（cleanup 未被调用）
```

`events.drop()` 做的是 `removeAllListeners` —— 它把**订阅**摘掉了，但 SSE 连接、
心跳定时器、以及 `res` 上的 4 个监听器全都还在。只要浏览器不关这个标签页，
它就会每 15 秒收一次心跳，永远收不到任何业务事件。

**期望结果**：任务被删除时，属于它的 SSE 连接应当被主动关闭（发一条
`{"type":"error","message":"这个任务已被删除"}` 然后 `res.end()`），
让前端能提示用户并断开。

**根因**：`src/store/events.js:63-66` `drop()` 只清内部状态；
`src/util/sse.js` 的心跳闭包与 `events` 之间没有"job 已删除"的通知通道。

**影响**：用户删掉一个长任务后，标签页看起来还在"已连接，进展会实时更新"，
实际上永远不会再更新；同时每个这样的僵尸连接都占着一个 socket + 一个 15 秒定时器。

**建议修法**：`events.drop()` 在 `removeAllListeners` 之前先 `emit(jobId, {type:'dropped'})`，
`sseHandler` 收到 `dropped` 就写一条 error 帧并 `cleanup()`。

---

## 附：我验证过、**没有**发现缺陷的方向（避免重复劳动）

| 方向 | 结论 |
|---|---|
| 交付物名字的**响应头注入**（`\r\n`、`"`、`%00`、`;`） | 全部被 `sanitizeFilename` + RFC 5987 中和，头里没有裸 CR/LF，也没有第二个头 |
| `artifactId` / `jobId` 的路径穿越 | 双层校验（正则 + `path.resolve` 前缀断言），`../../../etc/passwd` 一律 404，不泄漏文件系统信息 |
| `/../src/server.js` 等静态目录穿越 | Express 静态中间件 + SPA 兜底，只会返回 index.html，拿不到源码 |
| 100MB 请求体 | 413 + 契约形状的错误体，不崩、不 OOM |
| 原子写盘 / 并发写同一文件 | 20 个 job × 30 次并发 `updateJob`，期间 221,840 次读取：0 次 JSON 解析错误、0 次半截文件、0 个残留 `.tmp`，计数全对 |
| 20 个任务并发跑完之后 | 无串号（goal/artifacts 都对）、`events.listenerCount` 全为 0、磁盘文件全部合法 |
| 200 次并发 GET 同一个任务 | 响应互相独立，没有共享对象被改写 |
| SSE 立刻断开 100 次 ×4 轮 | 监听器/定时器归零，无泄漏 |
| 前端 XSS（裸 script / onerror / iframe / `javascript:` / 大小写 / HTML 实体 / 制表符） | DOM 里 `script` 只有 app.js 一个；`on*` 属性 0 个；`href` 里 0 个危险协议；`window.__XSS_FIRED` 始终为 null |
| 全流程外部请求 | `performance.getEntriesByType('resource')` 里 0 个非本机请求（承诺的"零外部依赖"成立） |
| 375px 移动端 | 四个页面 `scrollWidth === clientWidth`（无横向滚动）、没有小于 32px 的点击目标 |
| 3000+ 字交付物渲染 | 53ms 完成，30KB HTML / 891 个节点，无卡顿 |
| 键盘走完「新建 → 看结果」 | Tab 顺序完整、焦点环可见、能 Tab 到"复制"按钮；仅"提交后焦点丢到 body"这一处（已记在报告里，未列为缺陷） |
