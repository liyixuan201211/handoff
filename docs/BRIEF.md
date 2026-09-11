# Handoff 开发简报（所有子代理入口）

> 你是「交接 Handoff」项目的一名工程师。这份简报 + `docs/CONTRACT.md` 就是你需要的全部背景。
> **先读 `docs/CONTRACT.md`**，它是硬约束。

---

## 项目根目录

```
/Users/imac/260912/handoff
```

所有路径都相对这里。**绝对不要写到这个目录之外。**

---

## 这是什么产品

**把普通人说不清楚的需求，变成 AI 团队真正交付的成果。**

用户（老师、小店主、护士、学生）只需要说人话：
> 「帮我把这份租房合同看一遍，我怕有坑」

然后一支可见的 AI 团队（接待员 → 项目经理 → 调研员 → 执行专员 → 审查员 → 质检员 → 交付专员）
把它做成真正的交付物，每一步都留下证据。普通人负责「想要什么」和「验收」，其余全部由 AI 承担。

**我们不能做第二个 ChatGPT 套壳。**我们的独特性在于：
1. **深度**：7 个阶段的真实流水线，不是一次问答
2. **可见**：用户能看到每个虚拟员工在干什么、花了多久
3. **诚实**：明确列出「我们替你假设了什么」
4. **抗摔**：模型降级链 + 重试 + JSON 抢救，普通任务不会因为网络抖动失败
5. **透明**：交付物带自检结果和安全审查

---

## 已完成（可以直接用，不要重写）

| 模块 | 状态 |
|---|---|
| `src/llm/errors.js` | ✅ `ERR` 错误码、`AppError`、`redactSecrets()`、`looksLikeSecret()` |
| `src/llm/schema-check.js` | ✅ `validate()`、`assertValid()`、`coerceInPlace()`、`describeEnumConstraints()` |
| `src/llm/json-repair.js` | ✅ `repairJson()` 五级抢救 |
| `src/llm/providers.js` | ✅ `PROVIDERS`、`resolveKey()`、`resolveChain()`、`inspectChain()` |
| `src/llm/gateway.js` | ✅ `callModel()` —— **已用真实 API 验证通过（1.6s）** |
| `src/store/events.js` | ✅ 事件总线 `events.publish/since/subscribe/cursor/drop`、`newId(prefix)` |
| `docs/CONTRACT.md` | ✅ 权威契约 |

`newId` 在 `src/store/events.js` 里，不在 util/ids.js。契约里的 `util/ids.js` 作废，**从 events.js 导入 `newId`**。

---

## 模型怎么调（已验证可用）

```js
import { callModel } from '../llm/gateway.js';

const r = await callModel({
  system: '你是…',
  user: '…',
  schema: { type:'object', required:['x'], properties:{ x:{type:'string'} } },
  maxTokens: 4000,
  temperature: 0.3,
  purpose: 'intake',      // 日志用
  role: '接待员',          // 展示给用户的虚拟员工名
  onNotice: (n) => {},    // 降级/重试/修正时回调，用于给用户解释发生了什么
});
// r = { text, json, usage:{promptTokens,completionTokens}, ms, provider, providerLabel, model, degraded, notices, attempts }
```

真实可用路由（**均已验证**）：
- `deepseek-official/deepseek-flash` = **DeepSeek-V4.1-Flash**（主力）
- `aiping/DeepSeek-V4-Flash`、`aiping/DeepSeek-V4.1-Flash`、`aiping/GLM-5.3`、`aiping/Qwen3.8-Max`（降级链）

Key 自动从 Cherry Studio 本地配置读取，**你什么都不用配**。

**安全铁律**：任何日志、错误信息、HTTP 响应里都不许出现 API Key。需要输出时用 `redactSecrets()`。

---

## 工作纪律

1. **只改你负责的文件。**文件所有权见 `docs/CONTRACT.md` §1。改别人文件会覆盖他的工作，这是本项目最大的风险。
2. **写完必须自己跑起来验证。**不是"看起来对"，是"我真的运行了，输出是这些"。
3. **写测试。**用 vitest（已装好）。`npx vitest run 你的测试文件`
4. **不要用 `npm install` 加新依赖。**只能用 express / vitest / supertest。
5. **不要修改 `docs/CONTRACT.md`。**要偏离先在 `docs/DECISIONS.md` 追加一条，并在报告里说明。
6. **你的报告里必须包含真实的命令与输出**，我会核对。报告写入 `docs/reports/<你的名字>.md`。

---

## 报告格式（写进 docs/reports/<你的名字>.md，并在最终回复里给摘要）

```markdown
# <你的名字> 工作报告 <轮次>
时间：2026-09-12 HH:MM

## 交付
| 文件 | 行数 | 状态 |
|---|---|---|

## 我实际运行的验证
\`\`\`
$ <命令>
<真实输出>
\`\`\`

## 发现的问题 / 风险
- …

## 需要别人配合的事
- …

## 下一轮我建议做什么
- …
```
