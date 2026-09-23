// dsh-remote 网络工具：局域网地址枚举 + Host/来源分类
// （分类逻辑与 dsh-pocket 同源，保持 fail-closed：认不出的 Host 一律按公网处理）

import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';

// RFC1918 私网地址 + CGNAT 100.64/10（Tailscale/ZeroTier 默认网段，公网不可路由）
const PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/;

/** 名称像真实物理网卡的接口 */
const PHYSICAL_IFACE_RE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|有线|无线|本地连接)/i;

/** 常见 VPN / 虚拟网卡：服务器通常无法经它们直连本机 */
const VPN_IFACE_RE = /(?:radmin|tailscale|zerotier|easytier|et_|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge|utun|awdl|llw|anpi|ap\d|nan\d|gif|stf)/i;

/**
 * Host 信任边界分类（fail closed）。
 * @returns {'loopback'|'lan'|'public'}
 */
export function classifyHost(host) {
  let name = String(host ?? '').trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end >= 0) name = name.slice(1, end);
  } else {
    name = name.replace(/:\d+$/, '');
  }
  if (name === 'localhost' || name === '0.0.0.0' || name === '::1' || /^127\./.test(name)) return 'loopback';
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(name)) return 'lan';
  if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(name) && name.includes(':')) return 'lan';
  if (name === '' || name.includes(':')) return 'loopback';
  if (name.endsWith('.local') || !name.includes('.')) return 'lan';
  return 'public';
}

/**
 * 按 TCP 源地址给出来源类别。认不出时按 public（兜底方向与 classifyHost 相反：
 * 源地址不可伪造，必须 fail closed）。
 * @returns {'loopback'|'lan'|'public'|null}
 */
export function classifySource(addr) {
  let a = String(addr ?? '').trim().toLowerCase();
  if (!a) return null;
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || /^127\./.test(a)) return 'loopback';
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(a)) return 'lan';
  if (/^169\.254\./.test(a)) return 'lan';
  if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(a)) return 'lan';
  return 'public';
}

/** WSL 检测（与 dsh-pocket 一致） */
export function detectWsl() {
  try {
    const v = readFileSync('/proc/version', 'utf8').toLowerCase();
    if (v.includes('microsoft') || v.includes('wsl')) return true;
  } catch { /* 非 Linux */ }
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

/**
 * 枚举本机所有可对外通告的 IPv4 候选（去重、排除 loopback/link-local）。
 * 顺序即优先级：物理网卡私网地址在前，VPN/虚拟网卡兜底在后。
 * @returns {Array<{ip:string, score:number}>}
 */
export function listIPv4Candidates() {
  const out = [];
  const seen = new Set();
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      if (seen.has(ip)) continue;
      seen.add(ip);
      let score = 0;
      if (PRIVATE_IPV4_RE.test(ip)) score += 100;
      if (PHYSICAL_IFACE_RE.test(name)) score += 20;
      else if (VPN_IFACE_RE.test(name)) score -= 50;
      out.push({ ip, score });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 最可能被同局域网服务器直达的本机 IPv4（没有私网地址时回退最高分）。 */
export function primaryLanIPv4() {
  const list = listIPv4Candidates();
  return list[0]?.ip ?? null;
}

/**
 * 生成给中继服务器的通告候选：{ip, port} 列表。
 * 只通告私网/链路可达地址（公网 IP 通告了也没有意义，NAT 后面不可拨入）。
 */
export function lanTargets(port) {
  return listIPv4Candidates()
    .filter(({ ip }) => PRIVATE_IPV4_RE.test(ip))
    .map(({ ip }) => ({ ip, port }));
}
