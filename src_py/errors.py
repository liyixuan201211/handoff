"""错误码与统一错误形状.

契约（docs/CONTRACT.md §2）: 所有 API 错误都是
    {"error": {"code": "STRING_CODE", "message": "给人看的中文说明"}}

另外一条安全纪律（沿自 Node 版）: 任何对外可见的文本都要先过 `redact_secrets`。
密钥泄漏最常见的位置不是接口本身，而是**错误信息**里带出来的请求体或堆栈。
"""

from __future__ import annotations

import re
from typing import Any


class ERR:
    """错误码常量. 与 Node 版 src/llm/errors.js 逐一对齐, 不能改名 —— 前端按码分派."""

    BAD_REQUEST = "BAD_REQUEST"
    NOT_FOUND = "NOT_FOUND"
    RATE_LIMITED = "RATE_LIMITED"
    PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE"

    LLM_TIMEOUT = "LLM_TIMEOUT"
    LLM_HTTP_ERROR = "LLM_HTTP_ERROR"
    LLM_JSON_INVALID = "LLM_JSON_INVALID"
    LLM_SCHEMA_INVALID = "LLM_SCHEMA_INVALID"
    LLM_NO_PROVIDER = "LLM_NO_PROVIDER"
    LLM_ABORTED = "LLM_ABORTED"
    LLM_EMPTY_RESPONSE = "LLM_EMPTY_RESPONSE"

    PIPELINE_STAGE_FAILED = "PIPELINE_STAGE_FAILED"
    PIPELINE_CANCELLED = "PIPELINE_CANCELLED"

    SECURITY_BLOCKED = "SECURITY_BLOCKED"

    INTERNAL = "INTERNAL"


# 默认 HTTP 状态码: 没显式给 status 时按码推断
DEFAULT_STATUS: dict[str, int] = {
    ERR.BAD_REQUEST: 400,
    ERR.NOT_FOUND: 404,
    ERR.RATE_LIMITED: 429,
    ERR.PAYLOAD_TOO_LARGE: 413,
    ERR.SECURITY_BLOCKED: 403,
    ERR.PIPELINE_CANCELLED: 409,
    ERR.LLM_NO_PROVIDER: 503,
    ERR.LLM_TIMEOUT: 504,
}


class AppError(Exception):
    """带错误码的应用异常. 路由层统一转成契约形状."""

    def __init__(self, code: str, message: str, *, status: int | None = None,
                 cause: BaseException | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status if status is not None else DEFAULT_STATUS.get(code, 500)
        self.cause = cause

    def to_body(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": redact_secrets(self.message)}}

    def __repr__(self) -> str:                       # 日志里看得懂
        return f"AppError({self.code}, {self.message!r}, status={self.status})"


def to_public_error(exc: BaseException) -> tuple[int, dict[str, Any]]:
    """任意异常 -> (status, 契约形状响应体).

    非 AppError 一律当成 500 并且**不把原始信息透给用户** ——
    内部堆栈、文件路径、上游响应体都可能含密钥。
    """
    if isinstance(exc, AppError):
        return exc.status, exc.to_body()
    return 500, {
        "error": {
            "code": ERR.INTERNAL,
            "message": "服务器出了点问题，请稍后再试。",
        }
    }


# --------------------------------------------------------------------------
# 脱敏
# --------------------------------------------------------------------------

# 常见密钥形态. 顺序有讲究: 先匹配长前缀的, 避免 sk- 抢先吃掉 sk-ant-
_SECRET_SPECS: list[tuple[str, str]] = [
    # Anthropic / OpenAI / DeepSeek 等
    (r"\bsk-ant-[A-Za-z0-9_\-]{8,}", "sk-ant-***"),
    (r"\bsk-[A-Za-z0-9_\-]{12,}", "sk-***"),
    (r"\bBearer\s+[A-Za-z0-9_\-\.=]{12,}", "Bearer ***"),
    # 通用赋值形态: api_key=xxx / token: "xxx" / authorization: xxx
    (r"""(?i)\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|
              auth[_-]?token|client[_-]?secret|password|passwd|secret)\b
             (\s*[:=]\s*["']?)([^\s"',;}]{6,})""", r"\1\2***"),
    # URL 里的凭据: https://user:pass@host
    # 必须把凭据本身也捕获成组: 否则脱敏后无法判断"这段已经是 *** 了",
    # 自检会把 https://***:***@host 误判成仍有密钥。
    (r"(https?://)([^/\s:@]+:[^/\s@]+)@", r"\1***:***@"),
    # JWT
    (r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}", "***JWT***"),
]

# 编译一次. re.X 只给需要它的那条(多行赋值形态)
_SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(pat, re.X if "\n" in pat or "  " in pat else 0), repl)
    for pat, repl in _SECRET_SPECS
]

# 已经脱敏后的占位符. contains_secret() 必须放行它们,
# 否则 "https://***:***@host" 会被自己的凭据正则再次判成有密钥。
# 允许冒号: URL 凭据脱敏后是 "***:***" 形态
_PLACEHOLDER_RE = re.compile(r"^[\*:]+$")


def redact_secrets(text: Any) -> str:
    """把文本里可能出现的密钥替换成 ***. 非字符串先转字符串."""
    if text is None:
        return ""
    s = text if isinstance(text, str) else str(text)
    for pat, repl in _SECRET_PATTERNS:
        s = pat.sub(repl, s)
    return s


def contains_secret(text: Any) -> bool:
    """判断文本里是否还有**真实**密钥残留(安全测试用).

    注意要排除已脱敏的占位符: "***" 会被凭据正则匹配到(它本来就是
    user:pass 的形状), 但那已经不是密钥了。不排除的话,
    redact 之后自检会永远失败 —— 一个永远为真的安全断言等于没有断言。
    """
    if text is None:
        return False
    s = text if isinstance(text, str) else str(text)
    for pat, _ in _SECRET_PATTERNS:
        for m in pat.finditer(s):
            groups = [g for g in m.groups() if g]
            if groups:
                # 约定: 最后一个捕获组是"值"。它是 *** 就说明这段已脱敏。
                if _PLACEHOLDER_RE.match(groups[-1]):
                    continue
            elif _PLACEHOLDER_RE.match(m.group(0)):
                continue
            return True
    return False
