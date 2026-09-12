"""模型网关.

契约(§4)要求 call_model 返回统一形状, 并且**失败要分类**: 超时/HTTP 错误/
JSON 非法/schema 不符各有错误码, 前端据此给不同提示。

本实现优先使用 OpenAI 兼容的 /chat/completions(DeepSeek、OpenAI、以及大多数
国内网关都是这个形状), 其次 Anthropic 的 /v1/messages。没有配 key 时抛
LLM_NO_PROVIDER —— 调用方会走降级路径(离线模板), 服务不会因此不可用。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from errors import ERR, AppError, redact_secrets


@dataclass
class ModelResult:
    text: str
    json: Any = None
    usage: dict = field(default_factory=lambda: {"promptTokens": 0, "completionTokens": 0})
    ms: int = 0
    provider: str = ""
    model: str = ""
    degraded: bool = False          # True 表示没走真实模型(降级数据)


@dataclass
class Provider:
    name: str
    base_url: str
    api_key_env: str
    model_env: str
    default_model: str
    style: str = "openai"           # openai | anthropic


def _providers() -> list[Provider]:
    return [
        Provider("deepseek", os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
                 "DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "deepseek-chat"),
        Provider("openai", os.environ.get("OPENAI_BASE_URL", "https://api.openai.com"),
                 "OPENAI_API_KEY", "OPENAI_MODEL", "gpt-4o-mini"),
        Provider("anthropic", os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
                 "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "claude-3-5-sonnet-latest",
                 style="anthropic"),
    ]


def inspect_chain() -> list[dict]:
    """只报"有没有配 key", 绝不返回 key 本身."""
    out = []
    for p in _providers():
        out.append({
            "provider": p.name,
            "model": os.environ.get(p.model_env, p.default_model),
            "configured": bool(os.environ.get(p.api_key_env)),
        })
    return out


def pick_provider() -> Provider | None:
    for p in _providers():
        if os.environ.get(p.api_key_env):
            return p
    return None


# --------------------------------------------------------------------------
# JSON 提取
# --------------------------------------------------------------------------

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def extract_json(text: str) -> Any:
    """从模型输出里抠出 JSON.

    模型很爱在 JSON 外面包一层 ```json 或者加一句"好的, 这是结果:"。
    先试整体, 再试代码围栏, 最后试第一个平衡的 {...} / [...]。
    """
    if not text:
        return None
    s = text.strip()
    for candidate in (s, *(m.group(1).strip() for m in _FENCE_RE.finditer(s))):
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
    # 扫描第一个平衡的括号块
    for opener, closer in (("{", "}"), ("[", "]")):
        start = s.find(opener)
        if start < 0:
            continue
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(s)):
            ch = s[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(s[start:i + 1])
                    except json.JSONDecodeError:
                        break
    return None


# --------------------------------------------------------------------------
# 调用
# --------------------------------------------------------------------------


async def call_model(prompt: str, *, system: str | None = None,
                     expect_json: bool = False, temperature: float = 0.3,
                     max_tokens: int = 4096, timeout: float = 120.0,
                     demo: bool = False) -> ModelResult:
    """调用模型. demo=True 时直接返回降级标记, 调用方用离线数据。"""
    if demo:
        return ModelResult(text="", json=None, provider="demo", model="demo",
                           degraded=True)

    provider = pick_provider()
    if provider is None:
        # 没有配 key 不是崩溃, 是一种可预期的状态: 上游会走降级
        return ModelResult(text="", json=None, provider="none", model="none",
                           degraded=True)

    model = os.environ.get(provider.model_env, provider.default_model)
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    if provider.style == "anthropic":
        url = provider.base_url.rstrip("/") + "/v1/messages"
        body = {"model": model, "max_tokens": max_tokens, "temperature": temperature,
                "messages": [m for m in messages if m["role"] != "system"]}
        if system:
            body["system"] = system
        headers = {"content-type": "application/json",
                   "x-api-key": os.environ.get(provider.api_key_env, ""),
                   "anthropic-version": "2023-06-01"}
    else:
        url = provider.base_url.rstrip("/") + "/chat/completions"
        body = {"model": model, "temperature": temperature, "max_tokens": max_tokens,
                "messages": messages}
        headers = {"content-type": "application/json",
                   "authorization": f"Bearer {os.environ.get(provider.api_key_env, '')}"}

    t0 = time.monotonic()
    try:
        raw = await asyncio.wait_for(_post_json(url, body, headers), timeout=timeout)
    except asyncio.TimeoutError:
        raise AppError(ERR.LLM_TIMEOUT, "模型响应太慢了，请稍后再试。", status=504)
    except AppError:
        raise
    except Exception as exc:                       # noqa: BLE001
        raise AppError(ERR.LLM_HTTP_ERROR,
                       f"连接模型服务失败：{redact_secrets(str(exc))[:200]}", status=502)
    ms = int((time.monotonic() - t0) * 1000)

    text, usage = _parse_response(provider, raw)
    if not text:
        raise AppError(ERR.LLM_EMPTY_RESPONSE, "模型这次没有返回内容，请重试一次。", status=502)

    parsed = extract_json(text) if expect_json else None
    if expect_json and parsed is None:
        raise AppError(ERR.LLM_JSON_INVALID,
                       "模型返回的内容不是合法 JSON。", status=502)

    return ModelResult(text=text, json=parsed, usage=usage, ms=ms,
                       provider=provider.name, model=model)


async def _post_json(url: str, body: dict, headers: dict) -> dict:
    """在线程里跑阻塞的 urlopen, 不挡住事件循环."""
    def _do() -> dict:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "ignore")[:300]
            except Exception:
                pass
            raise AppError(ERR.LLM_HTTP_ERROR,
                           f"模型服务返回 {e.code}：{redact_secrets(detail)}",
                           status=502)
        except urllib.error.URLError as e:
            raise AppError(ERR.LLM_HTTP_ERROR,
                           f"无法连接模型服务：{redact_secrets(str(e.reason))[:200]}",
                           status=502)

    return await asyncio.to_thread(_do)


def _parse_response(provider: Provider, raw: dict) -> tuple[str, dict]:
    if provider.style == "anthropic":
        blocks = raw.get("content") or []
        text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict))
        u = raw.get("usage") or {}
        usage = {"promptTokens": u.get("input_tokens", 0),
                 "completionTokens": u.get("output_tokens", 0)}
        return text, usage
    choices = raw.get("choices") or []
    text = ""
    if choices and isinstance(choices[0], dict):
        text = (choices[0].get("message") or {}).get("content") or ""
    u = raw.get("usage") or {}
    usage = {"promptTokens": u.get("prompt_tokens", 0),
             "completionTokens": u.get("completion_tokens", 0)}
    return text, usage
