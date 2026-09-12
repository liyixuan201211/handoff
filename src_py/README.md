# 交接 Handoff — Python 后端

`docs/CONTRACT.md` 冻结部分的 **Python 实现**。与 Node 版并排存在，共用同一个
`data/` 目录和同一个 `public/` 前端，因此可以两套一起跑、用同一批真实数据对照行为。

## 为什么要有这一版

Node 版是好用的，但原后端是 Node + Express。这一版把同样的契约用 Python 重写，
保留全部对外行为不变——**契约冻结，实现自由**。

| | Node 版 | Python 版 |
|---|---|---|
| 入口 | `src/server.js` | `src_py/server.py` |
| 框架 | Express 5 | FastAPI + uvicorn |
| 默认端口 | `8787` | `8790` |
| 数据 | `data/jobs/*.json` | **同一份**（直接复用） |
| 前端 | `public/` | **同一份** |
| 测试 | `tests/` (vitest) | `tests_py/` (pytest) |

## 快速开始

```bash
# 依赖（已经装好，重新装用这条）
uv venv .venv
uv pip install --python .venv/bin/python fastapi "uvicorn[standard]" pytest httpx

# 启动
.venv/bin/python -m uvicorn src_py.server:app --host 127.0.0.1 --port 8790
# 或者
.venv/bin/python src_py/server.py

# 测试
.venv/bin/python -m pytest tests_py -q
```

环境变量与 Node 版**一致**：`HANDOFF_HOST` / `HANDOFF_PORT`（Python 版额外认
`HANDOFF_PY_PORT` 便于两套并行）、`HANDOFF_DATA_DIR`、以及各家的 `*_API_KEY`。

## 实现的契约

### HTTP API（`docs/CONTRACT.md` §2，全部 10 个端点）

```
GET    /api/health
GET    /api/templates
POST   /api/jobs                                    201, 立即返回
GET    /api/jobs                                    最新在前, 最多 50
GET    /api/jobs/:id
GET    /api/jobs/:id/versions
POST   /api/jobs/:id/message                        兼容 {text} 与 {message}
POST   /api/jobs/:id/retry
DELETE /api/jobs/:id
GET    /api/jobs/:id/artifacts/:artifactId/download
GET    /api/jobs/:id/stream                         SSE
```

错误统一形状：

```json
{ "error": { "code": "NOT_FOUND", "message": "找不到这个任务。" } }
```

错误码与 Node 版逐一对齐（`BAD_REQUEST` / `NOT_FOUND` / `RATE_LIMITED` /
`PAYLOAD_TOO_LARGE` / `LLM_*` / `PIPELINE_*` / `SECURITY_BLOCKED`）。

### SSE（§2）

- 事件类型：`job` / `stage` / `log` / `artifact` / `review` / `security` / `clarify` / `done` / `error`
- 连接时先补发全量快照，再增量推送
- **`seq` 走 SSE 的 `id:` 行**（不是塞进 JSON），浏览器重连时自动回传
  `Last-Event-ID`，服务端据此补发
- 立刻发 `: connected` 注释帧——否则新建且暂无事件的任务会让前端一直转圈
- 15 秒心跳防代理掐连接
- 检测到断档（请求的 seq 已被环形缓冲挤掉）时发 `resync` 事件，
  让前端用权威快照重新对齐，而不是静默少发一段
- 每个 job 的环形日志上限 500 条，订阅在响应关闭时解绑

### 流水线（§3）

8 个阶段保序执行，硬规则逐条落实：

| 规则 | 实现位置 |
|---|---|
| intake 第一、deliver 最后 | `engine.STAGE_ORDER` |
| 任一阶段失败 → job failed，但**已完成的产物保留** | `engine._fail()` |
| 每阶段结束**必须** emit | `engine._run_stage()` |
| 阶段前检查取消，收到信号立即停 | `engine.is_aborted()` 在阶段边界检查 |
| 只在明确缺信息时才 `clarifyQuestions` | 默认策略"先做，把假设亮出来" |

## 从 Node 版继承的实战教训

这些不是设计洁癖，每一条都对应一个真实的坑，代码里都有注释：

1. **原子写**：先写 `.tmp` 再 `os.replace`，进程被杀不会留下半个 JSON
2. **每 job 一把锁**：`update_job` 是读-改-写，并发时会互相覆盖
3. **启动扫盘全量**：恢复中断任务不能用内存缓存，否则任务数超上限后更早的
   中断任务永远卡在 `running`
4. **删除要防复活**：后台阶段可能在删除后完成并写回，所以有 `mark_deleted` 守卫
5. **取消不能只靠 `task.cancel()`**：跨事件循环调用不是线程安全的，因此另有一个
   同步 `_aborted` 标记在阶段边界兜底
6. **不信任 `X-Forwarded-For`**：伪造它就能绕过限流
7. **限流器要能 dispose**：定时清理是必需的，但测试必须能停掉
8. **字段名兼容**：契约写 `{text}`、前端发 `{message}`，两个都收——这类偏差
   两边各自的测试都是绿的，只有端到端真跑才会暴露
9. **脱敏要排除自己的占位符**：`***:***@host` 仍匹配凭据正则，
   自检必须放过它，否则"永远为真的安全断言"等于没有断言
10. **响应头里的文件名**：同时给 ASCII 回退与 RFC 5987，并清掉控制字符
    （换行能注入额外响应头）

## 测试

54 项契约测试，3.3 秒：

```
.venv/bin/python -m pytest tests_py -q
```

覆盖：全部 10 个端点、状态码、Job 冻结形状、校验错误、限流、
路径穿越、SSE 协议（seq 行、环形缓冲、断档、退订、closed 通知）、
存储原子性与坏文件容错、脱敏与文件名净化。

关于 SSE 测试的一个取舍：**不发真实的流式 HTTP 请求**。缓冲式客户端会等响应体
结束而 SSE 永不结束；而同一进程里反复 `asyncio.run()` 会留下绑定在已关闭循环上的
后台任务，产生"环境造成的假挂起"。真实长连接行为由端到端验证覆盖
（启动服务 + `curl -N` 抓到 8 个阶段的完整推进），单测只把协议契约钉死。

## 已验证的能力

- **直接复用 Node 版数据**：指向 `data/` 能读到已有任务，`public_job` 形状齐全，只读不改
- **完整流水线**：创建任务 → SSE 观察到 8 阶段依次 running→done → 产出交付物与 review
- **离线可用**：没配模型 key 时走确定性降级路径，产出结构完整的交付物，
  服务不会因为缺 key 就不可用

## 文件

```
src_py/
├── server.py      FastAPI 装配、10 个端点、限流与错误处理、崩溃恢复
├── engine.py      8 阶段流水线、事件发射、追加要求/重试/取消
├── gateway.py     模型网关（OpenAI 兼容 + Anthropic），JSON 提取与错误分类
├── store.py       JSON 文件存储：原子写、每 job 锁、删除守卫、磁盘全量扫描
├── events.py      事件总线：环形日志、seq 游标、订阅、drop 通知
├── sse.py         SSE：补发、断档 resync、心跳、注释帧
├── jobs.py        输入校验、Job 公开形状、文件名净化
├── ratelimit.py   滑动窗口限流
└── errors.py      错误码、AppError、密钥脱敏

tests_py/
├── conftest.py    夹具（httpx ASGITransport，不用已弃用的 TestClient 路径）
└── test_contract.py
```

## 工具与安全层（已移植）

| 模块 | 对应 Node 文件 | 说明 |
|---|---|---|
| `guard.py` | `security/guard.js`（794 行） | 提示注入 / PII / 密钥 / 危险命令 / 不安全 HTML |
| `net_guard.py` | `tools/net-guard.js`（311 行） | SSRF 与 DNS rebinding 防护、路径穿越 |
| `tools.py` | `tools/registry.js` + `tools/native.js` | 工具注册表 + 内置工具 |
| `mcp_client.py` | `tools/mcp-client.js`（284 行） | MCP over stdio 客户端 |
| `skill_loader.py` | `skills/loader.js`（272 行） | 技能加载与按目标筛选 |

已接进流水线（不是躺在那里）：

- **输入净化**：`jobs.normalize_job_input()` 走 `guard.sanitize_user_input` ——
  剥控制字符/零宽字符、检测注入、超长**截断而非拒绝**（粘贴长合同是正常需求）
- **指令隔离**：用户文本送进模型前一律 `guard.wrap_untrusted`，
  就算特征检测漏了，模型也能从标签看出"这是数据不是指令"
- **交付前审计**：`deliver` 阶段对全部产物跑 `guard.audit_output`，
  密钥打码、危险命令、PII 都在这道关拦下，结果写进契约的 `job.security`
- **工具体系**：启动时注册内置工具并加载技能，`GET /api/tools` 可观测

### 移植时踩到的语言差异

1. **JS 的 `\d`/`\w`/`\b` 是 ASCII 语义，Python 默认是 Unicode**。
   不加 `re.ASCII` 的话 `\d` 会匹配全角数字，PII 检测会乱报漏报。
   所有规则一律加 `re.ASCII`。
2. **`100.64.0.0/10`（CGNAT）Python 标准库不认为是 private**，而 Node 明确拦它。
   已显式补上；`198.18.0.0/15` 同理。
3. **`redact_case_insensitive` 必须重新编译成 IGNORECASE**。
   直接复用 `SECRET_PATTERNS` 是错的 —— 那些 pattern 里只有 Bearer 带 `re.I`，
   其余大小写敏感，于是 `SK-ABC...` 打不掉，而这正是这个函数存在的理由。
4. **NFKC 只作用于检测副本**。它会收敛全角标点（，→,），
   改到用户正文上就是"交付物引用的原文标点被改了"的可见缺陷。

### 已知边界

- 语气模板（`tone: simple/formal`）在 Python 版里是简化实现。
- `tools/native.js` 的网页抓取额外依赖（如 Jina reader 之类的降级通道）未移植。
- MCP 的 HTTP/SSE 传输未移植，只做了 stdio（本地子进程）——这也是默认且更安全的路径。
