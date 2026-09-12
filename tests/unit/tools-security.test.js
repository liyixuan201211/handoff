/**
 * 工具的安全边界测试。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件的用例全是攻击。
 *
 * 为什么值得单独一个文件：一旦 AI 能自己决定访问哪个 URL、读哪个文件，
 * SSRF 和路径穿越就从"教科书名词"变成了**真实攻击面**。
 * 攻击方式很朴实 —— 用户在输入框里粘一段"资料"，里面有句话诱导模型
 * 去抓 `http://169.254.169.254/latest/meta-data/`（云元数据接口），
 * 或者去读 `~/.ssh/id_rsa`。用户完全不知道发生了什么。
 *
 * 只靠提示词说"不要访问内网"是**完全不够的**。必须在发请求/读文件之前，
 * 用代码判断。这个文件就是在证明那层代码真的挡得住。
 * ══════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isPrivateIp, checkUrl, checkPath, isInsideDir } from '../../src/tools/net-guard.js';
import { registerWebFetch } from '../../src/tools/native.js';
import { executeTool, clearTools } from '../../src/tools/registry.js';

describe('内网 IP 判定（SSRF 的核心）', () => {
  it('这些 IP 必须判为内网/危险', () => {
    const dangerous = [
      '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '10.255.255.255',
      '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.168.255.255',
      '169.254.169.254', // ← AWS/GCP 元数据，SSRF 的头号目标
      '169.254.0.1',
      '100.64.0.1', // CGNAT
      '198.18.0.1',
      '224.0.0.1', '239.255.255.255', '255.255.255.255',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    ];
    for (const ip of dangerous) {
      expect(isPrivateIp(ip), `${ip} 应该被判为危险`).toBe(true);
    }
  });

  it('这些公网 IP 不能被误判（否则正常网页都打不开）', () => {
    const ok = ['8.8.8.8', '1.1.1.1', '104.20.23.154', '203.0.113.1', '2606:4700::1'];
    for (const ip of ok) {
      expect(isPrivateIp(ip), `${ip} 不该被判为危险`).toBe(false);
    }
  });

  it('不是 IP 的输入一律当危险处理（宁可拒绝）', () => {
    for (const bad of ['', 'not-an-ip', '999.1.1.1', '1.2.3', null, undefined]) {
      expect(isPrivateIp(bad)).toBe(true);
    }
  });
});

describe('URL 闸门：这些必须被拒绝', () => {
  const mustReject = [
    ['回环地址', 'http://127.0.0.1:8787/api/health'],
    ['localhost', 'http://localhost/admin'],
    ['云元数据', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['私有网段', 'http://192.168.1.1/'],
    ['私有网段', 'http://10.0.0.1/'],
    ['CGNAT', 'http://100.64.0.1/'],
    ['IPv6 回环', 'http://[::1]/'],
    ['未指定地址', 'http://0.0.0.0/'],
    ['file 协议', 'file:///etc/passwd'],
    ['gopher 协议', 'gopher://127.0.0.1:11211/'],
    ['ftp 协议', 'ftp://example.com/x'],
    ['带凭据', 'http://user:pass@example.com/'],
    ['javascript 伪协议', 'javascript:alert(1)'],
    ['data 伪协议', 'data:text/html,<script>alert(1)</script>'],
    ['不是 URL', 'not a url at all'],
    ['空', ''],
  ];

  for (const [label, url] of mustReject) {
    it(`${label}：${url.slice(0, 50)}`, async () => {
      const r = await checkUrl(url);
      expect(r.ok, `${url} 应该被拒`).toBe(false);
      expect(typeof r.error).toBe('string');
    });
  }

  it('IPv6 的方括号不能成为绕过口（真实修过的漏洞）', async () => {
    // ⚠️ `new URL('http://[::1]/').hostname` 返回的是 `"[::1]"`（**带方括号**），
    // 而 `net.isIP('[::1]')` 返回 0 —— 于是它会被当成域名去查 DNS，
    // 查询失败时就被"解析不了"这条路径放过了。
    // 这个 bug 的症状是**偶发超时**而不是"被拦"，很容易被当成 flaky 忽略。
    expect((await checkUrl('http://[::1]/')).ok).toBe(false);
    expect((await checkUrl('http://[::1]:8080/x')).ok).toBe(false);
    expect((await checkUrl('http://[fe80::1]/')).ok).toBe(false);
  });

  it('IPv4-mapped 的十六进制写法也要被拦（同一个漏洞家族的第二个变体）', async () => {
    // Node 的 URL 会把 `[::ffff:127.0.0.1]` **规范化成** `[::ffff:7f00:1]`。
    // 只认点分写法的话这条就漏了。修第一个变体时我没想到还藏着这个。
    expect((await checkUrl('http://[::ffff:127.0.0.1]/')).ok).toBe(false);
    expect((await checkUrl('http://[::ffff:7f00:1]/')).ok).toBe(false);
    expect((await checkUrl('http://[::ffff:a00:1]/')).ok).toBe(false); // 10.0.0.1
    expect((await checkUrl('http://[::ffff:c0a8:101]/')).ok).toBe(false); // 192.168.1.1
    expect((await checkUrl('http://[::ffff:169.254.169.254]/')).ok).toBe(false); // 云元数据
  });

  it('公网 IPv6 不能被误伤（否则 IPv6-only 的网站全打不开）', async () => {
    expect((await checkUrl('https://[2606:4700::1]/')).ok).toBe(true);
    expect((await checkUrl('https://[::ffff:8.8.8.8]/')).ok).toBe(true);
  });

  it('十进制写的 127.0.0.1 也要被拦（常见绕过手法）', async () => {
    // 2130706433 === 127.0.0.1
    const r = await checkUrl('http://2130706433/');
    // Node 的 URL 会把十进制主机名解析成 127.0.0.1 —— 我们希望它被判定为内网
    expect(r.ok).toBe(false);
  });

  it('十六进制写的回环也要被拦', async () => {
    expect((await checkUrl('http://0x7f000001/')).ok).toBe(false);
  });

  it('公网地址正常放行（不能误伤）', async () => {
    // ⚠️ 注入 DNS：不能依赖这台机器当下的解析结果。
    // 实测踩到过：某台开发机的 DNS 会把 example.com 解析成 127.0.0.1，
    // 于是这条测试无缘无故红了，而代码完全没问题。
    const r = await checkUrl('https://example.com/', {
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    expect(r.ok).toBe(true);
    expect(r.url.hostname).toBe('example.com');
  });

  it('域名解析到内网 → 拦下（DNS rebinding 的简化版）', async () => {
    // 攻击者可以注册一个解析到 127.0.0.1 的域名来绕过纯字符串检查。
    // 所以必须解析后检查**真实 IP**，不能只看域名。
    const r = await checkUrl('https://evil-looks-public.com/', {
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(r.ok, '解析到回环的域名必须被拦').toBe(false);
    expect(r.error).toContain('内网');
  });

  it('域名解析到多个地址时，只要有一个是内网就拦（不能只看第一个）', async () => {
    const r = await checkUrl('https://mixed.example/', {
      dnsLookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    });
    expect(r.ok, '多地址里混了内网 IP 也必须拦').toBe(false);
  });

  it('DNS 解析失败 → 拦下（不猜、不放行）', async () => {
    const r = await checkUrl('https://nowhere.invalid/', {
      dnsLookup: async () => {
        throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      },
    });
    expect(r.ok).toBe(false);
  });

  it('allowPrivateHosts=true 才允许内网（显式开关）', async () => {
    expect((await checkUrl('http://127.0.0.1:8787/')).ok).toBe(false);
    expect((await checkUrl('http://127.0.0.1:8787/', { allowPrivateHosts: true })).ok).toBe(true);
  });

  it('allowHosts 里的域名可以放行（信任逃生口）', async () => {
    const r = await checkUrl('http://127.0.0.1:9000/x', { allowHosts: ['127.0.0.1'] });
    expect(r.ok).toBe(true);
  });
});

describe('路径闸门：这些必须被拒绝', () => {
  let root;
  let outside;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-out-'));
    fs.writeFileSync(path.join(root, 'ok.txt'), 'inside');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
  });

  const opts = () => ({ allowedRoots: [root], fs, path });

  it('没配任何允许目录 → 一律拒绝（默认安全）', async () => {
    const r = await checkPath(path.join(root, 'ok.txt'), { allowedRoots: [], fs, path });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有配置');
  });

  it('允许目录内的文件 → 放行', async () => {
    const r = await checkPath(path.join(root, 'ok.txt'), opts());
    expect(r.ok).toBe(true);
  });

  it('用 .. 跳出允许目录 → 拒绝', async () => {
    const r = await checkPath(path.join(root, '..', path.basename(outside), 'secret.txt'), opts());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不允许');
  });

  it('直接给外部绝对路径 → 拒绝', async () => {
    const r = await checkPath(path.join(outside, 'secret.txt'), opts());
    expect(r.ok).toBe(false);
  });

  it('/etc/passwd 这种系统文件 → 拒绝', async () => {
    const r = await checkPath('/etc/passwd', opts());
    expect(r.ok).toBe(false);
  });

  it('前缀相同的兄弟目录不能被绕过（root-evil 不是 root 的子目录）', async () => {
    const evil = `${root}-evil`;
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'x.txt'), 'evil');
    const r = await checkPath(path.join(evil, 'x.txt'), opts());
    expect(r.ok).toBe(false);
    fs.rmSync(evil, { recursive: true, force: true });
  });

  it('路径里有 NUL 字节 → 拒绝', async () => {
    const r = await checkPath(`${root}/ok.txt\u0000.png`, opts());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('NUL');
  });

  it('符号链接指向允许目录之外 → 拒绝（realpath 必须生效）', async () => {
    const link = path.join(root, 'link-to-secret.txt');
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), link);
    } catch {
      return; // 某些环境不允许建符号链接，跳过
    }
    const r = await checkPath(link, opts());
    // 关键：不能因为"符号链接文件本身在 root 里"就放行
    expect(r.ok).toBe(false);
  });

  it('允许目录里的子目录 → 放行', async () => {
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.txt'), 'x');
    expect((await checkPath(path.join(sub, 'a.txt'), opts())).ok).toBe(true);
  });
});

describe('isInsideDir 的边界', () => {
  it('相等算在内', () => {
    expect(isInsideDir('/a/b', '/a/b', path)).toBe(true);
  });
  it('子路径算在内', () => {
    expect(isInsideDir('/a/b', '/a/b/c/d', path)).toBe(true);
  });
  it('父路径不算', () => {
    expect(isInsideDir('/a/b', '/a', path)).toBe(false);
  });
  it('前缀相同的兄弟目录不算', () => {
    expect(isInsideDir('/a/b', '/a/bc', path)).toBe(false);
  });
});

describe('web_fetch 端到端：攻击必须被挡住', () => {
  beforeEach(() => {
    clearTools();
    // 注入一个"永远成功"的 fetch —— 如果闸门失效，它会返回假的成功结果，
    // 我们就能从"是否被拦"判断出闸门有没有起作用。
    // 这样测试不依赖网络，也不会真的去访问内网。
    registerWebFetch({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        arrayBuffer: async () => new TextEncoder().encode('<html><body>不该被访问到</body></html>').buffer,
      }),
    });
  });

  it('15 种内网地址全部被拦（一个都不许漏）', async () => {
    const attacks = [
      'http://127.0.0.1:8787/api/health',
      'http://localhost/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/',
      'http://10.0.0.1/',
      'http://[::1]/',
      'http://0.0.0.0/',
      'file:///etc/passwd',
      'http://user:pass@example.com/',
      'http://2130706433/',
      'http://0x7f.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
    ];
    const leaked = [];
    for (const url of attacks) {
      const r = await executeTool('web_fetch', { url });
      if (r.ok) leaked.push(url);
    }
    expect(leaked, `这些地址被放行了：${leaked.join(', ')}`).toEqual([]);
  });

  it('参数不合法时不会发出请求', async () => {
    let fetchCalled = false;
    clearTools();
    registerWebFetch({
      fetchImpl: async () => {
        fetchCalled = true;
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, arrayBuffer: async () => new ArrayBuffer(0) };
      },
    });
    await executeTool('web_fetch', {}); // 缺 url
    await executeTool('web_fetch', { url: 'http://127.0.0.1/' }); // 内网
    expect(fetchCalled).toBe(false);
  });
});
