/**
 * 运行时开关。
 *
 * 为什么单独一个文件、而不是塞进 engine 或 prompts：
 * 这个函数被 `server.js`、`pipeline/engine.js` 一起用，而测试经常 `vi.mock()`
 * 整个 engine 模块 —— 那样一来 engine 的导出会变成 undefined，
 * `/api/health` 直接 500。**被多处引用的纯工具必须放在没有人会去 mock 的小模块里。**
 */

/** 整站演示模式：HANDOFF_DEMO=1 时不调用任何模型，用离线数据跑完整流程 */
export const isDemoMode = () =>
  ['1', 'true', 'yes', 'on'].includes(String(process.env.HANDOFF_DEMO ?? '').toLowerCase());

/** 单次模型调用的超时（毫秒） */
export const llmTimeoutMs = () =>
  Number(process.env.HANDOFF_LLM_TIMEOUT_MS) || 120_000;
