"""pytest 夹具.

用 **httpx.ASGITransport 直连 ASGI app**, 不用 starlette 的 TestClient ——
本机这套组合(starlette + httpx 0.28)在 pytest 下会出现退出阶段挂住的现象,
而 ASGITransport 没有这个问题, 也不引入对 TestClient 弃用路径的依赖。

每个用例拿到:
    * 独立的临时数据目录(不会污染真实 data/)
    * 干净的 events 日志与限流计数
    * 一个同步风格的 client(内部自动跑事件循环), 便于写直白的断言
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src_py"))

# 模块只导入一次: 反复 sys.modules.pop 会让 server 里的 app 与新的 store 模块
# 指向不同的实例, 那才是真正的诡异来源。
import events as events_mod  # noqa: E402
import httpx  # noqa: E402
import server as server_mod  # noqa: E402
import store as store_mod  # noqa: E402


class SyncClient:
    """把 async 的 httpx client 包成同步接口, 省得每个用例写 async."""

    def __init__(self, app):
        self._transport = httpx.ASGITransport(app=app)
        self._client = httpx.AsyncClient(transport=self._transport,
                                         base_url="http://testserver")

    # -- 请求 --------------------------------------------------------------

    def request(self, method: str, url: str, **kw):
        return asyncio.run(self._client.request(method, url, **kw))

    def get(self, url: str, **kw):
        return self.request("GET", url, **kw)

    def post(self, url: str, **kw):
        return self.request("POST", url, **kw)

    def delete(self, url: str, **kw):
        return self.request("DELETE", url, **kw)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # 1) 独立数据目录
    monkeypatch.setenv("HANDOFF_DATA_DIR", str(tmp_path))
    (tmp_path / "jobs").mkdir(parents=True, exist_ok=True)
    store_mod.set_data_dir(str(tmp_path))
    store_mod.reset_store()

    # 2) 清干净事件与限流, 避免用例互相干扰
    events_mod.events.reset()
    server_mod._limiter.hits.clear()

    # 3) 不配任何模型 key -> 走离线降级路径, 测试快且确定
    for k in ("DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(k, raising=False)

    # 4) 生命周期: 手动跑 startup/shutdown(ASGITransport 不会触发 lifespan)
    asyncio.run(server_mod._on_startup())
    try:
        yield SyncClient(server_mod.app)
    finally:
        asyncio.run(server_mod._on_shutdown())
        store_mod.reset_store()
        os.environ.pop("HANDOFF_DATA_DIR", None)
