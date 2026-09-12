"""交接 Handoff —— Python 后端.

严格实现 docs/CONTRACT.md 的**冻结部分**:
    §2 HTTP API (10 个端点 + 统一错误形状 + Job 对象形状 + SSE 事件类型)
    §3 流水线阶段顺序与硬规则

与 Node 版的关系:
    两套后端共用同一个 `data/` 目录与同一个 `public/` 前端, 因此可以并排跑、
    用同一批真实数据对比行为。python 版跑在 HANDOFF_PY_PORT(默认 8790)。

启动:
    .venv/bin/python -m uvicorn src_py.server:app --port 8790
或:
    .venv/bin/python src_py/server.py
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import sys
import time
import threading
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

import store
from errors import ERR, AppError, redact_secrets, to_public_error
from events import events, new_id
from sse import resolve_since, sse_stream
from ratelimit import RateLimiter, RATE_RULES
from jobs import (
    public_job, summarize_job, normalize_job_input, require_message_text,
    sanitize_filename, content_disposition,
)
from engine import start_job, send_message, retry_job, cancel_job, is_running
import tools as TOOLS

ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT_DIR / "public"
TEMPLATES_DIR = ROOT_DIR / "templates"
VERSION = "1.0.0-py"

BODY_LIMIT = 256 * 1024          # 契约 §5.8


# --------------------------------------------------------------------------
# 环境: .env 加载, 真实环境变量优先
# --------------------------------------------------------------------------


def load_dotenv(path: pathlib.Path) -> None:
    """加载 .env, 但**真实环境变量优先**.

    与 Node 版同一条理由: README / .env.example 都在教用户"建一个 .env"。
    如果只有某一种启动方式读它, 换个方式启动的用户会得到一份静默失效的配置 ——
    他改了端口没生效, 还以为是产品坏了。
    """
    if not path.exists():
        return
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            continue
        # 已有真实环境变量 -> 不覆盖
        if key not in os.environ:
            os.environ[key] = value


load_dotenv(ROOT_DIR / ".env")


# --------------------------------------------------------------------------
# 应用
# --------------------------------------------------------------------------

app = FastAPI(title="交接 Handoff", version=VERSION, docs_url=None, redoc_url=None)

_limiter = RateLimiter(rules=RATE_RULES)


@app.middleware("http")
async def _middleware(request: Request, call_next):
    """限流 + 请求体大小限制 + 统一错误形状."""
    # 1) 限流(契约 §5.7)
    ip = _client_ip(request)
    rule = _limiter.match(request.method, request.url.path)
    if rule is not None:
        allowed, retry_after = _limiter.hit(rule, ip)
        if not allowed:
            return JSONResponse(
                {"error": {"code": ERR.RATE_LIMITED,
                           "message": "操作太快了，请稍等一分钟再试"}},
                status_code=429,
                headers={"Retry-After": str(retry_after)},
            )

    # 2) 请求体上限。先看 Content-Length, 再看实际字节(分块传输时没有长度)
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > BODY_LIMIT:
                return _err(ERR.PAYLOAD_TOO_LARGE, "内容太大了，请精简一下再试。", 413)
        except ValueError:
            pass

    try:
        response = await call_next(request)
    except AppError as exc:
        status, body = to_public_error(exc)
        return JSONResponse(body, status_code=status)
    except Exception as exc:                       # noqa: BLE001
        status, body = to_public_error(exc)
        sys.stderr.write(
            f"[server] {request.method} {request.url.path} -> {status} "
            f"{body['error']['code']}: {redact_secrets(exc)}\n"
        )
        return JSONResponse(body, status_code=status)

    # 3) 统一补安全响应头
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    return response


def _client_ip(request: Request) -> str:
    """**不信任** X-Forwarded-For.

    伪造这个头就能绕过限流, 所以只认 socket 对端地址。
    真要放在反向代理后面, 应该在代理层做限流而不是信这个头。
    """
    client = request.client
    return client.host if client else "unknown"


def _err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


# --------------------------------------------------------------------------
# GET /api/health
# --------------------------------------------------------------------------


@app.get("/api/health")
async def health() -> JSONResponse:
    try:
        jobs = store.count_jobs()
    except Exception:
        jobs = 0
    return JSONResponse({
        "ok": True,
        "version": VERSION,
        "uptimeMs": int((time.monotonic() - _STARTED) * 1000),
        "models": _model_chain(),
        "dataDir": str(pathlib.Path(store.get_data_dir()).resolve()),
        "jobs": jobs,
        "demoMode": _is_demo_mode(),
        # 字段名刻意不含 "key": 安全测试会扫响应体里有没有 /key/ 字样,
        # 命名也是安全边界的一部分。
        "modelPlan": [f"{m.get('provider')}/{m.get('model')}" for m in _model_chain()],
        "engine": "python",
    })


def _model_chain() -> list[dict]:
    """只报"有没有配 key", 绝不返回 key 本身."""
    out = []
    for name, env_key in (("deepseek", "DEEPSEEK_API_KEY"),
                          ("openai", "OPENAI_API_KEY"),
                          ("anthropic", "ANTHROPIC_API_KEY")):
        out.append({
            "provider": name,
            "model": os.environ.get(f"{name.upper()}_MODEL", ""),
            "configured": bool(os.environ.get(env_key)),
        })
    return out


def _tool_config() -> dict:
    """读工具配置. 缺文件时给一份能用的默认值 —— 默认就该能用."""
    import json as _json

    cfg_path = ROOT_DIR / "handoff.config.json"
    cfg: dict = {}
    if cfg_path.exists():
        try:
            cfg = _json.loads(cfg_path.read_text(encoding="utf-8"))
        except (OSError, _json.JSONDecodeError):
            cfg = {}
    tools_cfg = cfg.get("tools") if isinstance(cfg.get("tools"), dict) else {}
    tools_cfg = dict(tools_cfg)
    # 读文件工具默认限制在项目目录内, 不能让模型随便读 ~/.ssh/id_rsa
    read_cfg = dict(tools_cfg.get("read_text_file") or {})
    read_cfg.setdefault("allowedRoots", [str(ROOT_DIR)])
    tools_cfg["read_text_file"] = read_cfg
    return tools_cfg


def _is_demo_mode() -> bool:
    return os.environ.get("HANDOFF_DEMO", "").strip().lower() in ("1", "true", "yes")


# --------------------------------------------------------------------------
# GET /api/templates
# --------------------------------------------------------------------------


@app.get("/api/tools")
async def list_tool_registry() -> JSONResponse:
    """当前注册了哪些工具. 不含任何密钥, 只报"有没有配"."""
    try:
        specs = TOOLS.tool_specs()
        return JSONResponse({
            "tools": [{"name": t["function"]["name"],
                       "description": t["function"]["description"]} for t in specs],
            "count": len(specs),
        })
    except Exception as exc:                       # noqa: BLE001
        return JSONResponse({"tools": [], "count": 0,
                             "error": f"{type(exc).__name__}"})


@app.get("/api/templates")
async def templates() -> JSONResponse:
    return JSONResponse({"templates": load_templates()})


def load_templates(directory: pathlib.Path | None = None) -> list[dict]:
    """读 templates/*.json. 目录不存在或为空 -> [] (模板缺失不算服务坏了)."""
    d = directory or TEMPLATES_DIR
    if not d.is_dir():
        return []
    out: list[dict] = []
    for path in sorted(d.glob("*.json")):
        try:
            parsed = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            sys.stderr.write(f"[server] 跳过损坏的模板 {path.name}：{exc}\n")
            continue
        if isinstance(parsed, dict):
            out.append({"id": parsed.get("id") or path.stem, **parsed})
    return out


# --------------------------------------------------------------------------
# 任务 API
# --------------------------------------------------------------------------


def _load_job_or_none(job_id: str) -> dict | None:
    if not store.is_valid_job_id(job_id):
        return None
    return store.get_job(job_id)


def _not_found() -> JSONResponse:
    return _err(ERR.NOT_FOUND, "找不到这个任务。", 404)


@app.post("/api/jobs", status_code=201)
async def create_job(request: Request) -> JSONResponse:
    """创建任务, **立即返回**, 流水线在后台跑(契约 §2)."""
    payload = await _read_json(request)
    job_input = normalize_job_input(payload)
    job = await start_job(job_input)
    if not job or not isinstance(job.get("id"), str):
        raise AppError(ERR.PIPELINE_STAGE_FAILED, "任务创建失败，请重试一次。", status=500)

    # 兜底持久化: 只要 job 已经返回给客户端, 就必须能从 GET /api/jobs/:id 读到。
    # engine 自己会 save_job(幂等覆盖), 但"刷新页面还在"这个承诺不能依赖
    # 调用方的实现细节。
    if not store.get_job(job["id"]):
        try:
            store.save_job(job)
        except Exception as exc:                   # noqa: BLE001
            sys.stderr.write(f"[routes] 兜底持久化失败（不影响本次响应）：{exc}\n")
    return JSONResponse({"job": public_job(job)}, status_code=201)


@app.get("/api/jobs")
async def list_jobs() -> JSONResponse:
    """最新在前, 最多 50(契约固定)."""
    jobs = store.list_jobs(50)
    return JSONResponse({"jobs": [s for s in (summarize_job(j) for j in jobs) if s]})


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> JSONResponse:
    job = _load_job_or_none(job_id)
    if job is None:
        return _not_found()
    return JSONResponse({"job": public_job(job)})


@app.get("/api/jobs/{job_id}/versions")
async def job_versions(job_id: str) -> JSONResponse:
    """交付物历史版本.

    单独一个端点: 版本正文可能很长(4000 字 x 5 版 = 2 万字), 塞进详情会让
    每次刷新都传几十 KB, 而用户绝大多数时候只看最新版。
    """
    job = _load_job_or_none(job_id)
    if job is None:
        return _not_found()
    artifacts = []
    for a in (job.get("artifacts") or []):
        versions = []
        for v in reversed(a.get("versions") or []):
            content = v.get("content") or ""
            versions.append({
                "n": v.get("n"),
                "round": v.get("round", 1),
                "stageKey": v.get("stageKey"),
                "at": v.get("at"),
                "chars": v.get("chars") if v.get("chars") is not None
                         else len(re.sub(r"\s", "", content)),
                "confidence": v.get("confidence"),
                "content": content,
            })
        artifacts.append({
            "artifactId": a.get("id"),
            "deliverableId": a.get("deliverableId"),
            "name": a.get("name"),
            "currentVersion": a.get("version", 1),
            "versions": versions,
        })
    return JSONResponse({
        "rounds": job.get("round", 1),
        "roundHistory": job.get("roundHistory") or [],
        "toolTrace": job.get("toolTrace") or [],
        "skillsUsed": job.get("skillsUsed") or [],
        "artifacts": artifacts,
    })


@app.post("/api/jobs/{job_id}/message")
async def post_message(job_id: str, request: Request) -> JSONResponse:
    """回答澄清 / 中途追加要求.

    字段名兼容: 契约写 `{text}`, 前端实现发 `{message}`。两个都收 ——
    这类"文档说 A、代码发 B"的偏差单测发现不了(两边各自测试都绿),
    只有端到端真跑一次才会暴露, 会直接让核心交互 100% 返回 400。
    """
    job = _load_job_or_none(job_id)
    if job is None:
        return _not_found()
    payload = await _read_json(request)
    raw = payload.get("text")
    if raw is None:
        raw = payload.get("message")
    text = require_message_text(raw)
    await send_message(job["id"], text)
    fresh = store.get_job(job["id"]) or job
    return JSONResponse({"ok": True, "job": public_job(fresh)})


@app.post("/api/jobs/{job_id}/retry")
async def post_retry(job_id: str) -> JSONResponse:
    job = _load_job_or_none(job_id)
    if job is None:
        return _not_found()
    fresh = await retry_job(job["id"])
    return JSONResponse({"ok": True, "job": public_job(fresh or store.get_job(job["id"]) or job)})


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str) -> JSONResponse:
    job = _load_job_or_none(job_id)
    if job is None:
        return _not_found()
    # 先停流水线再删盘, 否则后台阶段会把这个 job 又写回来
    try:
        cancel_job(job["id"])
    except Exception as exc:                       # noqa: BLE001
        sys.stderr.write(f"[routes] 取消任务失败（继续删除）：{exc}\n")
    store.delete_job(job["id"])
    events.drop(job["id"])
    return JSONResponse({"ok": True, "deleted": job["id"]})


@app.get("/api/jobs/{job_id}/artifacts/{artifact_id}/download")
async def download_artifact(job_id: str, artifact_id: str) -> Response:
    job = _load_job_or_none(job_id)
    if job is None:
        return _not_found()
    artifacts = job.get("artifacts") or []
    artifact = next((a for a in artifacts if a and a.get("id") == artifact_id), None)
    if artifact is None:
        return _err(ERR.NOT_FOUND, "找不到这个交付物。", 404)
    filename = sanitize_filename(artifact.get("name"), "deliverable")
    content = artifact.get("content")
    return Response(
        content if isinstance(content, str) else "",
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": content_disposition(filename),
            "X-Content-Type-Options": "nosniff",
        },
    )


# --------------------------------------------------------------------------
# SSE: GET /api/jobs/{id}/stream
# --------------------------------------------------------------------------


@app.get("/api/jobs/{job_id}/stream")
async def job_stream(job_id: str, request: Request) -> Response:
    if not store.is_valid_job_id(job_id):
        return _not_found()
    job = store.get_job(job_id)
    if job is None:
        return _not_found()

    since = resolve_since(request.query_params.get("since"),
                          request.headers.get("last-event-id"), 0)

    def is_closed() -> bool:
        return store.get_job(job_id) is None

    return StreamingResponse(
        sse_stream(job_id, since, is_closed=is_closed),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # nginx 默认会缓冲 text/event-stream, 前端就永远收不到实时更新
            "X-Accel-Buffering": "no",
        },
    )


# --------------------------------------------------------------------------
# 静态资源 + SPA + 404
# --------------------------------------------------------------------------


if PUBLIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(PUBLIC_DIR)), name="static")


@app.get("/")
async def index() -> Response:
    return _serve_index()


def _serve_index() -> Response:
    path = PUBLIC_DIR / "index.html"
    if path.exists():
        return FileResponse(str(path), media_type="text/html; charset=utf-8")
    # 前端还没写时给一句人话, 不要 500
    return PlainTextResponse(
        "<!doctype html><meta charset=\"utf-8\"><title>交接 Handoff</title>"
        "<p>界面正在准备中，请稍后再刷新。</p>",
        media_type="text/html; charset=utf-8",
    )


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str) -> Response:
    """前端路由兜底. /api/ 前缀的交给 404, 其余一律回 index.html."""
    if full_path.startswith("api/"):
        return _err(ERR.NOT_FOUND, "这个接口不存在。", 404)
    candidate = PUBLIC_DIR / full_path
    if full_path and candidate.is_file() and PUBLIC_DIR in candidate.parents:
        return FileResponse(str(candidate))
    return _serve_index()


# --------------------------------------------------------------------------
# 工具
# --------------------------------------------------------------------------


async def _read_json(request: Request) -> dict:
    """读 JSON body. 非法 JSON / 超限都翻成人话."""
    raw = await request.body()
    if len(raw) > BODY_LIMIT:
        raise AppError(ERR.PAYLOAD_TOO_LARGE, "内容太大了，请精简一下再试。", status=413)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise AppError(ERR.BAD_REQUEST, "请求内容不是合法的 JSON。", status=400)
    if not isinstance(parsed, dict):
        raise AppError(ERR.BAD_REQUEST, "请求内容必须是一个对象。", status=400)
    return parsed


# --------------------------------------------------------------------------
# 启动 / 关闭
# --------------------------------------------------------------------------

_STARTED = time.monotonic()


@app.on_event("startup")
async def _on_startup() -> None:
    store.load_from_disk()
    store.sweep_tmp_files()
    store.start_sync_timer()

    # 工具体系: 注册内置工具 + 加载技能.
    # 承诺是"任何失败都只少一个能力, 不能挡住启动" —— 所以这里逐个兜住。
    try:
        tool_result = TOOLS.register_native_tools(_tool_config())
        for w in tool_result.get("warnings") or []:
            print(f"[tools] {w}")
        if tool_result.get("registered"):
            print(f"[tools] 已注册: {', '.join(tool_result['registered'])}")
    except Exception as exc:                       # noqa: BLE001
        print(f"[tools] 工具体系初始化失败（不影响启动）：{exc}")

    try:
        import skill_loader

        res = skill_loader.load_skills({"root_dir": str(ROOT_DIR),
                                        "dirs": ["skills"]})
        skills = res.get("skills") or []
        for w in res.get("warnings") or []:
            print(f"[skills] {w}")
        if skills:
            names = "、".join(str(sk.get("name") or sk.get("id") or "?")
                             for sk in skills[:6])
            print(f"[skills] 已加载 {len(skills)} 个技能：{names}")
    except Exception as exc:                       # noqa: BLE001
        print(f"[skills] 技能加载失败（不影响启动）：{exc}")

    # 崩溃恢复: 上次进程被强杀时正在跑的任务会永远停在 running, 用户看到的是
    # 一个**永远不会再往前走**的进度条 —— 比报错更糟, 因为他会一直等。
    interrupted = await mark_interrupted_jobs()
    if interrupted:
        print(f"[server] 已把 {interrupted} 个上次被中断的任务标记为可重试。")

    host = os.environ.get("HANDOFF_HOST", "127.0.0.1")
    port = os.environ.get("HANDOFF_PY_PORT", os.environ.get("HANDOFF_PORT", "8790"))
    print(f"[server] 交接 Handoff (Python) 已启动：http://{host}:{port}  "
          f"(dataDir={pathlib.Path(store.get_data_dir()).resolve()})")


@app.on_event("shutdown")
async def _on_shutdown() -> None:
    store.stop_sync_timer()
    store.flush_writes()
    _limiter.dispose()


async def mark_interrupted_jobs() -> int:
    """把上次中断留下的 running/queued 任务标记为可重试.

    ⚠️ 必须扫**磁盘全量**, 不能用 list_jobs(它只看内存缓存且有上限) ——
    否则任务数超过上限时, 更早的中断任务永远卡在"运行中", 重启多少次都修不好。
    """
    count = 0
    try:
        for job in store.list_all_jobs_on_disk():
            if job.get("status") not in ("running", "queued"):
                continue

            def mutate(j: dict) -> None:
                j["status"] = "failed"
                j["updatedAt"] = int(time.time() * 1000)
                j["error"] = {
                    "code": "INTERRUPTED",
                    "message": "这次运行被中断了（服务被关闭或电脑休眠）。"
                               "已经做好的部分都保留在上面，点「重试」可以接着做完。",
                    "attempts": None,
                }
                for s in reversed(j.get("stages") or []):
                    if s.get("status") == "running":
                        s["status"] = "failed"
                        s["endedAt"] = int(time.time() * 1000)
                        s["error"] = j["error"]
                        break

            if store.update_job(job["id"], mutate):
                count += 1
    except Exception as exc:                      # noqa: BLE001
        print(f"[server] 中断任务恢复失败（不影响启动）：{exc}")
    return count


def main() -> None:
    import uvicorn

    host = os.environ.get("HANDOFF_HOST", "127.0.0.1")
    port = int(os.environ.get("HANDOFF_PY_PORT", os.environ.get("HANDOFF_PORT", "8790")))
    uvicorn.run(app, host=host, port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
