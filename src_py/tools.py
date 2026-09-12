"""工具注册表与内置工具.

这是 src/tools/registry.js + src/tools/native.js 的 Python 移植。

注册表负责:
    * 注册/注销工具, 校验定义形状(缺 handler / parameters 直接报错)
    * 统一结果形状 {ok, text, meta, error} —— 模型看到的东西必须一致
    * **执行超时**: 一个卡住的工具会让整条流水线停住, 用户看到进度条不动
    * 输出截断: 网页/文件可能很长, 全塞进上下文会挤掉真正需要的内容

内置工具负责:
    * web_fetch  —— 抓网页并转成纯文本(带 SSRF 防护)
    * web_search —— 搜索(默认 DuckDuckGo HTML, 无需 API key)
    * read_text_file —— 读工作目录内的文件(防路径穿越)

安全要点(移植时逐条保留):
    * 抓取前必须过 net_guard.check_url, 并且**用校验时解析到的 IP 去连**,
      否则 DNS rebinding 会在校验与连接之间换掉解析结果。
    * 读文件默认限制在工作目录内, 不能让模型随便读 ~/.ssh/id_rsa。
"""

from __future__ import annotations

import asyncio
import html as html_mod
import json
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable

import net_guard

TOOL_RESULT_SHAPE = "{ ok:boolean, text:string, meta?:object, error?:string }"
MAX_TOOL_OUTPUT_CHARS = 12000
DEFAULT_TOOL_TIMEOUT_MS = 20000

USER_AGENT = ("HandoffBot/1.0 (+https://github.com/handoff) "
              "AI assistant for everyday tasks")


class ToolError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# --------------------------------------------------------------------------
# 结果归一化
# --------------------------------------------------------------------------


def normalize_tool_result(raw: Any, tool_name: str = "unknown") -> dict:
    """把工具返回的任意形状归一成契约形状.

    工具是外部实现(可能是 MCP 服务), 返回什么都有可能。统一在这里兜住,
    免得下游到处判断。
    """
    if raw is None:
        return {"ok": False, "text": "", "error": f"{tool_name} 没有返回内容"}
    if isinstance(raw, str):
        return {"ok": True, "text": clip_output(raw)}
    if isinstance(raw, dict):
        text = raw.get("text")
        if text is None and raw.get("content") is not None:
            text = raw.get("content")
        out = {
            "ok": bool(raw.get("ok", raw.get("error") is None)),
            "text": clip_output(str(text)) if text is not None else "",
        }
        if raw.get("meta") is not None:
            out["meta"] = raw["meta"]
        if raw.get("error"):
            out["error"] = str(raw["error"])
        return out
    return {"ok": True, "text": clip_output(str(raw))}


def clip_output(text: Any, limit: int = MAX_TOOL_OUTPUT_CHARS) -> str:
    """截断过长输出, 并在末尾说明截掉了多少 —— 保密不说明会让模型以为读完了."""
    s = str(text if text is not None else "")
    if len(s) <= limit:
        return s
    head = s[:limit]
    return head + f"\n\n…（内容过长，已截断，原文共 {len(s)} 字符）"


# --------------------------------------------------------------------------
# 注册表
# --------------------------------------------------------------------------


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    handler: Callable[..., Any]
    meta: dict = field(default_factory=dict)


_tools: dict[str, Tool] = {}


def register_tool(tool: Tool | dict) -> Tool:
    if isinstance(tool, dict):
        tool = Tool(name=tool.get("name", ""), description=tool.get("description", ""),
                    parameters=tool.get("parameters") or {},
                    handler=tool.get("handler"), meta=tool.get("meta") or {})
    if not tool or not getattr(tool, "name", None):
        raise ToolError("BAD_TOOL", "工具必须有 name")
    if not callable(tool.handler):
        raise ToolError("BAD_TOOL", f"工具 {tool.name} 缺少 handler")
    if not tool.parameters:
        raise ToolError("BAD_TOOL", f"工具 {tool.name} 缺少 parameters schema")
    # OpenAI 的 function calling 要求 parameters.type 必须是 object
    if tool.parameters.get("type") != "object":
        raise ToolError("BAD_TOOL",
                        f"工具 {tool.name} 的 parameters.type 必须是 object")
    _tools[tool.name] = tool
    return tool


def unregister_tool(name: str) -> bool:
    return _tools.pop(name, None) is not None


def unregister_by_prefix(prefix: str) -> int:
    victims = [n for n in _tools if n.startswith(prefix)]
    for n in victims:
        _tools.pop(n, None)
    return len(victims)


def get_tool(name: str) -> Tool | None:
    return _tools.get(name)


def list_tools() -> list[str]:
    return sorted(_tools)


def tool_specs(allowed: list[str] | None = None) -> list[dict]:
    """导出给模型看的工具清单(OpenAI function calling 形状)."""
    out = []
    for name, t in sorted(_tools.items()):
        if allowed and name not in allowed:
            continue
        out.append({"type": "function", "function": {
            "name": t.name, "description": t.description,
            "parameters": t.parameters,
        }})
    return out


def clear_tools() -> None:
    _tools.clear()


async def execute_tool(name: str, raw_args: Any, ctx: dict | None = None,
                       timeout_ms: int = DEFAULT_TOOL_TIMEOUT_MS) -> dict:
    """执行一个工具, 带超时与错误兜底.

    超时是必须的: 一个卡住的工具会让整条流水线停住, 用户看到进度条不动,
    比报错更糟(他会一直等)。
    """
    ctx = ctx or {}
    t = _tools.get(name)
    if t is None:
        return {"ok": False, "text": "", "error": f"没有名为 {name} 的工具"}

    args = raw_args
    if isinstance(args, str):
        try:
            args = json.loads(args) if args.strip() else {}
        except json.JSONDecodeError:
            return {"ok": False, "text": "",
                    "error": f"{name} 的参数不是合法 JSON"}
    if args is None:
        args = {}
    if not isinstance(args, dict):
        return {"ok": False, "text": "", "error": f"{name} 的参数必须是对象"}

    t0 = time.monotonic()
    try:
        # ⚠️ 同步 handler 必须丢到线程里跑, 不能直接调。
        #
        # 原因: MCP 的 handler 是**同步阻塞**的(内部等子进程回包, 最长一个
        # callTimeoutMs)。在 async 上下文里直接调它, 会把事件循环**整个卡住**
        # 那么久 —— 表现是"服务没响应", 而所有 SSE 连接也一起停住。
        # 我们自己写的内置工具是 async, 所以这条只在接 MCP 之后才会暴露。
        #
        # 注意 to_thread 无法取消: wait_for 超时后线程仍在跑, 直到 handler
        # 自己返回。所以超时只保证"不再等它", 不保证"它已停止" ——
        # 子进程的清理由 MCP 连接的 close 负责。这个取舍是刻意的:
        # 直接同步调用会造成整站卡死, 比"超时后线程多跑一会儿"糟糕得多。
        if asyncio.iscoroutinefunction(t.handler):
            result = await asyncio.wait_for(t.handler(args, ctx),
                                            timeout=timeout_ms / 1000.0)
        else:
            result = await asyncio.wait_for(
                asyncio.to_thread(t.handler, args, ctx),
                timeout=timeout_ms / 1000.0)
    except asyncio.TimeoutError:
        return {"ok": False, "text": "",
                "error": f"{name} 执行超过 {timeout_ms // 1000} 秒，已中止"}
    except ToolError as exc:
        return {"ok": False, "text": "", "error": exc.message}
    except Exception as exc:                       # noqa: BLE001
        return {"ok": False, "text": "",
                "error": f"{name} 执行出错：{type(exc).__name__}"}

    out = normalize_tool_result(result, name)
    out.setdefault("meta", {})["ms"] = int((time.monotonic() - t0) * 1000)
    return out


def render_tool_result(result: dict) -> str:
    """把结果渲染成给模型看的一段文字."""
    if not isinstance(result, dict):
        return str(result)
    if result.get("error"):
        return f"[工具失败] {result['error']}"
    return result.get("text") or ""


# --------------------------------------------------------------------------
# HTML -> 文本
# --------------------------------------------------------------------------

_DROP_WITH_CONTENT = re.compile(
    r"<(script|style|noscript|svg|canvas|template|iframe)\b[^>]*>.*?</\1>",
    re.I | re.S)
_BLOCK_TAGS = re.compile(
    r"</?(?:p|div|br|li|tr|h[1-6]|section|article|header|footer|blockquote)\b[^>]*>",
    re.I)
_TAG_RE = re.compile(r"<[^>]+>")


def html_to_text(source: Any) -> str:
    """把 HTML 转成纯文本.

    顺序有讲究: **先整块删掉 script/style**, 再删其余标签 ——
    反过来会把 script 里的代码当正文留下。
    """
    s = str(source if source is not None else "")
    s = _DROP_WITH_CONTENT.sub(" ", s)
    s = _BLOCK_TAGS.sub("\n", s)
    s = _TAG_RE.sub("", s)
    s = decode_entities(s)
    s = re.sub(r"[ \t\r\f\v]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return "\n".join(line.strip() for line in s.split("\n")).strip()


NAMED_ENTITIES = {
    "lt": "<", "gt": ">", "amp": "&", "quot": '"', "apos": "'", "nbsp": " ",
    "mdash": "—", "ndash": "–", "hellip": "…", "ldquo": "“", "rdquo": "”",
    "lsquo": "‘", "rsquo": "’", "middot": "·", "times": "×", "copy": "©",
}


def decode_entities(value: Any) -> str:
    s = str(value if value is not None else "")

    def repl(m: re.Match) -> str:
        body = m.group(1)
        try:
            if body.startswith(("#x", "#X")):
                cp = int(body[2:], 16)
            elif body.startswith("#"):
                cp = int(body[1:], 10)
            else:
                return NAMED_ENTITIES.get(body.lower(), m.group(0))
            if 0 <= cp <= 0x10FFFF:
                return chr(cp)
        except (ValueError, OverflowError):
            pass
        return m.group(0)

    return re.sub(r"&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);", repl, s)


def extract_title(source: Any) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", str(source or ""), re.I | re.S)
    return html_to_text(m.group(1)) if m else ""


# --------------------------------------------------------------------------
# 内置工具: web_fetch
# --------------------------------------------------------------------------


def _fetch_url(url: str, *, resolved_ip: str | None, host: str,
               timeout: float = 15.0, max_bytes: int = 2_000_000) -> tuple[str, int]:
    """抓取 URL.

    **关键安全点**: 若给了 resolved_ip, 就直连这个 IP 并在 Host 头里带上原主机名。
    这是防御 DNS rebinding 的落地方式 —— 校验时解析到的 IP 与连接时用的必须是同一个。
    只在 URL 层面"校验过"是不够的, 因为 urllib 会自己再解析一次。
    """
    parsed = urllib.parse.urlparse(url)
    target = url
    headers = {"User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}

    if resolved_ip and host and resolved_ip != host:
        # 把 URL 的 host 换成已校验的 IP
        netloc = resolved_ip
        if parsed.port:
            netloc = f"{resolved_ip}:{parsed.port}"
        target = parsed._replace(netloc=netloc).geturl()
        # 虚拟主机靠 Host 头识别, 不带就会被拒或拿到错误站点
        headers["Host"] = host if not parsed.port else f"{host}:{parsed.port}"

    req = urllib.request.Request(target, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read(max_bytes + 1)
        charset = resp.headers.get_content_charset() or "utf-8"
        status = getattr(resp, "status", 200)
    if len(raw) > max_bytes:
        raw = raw[:max_bytes]
    try:
        text = raw.decode(charset, errors="replace")
    except LookupError:
        text = raw.decode("utf-8", errors="replace")
    return text, status


def register_web_fetch(cfg: dict | None = None) -> Tool:
    cfg = cfg or {}
    allow_hosts = cfg.get("allowHosts") or []

    async def handler(args: dict, ctx: dict) -> dict:
        url = str(args.get("url") or "").strip()
        if not url:
            return {"ok": False, "text": "", "error": "没有给出网址。"}

        check = net_guard.check_url(url, allow_hosts=allow_hosts)
        if not check.get("ok"):
            return {"ok": False, "text": "", "error": check.get("error")}

        try:
            body, status = await asyncio.to_thread(
                _fetch_url, url,
                resolved_ip=check.get("resolved_ip"), host=check.get("host", ""))
        except urllib.error.HTTPError as e:
            return {"ok": False, "text": "",
                    "error": f"网页返回 {e.code}，可能不存在或需要登录。"}
        except (urllib.error.URLError, OSError, socket.timeout) as e:
            return {"ok": False, "text": "",
                    "error": f"打不开这个网页：{type(e).__name__}"}

        title = extract_title(body)
        text = html_to_text(body)
        if not text:
            return {"ok": False, "text": "", "error": "这个网页没有可读的正文。"}
        header = f"# {title}\n\n" if title else ""
        return {"ok": True, "text": clip_output(header + text),
                "meta": {"url": url, "status": status, "title": title}}

    return register_tool(Tool(
        name="web_fetch",
        description="抓取一个网页并转成纯文本。适合读公告、文档、条款等公开页面。",
        parameters={"type": "object", "properties": {
            "url": {"type": "string", "description": "要抓取的网址，必须是 http 或 https"}},
            "required": ["url"]},
        handler=handler))


# --------------------------------------------------------------------------
# 内置工具: web_search
# --------------------------------------------------------------------------


def parse_duckduckgo(html: str) -> list[dict]:
    """从 DuckDuckGo 的 HTML 结果页里抠出标题/链接/摘要.

    不依赖 API key 是这个工具的价值所在; 代价是解析 HTML, 所以要有多个回退模式。
    """
    out: list[dict] = []
    for m in re.finditer(
            r'<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
            html, re.I | re.S):
        href, title_html = m.group(1), m.group(2)
        title = html_to_text(title_html)
        url = href
        # DuckDuckGo 有时给的是跳转链接
        if "uddg=" in href:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
            if q.get("uddg"):
                url = q["uddg"][0]
        if title and url.startswith("http"):
            out.append({"title": title, "url": url, "snippet": ""})
    # 摘要
    snippets = [html_to_text(m.group(1)) for m in re.finditer(
        r'<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>', html, re.I | re.S)]
    for i, sn in enumerate(snippets):
        if i < len(out):
            out[i]["snippet"] = sn
    return out


def pick_search_items(data: Any) -> list[dict]:
    """把不同搜索后端的返回统一成 [{title,url,snippet}]."""
    items: list[dict] = []
    if isinstance(data, dict):
        for key in ("Results", "results", "items", "organic"):
            arr = data.get(key)
            if isinstance(arr, list):
                for r in arr:
                    if not isinstance(r, dict):
                        continue
                    items.append({
                        "title": str(r.get("Text") or r.get("title") or ""),
                        "url": str(r.get("FirstURL") or r.get("url") or r.get("link") or ""),
                        "snippet": str(r.get("Result") or r.get("snippet") or ""),
                    })
                break
    elif isinstance(data, list):
        for r in data:
            if isinstance(r, dict):
                items.append({"title": str(r.get("title") or ""),
                              "url": str(r.get("url") or r.get("link") or ""),
                              "snippet": str(r.get("snippet") or "")})
    return [i for i in items if i["url"].startswith("http")]


def format_search_results(query: str, items: list[dict], limit: int = 6) -> str:
    if not items:
        return f"没有搜到关于「{query}」的结果。"
    lines = [f"关于「{query}」的搜索结果：", ""]
    for i, it in enumerate(items[:limit], 1):
        lines.append(f"{i}. {it['title']}")
        lines.append(f"   {it['url']}")
        if it.get("snippet"):
            lines.append(f"   {it['snippet'][:200]}")
        lines.append("")
    return "\n".join(lines)


def register_web_search(cfg: dict | None = None) -> Tool:
    cfg = cfg or {}
    endpoint = cfg.get("searchEndpoint") or "https://html.duckduckgo.com/html/"

    async def handler(args: dict, ctx: dict) -> dict:
        query = str(args.get("query") or "").strip()
        if not query:
            return {"ok": False, "text": "", "error": "没有给出搜索词。"}

        check = net_guard.check_url(endpoint)
        if not check.get("ok"):
            return {"ok": False, "text": "", "error": check.get("error")}

        body = urllib.parse.urlencode({"q": query})
        req = urllib.request.Request(
            endpoint, data=body.encode("utf-8"),
            headers={"User-Agent": USER_AGENT,
                     "Content-Type": "application/x-www-form-urlencoded"})

        def _do() -> str:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.read(1_500_000).decode("utf-8", errors="replace")

        try:
            page = await asyncio.to_thread(_do)
        except (urllib.error.URLError, OSError, socket.timeout):
            return {"ok": False, "text": "", "error": "搜索服务暂时打不开。"}

        items = parse_duckduckgo(page)
        return {"ok": True, "text": clip_output(format_search_results(query, items)),
                "meta": {"query": query, "count": len(items)}}

    return register_tool(Tool(
        name="web_search",
        description="搜索公开网页，返回标题、链接与摘要。用于补充背景资料。",
        parameters={"type": "object", "properties": {
            "query": {"type": "string", "description": "搜索词"}},
            "required": ["query"]},
        handler=handler))


# --------------------------------------------------------------------------
# 内置工具: read_text_file
# --------------------------------------------------------------------------


def register_read_file(cfg: dict | None = None) -> Tool:
    cfg = cfg or {}
    roots = cfg.get("allowedRoots") or [os.getcwd()]
    max_bytes = int(cfg.get("maxBytes") or 200_000)

    async def handler(args: dict, ctx: dict) -> dict:
        raw = str(args.get("path") or "").strip()
        check = net_guard.check_path(raw, allowed_roots=roots)
        if not check.get("ok"):
            return {"ok": False, "text": "", "error": check.get("error")}

        path = check["path"]
        if check.get("size", 0) > max_bytes:
            return {"ok": False, "text": "",
                    "error": f"文件太大了（{check['size'] // 1024} KB），"
                             f"请挑一份更小的，或先节选。"}

        def _read() -> str:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                return fh.read(max_bytes)

        try:
            text = await asyncio.to_thread(_read)
        except OSError as exc:
            return {"ok": False, "text": "", "error": f"读不了这个文件：{exc.strerror}"}

        return {"ok": True, "text": clip_output(text),
                "meta": {"path": os.path.basename(path), "chars": len(text)}}

    return register_tool(Tool(
        name="read_text_file",
        description="读取工作目录里的文本文件。适合读用户提供的合同、说明书等。",
        parameters={"type": "object", "properties": {
            "path": {"type": "string", "description": "文件路径（相对或绝对）"}},
            "required": ["path"]},
        handler=handler))


# --------------------------------------------------------------------------
# 装配
# --------------------------------------------------------------------------


def register_native_tools(cfg: dict | None = None) -> dict:
    """注册全部内置工具. 任何单个工具注册失败都不影响其它工具."""
    cfg = cfg or {}
    warnings: list[str] = []
    registered: list[str] = []
    for name, fn in (("web_fetch", register_web_fetch),
                     ("web_search", register_web_search),
                     ("read_text_file", register_read_file)):
        section = cfg.get(name) or {}
        if section.get("enabled") is False:
            continue
        try:
            fn({**section, **(cfg.get("common") or {})})
            registered.append(name)
        except ToolError as exc:
            warnings.append(f"{name} 注册失败：{exc.message}")
        except Exception as exc:                   # noqa: BLE001
            warnings.append(f"{name} 注册失败：{type(exc).__name__}")
    return {"registered": registered, "warnings": warnings}
