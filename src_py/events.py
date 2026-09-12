"""事件总线 + 游标式读日志.

为什么要事件日志而不是纯广播:
    用户会刷新页面、会关掉浏览器再回来。纯内存广播丢事件后, 前端会永远停在
    "运行中"。所以每个事件既广播给在线订阅者, 也按 seq 追加进环形日志,
    重连时用 Last-Event-ID 补发。

与 Node 版 src/store/events.js 行为对齐:
    * 每个 job 最多留 500 条(防止长跑任务吃光内存)
    * publish 返回带 seq/at 的完整事件
    * since(jobId, seq) 读 seq 之后的事件
    * drop() **先**广播 closed 再删日志 —— 让 SSE 连接主动关闭, 否则那条连接
      和它的心跳定时器会一直挂着, 而界面上还写着"进展会实时更新"。
"""

from __future__ import annotations

import threading
import time
import uuid
from collections import deque
from typing import Any, Callable

MAX_LOG_PER_JOB = 500

Listener = Callable[[dict], None]


class JobEvents:
    """按 job 分组的发布/订阅 + 环形事件日志. 线程安全."""

    def __init__(self, max_log: int = MAX_LOG_PER_JOB):
        self._max_log = max_log
        self._lock = threading.RLock()
        # job_id -> {"seq": int, "events": deque[dict]}
        self._logs: dict[str, dict[str, Any]] = {}
        # job_id -> [listener, ...]
        self._subs: dict[str, list[Listener]] = {}

    # -- 写 ----------------------------------------------------------------

    def publish(self, job_id: str, payload: dict) -> dict:
        """追加事件并广播. 返回带 seq/at 的完整事件."""
        with self._lock:
            entry = self._logs.get(job_id)
            if entry is None:
                entry = {"seq": 0, "events": deque(maxlen=self._max_log)}
                self._logs[job_id] = entry
            entry["seq"] += 1
            full = dict(payload)
            full["seq"] = entry["seq"]
            full["at"] = int(time.time() * 1000)
            entry["events"].append(full)      # deque(maxlen) 自动挤掉最旧的
            listeners = list(self._subs.get(job_id, ()))

        # 广播放在锁外: 监听器可能立刻回写(例如 closed 触发 cleanup), 避免死锁
        for fn in listeners:
            try:
                fn(full)
            except Exception:
                # 一个坏监听器不能影响其他订阅者(比如某个页面已经崩了)
                continue
        return full

    # -- 读 ----------------------------------------------------------------

    def since(self, job_id: str, seq: int = 0) -> list[dict]:
        """读 seq 之后的事件(断线重连补发用)."""
        with self._lock:
            entry = self._logs.get(job_id)
            if entry is None:
                return []
            return [e for e in entry["events"] if e.get("seq", 0) > seq]

    def cursor(self, job_id: str) -> int:
        with self._lock:
            entry = self._logs.get(job_id)
            return entry["seq"] if entry else 0

    def earliest_seq(self, job_id: str) -> int | None:
        """环形日志里现存最早的一条 seq —— 用于检测断档."""
        with self._lock:
            entry = self._logs.get(job_id)
            if not entry or not entry["events"]:
                return None
            return entry["events"][0].get("seq")

    # -- 订阅 --------------------------------------------------------------

    def subscribe(self, job_id: str, listener: Listener) -> Callable[[], None]:
        """订阅. 返回退订函数 —— 必须在响应关闭时调用, 否则内存泄漏."""
        with self._lock:
            self._subs.setdefault(job_id, []).append(listener)

        def unsubscribe() -> None:
            with self._lock:
                lst = self._subs.get(job_id)
                if not lst:
                    return
                try:
                    lst.remove(listener)
                except ValueError:
                    pass
                if not lst:
                    self._subs.pop(job_id, None)

        return unsubscribe

    def listener_count(self, job_id: str) -> int:
        with self._lock:
            return len(self._subs.get(job_id, ()))

    # -- 删除 --------------------------------------------------------------

    def drop(self, job_id: str) -> None:
        """job 被删除时清理.

        顺序不能反: 先广播 closed(让 SSE handler 主动关连接), 再清日志与监听器。
        """
        with self._lock:
            listeners = list(self._subs.get(job_id, ()))
        closed = {"type": "closed", "jobId": job_id, "at": int(time.time() * 1000)}
        for fn in listeners:
            try:
                fn(closed)
            except Exception:
                continue
        with self._lock:
            self._logs.pop(job_id, None)
            self._subs.pop(job_id, None)

    # -- 测试辅助 ----------------------------------------------------------

    def reset(self) -> None:
        with self._lock:
            self._logs.clear()
            self._subs.clear()


events = JobEvents()


def new_id(prefix: str) -> str:
    """生成 job_xxx / art_xxx 形式的 id.

    与 Node 版一致: 去掉 UUID 里的连字符取前 16 位, 满足 store.JOB_ID_RE。
    """
    return f"{prefix}_{uuid.uuid4().hex[:16]}"
