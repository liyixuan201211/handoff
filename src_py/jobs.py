"""输入校验、Job 公开形状、文件名净化.

Job 对象形状是**冻结契约**(docs/CONTRACT.md §2), 前端按它渲染。
这里的原则: 只暴露前端需要的字段, 内部字段(如 __lastTrace)不外泄。
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any
from urllib.parse import quote

import guard
from errors import ERR, AppError

GOAL_MIN = 1
GOAL_MAX = 4000
MESSAGE_MAX = 2000
VALID_TONES = ("normal", "simple", "formal")
VALID_STATUS = ("queued", "running", "awaiting_input", "done", "failed", "cancelled")


# --------------------------------------------------------------------------
# POST /api/jobs 输入
# --------------------------------------------------------------------------


def normalize_job_input(body: Any) -> dict:
    """校验并归一化创建任务入参(契约 §2).

    错误信息用**人话**说清楚哪里不对 —— 这是给普通人用的产品,
    "validation failed" 这类措辞帮不了他。
    """
    if not isinstance(body, dict):
        raise AppError(ERR.BAD_REQUEST, "请求内容必须是一个对象。", status=400)

    goal = body.get("goal")
    if goal is None or (isinstance(goal, str) and not goal.strip()):
        raise AppError(ERR.BAD_REQUEST, "请先说一下你想让我做什么。", status=400)
    if not isinstance(goal, str):
        raise AppError(ERR.BAD_REQUEST, "「你想做什么」必须是一段文字。", status=400)

    # 走安全守卫: 剥控制字符/零宽字符、检出提示注入、超长截断(不拒绝)。
    # 为什么不在路由层做: 净化后的文本才是真正会被存进 job、送进模型的那份,
    # 所以必须在这里产出, 否则"检测的"和"使用的"是两份不同的东西。
    guard_result = guard.sanitize_user_input(goal, max_length=GOAL_MAX, field="goal")
    if not guard_result["ok"]:
        raise AppError(ERR.BAD_REQUEST, "请先说一下你想让我做什么。", status=400)
    goal = guard_result["text"]
    if len(goal) < GOAL_MIN:
        raise AppError(ERR.BAD_REQUEST, "请把要求说完整一点。", status=400)

    tone = body.get("tone") or "normal"
    if tone not in VALID_TONES:
        raise AppError(ERR.BAD_REQUEST,
                       f"语气只能是 {'、'.join(VALID_TONES)} 之一。", status=400)

    audience = body.get("audience")
    if audience is not None and not isinstance(audience, str):
        raise AppError(ERR.BAD_REQUEST, "「交付给谁」必须是一段文字。", status=400)
    if isinstance(audience, str):
        audience = audience.strip()[:200]

    deadline = body.get("deadline")
    if deadline is not None and not isinstance(deadline, str):
        raise AppError(ERR.BAD_REQUEST, "「截止时间」格式不对。", status=400)

    template_id = body.get("templateId")
    if template_id is not None and not isinstance(template_id, str):
        raise AppError(ERR.BAD_REQUEST, "「模板」格式不对。", status=400)

    return {
        "goal": goal,
        "templateId": template_id,
        "audience": audience,
        "tone": tone,
        "deadline": deadline,
        "demo": bool(body.get("demo")),
        # 输入阶段的安全发现, 交给 engine 写进 job.security(契约 §2)
        "securityFindings": guard_result["findings"],
        "truncated": guard_result["truncated"],
    }


def require_message_text(raw: Any) -> str:
    """校验中途追加的文本."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        raise AppError(ERR.BAD_REQUEST, "请先说点什么。", status=400)
    if not isinstance(raw, str):
        raise AppError(ERR.BAD_REQUEST, "追加的内容必须是一段文字。", status=400)
    text = raw.strip()
    if len(text) > MESSAGE_MAX:
        raise AppError(ERR.BAD_REQUEST,
                       f"内容太长了（{len(text)} 字），请精简到 {MESSAGE_MAX} 字以内。",
                       status=400)
    return text


# --------------------------------------------------------------------------
# Job 公开形状
# --------------------------------------------------------------------------

# 内部字段不外泄(前端不需要, 且可能很大)
_PRIVATE_FIELDS = ("__lastTrace", "toolCalls", "roundHistory")


def public_job(job: dict) -> dict:
    """按冻结契约输出 Job 对象."""
    if not isinstance(job, dict):
        return {}
    out: dict[str, Any] = {
        "id": job.get("id"),
        "goal": job.get("goal"),
        "templateId": job.get("templateId"),
        "status": job.get("status"),
        "createdAt": job.get("createdAt"),
        "updatedAt": job.get("updatedAt"),
        "plan": job.get("plan"),
        "stages": job.get("stages") or [],
        "artifacts": job.get("artifacts") or [],
        "review": job.get("review"),
        "security": job.get("security"),
        "usage": job.get("usage") or {"calls": 0, "promptTokens": 0,
                                      "completionTokens": 0, "ms": 0},
        "clarifyQuestions": job.get("clarifyQuestions") or [],
        "error": job.get("error"),
    }
    # 契约里没有但前端要用的可选字段, 有才带
    for k in ("templateTitle", "audience", "tone", "round", "amendedCount",
              "userMessages", "skillsUsed", "demo"):
        if k in job:
            out[k] = job[k]
    return out


def summarize_job(job: dict) -> dict | None:
    """列表用的轻量摘要: 不带 stages/artifacts 正文, 避免列表响应过大."""
    if not isinstance(job, dict):
        return None
    artifacts = job.get("artifacts") or []
    stages = job.get("stages") or []
    done = sum(1 for s in stages if s.get("status") == "done")
    return {
        "id": job.get("id"),
        "goal": job.get("goal"),
        "status": job.get("status"),
        "createdAt": job.get("createdAt"),
        "updatedAt": job.get("updatedAt"),
        "templateId": job.get("templateId"),
        "templateTitle": job.get("templateTitle"),
        "title": (job.get("plan") or {}).get("title"),
        "artifactCount": len(artifacts),
        "stageCount": len(stages),
        "stageDone": done,
        "usage": job.get("usage"),
        "error": job.get("error"),
    }


# --------------------------------------------------------------------------
# 下载文件名
# --------------------------------------------------------------------------

_UNSAFE_FILENAME = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]')


def sanitize_filename(name: Any, fallback: str = "deliverable") -> str:
    """净化文件名: 去路径分隔符与控制字符, 防 header 注入.

    Content-Disposition 里出现换行就能注入额外响应头, 所以控制字符必须清掉。
    """
    s = str(name or "").strip()
    if not s:
        return fallback
    s = unicodedata.normalize("NFKC", s)
    s = _UNSAFE_FILENAME.sub("_", s)
    s = s.strip(". ")                       # 结尾的点和空格在 Windows 上会被吞
    s = re.sub(r"\s+", " ", s)
    if not s:
        return fallback
    return s[:120]


def content_disposition(filename: str) -> str:
    """同时给 ASCII 回退与 RFC 5987 的 UTF-8 形式.

    只给 filename= 的话中文名在部分浏览器会变成乱码或被截断。
    """
    ascii_name = filename.encode("ascii", "ignore").decode("ascii") or "deliverable.md"
    if not ascii_name.lower().endswith(".md"):
        ascii_name += ".md"
    quoted = quote(filename if filename.lower().endswith(".md") else filename + ".md",
                   safe="")
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quoted}'
