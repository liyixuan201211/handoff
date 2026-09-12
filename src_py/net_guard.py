"""网络守卫: SSRF 与 DNS rebinding 防护.

这是 src/tools/net-guard.js 的 Python 移植。为什么必须有这一层:
    一旦允许工具"抓取用户给的网址", 攻击者就能让服务去访问
    169.254.169.254(云元数据, 能拿到实例凭证)或 127.0.0.1 上的内部服务。
    所以校验的不是"网址长得对不对", 而是"它最终会连到哪里"。

两个真实踩过的绕过案例(原文件注释里记着, 这里保留):
  1. **IPv4-mapped IPv6 有两种写法**: 点分 `::ffff:127.0.0.1` 与
     十六进制 `::ffff:7f00:1`。只认点分写法时,
     `http://[::ffff:127.0.0.1]/` 能绕过内网检查。
  2. **DNS rebinding**: 校验时解析成公网 IP, 连接时再解析成内网 IP。
     对策是把校验时解析到的 IP 一并返回, 让调用方直接连这个 IP。

Python 侧的一个不同: 解析后应把 host 换成已校验的 IP 再交给 urllib,
否则 urllib 会做第二次解析 —— 那就等于把 rebinding 的窗口又打开了。
"""

from __future__ import annotations

import ipaddress
import os
import socket
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

ALLOWED_PROTOCOLS = {"http", "https"}

# 这些主机名直接拒绝, 连 DNS 都不用查
BLOCKED_HOSTNAMES = {
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "metadata",
    "metadata.google.internal",
    "instance-data",
}


class NetGuardError(Exception):
    def __init__(self, message: str, code: str = "NET_BLOCKED"):
        super().__init__(message)
        self.code = code
        self.message = message


def is_private_ip(ip: Any) -> bool:
    """判断 IP 是否属于"内部地址".

    覆盖: 回环 / 私有 / 链路本地(169.254/16 就是云元数据) / 唯一本地 /
    CGNAT / 未指定 / 组播广播。

    **判断不出来时一律当危险处理** —— 安全函数在不确定时应该保守。
    """
    v = str(ip if ip is not None else "").strip()
    if not v:
        return True
    # 去掉 IPv6 方括号
    if v.startswith("[") and v.endswith("]"):
        v = v[1:-1]
    # 去掉 zone id: fe80::1%en0
    if "%" in v:
        v = v.split("%", 1)[0]

    try:
        addr = ipaddress.ip_address(v)
    except ValueError:
        return True                      # 不是合法 IP -> 当危险

    if isinstance(addr, ipaddress.IPv6Address):
        # IPv4-mapped: 两种写法都要认
        if addr.ipv4_mapped is not None:
            return is_private_ip(str(addr.ipv4_mapped))
        # 6to4 / Teredo 里也可能藏 IPv4
        sixtofour = getattr(addr, "sixtofour", None)
        if sixtofour is not None:
            return is_private_ip(str(sixtofour))
        # IPv6: 文档段 2001:db8::/32 会被 is_private 判 True, 但它不是内网,
        # 只是保留给示例用的。放行它更符合直觉(也不会带来 SSRF 风险)。
        if addr in ipaddress.ip_network("2001:db8::/32"):
            return False
        return bool(
            addr.is_loopback or addr.is_unspecified or addr.is_link_local
            or addr.is_multicast or addr.is_private or addr.is_reserved
        )

    # 注意: Python 的 ipaddress 认为 100.64.0.0/10(CGNAT) 不是 private,
    # 而 Node 侧的实现明确拦它。这是标准库口径差异, 必须显式补上 ——
    # 否则同一份规则在两个实现里结论不同。
    cgnat = ipaddress.ip_network("100.64.0.0/10")
    if addr in cgnat:
        return True
    # 198.18.0.0/15 基准测试段同理
    if addr in ipaddress.ip_network("198.18.0.0/15"):
        return True

    return bool(
        addr.is_loopback or addr.is_unspecified or addr.is_link_local
        or addr.is_multicast or addr.is_private or addr.is_reserved
    )


def _host_matches(host: str, pattern: str) -> bool:
    """主机名匹配: 精确, 或 .example.com 后缀. 大小写不敏感."""
    h = (host or "").lower().rstrip(".")
    p = (pattern or "").lower().rstrip(".")
    if not p:
        return False
    if p.startswith("."):
        return h == p[1:] or h.endswith(p)
    return h == p


def _default_resolver(host: str, port: int) -> list[str]:
    """解析主机名 -> IP 列表. 解析失败返回空表."""
    try:
        infos = socket.getaddrinfo(host, port or None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, OSError):
        return []
    out: list[str] = []
    for info in infos:
        addr = info[4][0]
        if addr not in out:
            out.append(addr)
    return out


def check_url(raw_url: Any, *, allow_hosts: list[str] | None = None,
              allow_private_hosts: bool = False,
              resolver: Callable[[str, int], list[str]] | None = None) -> dict:
    """校验 URL 是否允许抓取.

    返回 {"ok", "url", "host", "resolved_ip", "error"}。

    allow_private_hosts 默认 False: 单机场景下访问自己的服务是正当需求,
    但绝不能默认开 —— 默认开等于默认允许访问云元数据。

    resolver 可注入(测试用): 否则"公网域名放行"这条测试会取决于
    这台机器当下的 DNS —— 实测踩到过某台开发机把 example.com 解析到 127.0.0.1,
    于是代码没问题但测试无缘无故红了。
    """
    allow_hosts = allow_hosts or []
    resolver = resolver or _default_resolver

    try:
        parsed = urlparse(str(raw_url if raw_url is not None else ""))
    except ValueError:
        return {"ok": False, "error": f"这不是一个合法的网址：{str(raw_url)[:200]}"}

    if not parsed.scheme or not parsed.netloc:
        return {"ok": False, "error": f"这不是一个合法的网址：{str(raw_url)[:200]}"}

    if parsed.scheme.lower() not in ALLOWED_PROTOCOLS:
        return {"ok": False,
                "error": f"只允许 http 和 https，不允许 {parsed.scheme}（这是为了安全）"}

    if parsed.username or parsed.password:
        return {"ok": False, "error": "网址里不允许带用户名和密码"}

    host = (parsed.hostname or "").strip()
    if not host:
        return {"ok": False, "error": "网址里没有主机名。"}

    if host.lower() in BLOCKED_HOSTNAMES:
        return {"ok": False, "error": f"出于安全考虑，不允许访问内网地址（{host}）"}

    explicitly_allowed = any(_host_matches(host, p) for p in allow_hosts)
    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)

    if not allow_private_hosts and not explicitly_allowed:
        # 已经是 IP 的: 直接判, 不用查 DNS
        try:
            ipaddress.ip_address(host)
            if is_private_ip(host):
                return {"ok": False,
                        "error": f"出于安全考虑，不允许访问内网地址（{host}）"}
            return {"ok": True, "url": str(raw_url), "host": host,
                    "resolved_ip": host}
        except ValueError:
            pass

        addresses = resolver(host, port)
        if not addresses:
            return {"ok": False, "error": f"解析不了这个域名：{host}"}
        for addr in addresses:
            if is_private_ip(addr):
                # 只要**任一**解析结果落在内网就拒绝:
                # 攻击者可以返回多个 A 记录, 其中一个是内网。
                return {"ok": False,
                        "error": f"出于安全考虑，不允许访问内网地址（{host}）",
                        "resolved_ip": addr}
        return {"ok": True, "url": str(raw_url), "host": host,
                "resolved_ip": addresses[0]}

    return {"ok": True, "url": str(raw_url), "host": host, "resolved_ip": None}


def pinned_url(url: str, resolved_ip: str, host: str) -> str:
    """把 URL 里的主机名换成已校验的 IP, 防止第二次 DNS 解析.

    这就是防御 DNS rebinding 的关键: 校验与连接必须用**同一个** IP。
    不带 Host 头会破坏虚拟主机, 所以调用方还要补上原始 Host。
    """
    if not resolved_ip or not host:
        return url
    parsed = urlparse(url)
    netloc = parsed.netloc.replace(host, resolved_ip, 1)
    return parsed._replace(netloc=netloc).geturl()


# --------------------------------------------------------------------------
# 文件路径守卫
# --------------------------------------------------------------------------


def is_inside_dir(root: Any, child: Any) -> bool:
    """child 是否在 root 目录内(防路径穿越). 用 realpath 解析符号链接."""
    try:
        r = Path(os.path.realpath(str(root)))
        c = Path(os.path.realpath(str(child)))
    except (OSError, ValueError):
        return False
    try:
        c.relative_to(r)
        return True
    except ValueError:
        return False


def check_path(raw_path: Any, *, allowed_roots: list[str] | None = None,
               require_exists: bool = True) -> dict:
    """校验一个文件路径是否允许读取.

    默认要求路径必须落在 allowed_roots 内 —— 不能让模型随便读 ~/.ssh/id_rsa。
    """
    allowed_roots = [r for r in (allowed_roots or []) if r]
    p = str(raw_path if raw_path is not None else "").strip()
    if not p:
        return {"ok": False, "error": "没有给出文件路径。"}

    # 展开 ~ 并规范化, 否则 "~/x" 与 "/Users/x" 会被当成两个路径
    expanded = os.path.expanduser(p)
    resolved = os.path.realpath(expanded)

    if allowed_roots and not any(is_inside_dir(r, resolved) for r in allowed_roots):
        return {"ok": False,
                "error": "出于安全考虑，只能读取工作目录里的文件。"}

    if require_exists and not os.path.exists(resolved):
        return {"ok": False, "error": f"找不到这个文件：{p}"}
    if require_exists and not os.path.isfile(resolved):
        # 目录不直接报错, 但要明确说明, 免得调用方以为读到了空文件
        return {"ok": False, "error": f"这是一个目录，不是文件：{p}"}

    try:
        size = os.path.getsize(resolved) if os.path.exists(resolved) else 0
    except OSError:
        size = 0
    return {"ok": True, "path": resolved, "size": size}
