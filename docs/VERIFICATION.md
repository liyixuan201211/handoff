# 文档准确性验证清单（可复跑）

> 维护者：S14 文档准确性验证工程师
> 最后更新：2026-09-12
> 配套报告：`docs/reports/S14-文档准确性.md`
>
> **这份文件的用途**：任何人（包括下一位维护者）照着这份清单能**原样重做**一遍验证，
> 并得到与报告一致的结论。每条都有：命令 → 期望输出 → 怎么判定。
>
> **验证原则**：不读代码判断，**真的跑**。文档说 A，就实测 A。
>
> ⚠️ 复跑前注意：`node scripts/dry-run.js` 会**真的调用大模型（花真钱、几分钟）**，
> 整个清单里只有它是花钱的，其余全部免费、离线、可在 2 分钟内跑完。

---

## 0. 环境前置检查

```bash
cd /Users/imac/260912/handoff
node -v     # README 要求 >= 22.5.0；实测环境为 v24.19.0 ✅
npm -v      # 实测 11.17.0
```

**注意**：本项目用 `node:sqlite` 读 Cherry Studio 配置（`src/llm/providers.js`），
需要 Node 22.5+ 才有该模块。低于此版本「零配置读 Key」会静默降级为 null（不崩，但需要用户自己填 Key）。

---

## 1. README 可执行陈述逐条验证

### 1.1 `npm install` 真的能装吗？装了几个依赖？

```bash
# 在干净目录里装，避免复用已有 node_modules
rm -rf /tmp/hf-verify && mkdir -p /tmp/hf-verify
cd /Users/imac/260912/handoff
cp package.json package-lock.json /tmp/hf-verify/
cd /tmp/hf-verify && npm install
```

- **期望**：`added 126 packages in ~5s`，退出码 0。
- **实测**：`added 126 packages in 5s`（退出码 0）。
- **判定**：安装可行 ✅。但 README「**只用 3 个依赖**」与 `added 126 packages` 不符 ——
  3 个是**直接依赖**（express / vitest / supertest），用户实际要下载 **126 个包**。
  `ls /tmp/hf-verify/node_modules | wc -l` 实测 **115** 个顶层目录。

```bash
npm ls --depth=0     # 直接依赖确实只有 3 个
```

### 1.2 `npm start` 真的跑在 8787 吗？

```bash
cd /Users/imac/260912/handoff
node src/server.js > /tmp/hf-srv.log 2>&1 &
sleep 4
cat /tmp/hf-srv.log
curl -s -o /dev/null -w "status=%{http_code}\n" http://127.0.0.1:8787/
kill %1
```

- **期望**：日志含 `[server] 交接 Handoff 已启动：http://127.0.0.1:8787`，首页 HTTP 200。
- **实测**：完全一致 ✅（`src/server.js:339-340` 默认 `8787` / `127.0.0.1`）。

> ⚠️ 复跑注意：本工作区**同时有其他同事的服务占着 8787**。若日志出现
> `EADDRINUSE: address already in use 127.0.0.1:8787`，用
> `HANDOFF_PORT=18800` 换端口重测，不要 kill 别人的进程。

### 1.3 打开首页，和 README 描述一致吗？

```bash
curl -s -o /tmp/hf-index.html -w "status=%{http_code} bytes=%{size_download}\n" http://127.0.0.1:8787/
grep -o "交接 Handoff[^<]*" /tmp/hf-index.html | head -3
```

- **期望**：200，返回真实 SPA（不是「界面正在准备中」占位）。
- **实测**：`status=200 bytes=1745`，`<title>交接 Handoff — 你只管说想要什么</title>`，
  内联 SVG favicon（`data:image/svg+xml`，不请求外部资源）✅

### 1.4 `HANDOFF_DEMO=1 npm start` 真的能离线跑通吗？

**关键**：把 `HOME` 指到一个没有任何 Cherry Studio 配置的空目录，模拟「没装 Cherry Studio、没有 Key」。

```bash
mkdir -p /tmp/hf-fakehome
cd /Users/imac/260912/handoff
HOME=/tmp/hf-fakehome HANDOFF_DEMO=1 HANDOFF_PORT=18801 HANDOFF_DATA_DIR=/tmp/hf-demo/data \
  node src/server.js > /tmp/hf-demo.log 2>&1 &
sleep 4
curl -s http://127.0.0.1:18801/api/health
```

- **期望**：`"demoMode": true`，5 个模型全部 `"configured": false`（证明没有 Key 也能起）。
- **实测**：`demoMode=True`，`configured=[False,False,False,False,False]` ✅

然后在演示模式下真的创建一个任务并等它跑完：

```bash
JOB=$(curl -s -X POST http://127.0.0.1:18801/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"goal":"帮我把这份租房合同看一遍，我怕有坑"}')
ID=$(echo "$JOB" | python3 -c "import sys,json;print(json.load(sys.stdin)['job']['id'])")
sleep 18
curl -s "http://127.0.0.1:18801/api/jobs/$ID" | python3 -c "
import sys,json; d=json.load(sys.stdin)['job']
print('status=',d['status'],'artifacts=',len(d['artifacts'] or []),'stages=',len(d['stages'] or []))"
```

- **期望**：`status= done artifacts= 3 stages= 8`
- **实测**：`status= done artifacts= 3 stages= 8` ✅

### 1.5 README「断网也能用」—— 演示模式真的零外部请求吗？

**代码侧证据**（先缩小范围，再实测）：

```bash
# 全仓只有两个外部主机名，且都是模型服务商
grep -rhoE "https?://[A-Za-z0-9._/-]+" src/ | sort -u
# → https://aiping.cn/api/v1
# → https://api.deepseek.com/v1

# 真正的出口只有一个 fetch
grep -rn "fetch(" src/llm/gateway.js
# → src/llm/gateway.js:134  res = await deps.fetch(`${def.baseURL}/chat/completions`, ...)
```

**实测**：跑一个演示任务的同时，持续采样服务进程的非 loopback TCP 连接：

```bash
SRV=<上面的 node 进程 pid>
for i in $(seq 1 8); do
  lsof -nP -iTCP -a -p $SRV | grep ESTABLISHED | grep -v 127.0.0.1 && echo "外连!"
  sleep 1.5
done
```

- **期望**：8 次采样都没有任何非 loopback 的 ESTABLISHED 连接。
- **实测**：8 次全部 `no non-loopback established connection`，任务仍跑到 `done`（3 份交付物）✅
- **判定**：**README / SECURITY.md 的「一次网络请求都不发」属实。**

### 1.6 README 的模型降级链 vs `src/llm/providers.js` 的 `DEFAULT_CHAIN`

```bash
sed -n '37,43p' src/llm/providers.js
```

- **期望**：与 README 第 127 行完全一致。
- **实测**：`DEFAULT_CHAIN` = `deepseek-official/deepseek-flash` → `aiping/DeepSeek-V4-Flash`
  → `aiping/DeepSeek-V4.1-Flash` → `aiping/GLM-5.3` → `aiping/Qwen3.8-Max`，
  与 README **逐项一致** ✅
- **附带发现**：`.env.example` 里的 `HANDOFF_MODEL_CHAIN` 注释值**少了一级**
  （缺 `aiping/DeepSeek-V4.1-Flash`），与 README 和代码都不一致 ❌（详见报告 §2）。

### 1.7 README 里的测试脚本真的存在吗？跑得通吗？

```bash
cd /Users/imac/260912/handoff
npm test          ; echo "EXIT=$?"
npm run test:unit ; echo "EXIT=$?"
npm run test:e2e  ; echo "EXIT=$?"
node scripts/smoke.js ; echo "EXIT=$?"
```

- **期望**：README 承诺的四个入口都存在，且**全绿、退出码 0**。
- **实测（03:08，测试文件 8 个 / 316 用例）**：

| 命令 | 脚本存在 | 退出码 | 结果 |
|---|---|---|---|
| `npm test` | ✅ | **1** | **3 failed** / 307 passed / 5 expected fail / 1 skipped（316） |
| `npm run test:unit` | ✅ | 0 | 7 files / 286 passed / 4 expected fail（290） |
| `npm run test:e2e` | ✅ | 0 | 1 file / 24 passed / 1 expected fail / 1 skipped（26） |
| `node scripts/smoke.js` | ✅ | 0 | 冒烟通过 ✅ |

- **判定**：脚本都存在 ✅，但 **`npm test` 退出码 1、有 3 个红色用例** ❌。

**⚠️ 复查（03:19 之后，同事改了测试，变成 10 个文件 / 340 用例）—— 请务必自己重跑：**

```bash
for i in 1 2 3; do npm test 2>&1 | grep -E "^ FAIL|      Tests "; echo "---"; done
```

- **实测（5 次运行）：`npm test` 退出码恒为 1，但失败数是 3 / 1 / 3 / 2 / 4，
  失败用例集合每次都不同。**
- 失败集中在三处：
  - `tests/adversarial/state-machine.test.js` —— S9-1「DELETE 之后任务不能复活」、
    S9-7「retry 后旧日志要清干净」（**每次都红，疑似真 bug**）
  - `tests/e2e/pipeline.test.js` —— 「引擎确实把任务写到了磁盘」断言 `status === 'done'`，
    实际拿到 `'running'`（**竞态**）
  - `tests/unit/api-contract.test.js` —— 缺陷 #5 回归（**时红时绿**）
- **判定**：❌ **`npm test` 目前不稳定，不能作为放行依据。**
  详见报告 §6 错误 #2。
- 单项复跑可用来区分「真 bug」和「flaky」：
  ```bash
  npx vitest run tests/adversarial/state-machine.test.js   # 连跑两次
  npx vitest run tests/e2e/pipeline.test.js                # 连跑两次
  ```

### 1.8 `docs/PLAYBOOK.md` 存在吗？

```bash
ls docs/PLAYBOOK.md
```

- **实测**：验证开始时**不存在**；验证过程中（03:09）S12 补上了。
- **判定**：README 曾引用一个不存在的文档（现已补齐，属**时序性**问题，但值得记录：
  文档表格里的链接必须与仓库实际文件对齐）。

---

## 2. 环境变量逐个验证

**总纲**：README §常用配置 与 `.env.example` 都写着「在项目根目录建一个 `.env`」。
**这是本次验证最重要的发现。**

### 2.1 `.env` 文件到底有没有被读取？

```bash
# 1) 静态：全仓搜 dotenv / loadEnvFile / .env 读取
cd /Users/imac/260912/handoff
grep -rn "dotenv\|loadEnvFile\|\.env" src/ scripts/
# → 只匹配到注释和错误提示文字，没有任何读取 .env 的代码

# 2) 动态：真的建一个 .env，看它生不生效
rm -rf /tmp/hf-envtest && mkdir -p /tmp/hf-envtest
cd /Users/imac/260912/handoff
cp -R src public templates package.json /tmp/hf-envtest/
ln -s /Users/imac/260912/handoff/node_modules /tmp/hf-envtest/node_modules
printf 'HANDOFF_PORT=9911\nHANDOFF_DATA_DIR=./data\n' > /tmp/hf-envtest/.env

cd /tmp/hf-envtest && HANDOFF_DEMO=1 node src/server.js &
sleep 4
# 看它实际监听哪个端口
curl -s -m 2 http://127.0.0.1:9911/api/health || echo "9911 拒绝连接"
curl -s -m 2 http://127.0.0.1:8787/api/health >/dev/null && echo "8787 有响应"
```

- **期望（若 README 属实）**：服务监听 **9911**（`.env` 里写的），`dataDir` 指向 `./data`。
- **实测（03:12）**：日志 `[server] 交接 Handoff 已启动：http://127.0.0.1:8787`，
  **9911 连接被拒绝**。
- **判定**：❌ **`.env` 完全不被读取，是死配置。** 用户照 README 配 `.env` 全部无效。
  详见报告 §6 错误 #1。

**⚠️ 复查（03:26，同事已加 `--env-file-if-exists`）—— 注意要分两个入口各测一次：**

```bash
# 入口 A：npm start（README 推荐的方式）
cd /tmp/hf-env3 && npm start        # package.json: node --env-file-if-exists=.env src/server.js
# 实测 → 已启动：http://127.0.0.1:19911   ✅ .env 生效

# 入口 B：直接跑 node（README L166 的 dry-run 就是这种；Docker/PM2 也是）
cd /tmp/hf-envtest && node src/server.js
# 实测 → 已启动：http://127.0.0.1:8787    ❌ .env 仍被忽略
```

- **判定（当前）**：⚠️ **只修了一半。** `npm start` 生效，`node` 直启无效。
  受影响的入口：`node scripts/dry-run.js`、`scripts/smoke.js`、`scripts/bench.js`、
  以及所有不经过 npm 脚本的部署方式。
- **建议修法**：把加载逻辑放进 `src/server.js`（报告 §6 错误 #1 有完整代码）。

**补充：建议的修复方案本身也实测过。** 把报告 §6 错误 #1 的
`loadDotEnvFile()`（`process.loadEnvFile` + `before` 快照保护真实环境变量）
贴到副本 `src/server.js` 的 `const VERSION = '1.0.0';` 之后：

```bash
$ node src/server.js          # 含 HANDOFF_PORT=9911 的 .env，且未用 --env-file
[server] 交接 Handoff 已启动：http://127.0.0.1:9911  (dataDir=/tmp/hf-fixcheck/dotenv-data)
$ curl -s http://127.0.0.1:9911/api/health
dataDir= /tmp/hf-fixcheck/dotenv-data demoMode= True

# 关键回归：真实环境变量必须仍然覆盖 .env
$ HANDOFF_PORT=9912 node src/server.js
[server] 交接 Handoff 已启动：http://127.0.0.1:9912  (dataDir=/tmp/hf-fixcheck/dotenv-data)
```

三个 `.env` 变量全部生效，且 shell 环境变量优先级仍然更高 ✅

### 2.2 用真正的环境变量（而非 `.env`）逐个验证

表格里「默认值」一律与 `README` 第 113–122 行对照。
**本节一律用 shell 环境变量测**（绕开 `.env` 的历史问题，见 2.1），
这样测的是代码本身对每个变量的处理，与 `.env` 是否被加载无关。

| 变量 | README 写的默认值 | 实测默认值 | 实测行为 | 判定 |
|---|---|---|---|---|
| `HANDOFF_PORT` | `8787` | `8787`（`Number(process.env.HANDOFF_PORT) \|\| Number(process.env.PORT) \|\| 8787`） | `HANDOFF_PORT=18801` → 监听 18801，日志 URL 同步变 ✅ | ✅ 属实（`.env` 形式见 2.1） |
| `HANDOFF_HOST` | `127.0.0.1` | `127.0.0.1` | 见 `src/server.js:340`；默认不信任代理（`app.set('trust proxy', false)`） | ✅ 属实 |
| `AIPING_API_KEY` | 自动读取 | 见 2.3 | 设为 canary 后 `/api/health` 的 `keySource` 变 `env` | ✅ 属实 |
| `DEEPSEEK_API_KEY` | 自动读取 | 见 2.3 | 同上 | ✅ 属实 |
| `HANDOFF_MODEL_CHAIN` | 见下（README 列 5 级） | `DEFAULT_CHAIN` 5 级 | `resolveChain()` 解析 `provider/model`，未知 provider 被过滤；全空则回落默认链 | ✅ 代码与 README 的 5 级一致；**`.env.example` 的示例值不一致** ❌ |
| `HANDOFF_DATA_DIR` | `./data` | `./data` | 设 `/tmp/hf-demo/data` → `/api/health` 的 `dataDir` 同步变 ✅ | ✅ 属实（`.env` 形式见 2.1） |
| `HANDOFF_DEMO` | `0` | `0`（未设 = false） | 设 `1` → `/api/health` 的 `demoMode: true`，且真的不调模型 ✅ | ✅ 属实（QA 缺陷 #8「没人读」已在 `runtime-flags.js:12` 修复） |
| `HANDOFF_LLM_TIMEOUT_MS` | `120000` | `120000` | `src/runtime-flags.js:16` 与 `gateway.js:216` 同值 | ✅ 属实 |
| `AIPING_BASE_URL` | `.env.example` 里有 | **代码从不读取** | `grep -rn "AIPING_BASE_URL" src/ scripts/ public/` → 0 处 | ❌ 误导（provider baseURL 是硬编码常量，防 SSRF 的正确设计） |

### 2.3 密钥解析优先级验证

```bash
grep -n "apiKeyEnv" -A 2 src/llm/providers.js
```

- 代码顺序：显式注入 → `DEEPSEEK_API_KEY`/`HANDOFF_DEEPSEEK_API_KEY`（或 `AIPING_API_KEY`/`HANDOFF_AIPING_API_KEY`）
  → Cherry Studio 本地 sqlite（只读）。
- **与 README「1. 环境变量 → 2. Cherry Studio → 3. .env」对比**：
  前两项一致 ✅；第三项 `.env` 是**通过 `--env-file-if-exists` 加载的**，
  所以对代码而言它最终等价于「环境变量」——但对**只跑 `node` 的入口无效**（见 2.1）。

---

## 3. 安全承诺验证（README + SECURITY.md）

### 3.1 「你的 Key 不会写进日志、不会放进任何 HTTP 响应」—— canary 实测

用一枚**独一无二的可搜索字符串**当 Key，跑完整流程后全局搜。

```bash
cd /Users/imac/260912/handoff
FAKEKEY="sk-s14CANARY1234567890abcdefCANARY"
HOME=/tmp/hf-fakehome AIPING_API_KEY="$FAKEKEY" DEEPSEEK_API_KEY="$FAKEKEY" \
  HANDOFF_DEMO=1 HANDOFF_PORT=18803 HANDOFF_DATA_DIR=/tmp/hf-key/data \
  node src/server.js > /tmp/hf-key.log 2>&1 &
sleep 4

# 建一个任务并等它跑完
JOB=$(curl -s -X POST http://127.0.0.1:18803/api/jobs -H 'Content-Type: application/json' \
  -d '{"goal":"帮我把这份租房合同看一遍，我怕有坑。押金两个月6000元，租期一年。"}')
ID=$(echo "$JOB" | python3 -c "import sys,json;print(json.load(sys.stdin)['job']['id'])")
sleep 18
ART=$(curl -s "http://127.0.0.1:18803/api/jobs/$ID" | python3 -c "
import sys,json; d=json.load(sys.stdin)['job']; a=d['artifacts']; print(a[0]['id'])")

# 扫描所有 HTTP 响应
for p in /api/health /api/templates /api/jobs "/api/jobs/$ID" "/api/jobs/$ID/stream" \
         "/api/jobs/$ID/artifacts/$ART/download" /; do
  curl -s "http://127.0.0.1:18803$p" | grep -q "sk-s14CANARY" \
    && echo "!!! LEAK in $p" || echo "clean: $p"
done

# 扫描日志与落盘数据
grep -q "sk-s14CANARY" /tmp/hf-key.log && echo "!!! LEAK in log" || echo "clean: server log"
grep -rq "sk-s14CANARY" /tmp/hf-key/data && echo "!!! LEAK in data" || echo "clean: data dir"
```

- **期望**：全部 `clean`。
- **实测**：7 个端点 + 日志 + 数据目录**全部 clean** ✅
  任务本身跑到 `status=done`（3 份交付物 / 8 个阶段），证明不是「因为没跑起来所以没泄漏」。
- **判定**：**README / SECURITY.md 的密钥承诺属实。**

### 3.2 `/api/health` 不返回密钥本体，只返回「有没有配」

```bash
curl -s http://127.0.0.1:18803/api/health | python3 -m json.tool | grep -i key
```

- **实测**：只有 `"keySource": "cherry-studio"` / `"env"` / `null`，**没有 key 本体** ✅
- 代码注释（`server.js:162`）说明字段命名刻意避开 `key` 字样以免安全测试误报。

### 3.3 限流（CONTRACT §5.7：创建任务 10 次/分钟）

```bash
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "attempt $i -> %{http_code}\n" -X POST \
    http://127.0.0.1:18806/api/jobs -H 'Content-Type: application/json' \
    -d "{\"goal\":\"第 $i 次请求测试限流\"}"
done
```

- **期望**：第 1–10 次 201，第 11、12 次 429。
- **实测**：`1..10 → 201`，`11,12 → 429` ✅ **与契约完全一致。**

### 3.4 请求体上限（CONTRACT §5.8：256kb）

```bash
python3 -c "
import json,urllib.request
req=urllib.request.Request('http://127.0.0.1:18805/api/jobs',
  data=json.dumps({'goal':'a'*300000}).encode(),
  headers={'Content-Type':'application/json'})
try:
    print(urllib.request.urlopen(req).status)
except urllib.error.HTTPError as e: print('status',e.code,e.read()[:120])
"
```

- **实测**：`413` + `{"error":{"code":"PAYLOAD_TOO_LARGE",...}}` ✅

### 3.5 输入长度边界（CONTRACT §5.1：1..4000）

```bash
# 4000 字：接受；4001 字：拒绝；0 字：拒绝
```

- **实测**：4000 → `201`（接受），4001 → `400 BAD_REQUEST 需求描述太长了，最多 4000 字，现在 4001 字。`，
  空 → `400` ✅ **边界与契约完全一致。**

### 3.6 前端 XSS 面（CONTRACT §5.6）

```bash
grep -rn "innerHTML\s*=" public/
```

- **实测**：只有 2 处 —— `ui.js:531 node.innerHTML = renderMarkdown(...)`（渲染器逐段先转义，
  有 17 处 `escapeHtml` 调用）和 `ui.js:490` 的 `key === 'html'` 显式通道（注释声明调用方保证已转义）。
  **没有 `insertAdjacentHTML` / `outerHTML` / `document.write`** ✅
- 完整的行为验证由 `tests/unit/frontend.test.js` 承担（24 用例，全绿）。

### 3.7 无 SSRF（CONTRACT §5.4）

```bash
grep -rhoE "https?://[A-Za-z0-9._/-]+" src/ | sort -u
grep -rn "fetch(" src/
```

- **实测**：只有 2 个硬编码模型主机名，只有 1 个 `fetch` 调用点（`gateway.js:134`），
  `baseURL` 来自 `PROVIDERS` 常量而非用户输入 ✅

---

## 4. CONTRACT.md 与代码的一致性

### 4.1 HTTP 端点清单（契约 §2）

```bash
grep -nE "router\.(get|post|delete)\(" src/routes/jobs.js src/routes/stream.js
grep -nE "app\.(get|post)\(" src/server.js
```

| 契约 | 实际 | 判定 |
|---|---|---|
| `GET /api/health` | ✅ | ✅ |
| `GET /api/templates` | ✅ | ✅ |
| `POST /api/jobs` | ✅ | ✅ |
| `GET /api/jobs` | ✅ | ✅ |
| `GET /api/jobs/:id` | ✅ | ✅ |
| `POST /api/jobs/:id/message` | ✅ 接收 `text` **和** `message` | ⚠️ 契约只写了 `{text}`，代码两者都收 |
| `POST /api/jobs/:id/retry` | ✅ | ✅ |
| `DELETE /api/jobs/:id` | ✅ | ✅ |
| `GET /api/jobs/:id/stream` | ✅ SSE | ✅ |
| `GET /api/jobs/:id/artifacts/:artifactId/download` | ✅ | ✅ |

**路径/方法全部对得上** ✅。**响应形状对不上** ❌：

```bash
# 契约说响应是 Job 对象本身，实际都包了一层
curl -s -X POST http://127.0.0.1:18803/api/jobs -H 'Content-Type: application/json' \
  -d '{"goal":"测试"}' | head -c 80
# → {"job":{"id":"job_...", ...}}      ← 包了 {job:...}
curl -s http://127.0.0.1:18803/api/jobs | head -c 60
# → {"jobs":[...]}                     ← 包了 {jobs:...}
```

契约 §2 从头到尾**没有说明这些包装层**，也没写 `POST` 返回 `201`。

### 4.2 Job 对象字段（契约 §2 冻结形状）

```bash
curl -s http://127.0.0.1:18803/api/jobs/$ID | python3 -c "
import sys,json; print(sorted(json.load(sys.stdin)['job'].keys()))"
```

- **契约列出的字段**：`id, goal, templateId, status, createdAt, updatedAt, plan, stages,
  artifacts, review, security, usage, clarifyQuestions, error`
- **实测多出**：`templateTitle, audience, tone, deadline, demo, userMessages, amendedCount, grade`
- **判定**：❌ 契约**严重滞后于代码**（代码多 8 个字段，响应里真实存在）。
  这会让按契约写前端/写测试的人踩空 —— S11 报告里前端解包 bug 与此同源。

### 4.3 SSE 事件类型（契约 §2）

```bash
grep -rhoE "type: '[a-z]+'" src/pipeline/engine.js src/demo/fixtures.js | sort | uniq -c
```

- **契约列出 9 种**：`job / stage / log / artifact / review / security / clarify / done / error`
- **实测**：9 种**全部都有实际发射点** ✅（`job`×12、`log`×6、`done`×6、`stage`×5、
  `artifact`×3、`security`×2、`review`×2、`error`×2、`clarify`×1）
- **附带**：实际事件还带 `seq` / `at` 字段（契约未写，`events.publish()` 统一附加）。

### 4.4 八个阶段（契约 §3 vs `STAGE_META`）

```bash
sed -n '25,34p' src/pipeline/stages.js
```

- **实测**：`intake(10) / plan(20) / research(30) / draft(40) / critique(50) / revise(60) /
  verify(70) / deliver(80)`，中文名、必需性、顺序**与契约 §3 表逐行一致** ✅

### 4.5 `callModel` 契约（契约 §4）

```bash
sed -n '209,222p' src/llm/gateway.js
```

- **契约列出**：`system, user, schema, maxTokens, temperature, timeoutMs, signal, purpose, role`
- **实测多出**：`onNotice`（降级/重试通知回调）；另有 `deps`、`budgetMs`（从 `opts` 直接读，
  未列在解构里）—— `budgetMs` 是**总时间预算**，`src/llm/gateway.js:263`。
- **判定**：❌ 契约漏了 `onNotice` / `budgetMs` / `deps` 三个实际存在的入参。

### 4.6 契约 §4 的其他数字 vs 代码

| 契约说 | 代码实际 | 判定 |
|---|---|---|
| 重试「2 次（共 3 次尝试）」 | `MAX_ATTEMPTS = 2`（共 2 次尝试） | ❌ 契约过时 |
| 降级链 4 级 | 5 级（多了 `aiping/DeepSeek-V4.1-Flash`） | ❌ 契约过时（README 是对的） |
| `maxTokens` 默认 4000 | draft/revise 实际传 24000 | ❌ 契约过时 |

### 4.7 契约 §7 验收标准 vs `validateDelivery()`

```bash
sed -n '953,985p' src/pipeline/engine.js
```

| 契约 §7 | 代码 | 判定 |
|---|---|---|
| 1. `status === "done"` | 代码**反向推导**：先算 problems，无问题才置 done | ⚠️ 语义等价，但不是同一实现 |
| 2. ≥1 artifact 且每个 `content.length > 80` | 只要求**至少一份**够长（`substantial.length`），且按**去空白字符**计长 | ⚠️ 比契约宽松 |
| 3. `review` 非空且 `verdict !== "needs_revision"` | 只检查 `review` 非空，**不看 verdict** | ❌ 契约过时（ADR-016 明确「分层验收」，`needs_revision` 也照样交付） |
| 4. `security.level !== "blocked"` | ✅ 一致 | ✅ |
| 5. `deliver` 产出「怎么用」说明 | 只把非 `__handoff_guide__` 的 artifact 计入，**不强制要求 guide** | ❌ 与契约不符（代码注释明说「缺失不判失败」） |

`scripts/dry-run.js` 打的是**另一套 7 条**（多了「阶段数 ≥ 5」「有怎么用说明」两项，
且按 `content.length > 80` 而非去空白计长）。

---

## 5. 报告可信度抽查（`docs/reports/*.md`）

抽 3 条同事贴出的「验证输出」，**自己跑一遍**比对。

### 抽查 1 —— S8-QA §「我实际运行的验证 / 5. 演示数据自洽性」

报告声称：`npx vitest run tests/unit/fixtures.test.js` 的 4 条 ✓。

```bash
npx vitest run tests/unit/fixtures.test.js
```

- **实测**：`24 tests passed (24)`，退出码 0 ✅ **一致。**
（报告只摘了 4 条标题，未声称总数为 4，不算不实。）

### 抽查 2 —— S8-QA §「3. 一键冒烟」

报告贴出完整输出（3 份交付物 1955/1223/640 字、9 次调用、18640+8240 tokens、`EXIT=0`）。

```bash
node scripts/smoke.js
```

- **实测**：字数、份数、tokens、质检结论、安全等级 **逐字一致**；
  端到端耗时 5924ms（报告 5895ms，正常波动）；`EXIT=0` ✅ **高度可信。**

### 抽查 3 —— S8-QA §「2. 全仓测试」

报告声称 `npx vitest run` → `Test Files 8 passed (8)` / `Tests 309 passed | 6 expected fail | 1 skipped (316)`。

```bash
npm test
```

- **实测**：`Test Files 1 failed | 7 passed (8)` / `Tests 3 failed | 307 passed | 5 expected fail | 1 skipped (316)`
- **判定**：❌ **与报告不一致。** 报告是在提交 `4c2813d` 那次快照下写的，之后
  `5f74ff4` 修复了缺陷 #4/#5/#6，把当时用来「登记现状」的断言变成了红色
  （`tests/e2e/pipeline.test.js:451` 等），但报告与 TESTING.md 都没同步。
  **总数 316 对得上，通过数对不上** —— 说明报告本身没造假，只是**过期了**。

### 抽查 4（附加）—— `docs/reports/S6-安全.md` 与 SECURITY.md 的用例数

`docs/SECURITY.md:103` 声称「`tests/unit/security.test.js`（77 个用例）」。

```bash
npx vitest run tests/unit/security.test.js
```

- **实测**：`77 passed (77)` ✅ **准确。**

### 抽查 5（附加）—— `docs/ARCHITECTURE.md` §8.1 的全仓测试状态

- 报告声称：`Tests 310 passed | 5 expected fail | 1 skipped (316)`，「**全绿**」。
- **实测**：`3 failed | 307 passed`。
- **判定**：❌ 不准确（迟写于抽查 3 之后，仍沿用了「全绿」的错误结论）。
- 同节里把 `#4/#5/#6/#7/#8` 标为「已修」，**这部分是对的**（实测确认这 5 条确实已修，
  其中 #4/#5/#6 的修复正是当前 3 条红色用例的成因）。

**抽查结论**：S8 报告里逐字贴出的输出**可信**（抽查 1/2/4 完全一致）；
但凡涉及「当前测试状态」的**汇总性陈述已过期**（抽查 3/5）。**过期比造假更常见，也更危险。**

---

## 6. 复杂/花钱的条目

### 6.1 `node scripts/dry-run.js`（真打模型，**会花钱**）

```bash
cd /Users/imac/260912/handoff
node scripts/dry-run.js          # 只跑一次！
```

- **README 声称**：真的调用模型、跑完 8 个阶段、打印每份交付物开头、按契约 §7 逐条打勾。
- **实测（2026-09-12，一次）**：

  ```
  状态：done   总耗时：246.8s
  模型调用：8 次，输入 27260 tokens，输出 34577 tokens
  阶段：8 个（完成 8 个）
  交付物：4 份
     · 五条条款逐条风险体检表（2487 字，把握度：high）
     · 跟房东谈条款的话术（可直接复制发微信）（2663 字）
     · 签前—住中—退租三阶段证据清单（2263 字）
     · 先看这份：怎么用（1645 字）
  质检（pass_with_notes）：10 条 checklist 全 ✓，另 2 条 low 级 issue
  安全（clean）：0 项

  验收：
    ✓ 最终状态是 done          ✓ 至少 1 份交付物
    ✓ 每份交付物内容 > 80 字    ✓ 质检结论不是 needs_revision
    ✓ 安全等级不是 blocked      ✓ 有「怎么用」说明
    ✓ 阶段数 ≥ 5
  全部通过 ✅        DRYRUN EXIT=0
  ```

- **实测的额外收获**：脚本运行中真实发生了 **2 次模型降级**
  （`切换到备用模型继续（AI Ping）`、`主模型繁忙，已自动切换到备用模型（AI Ping）继续。`），
  README「主模型超时或限流时系统会自动换下一个」这句**有真实证据**。
- **判定**：✅ 脚本可用、真的能跑完、真的打完验收。
  但注意其验收是**另一套 7 条**，与 CONTRACT §7 的 5 条不完全等价（详见报告 §6 错误 #7）。

### 6.2 真实模式 e2e（同样花钱，默认不跑）

```bash
HANDOFF_INTEGRATION=1 npx vitest run tests/e2e/pipeline.test.js
```

- 默认 `describe.skipIf`，不设该变量**不会**打网络 ✅（`tests/e2e/pipeline.test.js:280`）。

---

## 7. 一条命令检查本清单是否仍然成立

```bash
cd /Users/imac/260912/handoff

# 1) 稳定层：这两个 + 冒烟必须退出码 0
npm run test:unit && npm run test:e2e && node scripts/smoke.js && echo "稳定层通过 ✅"

# 2) 不稳定层：连跑 3 次，看失败集合是否变化
for i in 1 2 3; do
  echo "--- run $i ---"
  npm test 2>&1 | grep -E "^ FAIL|      Tests "
done
# 关注两点：(a) 退出码是否为 0；(b) 三次的失败用例是否相同。
# 2026-09-12 实测：退出码恒为 1，失败集合每次都不同（失败数 3/1/3/2/4）。

# 3) .env 两个入口都要测（只测 npm start 会漏掉缺口）
#    入口 A：npm start → 应读到 .env
#    入口 B：node src/server.js → 修复前会被忽略
```

判定标准：

| 检查 | 通过条件 |
|---|---|
| `npm run test:unit` | 退出码 0 |
| `npm run test:e2e` | 退出码 0 |
| `node scripts/smoke.js` | 退出码 0，输出含「冒烟通过 ✅」 |
| `npm test` | 退出码 0，**且连跑 3 次结果完全一致（都是 0 失败）** |
| `.env` | `npm start` 与 `node src/server.js` **两个入口都**读到 `.env` |
| Key 不泄漏 | §3.1 的 canary sweep 全部 `clean` |
| 演示零外连 | §1.5 的 `lsof` 采样 8 次全无外连 |

**任何一条不满足，报告 §6 的对应错误就仍然存在**（或出现了新的偏差）。

---

## 附：本清单覆盖不到的（诚实列出）

1. **真实浏览器里的视觉/交互**（360px 是否横向滚动、空状态好不好看）—— 无浏览器自动化测试。
2. **`HANDOFF_INTEGRATION=1` 的真实模式 e2e** —— 本轮未跑（S8 报告称 300 秒预算跑不完，缺陷 #10）。
3. **Windows / Linux 上的 Cherry Studio 路径** —— 代码硬编码 macOS 路径，未实测其他平台。
4. **多进程/反代下的限流** —— 进程内 Map，未实测多实例。
5. **`kill -9` 写到一半的崩溃恢复** —— 只验证了「启动时把 running 标成 INTERRUPTED」这条路径。
6. **模型输出质量** —— 只验证「引擎能不能处理输出」，不验证「模型写得好不好」。
