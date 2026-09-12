/**
 * 网络与文件访问的**安全闸门**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独一个文件、而且写得这么啰嗦：
 *
 * 一旦 AI 能自己决定访问哪个 URL，SSRF 就是**真实**的攻击面 ——
 * 不是教科书里的。攻击方式很朴实：用户在输入框里粘一段"资料"，
 * 里面有句话诱导模型去抓 `http://169.254.169.254/latest/meta-data/`
 * （云服务的元数据接口，能拿到临时凭证），或者
 * `http://127.0.0.1:8787/api/health`（我们自己的服务）。
 *
 * 只靠提示词说"不要访问内网"是**完全不够**的。
 * 必须在真正发请求之前，用代码判断。
 *
 * 所以这里的规则是「默认全禁，逐项放开」，而不是「默认放开，禁几个」。
 * ══════════════════════════════════════════════════════════════════
 */
import net from 'node:net';
import dns from 'node:dns/promises';

export class NetGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NetGuardError';
    this.code = code;
  }
}

/** 只允许这两种协议。file:/gopher:/ftp: 之类一律拒绝。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 判断一个 IP 是不是"内部地址"。
 *
 * 覆盖：
 *  · 回环 127.0.0.0/8、::1
 *  · 私有 10/8、172.16/12、192.168/16
 *  · 链路本地 169.254/16（**云元数据就在这里**）、fe80::/10
 *  · 唯一本地 fc00::/7
 *  · 运营商级 NAT 100.64/10
 *  · 未指定 0.0.0.0、::
 *  · 组播/广播
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateIp(ip) {
  const v = String(ip ?? '').trim();
  if (!v) return true; // 判断不出来 → 当危险处理

  // IPv6
  if (net.isIPv6(v)) {
    const lower = v.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true; // 链路本地
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // 唯一本地 fc00::/7
    if (lower.startsWith('ff')) return true; // 组播
    // IPv4-mapped：::ffff:127.0.0.1
    //
    // ⚠️ 有两种写法，必须都认：
    //   · 点分：`::ffff:127.0.0.1`
    //   · **十六进制**：`::ffff:7f00:1`  ← Node 的 URL 会把上面那种**规范化成这种**！
    // 只认点分写法的话，`http://[::ffff:127.0.0.1]/` 就能绕过内网检查
    // （实测确认过：Node 的 URL.hostname 给的是 `[::ffff:7f00:1]`）。
    // 这是同一个 SSRF 绕过家族的第二个变体 —— 修第一个时没想到还藏着这个。
    const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIp(dotted[1]);

    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const high = parseInt(hexMapped[1], 16);
      const low = parseInt(hexMapped[2], 16);
      const ipv4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
      return isPrivateIp(ipv4);
    }
    return false;
  }

  if (!net.isIPv4(v)) return true;

  const parts = v.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 私有
  if (a === 127) return true; // 回环
  if (a === 169 && b === 254) return true; // 链路本地 / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true; // 私有
  if (a === 192 && b === 168) return true; // 私有
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 协议分配
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试段
  if (a >= 224) return true; // 组播 + 保留 + 广播

  return false;
}

/** 这些主机名直接拒绝（连 DNS 都不用查） */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

/**
 * 校验一个 URL 是否允许被抓取。
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {string[]} [opts.allowHosts] 显式允许的主机（精确匹配或 `.example.com` 后缀）
 * @param {boolean} [opts.allowPrivateHosts] 是否允许访问内网（**默认 false**，
 *        只有用户显式打开才允许；单机场景下访问自己的服务是个正当需求，
 *        但绝不能默认开）
 * @returns {Promise<{ok:boolean, url?:URL, error?:string, resolvedIp?:string}>}
 */
export async function checkUrl(rawUrl, opts = {}) {
  const {
    allowHosts = [],
    allowPrivateHosts = false,
    // 可注入的 DNS 解析器（测试用）。
    // 为什么需要：我们的测试要断言"公网域名放行、解析到内网的域名拦下"，
    // 而这两件事都取决于**这台机器当下的 DNS**。
    // 实测踩到过：某台开发机的 DNS 会把 example.com 解析成 127.0.0.1，
    // 于是"公网地址应该放行"这条测试无缘无故就红了 —— 而代码完全没问题。
    // 靠真实 DNS 的测试是 flaky 测试，必须能注入。
    dnsLookup = (host) => dns.lookup(host, { all: true, verbatim: true }),
  } = opts;

  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, error: `这不是一个合法的网址：${String(rawUrl).slice(0, 200)}` };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      ok: false,
      error: `只允许 http 和 https，不允许 ${url.protocol.replace(':', '')}（这是为了安全）`,
    };
  }

  // 带凭据的 URL（http://user:pass@host）一律拒绝：这是常见的绕过手法，
  // 而且我们没有任何理由需要它。
  if (url.username || url.password) {
    return { ok: false, error: '网址里不允许带用户名和密码' };
  }

  // ⚠️ IPv6 的 hostname 在 URL 里是带方括号的：`new URL('http://[::1]/').hostname`
  // 返回的是 `"[::1]"` 而**不是** `"::1"`。
  // 不剥掉方括号的话：`net.isIP('[::1]')` 返回 0（认不出来）→ 代码会把它当**域名**
  // 去查 DNS → 查询失败或超时 → 要么放行要么报"解析不了"，
  // 总之**绕过了内网检查**。这是个真实的 SSRF 绕过（测试抓到的），
  // 而且症状是"偶发超时"而不是"被拦"，很容易被当成 flaky 忽略掉。
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, '') // 去掉尾点（FQDN 写法）
    .replace(/^\[|\]$/g, ''); // 剥掉 IPv6 的方括号

  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, error: `出于安全考虑，不允许访问内网地址（${host}）` };
  }

  const explicitlyAllowed = allowHosts.some(
    (h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase().replace(/^\./, '')}`),
  );

  // ⚠️ 关于 trustedHosts（对应配置里的 trustedHosts）：
  //
  // 判定"内网地址"只能靠**解析结果**，而解析结果有时会被本机环境改写。
  // 实测例子：某些开发机的 /etc/hosts 会把 github.com 指向 127.0.0.1
  // （网络管控/代理软件常这么做）。这时我们的检查会正确地拦下它 ——
  // 安全上没错，但用户会觉得"为什么 github 打不开"。
  //
  // 所以给一个**显式**的逃生口：用户可以在配置里列出他信任的域名，
  // 这些域名跳过内网 IP 检查。默认是空列表 —— 默认行为仍然是最严格的。
  // 这不是"关掉安全"，而是"把判断权交给用户，并且让他明确知道自己在做什么"。
  if (!allowPrivateHosts && !explicitlyAllowed) {
    // 主机名本身就是 IP 的情况：不用查 DNS
    if (net.isIP(host)) {
      if (isPrivateIp(host)) {
        return { ok: false, error: `出于安全考虑，不允许访问内网地址（${host}）` };
      }
      return { ok: true, url, resolvedIp: host };
    }

    // 域名：必须解析后检查真实 IP。
    // 这一步是必须的 —— 攻击者可以用一个解析到 127.0.0.1 的域名绕过纯字符串检查
    // （所谓 DNS rebinding 的简化版）。
    let addresses;
    try {
      addresses = await dnsLookup(host);
    } catch {
      return { ok: false, error: `解析不了这个域名：${host}` };
    }
    if (!addresses.length) {
      return { ok: false, error: `解析不了这个域名：${host}` };
    }
    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        return {
          ok: false,
          error: `出于安全考虑，不允许访问内网地址（${host} → ${addr.address}）`,
        };
      }
    }
    return { ok: true, url, resolvedIp: addresses[0].address };
  }

  return { ok: true, url };
}

/* ────────────────────────────────────────────────────────────────
 * 文件路径闸门
 * ──────────────────────────────────────────────────────────────── */

/**
 * 判断 `child` 是否在 `root` 里面（含相等）。
 * 用 path.relative 而不是字符串前缀 —— 后者会被 `root-evil` 这种绕过。
 */
export function isInsideDir(root, child, pathMod) {
  const p = pathMod;
  const rel = p.relative(p.resolve(root), p.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/**
 * 校验一个路径是否允许读写。
 *
 * 规则（默认全禁）：
 *  · 必须是绝对路径（或用 allowedRoots 里的某个根拼出来的相对路径）
 *  · 解析后（含 `..` 展开、符号链接解析）必须落在某个 allowedRoot 里
 *  · 拒绝 NUL 字节
 *
 * @param {string} rawPath
 * @param {object} opts
 * @param {string[]} opts.allowedRoots 允许的根目录（绝对路径）
 * @param {import('node:fs')} opts.fs 便于测试注入
 * @param {object} opts.path node:path
 * @returns {Promise<{ok:boolean, full?:string, error?:string}>}
 */
/** 把一条路径解析成"真实路径"（展开符号链接），尽量不失败 */
async function realpathBestEffort(target, fs, p) {
  try {
    return await fs.promises.realpath(target);
  } catch {
    // 目标还不存在（比如要写新文件）：解析它的父目录，再拼回文件名
    try {
      const parent = await fs.promises.realpath(p.dirname(target));
      return p.join(parent, p.basename(target));
    } catch {
      return p.resolve(target);
    }
  }
}

/**
 * 校验一个路径是否允许读写。
 *
 * ⚠️ 关键：**允许的根目录也要 realpath**，不能只解析被检查的路径。
 *
 * 这个 bug 是被真机实测抓出来的：macOS 上 `/var` 是指向 `/private/var` 的符号链接，
 * `os.tmpdir()` 给的是 `/var/folders/...`。我们把文件解析成
 * `/private/var/.../note.txt`，却拿**未解析**的 `/var/...` 当根目录去比对 ——
 * 于是一个完全合法的文件被判定为"越权访问"。
 *
 * 更糟的是当时的错误信息把它说成"只允许访问：/var/..."，
 * 而那个目录**看起来**就是这个文件所在的目录 —— 连模型都被绕晕了
 * （它在回答里准确指出了这个矛盾）。**错误的错误信息比没有错误信息更糟。**
 *
 * 所以现在两端都解析，并且报错时把"解析后的路径"也说清楚。
 */
export async function checkPath(rawPath, { allowedRoots = [], fs, path: p } = {}) {
  const raw = String(rawPath ?? '');
  if (!raw.trim()) return { ok: false, error: '路径是空的' };
  if (raw.includes('\u0000')) return { ok: false, error: '路径里不允许有 NUL 字节' };

  if (!allowedRoots.length) {
    return {
      ok: false,
      error:
        '当前没有配置任何允许访问的目录（这是默认状态，需要你在配置文件里显式加上 allowedReadRoots）',
    };
  }

  const resolved = p.resolve(raw);
  const real = await realpathBestEffort(resolved, fs, p);

  // ⚠️ 根目录也必须解析（见上面那段 macOS 的坑）
  const realRoots = [];
  for (const root of allowedRoots) {
    realRoots.push(await realpathBestEffort(p.resolve(root), fs, p));
  }

  const inside = realRoots.some((root) => isInsideDir(root, real, p));
  if (!inside) {
    return {
      ok: false,
      error:
        `不允许访问这个路径。\n要访问的（解析后）：${real}\n允许的目录：${realRoots.join('、')}\n` +
        '（如果这个文件确实该被读到，请让用户把它放进上面某个目录，或者把该目录加进配置。）',
    };
  }
  return { ok: true, full: real };
}
