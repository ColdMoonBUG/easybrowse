/**
 * 内网访问拦截。
 *
 * 平台通过 frp 暴露到公网后，远端浏览器就跑在宿主机上：如果不管，任何拿到账号的人
 * 都能用地址栏访问 127.0.0.1 上的服务、192.168.x.x 的路由器后台、云主机的
 * 169.254.169.254 元数据接口。这里在导航层（Document 级请求）做一次判定：
 * 目标主机解析到回环 / 内网 / 链路本地 / 保留地址就中止请求。
 *
 * 只拦 Document 级请求，避免对每个图片、脚本都做一次 DNS 判定拖慢远端画面。
 */
import dns from 'node:dns';
import net from 'node:net';
import { config } from '../config.js';
import { logger } from '../util/logger.js';

const cache = new Map(); // host -> { at, blocked, reason }
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 2000;

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

const V4_BLOCKS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // 含 169.254.169.254 云元数据
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0, bits }));

function isPrivateV4(ip) {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some(({ base, mask }) => ((n & mask) >>> 0) === base);
}

function isPrivateV6(ip) {
  const lower = ip.toLowerCase().split('%')[0];
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    return net.isIPv4(v4) && isPrivateV4(v4);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 唯一本地地址
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 链路本地
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true; // 组播
  return false;
}

/** 判断一个 IP 字面量是否属于内网 / 保留地址段 */
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (net.isIPv6(ip)) return isPrivateV6(ip);
  return false;
}

function hostIsLocalhost(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === 'localhost.localdomain';
}

/**
 * 判定 URL 是否应当被拦截。
 * @returns {Promise<{blocked: boolean, reason?: string}>}
 */
export async function checkUrl(rawUrl) {
  if (!config.blockPrivateNetwork) return { blocked: false };

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { blocked: false };
  }
  // 只校验会真正发起网络连接的协议；about: / data: / chrome: 由浏览器自身约束
  if (!['http:', 'https:', 'ws:', 'wss:', 'ftp:'].includes(url.protocol)) return { blocked: false };

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { blocked: false };
  if (hostIsLocalhost(host)) return { blocked: true, reason: '禁止访问本机地址' };

  const cached = cache.get(host);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return cached.blocked ? { blocked: true, reason: cached.reason } : { blocked: false };
  }

  let blocked = false;
  let reason = '';

  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      blocked = true;
      reason = '禁止访问内网地址';
    }
  } else {
    try {
      const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
      const hit = addrs.find((a) => isPrivateIp(a.address));
      if (hit) {
        blocked = true;
        reason = `该域名解析到内网地址（${hit.address}），已拦截`;
      }
    } catch {
      /* 解析失败交给浏览器报错，不额外拦截 */
    }
  }

  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(host, { at: Date.now(), blocked, reason });
  return blocked ? { blocked: true, reason } : { blocked: false };
}

/** 首页 / 管理员配置的起始页也走同一套校验 */
export async function assertNavigable(rawUrl) {
  const verdict = await checkUrl(rawUrl);
  if (verdict.blocked) {
    logger.warn(`拦截导航到内网地址：${rawUrl}（${verdict.reason}）`);
    const err = new Error(verdict.reason || '该地址不允许访问');
    err.code = 'PRIVATE_NETWORK_BLOCKED';
    throw err;
  }
}
