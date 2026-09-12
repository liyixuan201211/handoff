"""一个**真的** MCP 服务端(stdio 传输), 供 tests_py 测 MCP 客户端.

为什么要有它: MCP 集成最容易「看起来做完了、其实没通」。只有拿一个真服务端、
走真协议、真子进程通信, 才能证明 Python 版客户端的 JSON-RPC 分帧、握手顺序、
`isError` 识别这几处是真的对 —— 我们自己的 mock 只会按我们的**假设**回应,
而真实协议可能有我们没想到的字段与时序。

暴露三个工具(与 Node 版 tests/fixtures/mock-mcp-server.mjs 对齐):
    echo        —— 回显输入(测基本通路)
    add         —— 算两个数之和(测结构化结果)
    fail_always —— 返回 isError:true 的结果(测错误不会被吞成成功)

命令行开关:
    --pid-file PATH   把自身 pid 写进去(测试用它验证退出后没有孤儿进程)
    --child           额外拉起一个休眠子进程(模拟 npx → node 的进程树,
                      测试按进程组杀是否真的收干净)
    --log PATH        把收到的每个请求方法名追加进去(测试断言握手顺序)

stdout 只用于协议帧 —— 任何调试输出都必须走 stderr, 否则会污染分帧。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

PROTOCOL_VERSION = "2024-11-05"

TOOLS = [
    {
        "name": "echo",
        "description": "把输入原样返回",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}},
                        "required": ["text"]},
    },
    {
        "name": "add",
        "description": "算两个数之和",
        "inputSchema": {"type": "object", "properties": {"a": {"type": "number"},
                                                        "b": {"type": "number"}},
                        "required": ["a", "b"]},
    },
    {
        "name": "fail_always",
        "description": "永远失败，用来测错误处理",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def _arg(name: str, default: str | None = None) -> str | None:
    argv = sys.argv[1:]
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


def _log(method: str) -> None:
    path = _arg("--log")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(method + "\n")
    except OSError:
        pass


def _send(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _handle(msg: dict) -> None:
    method = msg.get("method")
    rid = msg.get("id")
    _log(str(method))

    if rid is None:
        return  # 通知: notifications/initialized 之类, 不回包

    if method == "initialize":
        _send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "handoff-mock", "version": "1.0.0"},
        }})
        return

    if method == "tools/list":
        _send({"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}})
        return

    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "echo":
            _send({"jsonrpc": "2.0", "id": rid, "result": {
                "content": [{"type": "text", "text": f"echo: {args.get('text', '')}"}]}})
        elif name == "add":
            total = args.get("a", 0) + args.get("b", 0)
            _send({"jsonrpc": "2.0", "id": rid, "result": {
                "content": [{"type": "text", "text": str(total)}]}})
        elif name == "fail_always":
            # 关键: 工具内部报错走的是**正常结果 + isError:true**, 不是 JSON-RPC error
            _send({"jsonrpc": "2.0", "id": rid, "result": {
                "isError": True,
                "content": [{"type": "text", "text": "这是故意的失败（mock 服务）"}]}})
        else:
            _send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601,
                                                          "message": f"未知工具 {name}"}})
        return

    _send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"未知方法 {method}"}})


def main() -> int:
    pid_file = _arg("--pid-file")
    if pid_file:
        try:
            with open(pid_file, "w", encoding="utf-8") as fh:
                fh.write(str(os.getpid()))
        except OSError:
            pass

    child = None
    if "--child" in sys.argv[1:]:
        # 模拟 npx → node 这样的进程树: 只杀直接子进程会留下它
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
        child_pid_file = _arg("--child-pid-file")
        if child_pid_file:
            try:
                with open(child_pid_file, "w", encoding="utf-8") as fh:
                    fh.write(str(child.pid))
            except OSError:
                pass

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if isinstance(msg, dict):
                _handle(msg)
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        if child is not None:
            try:
                child.kill()
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
