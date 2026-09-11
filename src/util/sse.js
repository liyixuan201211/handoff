/**
 * Server-Sent Events 工具。
 *
 * 为什么是 SSE 而不是 WebSocket？
 * 这个场景是**单向下行**（服务端推流水线进度给浏览器），SSE 用原生 EventSource
 * 就能跑，不用任何依赖、不用握手协议、浏览器自动重连还带 Last-Event-ID。
 *
 * 两个必须做对的事，否则线上会很惨：
 *  1. 断线重连补发：用户刷新页面 / 地铁里断网，必须能补回丢失的事件。
 *  2. 绝不泄漏：每个连接一个定时器 + 一个订阅。忘了解绑，聊十分钟就 OOM。
 */
import { events } from '../store/events.js';

/** 心跳间隔：15 秒。防代理/负载均衡把空闲连接掐掉。 */
export const HEARTBEAT_MS = 15_000;

/** 历史补发上限：一次重连最多补这么多条，避免恶意 since=0 拖垮内存 */
const MAX_REPLAY = 500;

function safeJson(value) {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? '{}' : s;
  } catch {
    // 理论上不该发生（事件都是纯数据），但 SSE 掉线比丢一条事件严重得多
    return JSON.stringify({ type: 'error', message: '事件序列化失败', stageId: null });
  }
}

/** 一条 SSE 消息：id 让浏览器自动在重连时带上 Last-Event-ID */
export function formatSse(event) {
  const payload = { ...event };
  const seq = payload.seq;
  delete payload.seq;
  const idLine = Number.isFinite(seq) ? `id: ${seq}\n` : '';
  return `${idLine}event: message\ndata: ${safeJson(payload)}\n\n`;
}

/** 解析 since：query ?since= 与 Last-Event-ID 取较大者，非法值归 0 */
export function resolveSince(req, fallback = 0) {
  const q = req?.query?.since;
  const fromQuery = Number.parseInt(Array.isArray(q) ? q[0] : q, 10);
  const header = req?.headers?.['last-event-id'];
  const fromHeader = Number.parseInt(Array.isArray(header) ? header[0] : header, 10);
  const candidates = [fallback, fromQuery, fromHeader].filter((n) => Number.isFinite(n) && n >= 0);
  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

/**
 * 接上一个 SSE 连接：补发历史 → 增量推送 → 心跳。
 * @returns {() => void} cleanup，调用后释放定时器与监听器（幂等）
 */
export function sseHandler({ jobId, req, res, sinceSeq = 0 } = {}) {
  if (!jobId) throw new Error('sseHandler 需要 jobId');
  if (!req || !res) throw new Error('sseHandler 需要 req/res');

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 关键：nginx 默认会把 text/event-stream 缓冲起来，前端就永远收不到实时更新
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const cursor = resolveSince(req, sinceSeq);
  const sent = new Set();
  let closed = false;
  let unsubscribe = null;
  let heartbeat = null;

  const write = (chunk) => {
    if (closed) return;
    try {
      res.write(chunk);
      res.flush?.();
    } catch {
      // 客户端已经跑了，当作关闭处理
      cleanup();
    }
  };

  const send = (event) => {
    if (closed || !event || typeof event !== 'object') return;
    if (Number.isFinite(event.seq)) {
      if (event.seq <= cursor) return; // 历史已补发，别重复
      if (sent.has(event.seq)) return;
      sent.add(event.seq);
    }
    write(formatSse(event));
  };

  function cleanup() {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    req.off?.('close', cleanup);
    req.off?.('aborted', cleanup);
    res.off?.('close', cleanup);
    res.off?.('error', cleanup);
  }

  // 先订阅再补发历史：中间留出 await 的话会漏事件，sent 集合负责去重
  unsubscribe = events.subscribe(jobId, send);

  // 一条一条写就好（补发是本地内存数组，量很小）
  const history = events.since(jobId, cursor).slice(-MAX_REPLAY);
  for (const event of history) send(event);

  heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
  // 不要把进程钉住
  heartbeat.unref?.();

  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  return cleanup;
}

export default sseHandler;
