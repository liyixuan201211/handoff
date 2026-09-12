"""Server-Sent Events.

为什么是 SSE 而不是 WebSocket:
    这个场景是**单向下行**(服务端推流水线进度给浏览器), 原生 EventSource 就能用,
    浏览器自带重连且会带 Last-Event-ID, 不需要握手协议。

三个必须做对的地方(全部来自 Node 版的实战教训):
  1. **断线重连补发**: 刷新页面/断网回来, 必须补回丢失的事件。
  2. **绝不泄漏**: 每个连接一个定时器 + 一个订阅, 忘了解绑聊十分钟就 OOM。
  3. **断档必须显式告知**: 环形日志只有 500 条, 断开太久时请求的 seq 已被挤掉,
     若静默少发一段, 前端以为事件连续, 进度条会永远停在半路且毫无提示。
     所以检测到 gap 要发 resync, 让前端用权威快照重新对齐。
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, AsyncIterator

from events import events

HEARTBEAT_SEC = 15.0
MAX_REPLAY = 500           # 一次重连最多补发这么多条, 防止恶意 since=0 拖垮内存
POLL_SEC = 0.25            # 事件推送的轮询粒度


def _safe_json(value: Any) -> str:
    try:
        s = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        return s if s is not None else "{}"
    except (TypeError, ValueError):
        # 事件都是纯数据, 理论上不该失败; 但 SSE 掉线比丢一条事件严重得多
        return json.dumps({"type": "error", "message": "事件序列化失败", "stageId": None},
                          ensure_ascii=False)


def format_sse(event: dict) -> bytes:
    """一条 SSE 消息. id: 让浏览器重连时自动带上 Last-Event-ID."""
    payload = dict(event)
    seq = payload.pop("seq", None)
    id_line = f"id: {seq}\n" if isinstance(seq, int) else ""
    return f"{id_line}event: message\ndata: {_safe_json(payload)}\n\n".encode("utf-8")


def resolve_since(query_since: str | None, last_event_id: str | None,
                  fallback: int = 0) -> int:
    """解析 since: query ?since= 与 Last-Event-ID 取较大者, 非法值忽略."""

    def parse(v: Any) -> int | None:
        try:
            n = int(str(v).strip())
            return n if n >= 0 else None
        except (TypeError, ValueError):
            return None

    candidates = [c for c in (fallback, parse(query_since), parse(last_event_id))
                  if c is not None]
    return max(candidates) if candidates else 0


async def sse_stream(job_id: str, since: int = 0,
                     is_closed: Any = None) -> AsyncIterator[bytes]:
    """SSE 事件流.

    顺序有讲究: **先订阅再补发** —— 两者之间不能有 await, 否则中间产生的事件
    会丢。用 last_sent 游标把补发与实时可能重叠的部分去重。

    is_closed: 可选的无参回调, 返回 True 表示 job 已不存在, 流应结束。
    """
    # 已发出的最大 seq. 只比较它而不是维护 Set: 连接可能挂几小时,
    # 每条事件都塞进 Set 就是稳定增长的内存泄漏。
    last_sent = since
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def listener(event: dict) -> None:
        # 从任意线程/同步上下文回到事件循环
        try:
            loop.call_soon_threadsafe(queue.put_nowait, event)
        except RuntimeError:
            pass                     # 循环已关闭

    unsubscribe = events.subscribe(job_id, listener)

    try:
        # 立刻吐一个注释帧: 告诉客户端/代理「连接已建立」。
        # 否则一个还没有任何事件的新 job 会让前端干等到 15 秒心跳, 用户看到转圈。
        yield b": connected\n\n"

        # ---- 补发历史 ----
        history = events.since(job_id, since)
        replay = history[-MAX_REPLAY:] if len(history) > MAX_REPLAY else history

        earliest = replay[0].get("seq") if replay else None
        if since > 0 and earliest is not None and earliest > since + 1:
            # 请求的 seq 已经被环形缓冲挤掉 -> 明确告知, 让前端走权威快照
            yield (
                "event: resync\ndata: "
                + _safe_json({
                    "type": "resync",
                    "reason": "gap",
                    "requestedSince": since,
                    "earliestAvailable": earliest,
                    "dropped": earliest - since - 1,
                })
                + "\n\n"
            ).encode("utf-8")

        for event in replay:
            seq = event.get("seq")
            if isinstance(seq, int):
                if seq <= last_sent:
                    continue
                last_sent = seq
            if event.get("type") == "closed":
                yield b'event: closed\ndata: {"type":"closed"}\n\n'
                return
            yield format_sse(event)

        # ---- 增量推送 + 心跳 ----
        last_beat = time.monotonic()
        while True:
            if is_closed is not None and is_closed():
                # 任务被删了 -> 主动收尾, 否则连接会一直挂着
                yield b'event: closed\ndata: {"type":"closed"}\n\n'
                return

            try:
                event = await asyncio.wait_for(queue.get(), timeout=POLL_SEC)
            except asyncio.TimeoutError:
                if time.monotonic() - last_beat >= HEARTBEAT_SEC:
                    last_beat = time.monotonic()
                    yield b": ping\n\n"
                continue

            if event.get("type") == "closed":
                yield b'event: closed\ndata: {"type":"closed"}\n\n'
                return

            seq = event.get("seq")
            if isinstance(seq, int):
                if seq <= last_sent:
                    continue
                last_sent = seq
            yield format_sse(event)
    finally:
        # 必须解绑, 否则内存泄漏
        unsubscribe()
