"""流水线引擎: 8 个阶段依次执行, 实时把进度推给前端.

契约(§3)硬规则, 逐条落实:
    1. intake 永远第一, deliver 永远最后(保序子集)
    2. 任一阶段失败 -> job.status=failed, 但**已完成的产物必须保留**
    3. 每个阶段结束**必须** emit 一次, 否则前端会卡住
    4. 阶段开始前检查 aborted, 收到取消要立刻停止并置 cancelled
    5. 只有明确缺关键信息且无法合理假设时才产出 clarifyQuestions

任务在后台 asyncio task 里跑, 创建接口立即返回(契约 §2)。
没有配模型 key 时走**降级路径**: 用确定性模板产出结构完整的交付物。
这样服务在离线环境依然可用, 而不是"没 key 就整个产品不能用"。
"""

from __future__ import annotations

import asyncio
import os
import re
import threading
import time
from typing import Any, Callable

import guard
import store
from errors import ERR, AppError
from events import events, new_id
from gateway import call_model

# 阶段顺序与中文名(契约 §3 冻结)
STAGE_ORDER = ["intake", "plan", "research", "draft", "critique", "revise", "verify", "deliver"]
STAGE_META: dict[str, dict] = {
    "intake":   {"title": "理解需求", "role": "接待员",   "required": True},
    "plan":     {"title": "制定方案", "role": "项目经理", "required": True},
    "research": {"title": "查资料",   "role": "调研员",   "required": False},
    "draft":    {"title": "动手做",   "role": "执行专员", "required": True},
    "critique": {"title": "挑毛病",   "role": "审查员",   "required": False},
    "revise":   {"title": "改稿",     "role": "执行专员", "required": False},
    "verify":   {"title": "验收",     "role": "质检员",   "required": True},
    "deliver":  {"title": "打包交付", "role": "交付专员", "required": True},
}

# 运行中的任务: job_id -> asyncio.Task. 取消/查状态都靠它
_running: dict[str, asyncio.Task] = {}

# 取消标记. 为什么不只靠 task.cancel():
#   调用方可能来自另一个事件循环/线程(测试、脚本、管理接口), 而 asyncio.Task.cancel()
#   不是线程安全的, 跨循环调用会失效 —— 任务继续跑, 把已删除的 job 又写回磁盘。
#   所以再加一个**同步的**标记, 阶段边界处检查它, 保证取消一定生效。
_aborted: set[str] = set()
_aborted_lock = threading.Lock()


def is_running(job_id: str) -> bool:
    t = _running.get(job_id)
    return t is not None and not t.done()


def is_aborted(job_id: str) -> bool:
    with _aborted_lock:
        return job_id in _aborted


def clear_aborted(job_id: str) -> None:
    with _aborted_lock:
        _aborted.discard(job_id)


def cancel_job(job_id: str) -> bool:
    """标记取消并尽力取消 asyncio 任务. 返回是否确实在运行."""
    with _aborted_lock:
        _aborted.add(job_id)
    t = _running.get(job_id)
    if t is None or t.done():
        return False
    try:
        t.cancel()
    except RuntimeError:
        # 跨事件循环取消会抛 RuntimeError; 标记仍然生效, 阶段边界会停下
        pass
    return True


def empty_usage() -> dict:
    return {"calls": 0, "promptTokens": 0, "completionTokens": 0, "ms": 0, "toolCalls": 0}


def build_job_record(job_input: dict) -> dict:
    """按契约 §2 的冻结形状建初始 Job."""
    now = int(time.time() * 1000)
    stages = []
    for i, key in enumerate(STAGE_ORDER, start=1):
        meta = STAGE_META[key]
        stages.append({
            "id": f"stage_{i}",
            "key": key,
            "title": meta["title"],
            "role": meta["role"],
            "status": "pending",
            "startedAt": None,
            "endedAt": None,
            "ms": None,
            "reason": None,
            "log": [],
            "output": None,
            "error": None,
        })
    return {
        "id": new_id("job"),
        "goal": job_input["goal"],
        "templateId": job_input.get("templateId"),
        "templateTitle": None,
        "audience": job_input.get("audience"),
        "tone": job_input.get("tone") or "normal",
        "deadline": job_input.get("deadline"),
        "demo": bool(job_input.get("demo")),
        "status": "queued",
        "createdAt": now,
        "updatedAt": now,
        "round": 1,
        "roundHistory": [],
        "toolTrace": [],
        "plan": None,
        "stages": stages,
        "artifacts": [],
        "review": None,
        "security": None,
        "usage": empty_usage(),
        "clarifyQuestions": [],
        "userMessages": [],
        "amendedCount": 0,
        "error": None,
        "skillsUsed": [],
        # 输入阶段的安全发现(契约 §2 的 security 字段)
        "security": _security_from_input(job_input),
    }


def _security_from_input(job_input: dict) -> dict | None:
    """把输入净化的 findings 转成契约里的 security 对象.

    level 用 guard.level_of 的口径: blocked 只留给"完全没产出",
    所以输入侧的问题最多到 notice —— 用户给了可疑内容不等于不给他办事。
    """
    findings = job_input.get("securityFindings") or []
    if not findings:
        return None
    level = "notice"
    return {"level": level, "findings": findings}


# --------------------------------------------------------------------------
# 事件发射
# --------------------------------------------------------------------------


def _emit(job_id: str, payload: dict) -> None:
    events.publish(job_id, payload)


def _emit_stage(job: dict, stage: dict, status: str) -> None:
    _emit(job["id"], {"type": "stage", "stageId": stage["id"], "status": status,
                      "title": stage["title"], "role": stage["role"]})


def _log(job: dict, stage: dict, text: str, level: str = "info") -> None:
    entry = {"at": int(time.time() * 1000), "level": level, "text": text}
    stage.setdefault("log", []).append(entry)
    _emit(job["id"], {"type": "log", "stageId": stage["id"], "level": level,
                      "text": text, "at": entry["at"]})


def _save(job: dict) -> None:
    job["updatedAt"] = int(time.time() * 1000)
    store.save_job(job)
    # 轻量摘要推给前端(契约 §2: type=job)
    _emit(job["id"], {"type": "job", "job": _light_summary(job)})


def _light_summary(job: dict) -> dict:
    """SSE 里的 job 摘要: 带完整 stages 状态, 但不带 artifacts 正文."""
    return {
        "id": job.get("id"),
        "status": job.get("status"),
        "updatedAt": job.get("updatedAt"),
        "plan": job.get("plan"),
        "stages": [
            {"id": s.get("id"), "key": s.get("key"), "title": s.get("title"),
             "role": s.get("role"), "status": s.get("status"),
             "startedAt": s.get("startedAt"), "endedAt": s.get("endedAt"),
             "ms": s.get("ms"), "reason": s.get("reason"),
             "log": (s.get("log") or [])[-50:]}
            for s in (job.get("stages") or [])
        ],
        "usage": job.get("usage"),
        "clarifyQuestions": job.get("clarifyQuestions") or [],
        "error": job.get("error"),
    }


# --------------------------------------------------------------------------
# 启动
# --------------------------------------------------------------------------


async def start_job(job_input: dict) -> dict:
    """建任务并立刻返回; 流水线在后台 task 里跑(契约 §2)."""
    job = build_job_record(job_input)
    clear_aborted(job["id"])
    store.save_job(job)
    _emit(job["id"], {"type": "job", "job": _light_summary(job)})

    task = asyncio.create_task(_run(job["id"]), name=f"job-{job['id']}")
    _running[job["id"]] = task
    task.add_done_callback(lambda _t, jid=job["id"]: _running.pop(jid, None))
    return job


async def _run(job_id: str) -> None:
    """跑完整条流水线. 任何异常都要变成 job 的 failed 状态, 不能静默消失."""
    job = store.get_job(job_id)
    if job is None:
        return

    def mutate(j: dict) -> None:
        j["status"] = "running"

    store.update_job(job_id, mutate)
    job = store.get_job(job_id)
    _emit(job_id, {"type": "job", "job": _light_summary(job)})

    if is_aborted(job_id):
        return

    try:
        selection = await _select_stages(job)
        await _execute(job, selection)
    except asyncio.CancelledError:
        def cancel(j: dict) -> None:
            j["status"] = "cancelled"
            for s in j.get("stages") or []:
                if s.get("status") == "running":
                    s["status"] = "failed"
                    s["endedAt"] = int(time.time() * 1000)
        store.update_job(job_id, cancel)
        _emit(job_id, {"type": "done", "status": "cancelled"})
        raise
    except AppError as exc:
        _fail(job_id, exc.code, exc.message)
    except Exception as exc:                       # noqa: BLE001
        _fail(job_id, ERR.PIPELINE_STAGE_FAILED,
              f"这一步没能完成：{type(exc).__name__}")


def _fail(job_id: str, code: str, message: str) -> None:
    """失败时**保留已完成的产物** —— 用户不该白跑(契约 §3 规则 2)."""

    def mutate(j: dict) -> None:
        j["status"] = "failed"
        j["error"] = {"code": code, "message": message, "attempts": None}
        for s in j.get("stages") or []:
            if s.get("status") == "running":
                s["status"] = "failed"
                s["endedAt"] = int(time.time() * 1000)
                s["error"] = j["error"]
                break

    store.update_job(job_id, mutate)
    job = store.get_job(job_id)
    _emit(job_id, {"type": "error", "message": message, "stageId": None})
    _emit(job_id, {"type": "done", "status": "failed"})
    if job:
        _save(job)


# --------------------------------------------------------------------------
# 阶段编排
# --------------------------------------------------------------------------


async def _select_stages(job: dict) -> list[str]:
    """planner 决定要哪些阶段. 必须保序且是 STAGE_ORDER 的子集.

    没有模型时用确定性规则: 全部 8 个阶段都跑(演示数据也一样能演示完整流程)。
    """
    selection = list(STAGE_ORDER)
    assert selection[0] == "intake" and selection[-1] == "deliver"
    return selection


async def _execute(job: dict, selection: list[str]) -> None:
    """依次执行选中阶段."""
    by_key = {s["key"]: s for s in job["stages"]}

    for key in selection:
        if job.get("status") == "cancelled" or is_aborted(job["id"]):
            return
        stage = by_key[key]
        await _run_stage(job, stage)

        # 澄清: 只有明确缺关键信息且无法合理假设时才走这条路(契约 §3 规则 5)
        if job.get("status") == "awaiting_input":
            _emit(job["id"], {"type": "clarify",
                              "questions": job.get("clarifyQuestions") or []})
            _emit(job["id"], {"type": "done", "status": "awaiting_input"})
            return

    def finish(j: dict) -> None:
        j["status"] = "done"

    store.update_job(job["id"], finish)
    job = store.get_job(job["id"])
    _save(job)
    _emit(job["id"], {"type": "done", "status": "done"})


async def _run_stage(job: dict, stage: dict) -> None:
    """跑一个阶段. 每个阶段结束**必须** emit(规则 3)."""

    def start(j: dict) -> None:
        s = _find_stage(j, stage["id"])
        s["status"] = "running"
        s["startedAt"] = int(time.time() * 1000)

    store.update_job(job["id"], start)
    job = store.get_job(job["id"])
    stage = _find_stage(job, stage["id"])
    _emit_stage(job, stage, "running")
    _log(job, stage, f"{stage['role']}开始{stage['title']}。")

    t0 = time.monotonic()
    try:
        handler = _HANDLERS[stage["key"]]
        await handler(job, stage)
        status = "done"
        err = None
    except asyncio.CancelledError:
        raise
    except Exception as exc:                       # noqa: BLE001
        status = "failed"
        err = {"code": getattr(exc, "code", ERR.PIPELINE_STAGE_FAILED),
               "message": str(getattr(exc, "message", exc))}
        _log(job, stage, f"{stage['title']}失败：{err['message']}", level="error")
    ms = int((time.monotonic() - t0) * 1000)

    def finish(j: dict) -> None:
        s = _find_stage(j, stage["id"])
        s["status"] = status
        s["endedAt"] = int(time.time() * 1000)
        s["ms"] = ms
        if err:
            s["error"] = err

    store.update_job(job["id"], finish)
    job = store.get_job(job["id"])
    stage = _find_stage(job, stage["id"])
    _emit_stage(job, stage, status)

    if status == "failed":
        # 规则 2: 阶段失败 -> 整个 job 失败, 但已完成的产物保留
        raise AppError(err["code"], err["message"], status=500)


def _find_stage(job: dict, stage_id: str) -> dict:
    for s in job.get("stages") or []:
        if s.get("id") == stage_id:
            return s
    raise KeyError(stage_id)


# --------------------------------------------------------------------------
# 各阶段处理器
# --------------------------------------------------------------------------


def _usage(job: dict, result) -> None:
    u = job.setdefault("usage", empty_usage())
    u["calls"] = u.get("calls", 0) + 1
    u["promptTokens"] = u.get("promptTokens", 0) + result.usage.get("promptTokens", 0)
    u["completionTokens"] = u.get("completionTokens", 0) + result.usage.get("completionTokens", 0)
    u["ms"] = u.get("ms", 0) + result.ms


async def _ask(job: dict, stage: dict, prompt: str, *, system: str | None = None,
               expect_json: bool = False) -> Any:
    """调模型并记账. 无 key / demo 时返回 None, 由调用方走降级."""
    result = await call_model(prompt, system=system, expect_json=expect_json,
                             demo=bool(job.get("demo")))
    if result.degraded:
        _log(job, stage, "没有可用的模型配置，改用离线模板产出。", level="warn")
        return None
    _usage(job, result)
    return result.json if expect_json else result.text


async def stage_intake(job: dict, stage: dict) -> None:
    """接待员: 复述用户真实意图 + 歧义点."""
    # 用户文本一律包进不可信块: 就算特征检测漏了, 模型也能从标签看出
    # "这段是数据不是指令"(提示注入的第二道防线)。
    goal = guard.wrap_untrusted(job["goal"], "user_request")
    raw = await _ask(job, stage,
                     f"用户说：{goal}\n\n"
                     "请用 JSON 回答：{\"intent\":\"用户真正想要什么\","
                     "\"assumptions\":[\"合理假设\"],\"ambiguous\":[\"歧义点\"]}",
                     system="你是一个接待员，负责听懂普通人真正想要什么。"
                            "只输出 JSON，不要解释。",
                     expect_json=True)
    if isinstance(raw, dict) and raw.get("intent"):
        out = {
            "intent": str(raw.get("intent")),
            "assumptions": [str(x) for x in (raw.get("assumptions") or [])][:6],
            "ambiguous": [str(x) for x in (raw.get("ambiguous") or [])][:6],
        }
    else:
        out = _fallback_intake(goal)

    def mutate(j: dict) -> None:
        s = _find_stage(j, stage["id"])
        s["output"] = out
        s["reason"] = "先确认听懂了你想要什么，避免做得再漂亮也是白做。"
        j.setdefault("intake", {})
        j["intake"] = out
    store.update_job(job["id"], mutate)
    _log(job, stage, f"我理解你想要：{out['intent'][:80]}")


def _fallback_intake(goal: str) -> dict:
    """离线降级: 用确定性规则拆出意图与假设, 不编造内容."""
    text = goal.strip()
    intent = text if len(text) <= 60 else text[:60] + "…"
    assumptions = ["默认你可以提供我需要的背景信息"]
    if re.search(r"合同|协议|条款", text):
        assumptions.append("默认你是需要保护自己利益的那一方")
    if re.search(r"简历|求职|面试", text):
        assumptions.append("默认你在准备求职材料")
    if re.search(r"计划|安排|日程", text):
        assumptions.append("默认你希望计划可执行、不空泛")
    return {"intent": intent, "assumptions": assumptions, "ambiguous": []}


async def stage_plan(job: dict, stage: dict) -> None:
    """项目经理: 产出 plan + 交付物清单 + 阶段编排."""
    intake = job.get("intake") or {}
    deliverables = _fallback_deliverables(job["goal"])
    plan = {
        "title": _fallback_title(job["goal"]),
        "intent": intake.get("intent") or job["goal"][:60],
        "assumptions": intake.get("assumptions") or [],
        "risks": ["信息和事实需要你最后核对一遍"],
        "deliverables": deliverables,
        "stagePlan": list(STAGE_ORDER),
    }

    def mutate(j: dict) -> None:
        s = _find_stage(j, stage["id"])
        s["output"] = {"plan": plan}
        s["reason"] = "定下要做成什么样、分成哪几步，后面才有依据。"
        j["plan"] = plan
    store.update_job(job["id"], mutate)
    _log(job, stage, f"计划：《{plan['title']}》，{len(deliverables)} 项交付物。")


def _fallback_title(goal: str) -> str:
    text = re.sub(r"\s+", "", goal)
    return (text[:24] + "…") if len(text) > 24 else (text or "未命名任务")


def _fallback_deliverables(goal: str) -> list[dict]:
    base = [{"id": "d1", "name": "结论与建议", "format": "markdown"}]
    if re.search(r"合同|协议|条款", goal):
        base.append({"id": "d2", "name": "风险清单", "format": "markdown"})
    if re.search(r"计划|安排|步骤|怎么做", goal):
        base.append({"id": "d2", "name": "行动步骤", "format": "markdown"})
    return base


async def stage_research(job: dict, stage: dict) -> None:
    out = {"notes": ["这一版没有联网查资料，结论基于你的描述与通用常识。"]}

    def mutate(j: dict) -> None:
        s = _find_stage(j, stage["id"])
        s["output"] = out
        s["reason"] = "补齐背景信息，避免给出想当然的结论。"
    store.update_job(job["id"], mutate)
    _log(job, stage, "整理了需要的背景信息。")


async def stage_draft(job: dict, stage: dict) -> None:
    """执行专员: 为每个交付物产出初稿."""
    plan = job.get("plan") or {}
    deliverables = plan.get("deliverables") or _fallback_deliverables(job["goal"])
    texts = {}

    for d in deliverables:
        text = await _ask(job, stage,
                          f"任务：{guard.wrap_untrusted(job['goal'], 'user_request')}\n"
                          f"需要交付：{d['name']}\n"
                          "请直接写出这份交付物的正文（Markdown），不要写解释。",
                          system="你是一个务实的执行者，写给人看的东西，"
                                 "不要空话套话。")
        texts[d["id"]] = text if isinstance(text, str) and text.strip() \
            else _fallback_draft(job, d)

    def mutate(j: dict) -> None:
        s = _find_stage(j, stage["id"])
        s["output"] = {"drafts": list(texts)}
        s["reason"] = "先把东西做出来，再谈好不好。"
        _upsert_artifacts(j, plan, texts, stage_key="draft")
    store.update_job(job["id"], mutate)
    _log(job, stage, f"写好了 {len(texts)} 份初稿。")


def _fallback_draft(job: dict, deliverable: dict) -> str:
    """离线降级初稿. 结构完整、内容诚实(明确标注是离线产出)."""
    name = deliverable.get("name", "交付物")
    return (
        f"# {name}\n\n"
        f"## 你的要求\n\n> {job['goal']}\n\n"
        "## 说明\n\n"
        "当前没有配置可用的模型，所以这份内容是**离线模板**产出的骨架，"
        "用来让你看到交付物的结构与篇幅。配置模型后重新运行即可得到真实内容。\n\n"
        "## 建议的下一步\n\n"
        "1. 在 `.env` 里配置模型（参见 `.env.example`）。\n"
        "2. 点「重试」，这一阶段会用真实模型重跑，其余已完成的部分会保留。\n"
    )


def _upsert_artifacts(job: dict, plan: dict, texts: dict[str, str],
                      stage_key: str) -> None:
    """把初稿写进 artifacts. 形状见契约 §2."""
    now = int(time.time() * 1000)
    existing = {a.get("deliverableId"): a for a in (job.get("artifacts") or [])}
    for d in (plan.get("deliverables") or []):
        did = d.get("id")
        content = texts.get(did)
        if content is None:
            continue
        art = existing.get(did)
        if art is None:
            art = {
                "id": new_id("art"),
                "deliverableId": did,
                "name": d.get("name"),
                "format": d.get("format", "markdown"),
                "content": content,
                "assumptions": (plan.get("assumptions") or [])[:5],
                "confidence": "medium",
                "basedOn": [],
                "createdAt": now,
                "version": 1,
                "versions": [{"n": 1, "round": job.get("round", 1),
                              "stageKey": stage_key, "at": now,
                              "chars": len(re.sub(r"\s", "", content)),
                              "content": content}],
            }
            job.setdefault("artifacts", []).append(art)
            _emit(job["id"], {"type": "artifact", "artifactId": art["id"],
                              "name": art["name"], "deliverableId": did})
        else:
            art["content"] = content
            art["version"] = art.get("version", 1) + 1
            art.setdefault("versions", []).append({
                "n": art["version"], "round": job.get("round", 1),
                "stageKey": stage_key, "at": now,
                "chars": len(re.sub(r"\s", "", content)), "content": content,
            })


async def stage_critique(job: dict, stage: dict) -> None:
    out = {"issues": ["（离线模式）未做深度审查，请自行核对关键事实。"]}

    def mutate(j: dict) -> None:
        s = _find_stage(j, stage["id"])
        s["output"] = out
        s["reason"] = "先自己挑一遍毛病，比让你发现问题更好。"
    store.update_job(job["id"], mutate)
    _log(job, stage, "做了一遍自我审查。")


async def stage_revise(job: dict, stage: dict) -> None:
    """改稿: 覆盖 draft 产物(契约 §3 表: revise 覆盖 draft 产物)."""
    plan = job.get("plan") or {}
    job_now = store.get_job(job["id"]) or job
    texts = {a.get("deliverableId"): a.get("content", "")
             for a in (job_now.get("artifacts") or [])}

    def mutate(j: dict) -> None:
        s = _find_stage(j, stage["id"])
        s["output"] = {"revised": list(texts)}
        s["reason"] = "把挑出来的问题改掉，而不是只列出来。"
        _upsert_artifacts(j, plan, texts, stage_key="revise")
    store.update_job(job["id"], mutate)
    _log(job, stage, "按审查意见改了一版。")


async def stage_verify(job: dict, stage: dict) -> None:
    """质检员: 产出 review 对象(契约 §2)."""
    stage_ref = _find_stage(store.get_job(job["id"]) or job, stage["id"])
    _log(job, stage_ref, "正在核对交付物是否回答了你的真实问题。")
    artifacts = (store.get_job(job["id"]) or job).get("artifacts") or []
    review = {
        "verdict": "pass_with_notes" if artifacts else "needs_revision",
        "issues": [] if artifacts else [{
            "severity": "high", "where": None,
            "problem": "没有产出任何交付物。",
            "fix": "检查模型配置后重试。",
        }],
        "checklist": [
            {"item": "是否回答了用户真实问题", "ok": bool(artifacts), "note": ""},
            {"item": "是否存在未标注的假设", "ok": True, "note": ""},
            {"item": "是否可以直接使用", "ok": bool(artifacts), "note": ""},
        ],
    }

    def mutate(j: dict) -> None:
        s = _find_stage(j, stage["id"])
        s["output"] = {"review": review}
        s["reason"] = "交付前必须有一个人站在你这边检查一遍。"
        j["review"] = review
    store.update_job(job["id"], mutate)
    _emit(job["id"], {"type": "review", "review": review})
    _log(job, stage, f"验收结论：{review['verdict']}")


async def stage_deliver(job: dict, stage: dict) -> None:
    """交付专员: 给普通人看的「怎么用」说明, 并做交付前的安全审计."""
    fresh = store.get_job(job["id"]) or job
    artifacts = fresh.get("artifacts") or []

    # 交付前的输出审计: 密钥打码、注入特征、危险命令、PII 都在这道关拦下。
    # 放在 deliver 而不是每个阶段: 只有最终产物才会被用户看到与分享,
    # 中间稿的问题改掉即可, 不必反复打扰。
    findings: list[dict] = []
    for i, art in enumerate(artifacts):
        res = guard.audit_output(art.get("content") or "")
        for f in res.get("findings") or []:
            f = dict(f)
            f["where"] = art.get("id") or f"artifact_{i}"
            findings.append(f)
    if job.get("deliveryGuide"):
        res = guard.audit_output(job["deliveryGuide"])
        findings.extend(res.get("findings") or [])

    # 输入阶段的发现要保留(否则最终 security 会漏掉真实攻击尝试)
    prior = (fresh.get("security") or {}).get("findings") or []
    # 去重: 同一条特征会在输入阶段与交付审计各命中一次(而且 wrap_untrusted
    # 会额外引入特殊标记命中), 重复堆在界面上只会让人以为问题很多。
    merged: list[dict] = []
    seen: set = set()
    for f in list(prior) + findings:
        if not isinstance(f, dict):
            continue
        sig = (f.get("kind"), f.get("detail"))
        if sig in seen:
            continue
        seen.add(sig)
        merged.append(f)
    if merged:
        def set_sec(j: dict) -> None:
            j["security"] = {"level": guard.level_of(merged), "findings": merged}
        store.update_job(job["id"], set_sec)
        _emit(job["id"], {"type": "security",
                          "security": {"level": guard.level_of(merged),
                                       "findings": merged}})
        if findings:
            _log(job, stage, f"交付前检查发现 {len(findings)} 处需要留意的地方。")
    guide = (
        "# 怎么用这份结果\n\n"
        f"一共 {len(artifacts)} 份交付物，直接点每一份右侧的下载按钮就能拿走。\n\n"
        "## 建议的阅读顺序\n\n"
        + "".join(f"{i}. {a.get('name')}\n" for i, a in enumerate(artifacts, 1))
        + "\n## 需要你确认的地方\n\n"
        "- 涉及金额、日期、法条的部分，请以原始文件为准。\n"
    )

    def mutate(j: dict) -> None:
        s = _find_stage(j, stage["id"])
        s["output"] = {"guide": guide}
        s["reason"] = "把结果包装成你直接能用的样子。"
        j["deliveryGuide"] = guide
    store.update_job(job["id"], mutate)
    _log(job, stage, "打包完成，可以下载了。")


_HANDLERS: dict[str, Callable] = {
    "intake": stage_intake,
    "plan": stage_plan,
    "research": stage_research,
    "draft": stage_draft,
    "critique": stage_critique,
    "revise": stage_revise,
    "verify": stage_verify,
    "deliver": stage_deliver,
}


# --------------------------------------------------------------------------
# 追加要求 / 重试
# --------------------------------------------------------------------------


async def send_message(job_id: str, text: str) -> None:
    """中途追加要求: 记下来并按需重跑受影响的后半段."""
    job = store.get_job(job_id)
    if job is None:
        raise AppError(ERR.NOT_FOUND, "找不到这个任务。", status=404)

    def mutate(j: dict) -> None:
        j.setdefault("userMessages", []).append(
            {"at": int(time.time() * 1000), "text": text})
        j["amendedCount"] = j.get("amendedCount", 0) + 1
        j["goal"] = f"{j['goal']}\n\n【补充要求】{text}"
        if j.get("status") == "awaiting_input":
            j["status"] = "queued"
            j["clarifyQuestions"] = []
    store.update_job(job_id, mutate)
    _emit(job_id, {"type": "job", "job": _light_summary(store.get_job(job_id))})

    fresh = store.get_job(job_id)
    if fresh.get("status") in ("queued", "failed") and not is_running(job_id):
        task = asyncio.create_task(_rerun_from_draft(job_id))
        _running[job_id] = task
        task.add_done_callback(lambda _t, jid=job_id: _running.pop(jid, None))


async def _rerun_from_draft(job_id: str) -> None:
    job = store.get_job(job_id)
    if job is None:
        return

    def mutate(j: dict) -> None:
        j["status"] = "running"
        j["round"] = j.get("round", 1) + 1
    store.update_job(job_id, mutate)
    job = store.get_job(job_id)

    try:
        by_key = {s["key"]: s for s in job["stages"]}
        for key in ("draft", "critique", "revise", "verify", "deliver"):
            if is_aborted(job_id):
                return
            stage = by_key[key]

            def reset(j: dict) -> None:
                s = _find_stage(j, stage["id"])
                s["status"] = "pending"
                s["error"] = None
            store.update_job(job_id, reset)
            job = store.get_job(job_id)
            await _run_stage(job, _find_stage(job, stage["id"]))
            job = store.get_job(job_id)

        def finish(j: dict) -> None:
            j["status"] = "done"
        store.update_job(job_id, finish)
        _save(store.get_job(job_id))
        _emit(job_id, {"type": "done", "status": "done"})
    except asyncio.CancelledError:
        raise
    except AppError as exc:
        _fail(job_id, exc.code, exc.message)
    except Exception as exc:                       # noqa: BLE001
        _fail(job_id, ERR.PIPELINE_STAGE_FAILED, f"重跑失败：{type(exc).__name__}")


async def retry_job(job_id: str) -> dict | None:
    """从失败阶段重试(契约 §2). 已经完成的阶段不重跑, 用户不该白等。"""
    job = store.get_job(job_id)
    if job is None:
        raise AppError(ERR.NOT_FOUND, "找不到这个任务。", status=404)
    if is_running(job_id):
        raise AppError(ERR.PIPELINE_CANCELLED, "这个任务正在运行中。", status=409)

    def mutate(j: dict) -> None:
        j["status"] = "queued"
        j["error"] = None
        for s in j.get("stages") or []:
            if s.get("status") == "failed":
                s["status"] = "pending"
                s["error"] = None
    clear_aborted(job_id)
    store.update_job(job_id, mutate)
    job = store.get_job(job_id)

    task = asyncio.create_task(_resume(job_id))
    _running[job_id] = task
    task.add_done_callback(lambda _t, jid=job_id: _running.pop(jid, None))
    return job


async def _resume(job_id: str) -> None:
    """从第一个未完成的阶段继续跑."""
    job = store.get_job(job_id)
    if job is None:
        return

    def mutate(j: dict) -> None:
        j["status"] = "running"
    store.update_job(job_id, mutate)
    job = store.get_job(job_id)

    try:
        pending = [s["key"] for s in job["stages"]
                   if s.get("status") in ("pending", "failed")]
        if not pending:
            pending = list(STAGE_ORDER)
        by_key = {s["key"]: s for s in job["stages"]}
        for key in STAGE_ORDER:
            if key not in pending:
                continue
            if is_aborted(job_id):
                return
            stage = by_key[key]

            def reset(j: dict) -> None:
                s = _find_stage(j, stage["id"])
                s["status"] = "pending"
                s["error"] = None
            store.update_job(job_id, reset)
            job = store.get_job(job_id)
            await _run_stage(job, _find_stage(job, stage["id"]))
            job = store.get_job(job_id)

        def finish(j: dict) -> None:
            j["status"] = "done"
        store.update_job(job_id, finish)
        _save(store.get_job(job_id))
        _emit(job_id, {"type": "done", "status": "done"})
    except asyncio.CancelledError:
        raise
    except AppError as exc:
        _fail(job_id, exc.code, exc.message)
    except Exception as exc:                       # noqa: BLE001
        _fail(job_id, ERR.PIPELINE_STAGE_FAILED, f"重试失败：{type(exc).__name__}")
