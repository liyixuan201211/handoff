"""MCP 客户端与 Skill 系统的移植测试.

对应 Node 版:
    src/tools/mcp-client.js   ← tests/unit/tools-mcp.test.js(真子进程 + 真协议)
    src/skills/loader.js      ← 前端注入路径

跑法:
    .venv/bin/python -m pytest tests_py -q

三条纪律(和被测代码同源):
  1. **必须用真子进程走真协议**测 MCP —— mock 掉传输层只能证明「我们的假设自洽」,
     证明不了分帧、握手顺序、isError 识别是对的。所以这里起
     tests_py/fixtures/mock_mcp_server.py 这个真的 stdio 服务端。
  2. **不能挂住**: 所有读都带超时, 每个用例 finally 里都 close, 不读无限流。
  3. **测安全边界优先于测功能**: stdio 必须显式 enabled、命令不许含 shell 元字符、
     环境变量不许整份透传 —— 这几条错了是安全问题, 不是「工具不好用」。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src_py"))

import mcp_client as mcp  # noqa: E402
import skill_loader as skl  # noqa: E402
import tools as tools_mod  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
MOCK_SERVER = FIXTURES / "mock_mcp_server.py"

# 每个用例默认 15 秒: 真子进程 + 真协议, 正常路径应在百毫秒级
CALL_TIMEOUT_MS = 15000


# ==========================================================================
# 夹具
# ==========================================================================


@pytest.fixture(autouse=True)
def _clean_mcp():
    """每个用例前后都收干净: 子进程、MCP 工具、模块状态.

    注意**不能**无脑 clear_tools() —— src_py/tools.py 里已经有原生工具
    (web_fetch 等), 掀翻别人注册的东西会让测试之间互相踩。这里只把注册表
    还原成本用例开始前的样子。
    """
    mcp.close_mcp_servers()
    mcp.__reset_mcp_for_test()
    snapshot = {n: tools_mod.get_tool(n) for n in tools_mod.list_tools()}
    yield
    mcp.close_mcp_servers()
    mcp.__reset_mcp_for_test()
    tools_mod.clear_tools()
    for name, tool in snapshot.items():
        tools_mod.register_tool(tool)


def _stdio_cfg(extra_args=None, *, enabled=True, servers_extra=None):
    """起一个连到 mock 服务端的配置(默认 command 就是当前解释器)."""
    args = [str(MOCK_SERVER), *(extra_args or [])]
    servers = {
        "mock": {
            "type": "stdio",
            "command": sys.executable,
            "args": args,
            "enabled": enabled,
        }
    }
    servers.update(servers_extra or {})
    return {"enabled": True, "callTimeoutMs": CALL_TIMEOUT_MS, "servers": servers}


def _tool_names():
    """MCP 工具名(注册表里还会混着原生工具, 所以只看 mock__ 前缀)."""
    return sorted(n for n in tools_mod.list_tools() if n.startswith("mock__"))


def _call(name, args):
    """按 tools.py 的契约调一个工具(它是 async 的, 用例里用 asyncio.run 收口)."""
    return asyncio.run(tools_mod.execute_tool(name, args, timeout_ms=CALL_TIMEOUT_MS))


def _wait_for_file(path, timeout=5.0):
    """等子进程把 pid 文件写出来(它可能刚 spawn 完还没执行到那里)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(path):
            text = Path(path).read_text(encoding="utf-8").strip()
            if text:
                return int(text)
        time.sleep(0.05)
    raise AssertionError(f"{timeout}s 内没等到 {path}")


def _pid_alive(pid, timeout=3.0):
    """等进程消失; 到超时还在就返回 True(避免竞态导致的偶发失败)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, PermissionError):
            return False
        time.sleep(0.05)
    return True


# ==========================================================================
# 工具名规范化
# ==========================================================================


class TestMcpToolName:
    def test_prefixes_server_name(self):
        """加服务名前缀, 避免两个服务互相覆盖."""
        assert mcp.mcp_tool_name("browser", "navigate") == "browser__navigate"
        assert mcp.mcp_tool_name("my-server", "do.thing") == "my_server__do_thing"

    def test_truncates_to_64(self):
        """超长名字截到 64 字符以内(注册表有长度限制)."""
        assert len(mcp.mcp_tool_name("a" * 80, "b" * 80)) <= 64

    def test_empty_and_numeric_names_still_registrable(self):
        """服务名是空的或以数字开头时, 也必须产出注册表能接受的名字."""
        for server, tool in [("", ""), ("123", "456"), ("服务", "工具")]:
            name = mcp.mcp_tool_name(server, tool)
            assert mcp._TOOL_NAME_RE.match(name), f"{name} 应当是合法工具名"

    def test_names_are_accepted_by_the_real_registry(self):
        """MCP 名是在本模块规范好的, 必须能被 src_py/tools.py 的注册表直接收下.

        tools.py 目前**不做**工具名正则校验(那是 Node registry 的事), 所以这条
        断言不是"注册表会拦住", 而是"MCP 名字本身合法", 保证将来注册表补上
        正则后不会突然全线失败。
        """
        for server, tool in [("browser", "navigate"), ("my-server", "do.thing"),
                             ("", ""), ("123", "456"), ("服务", "工具")]:
            assert mcp._TOOL_NAME_RE.match(mcp.mcp_tool_name(server, tool))


# ==========================================================================
# 安全默认值
# ==========================================================================


class TestMcpSecurityDefaults:
    def test_disabled_connects_nothing(self):
        """总开关关着时, 一个服务都不连."""
        state = mcp.load_mcp_servers({"enabled": False, "servers": {
            "mock": {"type": "stdio", "command": sys.executable, "args": [str(MOCK_SERVER)]}}})
        assert state["servers"] == []
        assert _tool_names() == []

    def test_stdio_requires_explicit_enabled(self):
        """⚠️ stdio 没写 enabled:true 时**不能**被启动(它会在用户机器上执行命令)."""
        state = mcp.load_mcp_servers(_stdio_cfg(enabled=False))
        assert state["servers"][0]["ok"] is False
        assert "enabled" in state["servers"][0]["error"]
        assert _tool_names() == [], "不该注册任何工具"

    def test_invalid_type_reports_clearly(self):
        """type 不合法时明确报错, 不尝试连接."""
        state = mcp.load_mcp_servers({"enabled": True, "servers": {"bad": {"type": "weird"}}})
        assert state["servers"][0]["ok"] is False
        assert "stdio 或 http" in state["servers"][0]["error"]

    def test_broken_server_only_records_error(self):
        """服务连不上时只是记错误, 不抛异常(其他功能必须照常可用)."""
        state = mcp.load_mcp_servers({"enabled": True, "servers": {
            "broken": {"type": "stdio", "command": "/definitely/not/a/real/binary",
                       "args": [], "enabled": True}}})
        assert state["servers"][0]["ok"] is False
        assert isinstance(state["servers"][0]["error"], str)
        assert _tool_names() == []

    def test_command_with_shell_metachars_is_rejected(self):
        """⚠️ 绝不允许把命令当 shell 片段执行: 元字符出现即拒绝."""
        for bad in ["npx; rm -rf /", "sh -c whoami", "npx && curl evil", "npx | sh",
                    "npx `whoami`", "npx $(whoami)", "npx\necho pwned", "npx'"]:
            with pytest.raises(mcp.McpError):
                mcp._validate_command(bad, [])

    def test_args_with_shell_metachars_are_rejected(self):
        """参数里塞 shell 片段同样拒绝(不给「配置里写一行就被执行」留空间)."""
        with pytest.raises(mcp.McpError):
            mcp._validate_command("npx", ["-y", "pkg; rm -rf /"])
        for bad in ["$(whoami)", "`id`", "a && b", "x | y", "a\nb", "print(1)"]:
            with pytest.raises(mcp.McpError):
                mcp._validate_command(sys.executable, [bad])
        # 正常参数(路径、-flag、包名)必须原样通过
        ok = ["-y", "some-mcp-package", "/tmp/skills/合同审查/SKILL.md"]
        assert mcp._validate_command("npx", ok)[1] == ok

    def test_args_must_be_strings(self):
        with pytest.raises(mcp.McpError):
            mcp._validate_command(sys.executable, [1, 2])

    def test_env_is_whitelisted_not_inherited(self, monkeypatch):
        """⚠️ 只透传 PATH/HOME + 用户显式给的 env, 绝不整份 os.environ.

        整份透传等于把 API Key 交给一个第三方程序。这里检查真正会传给
        Popen 的那份 env 字典, 而不是检查注释里写了什么。
        """
        monkeypatch.setenv("HANDOFF_SECRET_TOKEN", "sk-should-never-leak")
        transport = mcp.StdioTransport(sys.executable, [], env={"MY_FLAG": "1"})
        assert "HANDOFF_SECRET_TOKEN" not in transport.env
        assert "PATH" in transport.env
        assert transport.env["MY_FLAG"] == "1"
        assert set(transport.env) <= {"PATH", "HOME", "MY_FLAG"}


# ==========================================================================
# 真连接(真子进程 + 真协议)
# ==========================================================================


class TestMcpRealConnection:
    def test_connects_discovers_tools_with_prefix(self):
        """能连上、能发现工具、工具名带服务前缀."""
        state = mcp.load_mcp_servers(_stdio_cfg())
        assert state["servers"][0]["ok"] is True, state["servers"][0]["error"]
        assert state["servers"][0]["toolCount"] == 3
        assert _tool_names() == ["mock__add", "mock__echo", "mock__fail_always"]
        # 注册进的是**共用**的注册表: 模型循环从 tools.list_tools() 取工具,
        # MCP 注册到另一张表的话就会「注册成功却调不到」。
        assert "mock__echo" in tools_mod.list_tools()
        echo = tools_mod.get_tool("mock__echo")
        assert echo.parameters["type"] == "object"
        assert echo.description.startswith("[mock]")

    def test_handshake_order(self, tmp_path):
        """握手顺序: initialize → notifications/initialized → tools/list.

        顺序错了真实服务端会拒绝 tools/list, 而这件事只有真服务端能证明。
        """
        log = tmp_path / "mcp.log"
        mcp.load_mcp_servers(_stdio_cfg(["--log", str(log)]))
        lines = log.read_text(encoding="utf-8").split()
        assert lines[0] == "initialize"
        assert lines[1] == "notifications/initialized"
        assert lines[2] == "tools/list"

    def test_calls_tool_and_gets_result(self):
        """真的调用 MCP 工具并拿到结果."""
        mcp.load_mcp_servers(_stdio_cfg())
        r = _call("mock__echo", {"text": "你好世界"})
        assert r["ok"] is True
        assert r["text"] == "echo: 你好世界"
        assert r["meta"]["mcpServer"] == "mock"
        assert r["meta"]["tool"] == "echo"

    def test_structured_arguments_pass_through(self):
        """结构化参数被正确传过去(add 17+25=42)."""
        mcp.load_mcp_servers(_stdio_cfg())
        r = _call("mock__add", {"a": 17, "b": 25})
        assert r["ok"] is True
        assert r["text"].strip() == "42"

    def test_iserror_result_is_not_treated_as_success(self):
        """⚠️ MCP 工具内部报错必须被识别(isError 形式的失败不能当成成功).

        这是 Node 版实测抓到的 bug: 只处理「传输层抛异常」的话, 错误会被吞成成功,
        模型拿着错误信息往下写, 产出幻觉。
        """
        mcp.load_mcp_servers(_stdio_cfg())
        r = _call("mock__fail_always", {})
        assert r["ok"] is False, "内部报错的 MCP 工具不能被当成成功"
        assert "故意的失败" in r["error"]
        assert r["meta"]["isError"] is True

    def test_args_are_passed_as_json_object(self):
        """参数走 JSON 对象(工具循环里模型给的也是 JSON), 不是命令行字符串."""
        mcp.load_mcp_servers(_stdio_cfg())
        r = _call("mock__echo", json.dumps({"text": "来自 JSON 字符串"}))
        assert r["ok"] is True
        assert r["text"] == "echo: 来自 JSON 字符串"

    def test_handler_matches_tools_py_calling_convention(self):
        """⚠️ 回归: MCP 的 handler 必须能按 tools.py 的 `handler(args, ctx)` 调用.

        只收一个参数时, execute_tool 会抛 TypeError 并把它归一成
        「执行出错：TypeError」—— 工具看起来"存在但坏掉", 真实错误被吞掉。
        这条用例直接按那个签名调, 而不是绕开它。
        """
        mcp.load_mcp_servers(_stdio_cfg())
        tool = tools_mod.get_tool("mock__echo")
        assert tool is not None
        # 位置参数形态(execute_tool 的实际调用方式)
        out = tool.handler({"text": "两个参数"}, {})
        assert out["ok"] is True and out["text"] == "echo: 两个参数"
        # 关键字 + 省略 ctx 也要能用(直接调 handler 时更顺手)
        out_kw = tool.handler(args={"text": "关键字"})
        assert out_kw["ok"] is True and out_kw["text"] == "echo: 关键字"

    def test_repeated_init_is_idempotent(self):
        """重复初始化不会累积重复工具(幂等)."""
        mcp.load_mcp_servers(_stdio_cfg())
        first = len(_tool_names())
        mcp.load_mcp_servers(_stdio_cfg())
        assert len(_tool_names()) == first

    def test_close_unregisters_tools(self):
        """⚠️ 断开后工具必须从注册表消失(否则子进程和工具都会残留)."""
        mcp.load_mcp_servers(_stdio_cfg())
        assert len(_tool_names()) > 0
        mcp.close_mcp_servers()
        assert _tool_names() == []
        assert mcp.mcp_summary()["servers"] == []

    def test_close_only_removes_its_own_tools(self):
        """注销只能碰 MCP 自己注册的工具, 不能连原生工具一起清掉."""
        tools_mod.register_tool({"name": "native_keep", "description": "x",
                                 "parameters": {"type": "object", "properties": {}},
                                 "handler": lambda args, ctx=None: "ok"})
        mcp.load_mcp_servers(_stdio_cfg())
        mcp.close_mcp_servers()
        assert "native_keep" in tools_mod.list_tools()

    def test_after_close_tool_is_gone(self):
        """断开之后原来那些工具名调用会明确说「没有这个工具」."""
        mcp.load_mcp_servers(_stdio_cfg())
        mcp.close_mcp_servers()
        r = _call("mock__echo", {"text": "x"})
        assert r["ok"] is False
        assert "没有名为" in r["error"]


# ==========================================================================
# 子进程清理(孤儿进程是 Node 版明确记过的一条教训)
# ==========================================================================


class TestMcpProcessCleanup:
    def test_close_kills_child_process(self, tmp_path):
        """close 之后子进程必须真的没了 —— stdio 服务变孤儿是明确要避免的体验."""
        pid_file = tmp_path / "mcp.pid"
        mcp.load_mcp_servers(_stdio_cfg(["--pid-file", str(pid_file)]))
        pid = _wait_for_file(pid_file)
        assert _pid_alive(pid, timeout=0.2) is True, "服务端应当正在运行"

        mcp.close_mcp_servers()
        assert _pid_alive(pid) is False, f"MCP 子进程 {pid} 在 close 之后还活着"

    def test_close_kills_whole_process_group(self, tmp_path):
        """只杀直接子进程不够: 真实 MCP 服务常是 npx → node 的进程树.

        这里用 --child 模拟那棵树, 并**同时**记下孙进程的 pid —— 断言两个都没了,
        否则这条用例只是重复了上一个用例, 证明不了「按进程组收尾」这件事。
        """
        pid_file = tmp_path / "mcp.pid"
        child_pid_file = tmp_path / "child.pid"
        mcp.load_mcp_servers(_stdio_cfg(["--pid-file", str(pid_file),
                                         "--child-pid-file", str(child_pid_file), "--child"]))
        pid = _wait_for_file(pid_file)
        child_pid = _wait_for_file(child_pid_file)
        assert child_pid != pid

        mcp.close_mcp_servers()
        assert _pid_alive(pid) is False, f"MCP 服务端 {pid} 还活着"
        assert _pid_alive(child_pid) is False, f"孙进程 {child_pid} 成了孤儿"

    def test_failed_connect_does_not_leave_process(self, tmp_path):
        """子进程起来了但握手失败时也要收掉, 不能只在成功路径上清理."""
        pid_file = tmp_path / "mcp.pid"
        # 这个假服务端只会写 pid 然后一直等, 不回 initialize → 我们应当超时并收尾
        stall = tmp_path / "stall.py"
        stall.write_text(
            "import sys, time, os\n"
            f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n"
            "time.sleep(600)\n",
            encoding="utf-8")
        cfg = {"enabled": True, "callTimeoutMs": 700, "servers": {
            "stall": {"type": "stdio", "command": sys.executable,
                      "args": [str(stall)], "enabled": True}}}
        t0 = time.time()
        state = mcp.load_mcp_servers(cfg)
        assert time.time() - t0 < 10, "握手超时不该让主流程等太久"
        assert state["servers"][0]["ok"] is False
        assert _pid_alive(_wait_for_file(pid_file)) is False, "握手失败的子进程也必须被收掉"


# ==========================================================================
# http 型(不联网: 注入假传输, 真实验证不了就不假装验证)
# ==========================================================================


class TestMcpHttpTransport:
    def test_http_transport_builds_without_connecting(self):
        """http 型不需要 enabled, 也不起进程; url 校验要挡住明显写错的配置."""
        with pytest.raises(mcp.McpError):
            mcp.StreamableHTTPTransport("")
        with pytest.raises(mcp.McpError):
            mcp.StreamableHTTPTransport("ftp://example.com/mcp")
        assert mcp.StreamableHTTPTransport("https://example.com/mcp").session_id is None

    def test_sse_response_parsing(self):
        """流式响应里取第一条 data: 负载(服务端可能用 event-stream 回包)."""
        text = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n"
        assert mcp._parse_sse_response(text)["result"] == {"ok": True}
        assert mcp._parse_sse_response(": comment\n\n") is None


# ==========================================================================
# 返回内容渲染
# ==========================================================================


class TestRenderMcpContent:
    def test_plain_text(self):
        assert mcp.render_mcp_content({"content": [{"type": "text", "text": "abc"}]}) == "abc"

    def test_multiple_texts_joined(self):
        out = mcp.render_mcp_content({"content": [{"type": "text", "text": "a"},
                                                  {"type": "text", "text": "b"}]})
        assert "a" in out and "b" in out

    def test_resource_text(self):
        out = mcp.render_mcp_content({"content": [{"type": "resource",
                                                   "resource": {"text": "资源正文"}}]})
        assert out == "资源正文"

    def test_image_replaced_with_note(self):
        """图片内容被替换成一句说明(纯文本模型看不到图, 硬塞是噪音)."""
        out = mcp.render_mcp_content({"content": [{"type": "image", "data": "xxx",
                                                   "mimeType": "image/png"}]})
        assert "图片" in out

    def test_structured_content_fallback(self):
        out = mcp.render_mcp_content({"content": [], "structuredContent": {"a": 1}})
        assert '"a"' in out

    def test_unserializable_structured_content_does_not_crash(self):
        class Weird:
            pass

        out = mcp.render_mcp_content({"content": [], "structuredContent": {"o": Weird()}})
        assert isinstance(out, str) and out

    def test_error_without_text(self):
        assert "报错" in mcp.render_mcp_content({"content": [], "isError": True})
        assert "没有返回文字" in mcp.render_mcp_content({"content": []})

    def test_empty_inputs_do_not_crash(self):
        for bad in [None, {}, {"content": []}, {"content": "not-a-list"}, {"content": [None, 1]}]:
            assert isinstance(mcp.render_mcp_content(bad), str)

    def test_clip_output_marks_truncation(self):
        """截断必须显式标注, 不能让它看起来像完整的."""
        out = mcp.clip_output("x" * (mcp.MAX_TOOL_OUTPUT_CHARS + 50))
        assert out.startswith("x" * 10)
        assert "已截断" in out
        assert mcp.clip_output("short") == "short"


# ==========================================================================
# Skill 解析
# ==========================================================================


SAMPLE_FRONTMATTER = """---
name: 合同审查
description: 审查各类合同的风险点
when: 用户要审合同
tags: [法律, 合同]
authors:
  - 张三
  - 李四
---

## 正文
先定位角色。
"""


class TestParseSkillMarkdown:
    def test_parses_scalar_and_list_metadata(self):
        """frontmatter 支持 key: value、key: [a, b]、key: 后跟 - 列表项三种形态."""
        parsed = skl.parse_skill_markdown(SAMPLE_FRONTMATTER, "兜底")
        meta = parsed["meta"]
        assert meta["name"] == "合同审查"
        assert meta["description"] == "审查各类合同的风险点"
        assert meta["when"] == "用户要审合同"
        assert meta["tags"] == ["法律", "合同"]
        assert meta["authors"] == ["张三", "李四"]
        assert parsed["body"].startswith("## 正文")

    def test_crlf_is_normalized(self):
        parsed = skl.parse_skill_markdown(SAMPLE_FRONTMATTER.replace("\n", "\r\n"), "兜底")
        assert parsed["meta"]["name"] == "合同审查"

    def test_quotes_around_values_stripped(self):
        parsed = skl.parse_skill_markdown('---\nname: "带引号"\n---\n正文', "兜底")
        assert parsed["meta"]["name"] == "带引号"

    def test_without_frontmatter_uses_filename_and_first_line(self):
        """没有 frontmatter 时用文件名当 name、第一段非空文本当 description.

        「随手丢一个 md 进去也能用」是刻意降低贡献门槛的设计。
        """
        parsed = skl.parse_skill_markdown("# 大标题\n\n这是第一段正文。\n更多", "我的技能.md")
        assert parsed["meta"]["name"] == "我的技能.md"
        assert parsed["meta"]["description"] == "这是第一段正文。"

    def test_missing_fields_fall_back(self):
        parsed = skl.parse_skill_markdown("---\nname: 只有名字\n---\n描述行", "兜底")
        assert parsed["meta"]["description"] == "描述行"

    def test_no_frontmatter_and_empty_body(self):
        parsed = skl.parse_skill_markdown("", "兜底")
        assert parsed["meta"]["name"] == "兜底"
        assert parsed["body"] == ""

    def test_frontmatter_is_capped(self):
        """元信息有长度上限, 防止有人塞一篇论文当 frontmatter."""
        raw = "---\n" + "x" * 5000 + ": 1\nname: 截断测试\n---\n正文"
        parsed = skl.parse_skill_markdown(raw, "兜底")
        # 2000 字符之后的内容不再解析, 名字只能来自兜底
        assert parsed["meta"]["name"] == "兜底"


# ==========================================================================
# Skill 加载
# ==========================================================================


class TestLoadSkills:
    def _make_tree(self, root: Path):
        (root / "skills" / "合同审查").mkdir(parents=True)
        (root / "skills" / "合同审查" / "SKILL.md").write_text(
            "---\nname: 合同审查\ndescription: 审合同\nwhen: 审合同\n---\n正文A", encoding="utf-8")
        # 单文件形态也支持
        (root / "skills" / "写简历.md").write_text(
            "---\nname: 写简历\ndescription: 写简历\n---\n正文B", encoding="utf-8")
        # 目录里没有 SKILL.md → 跳过
        (root / "skills" / "空目录").mkdir()
        # 非 md 文件 → 跳过
        (root / "skills" / "readme.txt").write_text("x", encoding="utf-8")
        return root

    def test_loads_dir_and_single_file_forms(self, tmp_path):
        self._make_tree(tmp_path)
        out = skl.load_skills({"dirs": ["skills"], "root_dir": str(tmp_path)})
        assert [s["name"] for s in out["skills"]] == ["写简历", "合同审查"] or \
               sorted(s["name"] for s in out["skills"]) == ["写简历", "合同审查"]
        assert out["warnings"] == []
        assert all(s["path"].endswith(".md") for s in out["skills"])

    def test_missing_dir_is_silent(self, tmp_path):
        assert skl.load_skills({"dirs": ["nope"], "root_dir": str(tmp_path)}) == {
            "skills": [], "warnings": []}

    def test_duplicate_names_first_wins(self, tmp_path):
        """同名技能只保留第一次出现的(后面目录里的同名文件不会覆盖它)."""
        (tmp_path / "a").mkdir()
        (tmp_path / "b").mkdir()
        for d, body in (("a", "第一个"), ("b", "第二个")):
            (tmp_path / d / "同名.md").write_text(
                f"---\nname: 同名\n---\n{body}", encoding="utf-8")
        out = skl.load_skills({"dirs": ["a", "b"], "root_dir": str(tmp_path)})
        assert len(out["skills"]) == 1
        assert "第一个" in out["skills"][0]["body"]

    def test_empty_body_is_skipped_with_warning(self, tmp_path):
        (tmp_path / "skills").mkdir()
        (tmp_path / "skills" / "空.md").write_text("---\nname: 空的\n---\n   \n", encoding="utf-8")
        out = skl.load_skills({"dirs": ["skills"], "root_dir": str(tmp_path)})
        assert out["skills"] == []
        assert any("正文是空的" in w for w in out["warnings"])

    def test_unreadable_dir_warns_and_continues(self, tmp_path):
        """一个目录读不了只记警告并跳过, 不能连累其他目录 —— 技能是补充知识."""
        bad = tmp_path / "bad"
        bad.mkdir()
        good = tmp_path / "goods"
        good.mkdir()
        (good / "技能.md").write_text("---\nname: 好的\n---\n正文", encoding="utf-8")

        def broken_listdir(path):
            if os.path.basename(path) == "bad":
                raise OSError("权限不足")
            return [("技能.md", False)]

        out = skl.load_skills({"dirs": ["bad", "goods"], "root_dir": str(tmp_path),
                               "listdir": broken_listdir})
        assert [s["name"] for s in out["skills"]] == ["好的"]
        assert any("技能目录读不了" in w for w in out["warnings"])

    def test_unreadable_file_warns_and_continues(self, tmp_path, monkeypatch):
        """单个技能文件读不了(权限/IO 错)也只记警告, 不掀翻整个加载."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        (skills_dir / "坏的.md").write_text("---\nname: 坏的\n---\n正文", encoding="utf-8")
        (skills_dir / "好的.md").write_text("---\nname: 好的\n---\n正文", encoding="utf-8")

        real_open = open

        def flaky_open(file, *a, **kw):
            if os.path.basename(str(file)) == "坏的.md":
                raise OSError("权限不足")
            return real_open(file, *a, **kw)

        monkeypatch.setattr("builtins.open", flaky_open)
        out = skl.load_skills({"dirs": ["skills"], "root_dir": str(tmp_path)})
        assert [s["name"] for s in out["skills"]] == ["好的"]
        assert any("技能文件读不了" in w for w in out["warnings"])

    def test_malformed_utf8_is_replaced_not_dropped(self, tmp_path):
        """非法字节要按 Node 的语义替换成 U+FFFD, 而不是让这个技能整个消失."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        (skills_dir / "坏的.md").write_bytes(
            b"---\nname: \xe6\x8a\x80\xe8\x83\xbd\ndescription: \xff\xfe\n---\n\xff\xfe\xe6\xad\xa3\xe6\x96\x87")
        out = skl.load_skills({"dirs": ["skills"], "root_dir": str(tmp_path)})
        assert len(out["skills"]) == 1
        assert "\ufffd" in out["skills"][0]["description"]

    def test_long_body_is_truncated_and_flagged(self, tmp_path):
        (tmp_path / "skills").mkdir()
        (tmp_path / "skills" / "长.md").write_text(
            "---\nname: 很长\n---\n" + "字" * 200, encoding="utf-8")
        out = skl.load_skills({"dirs": ["skills"], "root_dir": str(tmp_path),
                               "max_chars_per_skill": 50})
        skill = out["skills"][0]
        assert skill["truncated"] is True
        assert "已截断" in skill["body"]
        assert skill["body"].startswith("字" * 50)

    def test_field_lengths_are_capped(self, tmp_path):
        (tmp_path / "skills").mkdir()
        (tmp_path / "skills" / "x.md").write_text(
            f"---\nname: {'名' * 200}\ndescription: {'描' * 500}\nwhen: {'触' * 500}\n---\n正文",
            encoding="utf-8")
        skill = skl.load_skills({"dirs": ["skills"], "root_dir": str(tmp_path)})["skills"][0]
        assert len(skill["name"]) == 80
        assert len(skill["description"]) == 300
        assert len(skill["when"]) == 300

    def test_shipped_skill_dir_loads(self):
        """仓库里真实的 skills/合同审查/SKILL.md 必须能被解析出来."""
        out = skl.load_skills({"dirs": ["skills"], "root_dir": str(ROOT)})
        assert "合同审查" in [s["name"] for s in out["skills"]]
        assert out["warnings"] == []

    def test_accepts_bare_path_like_server_startup_does(self):
        """server.py 启动时传的是 `ROOT_DIR / "skills"`(一个 Path), 必须能用.

        这条是集成契约: 那个调用点写在 server.py 里, 签名不兼容的话
        启动日志会打印「技能加载失败（不影响启动）」—— 功能静默失效。
        """
        out = skl.load_skills(ROOT / "skills")
        assert [s["name"] for s in out["skills"]] == ["合同审查"]
        assert out["warnings"] == []

    def test_accepts_str_path(self):
        out = skl.load_skills(str(ROOT / "skills"))
        assert [s["name"] for s in out["skills"]] == ["合同审查"]

    def test_return_is_dict_with_skills_key(self):
        """提醒调用方: 返回值是 dict, 判断有没有技能要看 ["skills"].

        返回值恒为真(即使一个技能都没有), 所以 `if result:` 永远是 True ——
        server.py 现有那行就是这种写法(目前只影响一行日志, 不致命)。
        """
        out = skl.load_skills({"dirs": ["definitely-not-here"], "root_dir": str(ROOT)})
        assert isinstance(out, dict) and out["skills"] == []


# ==========================================================================
# Skill 选择
# ==========================================================================


class TestSelectSkills:
    def _skills(self, tmp_path):
        (tmp_path / "skills").mkdir()
        (tmp_path / "skills" / "合同审查.md").write_text(
            "---\nname: 合同审查\ndescription: 审查租房、装修、兼职、报班等各类合同\n"
            "when: 用户要审合同、协议、条款\n---\n审查要点", encoding="utf-8")
        (tmp_path / "skills" / "写简历.md").write_text(
            "---\nname: 写简历\ndescription: 帮用户写一份突出业绩的简历\n"
            "when: 用户要写简历、求职信\n---\n简历要点", encoding="utf-8")
        return skl.load_skills({"dirs": ["skills"], "root_dir": str(tmp_path)})["skills"]

    def test_picks_relevant_skill(self, tmp_path):
        skills = self._skills(tmp_path)
        picked = skl.select_skills(skills, "帮我看一下租房合同的押金条款有没有坑")
        assert [s["name"] for s in picked] == ["合同审查"]

    def test_irrelevant_goal_picks_nothing(self, tmp_path):
        """只命中 1 个大词组就带进来等于没筛 —— 至少要 2 个独立命中."""
        skills = self._skills(tmp_path)
        assert skl.select_skills(skills, "今天天气怎么样") == []

    def test_empty_goal_picks_nothing(self, tmp_path):
        skills = self._skills(tmp_path)
        for goal in ["", "   ", None]:
            assert skl.select_skills(skills, goal) == []

    def test_respects_max_and_zero(self, tmp_path):
        skills = self._skills(tmp_path)
        goal = "帮我看一下租房合同，顺便写简历，合同的押金和简历的业绩都重要"
        assert len(skl.select_skills(skills, goal, 1)) <= 1
        assert skl.select_skills(skills, goal, 0) == []

    def test_english_keyword_matching(self):
        """英文按 3 字母以上的单词命中, 中文按二元组 —— 两条路都要通."""
        skills = [{"name": "contract review", "description": "review rental contracts",
                   "when": "user wants contract review", "body": "b"}]
        assert skl.select_skills(skills, "please review my rental contract") == skills
        assert skl.select_skills(skills, "帮我写一首诗") == []

    def test_no_single_char_scoring(self, tmp_path):
        """⚠️ 中文不能按单字匹配: 「的/了/一/是」在几乎所有描述里都有, 会让排序变随机."""
        skills = self._skills(tmp_path)
        # 只有「的」这种单字重合, 不该被选中
        assert skl.select_skills(skills, "的 的 的") == []


# ==========================================================================
# Skill 渲染与一步到位
# ==========================================================================


class TestRenderSkillsBlock:
    def _skill(self, **kw):
        base = {"name": "合同审查", "description": "审查合同", "body": "正文内容"}
        base.update(kw)
        return base

    def test_empty_returns_empty_string(self):
        assert skl.render_skills_block([]) == ""
        assert skl.render_skills_block(None) == ""

    def test_wraps_in_skill_tag_with_description(self):
        block = skl.render_skills_block([self._skill()])
        assert '<skill name="合同审查">' in block
        assert "适用场景：审查合同" in block
        assert "正文内容" in block
        assert block.rstrip().endswith("</已加载的技能>")

    def test_declares_reference_knowledge_not_orders(self):
        """⚠️ 注入前必须声明「这是参考知识, 不改变你的职责」—— 防提示词注入."""
        block = skl.render_skills_block([self._skill()])
        assert "不会改变你的职责" in block
        assert "以你的职责为准" in block

    def test_skill_name_is_escaped(self):
        """技能名是用户可写的: 不转义就能闭合 name=" 往提示词里塞标签."""
        block = skl.render_skills_block([self._skill(name='x"><script>alert(1)</script>')])
        assert "<script>" not in block
        assert "&lt;script&gt;" in block
        assert '"><script>' not in block

    def test_skill_without_description(self):
        block = skl.render_skills_block([self._skill(description="")])
        assert "适用场景" not in block

    def test_prepare_returns_full_shape(self, tmp_path):
        (tmp_path / "skills").mkdir()
        (tmp_path / "skills" / "合同审查.md").write_text(
            "---\nname: 合同审查\ndescription: 审查租房合同\nwhen: 审合同\n---\n要点",
            encoding="utf-8")
        out = skl.prepare_skills_for_goal({
            "goal": "帮我审查这份租房合同", "root_dir": str(tmp_path),
            "config": {"dirs": ["skills"], "maxCharsPerSkill": 4000, "maxSkills": 3}})
        assert set(out) == {"block", "used", "warnings", "total"}
        assert out["total"] == 1
        assert [s["name"] for s in out["used"]] == ["合同审查"]
        assert "<已加载的技能>" in out["block"]

    def test_prepare_with_no_skills_is_empty_block(self, tmp_path):
        out = skl.prepare_skills_for_goal({"goal": "随便", "root_dir": str(tmp_path),
                                           "config": {"dirs": ["nope"]}})
        assert out["block"] == "" and out["used"] == [] and out["total"] == 0

    def test_prepare_on_real_repo_skills(self):
        """仓库自带的技能, 用真实目标应当能被选出来并渲染成可注入文本."""
        out = skl.prepare_skills_for_goal({
            "goal": "帮我看看这份租房合同，押金和违约金条款有没有坑",
            "root_dir": str(ROOT), "config": {"dirs": ["skills"]}})
        assert [s["name"] for s in out["used"]] == ["合同审查"]
        assert "先定位角色" in out["block"]
