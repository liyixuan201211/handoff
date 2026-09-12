"""滑动窗口限流.

为什么自写: 契约禁止新增依赖, 而这件事本身只有几十行。

为什么用 list[时间戳] 而不是计数器: 需要的是"最近 60 秒内几次", 计数窗口
做不到平滑 —— 计数器会在窗口边界放过两倍流量。

为什么必须有 dispose(): 定时清理是必需的(否则恶意 IP 能把内存撑爆),
但测试里必须能停掉, 不然进程会挂着一个永不退出的线程。
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class Rule:
    name: str
    method: str
    limit: int
    match: Callable[[str], bool]


def _is_create_job(path: str) -> bool:
    return path == "/api/jobs"


_MESSAGE_RE = None


def _is_message(path: str) -> bool:
    global _MESSAGE_RE
    if _MESSAGE_RE is None:
        import re
        _MESSAGE_RE = re.compile(r"^/api/jobs/[^/]+/message$")
    return bool(_MESSAGE_RE.match(path))


# 契约 §5.7: POST /api/jobs 每 IP 每分钟 10 次; /message 每分钟 20 次
RATE_RULES: list[Rule] = [
    Rule("createJob", "POST", 10, _is_create_job),
    Rule("message", "POST", 20, _is_message),
]


class RateLimiter:
    def __init__(self, rules: list[Rule] | None = None,
                 window_ms: int = 60_000, cleanup_ms: int = 60_000,
                 now: Callable[[], float] | None = None):
        self.rules = rules or []
        self.window_ms = window_ms
        self._now = now or (lambda: time.time() * 1000)
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._timer = threading.Thread(target=self._loop, args=(cleanup_ms,),
                                       name="ratelimit-cleanup", daemon=True)
        self._timer.start()

    def _loop(self, cleanup_ms: int) -> None:
        while not self._stop.wait(cleanup_ms / 1000.0):
            self._prune_all()

    def _prune_all(self) -> None:
        ts = self._now()
        with self._lock:
            for key in list(self._hits):
                lst = self._hits[key]
                self._prune(lst, ts)
                if not lst:
                    self._hits.pop(key, None)

    def _prune(self, lst: list[float], ts: float) -> None:
        while lst and ts - lst[0] >= self.window_ms:
            lst.pop(0)

    def match(self, method: str, path: str) -> Rule | None:
        for r in self.rules:
            if r.method == method and r.match(path):
                return r
        return None

    def hit(self, rule: Rule, client_ip: str) -> tuple[bool, int]:
        """记一次访问. 返回 (是否放行, 超限时建议等待秒数)."""
        key = f"{rule.name}|{client_ip}"
        ts = self._now()
        with self._lock:
            lst = self._hits.setdefault(key, [])
            self._prune(lst, ts)
            if len(lst) >= rule.limit:
                retry_ms = max(0.0, self.window_ms - (ts - lst[0]))
                return False, int(retry_ms / 1000 + 0.999)
            lst.append(ts)
            return True, 0

    def dispose(self) -> None:
        """停掉清理线程(测试与优雅退出都要用)."""
        self._stop.set()

    # 测试辅助
    @property
    def hits(self) -> dict[str, list[float]]:
        return self._hits
