# 测试指南（写给后面的维护者）

> 这份文档的目标：**你不需要重新推导一遍，就能知道该跑什么、什么时候会红、以及哪里其实没测到。**
> 最后更新：2026-09-12（QA 工程师 S8）

---

## 1. 三十秒上手

```bash
# 全部单测 + e2e（e2e 的 demo 模式离线跑，不需要网络和 Key，约 40 秒）
npx vitest run

# 只跑我负责的两块
npx vitest run tests/unit/gateway.test.js tests/e2e/pipeline.test.js

# 一键冒烟：起真服务（非默认端口）→ 建 demo 任务 → 核对验收标准 → 自清理
node scripts/smoke.js          # 退出码 0 = 通过

# 真打模型（慢，需要网络 + 一个可用的 Key，会自动从 Cherry Studio 读）
HANDOFF_INTEGRATION=1 npx vitest run tests/e2e/pipeline.test.js
```

**测试栈**：vitest 5 + supertest。**不新增依赖**是硬约束，所以没有 nock、没有 msw ——
所有网络替身都是手写的（见 `tests/helpers/`）。

---

## 2. 测试金字塔（以及每一层防的是什么）

```
        ▲  node scripts/smoke.js            ← 一键冒烟：起真服务走真 HTTP。防「装不起来 / 端口读错 / 起不来」
        │  tests/e2e/pipeline.test.js       ← 端到端：HTTP → 引擎 → 交付物。防「模块都对但接不上」
        │  tests/unit/*.test.js             ← 单元：每个模块自己的边界。防「逻辑错」
        ▼  tests/helpers/                   ← 替身：mock-llm（模型）、e2e-harness（剧本模型 + 装配）
```

### 这些测试文件分别归谁
| 文件 | 归属 | 覆盖什么 |
|---|---|---|
| `tests/unit/gateway.test.js` | QA (S8) | 重试 / 降级 / JSON 抢救 / 超时 / 取消 / 密钥不泄漏 / 退避抖动 |
| `tests/unit/fixtures.test.js` | QA (S8) | 演示数据的形状与自洽（严格对齐 CONTRACT §2） |
| `tests/e2e/pipeline.test.js` | QA (S8) | demo 模式、真实模式、失败保留产物、取消、并发 5 个任务 |
| `tests/helpers/mock-llm.js` | QA (S8) | 可控的假 fetch / 假 sleep（**绝不打真网络**） |
| `tests/helpers/e2e-harness.js` | QA (S8) | 剧本模型（按阶段返回合法 JSON）、临时数据目录、轮询等待 |
| `tests/unit/security.test.js` | S6 | 注入检测 / PII / 转义 / 限流规则 |
| `tests/unit/routes.test.js` | S4 | HTTP 端点正常路径 + 错误路径 |
| `tests/unit/store.test.js` | S4 | 原子写、并发串行化、路径穿越 |
| `tests/unit/frontend.test.js` | S5 | markdown 渲染 / XSS 中和 / 状态映射 |

---

## 3. 哪些测试需要网络（重要）

| 测试 | 需要网络？ | 条件 |
|---|---|---|
| `tests/unit/gateway.test.js` | ❌ 绝不 | 所有 fetch 都是 `tests/helpers/mock-llm.js` 的桩。**如果你发现它变慢了，说明有桩没注入进去** |
| `tests/unit/fixtures.test.js` | ❌ | 纯数据 + 假延时 |
| `tests/e2e/pipeline.test.js` A 段（demo） | ❌ | `demo:true` 完全不调模型 |
| `tests/e2e/pipeline.test.js` C 段（失败与边界） | ❌ | 用剧本模型，或临时替换 `globalThis.fetch` |
| `tests/e2e/pipeline.test.js` B 段（真实模式） | ✅ | 只有 `HANDOFF_INTEGRATION=1` 时才运行，默认 300 秒预算（可用 `HANDOFF_INTEGRATION_TIMEOUT_MS` 放宽） |
| `scripts/smoke.js` | ❌ | 走 `demo:true` |

**为什么会有一条真跑测试**：mock 再全也证明不了「我们的请求格式、Key 解析、真实模型的输出，
凑在一起能不能跑通」。这一条就是那道保险，代价是慢和可能因为上游抖动而红。

---

## 4. 几条很容易踩的测试纪律

1. **`sleep` 必须 mock。** 网关失败时会退避（600ms 起，指数增长）。
   不 mock 的话一个用例就要等好几秒，而且会 flaky。`makeSleep()` 记录等待时长但不真的等。
2. **不要用 `vi.useFakeTimers()` 配 async。** 本项目一律用「注入假 sleep + 假 fetch」，
   比假时钟稳得多，也更容易看出被测代码到底等了几次。
3. **给网关传 `deps`**：`{ fetch, chain, resolveKey, env, sleep }`。
   网关的依赖全部走 `opts.deps`，就是为了让测试能这样注入（它也绝不在模块顶层读环境变量）。
4. **假 fetch 必须响应 `init.signal`**（`hangingFetch()` 就是这么写的）。
   否则超时 / 取消路径根本测不出来 —— 真实 fetch 会 abort，假的也必须会。
5. **e2e 里改 `engine.deps.callModel` 后要挂到任务跑完再还原。** 流水线在后台跑，
   提前还原会让后面的阶段去打真网络，测出来的失败原因是错的。
6. **`it.fails(...)` 是「已知缺陷」的登记方式。** 缺陷修好后它会变红 ——
   那不是回归，而是提醒你把它改成 `it(...)` 正断言。每条都带 `【缺陷 #N】` 前缀，
   对应 `docs/reports/S8-QA.md` 的缺陷清单。
7. **临时数据目录用完必须删。** `makeTempDataDir()` / `cleanupTempDataDir()` 成对使用；
   `scripts/smoke.js` 在 `finally` 里关子进程 + 删目录，成功失败都清理。

---

## 5. 已知的测试盲区（诚实列出，别以为绿了就没事）

这些地方**没有自动化覆盖**，改动时请人工确认：

1. **真实模型的输出质量。** 我们只验证「引擎能不能处理模型的输出」，
   不验证「模型写得好不好」。真实模式测试只断言 `content.length > 80`，
   一份胡说八道但很长的交付物同样会通过。
2. **真实 SSE 在浏览器里的行为。** e2e 用 Node 的 `fetch` 读流，验证了协议形状
   （`event: message` / `id:` / 首帧快照）；
   但 EventSource 的自动重连、`Last-Event-ID` 补发、15 秒心跳在代理后的表现，
   都没有自动化测试（建议上线前人工断网试一次）。
3. **前端视觉与交互。** 没有浏览器测试（不引入依赖的代价）。
   「空状态好不好看」「360px 下会不会横向滚动」这类只能人看。
4. **持久化的真实崩溃场景。** `store` 的单测覆盖了原子写和并发串行化，
   但「写盘写到一半被 kill -9」没有真跑过（用的是临时文件 + rename 的推理保证）。
5. **限流在多进程/多实例下的行为。** 限流是进程内 Map，单进程正确；
   多实例部署时形同虚设（也没有 `trust proxy`，反向代理后面所有用户共用一个 IP）。
6. **长任务与内存上限。** 事件日志每任务最多 500 条、内存最多 200 个 job，
   但没有跑过「几十个任务同时跑 10 分钟」的压力测试。
7. **`HANDOFF_INTEGRATION` B 段的稳定性。** 它依赖真实上游，可能因为限流/网络而红；
   我们把它单独隔离，不让它拖累日常测试。
8. **Windows / 非 macOS。** Key 自动解析依赖 `~/Library/Application Support/CherryStudio`
   （macOS 路径），其他平台只能靠环境变量，这条路径没有测试。

---

## 5.1 缺陷状态（2026-09-12 05:xx 更新）

> ⚠️ **这一节曾经严重过期。** 它最初写的是"QA 本轮结束时还没修的缺陷"，
> 但开发在它写完之后继续推进，全部修完了。过期的"待办清单"比没有清单更糟 ——
> 下一个人会照着它去排查已经不存在的问题。
>
> **教训：凡是"当前状态"类的文档，都要写清快照时间。**
> 本节对应的代码快照：提交 `7280f8e` 之后、测试 369 passed / 8 expected fail / 1 skipped。

### 已修复（原 QA 登记 #4–#11，全部有回归测试保护）

| 编号 | 严重度 | 一句话 | 修复方式 |
|---|---|---|---|
| #10 | 🔴 高 | 真实模式跑不到 done（critique 超时 120s × 15 次尝试 = 12 分钟失败） | 重试降为「首试 + 1 次」，加整链 `budgetMs` 总时间预算；长文本协议让 draft/revise 不再走 JSON。**实测真实模式 197 秒跑到 done** |
| #4 | 🔴 高 | 取消任务被标成 `failed` 而不是 `cancelled` | 取消判定同时认 `code` 和 `name === 'AbortError'` |
| #5 | 🔴 高 | 前端发 `{message}`、后端读 `{text}` → 追加要求 100% 400 | 后端两个字段都收；补了 `tests/unit/api-contract.test.js` 守这条线 |
| #6 | 🟠 中 | 没改任何东西也发「已自动修正格式偏差」 | 改用 `coerce()` 的 `{value, changed}`，不再看哨兵的真值 |
| #11 | 🟠 中 | 长文本协议下 artifacts 不校验 → `confidence: "0.95"` 进交付物 | 长文本协议统一归一化 confidence |
| #7 | 🟡 低 | 端口被占用时报 `TypeError` | Express 5 的 `listen` 回调要检查第一个参数 |
| #8 | 🟡 低 | `HANDOFF_DEMO` 没人读 | `buildJobRecord` 读 `isDemoMode()` |
| #9 | ⚪ 观察 | job/stage 比契约多字段 | **契约已降级为架构基线并登记 12 条偏离**，见 `docs/CONTRACT.md` §0 |

### 本轮新发现并已修复（对抗性测试 / 性能 / 产品 / 文档四位同事的发现）

| 编号 | 严重度 | 一句话 |
|---|---|---|
| S9-2 | 🔴 严重 | 并发 `retry` 全部 200 → 同一任务跑多遍，**真实模式下用户被重复扣模型费**。check-then-act 竞态，改为「任何 await 之前先占位」 |
| S10-1 | 🔴 严重 | `sweepTmpFiles()` 无条件删 `*.json.tmp`，会删掉**正在写**的临时文件 → `rename` 报 ENOENT → 用户「新建任务」500。实测 100 个任务 7 个失败。改为唯一临时文件名 + 只清 5 分钟前的 |
| S11-1 | 🔴 严重 | 服务端返回 `{job:{...}}`、前端按扁平读 → **真实浏览器里点「开始」100% 失败**，详情页永远空白。两侧单测都绿，中间那根线没人测 |
| S9-4 | 🟠 中 | 并发 `message` 全部接受 → 用户双击回车变成 5 条要求 + 5 条并行流水线 |
| S9-6 | 🟠 中 | 任务不存在时界面说「检查一下 Wi-Fi」→ 把用户引向错误的排查方向 |
| S9-3 | 🟡 低 | 畸形百分号编码让整个前端路由卡死（`URIError` 冒出路由函数） |
| S9-9 | 🟡 低 | `goal` 传对象 → 存成 `[object Object]` 变成任务目标 |
| S12-1 | 🟠 中 | `.env` 根本没被加载 → README、`.env.example`、报错文案三处都在教用户做无效的事 |
| S12-2 | 🟡 低 | `auditJob` 漏传 `security` → guard 里合并输入 findings 的逻辑是死代码 |

### 仍然是坏的（有测试钉住，欢迎来修）

```bash
npx vitest run 2>&1 | grep -E "expected fail|↓"
```
`it.fails(...)` 的用例**绿着恰恰说明缺陷还在**——它们记录"当前是坏的"。
详细清单见 `docs/BUGS.md`。

## 5.2 已知的测试 flaky（诚实登记，2026-09-12 05:xx）

**先说结论：核心路径已经稳定。**连续 8 次 `npx vitest run` 里，
被测代码本身的失败为 0；个别轮次会出现下面这两条**测试自身**的问题。

| 用例 | 现象 | 根因 | 状态 |
|---|---|---|---|
| `tests/e2e/pipeline.test.js` → 引擎确实把任务写到了磁盘 | 曾约 1/3 轮次偶发红 | 内存状态先变、落盘是紧随其后的独立异步操作。测试只等 `status` 变了就读盘，撞进那个窗口 | ✅ 已修：给 store 加了 `flushWrites()` 作为真正的同步点，测试改用它 |
| `tests/adversarial/input-validation.test.js` → /api/health 与 /api/templates 里没有密钥字段 | 约 2% 轮次偶发红 | 只在**全仓并行**时出现；单独跑、串行跑从不复现。四条正则都用真实响应复核过（都不匹配） | ⚠️ 未修：疑似并行时某个测试临时改写 `process.env` 与断言竞态 |

### 为什么我修了第一条、没修第二条

第一条的根因是**产品里真实存在的一个窗口**（"接口说 done 了，盘上还是 running"），
所以修它不只是修测试 —— `flushWrites()` 同时也是优雅关闭时该调用的东西
（关服前排空写队列，用户才不会丢最后一次状态更新）。

第二条只是测试之间的环境竞态，不影响产品行为，而且复现率低到无法稳定观察。
**在没有稳定复现之前不动它** —— 盲改一个看不见的竞态，往往是把偶发失败变成必然失败。

### 怎么判断"这次红是不是真问题"

```bash
npx vitest run tests/e2e/pipeline.test.js          # 单跑一遍（应该全绿）
npx vitest run tests/adversarial                    # 单跑对抗性测试
node scripts/smoke.js                               # 端到端冒烟
node scripts/dry-run.js                             # 真实模型端到端（花钱、约 5 分钟）
```
如果单跑全绿、只有全仓并行时偶发红，多半是上面第二条。
如果单跑也红，那就是真的坏了。

## 6. 复现缺陷的入口

`docs/reports/S8-QA.md` 里的每条缺陷都带可复制的命令。
最快的三个入口：

```bash
# 1) 看「已知缺陷」有哪些还是红的（it.fails 的用例）
npx vitest run tests/unit/gateway.test.js tests/e2e/pipeline.test.js --reporter=verbose | grep '缺陷'

# 2) 交付物正文有没有真的返回给前端（缺陷 #2）
node scripts/smoke.js && curl -s localhost:<port>/api/jobs/<id> | head -c 400

# 3) 服务启动失败的报错是不是人话（缺陷 #7）
node -e "require('net').createServer().listen(8899,'127.0.0.1')" & PORT=8899 node src/server.js
```
