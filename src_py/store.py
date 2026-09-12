"""Job 的 JSON 文件存储.

一个任务一个文件: data/jobs/<id>.json。这样刷新页面还在, 也不依赖数据库。

从 Node 版 src/store/json-store.js 继承下来的几条纪律:
    * **原子写**: 先写 .tmp 再 os.replace, 避免进程被杀时留下半个 JSON
    * **每 job 一把锁**: update_job 是「读-改-写」, 并发时后写的会覆盖前写的
    * **启动扫盘全量**: 恢复中断任务时必须扫磁盘而不是内存缓存, 否则任务数
      超过缓存上限后, 更早的中断任务永远卡在 "running"
    * **清理孤儿 .tmp**: 崩溃会留下临时文件, 不清会越积越多
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Any, Callable, Iterable

# 契约: id 形如 job_ + 8..32 位小写字母数字
JOB_ID_RE = re.compile(r"^job_[a-z0-9]{8,32}$")

DEFAULT_LIMIT = 50
MAX_LIST_ON_DISK = 5000

_lock = threading.RLock()
# 已删除的 job: 后台阶段可能在删除后完成并试图写回, 必须挡住。
# 只记一小段时间(几秒), 之后清理, 避免无限增长。
_deleted_at: dict[str, float] = {}
_DELETED_GUARD_SEC = 60.0
_write_locks: dict[str, threading.Lock] = {}
_cache: dict[str, dict] = {}
_loaded = False
_data_dir_override: str | None = None
_sync_timer: threading.Thread | None = None
_sync_stop = threading.Event()


# --------------------------------------------------------------------------
# 路径
# --------------------------------------------------------------------------


def _root_dir() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_data_dir() -> str:
    """数据目录. 可用 HANDOFF_DATA_DIR 覆盖(测试用临时目录)."""
    global _data_dir_override
    if _data_dir_override:
        return _data_dir_override
    env = os.environ.get("HANDOFF_DATA_DIR")
    if env:
        return os.path.abspath(env)
    return os.path.join(_root_dir(), "data")


def set_data_dir(path: str | None) -> None:
    global _data_dir_override, _loaded
    _data_dir_override = os.path.abspath(path) if path else None
    _loaded = False
    with _lock:
        _cache.clear()


def get_jobs_dir() -> str:
    return os.path.join(get_data_dir(), "jobs")


# --------------------------------------------------------------------------
# id 校验
# --------------------------------------------------------------------------


def is_valid_job_id(job_id: Any) -> bool:
    return isinstance(job_id, str) and bool(JOB_ID_RE.match(job_id))


def assert_valid_job_id(job_id: Any) -> str:
    """非法 id 直接抛 —— 也顺带挡住路径穿越(../ 之类)."""
    from errors import AppError, ERR
    if not is_valid_job_id(job_id):
        raise AppError(ERR.BAD_REQUEST, "任务编号不合法。", status=400)
    return job_id


# --------------------------------------------------------------------------
# 原子读写
# --------------------------------------------------------------------------


def _job_path(job_id: str) -> str:
    assert_valid_job_id(job_id)
    return os.path.join(get_jobs_dir(), f"{job_id}.json")


def _atomic_write(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        fh.flush()
        os.fsync(fh.fileno())          # 断电时也不留空文件
    os.replace(tmp, path)              # 原子替换


def _job_lock(job_id: str) -> threading.Lock:
    with _lock:
        lk = _write_locks.get(job_id)
        if lk is None:
            lk = threading.Lock()
            _write_locks[job_id] = lk
        return lk


def sweep_tmp_files() -> int:
    """清掉崩溃留下的 *.tmp. 返回清理数量."""
    d = get_jobs_dir()
    if not os.path.isdir(d):
        return 0
    removed = 0
    for name in os.listdir(d):
        if not name.endswith(".tmp"):
            continue
        p = os.path.join(d, name)
        try:
            os.remove(p)
            removed += 1
        except OSError:
            pass
    return removed


# --------------------------------------------------------------------------
# 载入
# --------------------------------------------------------------------------


def load_from_disk(force: bool = False) -> int:
    """把磁盘上的 job 读进内存缓存. 返回载入条数."""
    global _loaded
    with _lock:
        if _loaded and not force:
            return len(_cache)
        _cache.clear()
        d = get_jobs_dir()
        if not os.path.isdir(d):
            _loaded = True
            return 0
        for name in sorted(os.listdir(d)):
            if not name.endswith(".json"):
                continue
            job_id = name[:-5]
            if not is_valid_job_id(job_id):
                continue
            try:
                with open(os.path.join(d, name), "r", encoding="utf-8") as fh:
                    job = json.load(fh)
                if isinstance(job, dict):
                    job.setdefault("id", job_id)
                    _cache[job_id] = job
            except (OSError, json.JSONDecodeError):
                # 坏文件不能挡住启动, 跳过即可
                continue
        _loaded = True
        return len(_cache)


# --------------------------------------------------------------------------
# 后台同步
# --------------------------------------------------------------------------


def start_sync_timer(interval_ms: int = 30_000) -> None:
    """周期性地把内存里比磁盘新的 job 落盘.

    写操作本身是即时的; 这个定时器是**兜底**: 万一某次写失败(磁盘满/权限),
    下一个周期还会再试一次, 而不是永久丢数据。
    """
    global _sync_timer
    if _sync_timer is not None and _sync_timer.is_alive():
        return
    _sync_stop.clear()

    def loop() -> None:
        while not _sync_stop.wait(interval_ms / 1000.0):
            try:
                flush_writes()
            except Exception:
                continue

    _sync_timer = threading.Thread(target=loop, name="store-sync", daemon=True)
    _sync_timer.start()


def stop_sync_timer() -> None:
    _sync_stop.set()
    global _sync_timer
    _sync_timer = None


def flush_writes() -> int:
    """把缓存里的 job 全部重写一遍(幂等). 返回写了几条."""
    with _lock:
        snapshot = list(_cache.items())
    n = 0
    for job_id, job in snapshot:
        try:
            _atomic_write(_job_path(job_id), job)
            n += 1
        except (OSError, ValueError):
            continue
    return n


# --------------------------------------------------------------------------
# CRUD
# --------------------------------------------------------------------------


def mark_deleted(job_id: str) -> None:
    """标记 job 已删除, 之后一段时间内忽略对它的任何写入."""
    with _lock:
        _deleted_at[job_id] = time.time()


def _is_deleted(job_id: str) -> bool:
    with _lock:
        ts = _deleted_at.get(job_id)
        if ts is None:
            return False
        if time.time() - ts > _DELETED_GUARD_SEC:
            _deleted_at.pop(job_id, None)
            return False
        return True


def save_job(job: dict) -> dict | None:
    job_id = assert_valid_job_id(job.get("id"))
    if _is_deleted(job_id):
        # 删除后后台阶段想把 job 写回来 —— 忽略, 否则界面上的任务会"复活"
        return None
    with _job_lock(job_id):
        with _lock:
            _cache[job_id] = job
        _atomic_write(_job_path(job_id), job)
    return job


def get_job(job_id: str) -> dict | None:
    if not is_valid_job_id(job_id):
        return None
    with _lock:
        job = _cache.get(job_id)
        if job is not None:
            return job
    # 缓存里没有: 可能磁盘上新增了(另一个进程/手工放进来的)
    path = _job_path(job_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            job = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    if isinstance(job, dict):
        job.setdefault("id", job_id)
        with _lock:
            _cache[job_id] = job
        return job
    return None


def update_job(job_id: str, mutator: Callable[[dict], Any]) -> dict | None:
    """读-改-写, 全程持锁. mutator 就地修改 job 即可(返回值忽略)."""
    if not is_valid_job_id(job_id):
        return None
    if _is_deleted(job_id):
        return None
    with _job_lock(job_id):
        job = get_job(job_id)
        if job is None:
            return None
        mutator(job)
        with _lock:
            _cache[job_id] = job
        try:
            _atomic_write(_job_path(job_id), job)
        except (OSError, ValueError):
            # 落盘失败先留在内存, 由 sync timer 重试 —— 不能让用户这次操作失败
            pass
        return job


def list_all_jobs_on_disk(limit: int = MAX_LIST_ON_DISK) -> list[dict]:
    """扫磁盘全量. 恢复中断任务必须用这个, 不能用缓存."""
    d = get_jobs_dir()
    if not os.path.isdir(d):
        return []
    out: list[dict] = []
    names = sorted((n for n in os.listdir(d) if n.endswith(".json")), reverse=True)
    for name in names[:limit]:
        job = get_job(name[:-5])
        if job:
            out.append(job)
    return out


def list_jobs(limit: int = DEFAULT_LIMIT) -> list[dict]:
    """最新在前(按 createdAt 降序). 契约固定默认 50 条."""
    load_from_disk()
    with _lock:
        jobs = list(_cache.values())
    jobs.sort(key=lambda j: j.get("createdAt") or 0, reverse=True)
    return jobs[:limit]


def delete_job(job_id: str) -> bool:
    if not is_valid_job_id(job_id):
        return False
    mark_deleted(job_id)
    with _job_lock(job_id):
        with _lock:
            _cache.pop(job_id, None)
        path = _job_path(job_id)
        try:
            os.remove(path)
            removed = True
        except FileNotFoundError:
            removed = False
        except OSError:
            removed = False
    return removed


def count_jobs() -> int:
    d = get_jobs_dir()
    if not os.path.isdir(d):
        return 0
    return sum(1 for n in os.listdir(d) if n.endswith(".json"))


def reset_store() -> None:
    """测试用: 清空内存缓存与锁."""
    with _lock:
        _cache.clear()
        _write_locks.clear()
        global _loaded
        _loaded = False
