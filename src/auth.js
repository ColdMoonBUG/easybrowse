/**
 * 认证与会话：Cookie 登录态 + RBAC。
 * - Cookie 采用 HttpOnly + SameSite=Lax（HTTPS 部署时追加 Secure），不把 token 暴露给前端 JS
 * - 登录失败按 用户名+IP 计数并锁定，错误提示统一为“用户名或密码错误”，不泄露账号是否存在
 */
import { query } from './db.js';
import { config } from './config.js';
import { randomToken, verifyPassword } from './util/crypto.js';
import { audit } from './audit.js';
import { getSettings } from './db.js';

export const COOKIE_NAME = 'eb_sid';

const loginAttempts = new Map(); // key -> { count, lockedUntil }

/**
 * 取客户端 IP。
 *
 * 只用 Express 解析过的 req.ip（受 TRUST_PROXY 控制），不再自己读 X-Forwarded-For。
 * 原因：frp 的 tcp 映射是纯 TCP 透传，不会写这个头，客户端自己填的值全是伪造的——
 * 拿它做注册限流或登录锁定，攻击者每次换个假 IP 就绕过去了。
 * 经 Caddy/Nginx 反代时把 TRUST_PROXY 设为 1，Express 会按信任链还原真实 IP。
 */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

export { clientIp };

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setSessionCookie(res, token, ttlHours) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlHours * 3600)}`,
  ];
  if (config.behindHttps) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.behindHttps) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function createAuthSession(userId, req) {
  const token = randomToken(32);
  const now = Date.now();
  const expires = now + config.sessionTtlHours * 3600 * 1000;
  query.run(
    'INSERT INTO auth_sessions (token, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    token,
    userId,
    now,
    expires,
    clientIp(req),
    String(req.headers['user-agent'] || '').slice(0, 240),
  );
  // 顺手清理过期登录态，避免表膨胀
  query.run('DELETE FROM auth_sessions WHERE expires_at < ?', now);
  return { token, expires };
}

export function destroyAuthSession(token) {
  if (!token) return;
  query.run('DELETE FROM auth_sessions WHERE token = ?', token);
}

/**
 * 从请求里取出登录态令牌。
 *
 * 优先 Cookie（浏览器走这条），其次 Authorization: Bearer（脚本 / 第三方系统走这条）。
 * 两者指向同一张 auth_sessions 表，所以退出登录时任何一个都能让另一边同时失效。
 */
export function readToken(req) {
  const fromCookie = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  if (fromCookie) return fromCookie;
  const auth = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : '';
}

export function userByToken(req) {
  const token = readToken(req);
  if (!token) return null;
  const row = query.get(
    `SELECT u.*, s.token AS sid, s.expires_at AS sid_expires
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`,
    token,
  );
  if (!row) return null;
  if (row.sid_expires < Date.now()) {
    destroyAuthSession(token);
    return null;
  }
  if (row.status !== 'active') return null;
  row.sid = token;
  return row;
}

export function requireAuth(req, res, next) {
  const user = userByToken(req);
  if (!user) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = user;
  return next();
}

export function requireAdmin(req, res, next) {
  const user = userByToken(req);
  if (!user) return res.status(401).json({ error: '未登录或登录已过期' });
  if (user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  req.user = user;
  return next();
}

/** 判断账号是否可用（状态、有效期），返回中文错误或 null */
export function accountProblem(user) {
  if (!user) return '账号不存在';
  if (user.status === 'disabled') return '账号已被禁用，请联系管理员';
  if (user.expires_at && user.expires_at < Date.now()) return '账号已过期，请联系管理员续期';
  return null;
}

/**
 * 登录校验。无论账号是否存在都消耗一次哈希校验时间，降低账号枚举风险。
 */
export function login(req, username, password) {
  const settings = getSettings();
  const ip = clientIp(req);
  const key = `${String(username).toLowerCase()}|${ip}`;
  const now = Date.now();
  const attempt = loginAttempts.get(key);

  if (attempt && attempt.lockedUntil > now) {
    const mins = Math.ceil((attempt.lockedUntil - now) / 60000);
    return { error: `登录失败次数过多，请 ${mins} 分钟后再试` };
  }

  const user = query.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', String(username).trim());
  const dummyHash =
    'scrypt$16384$8$1$Y2hlY2tjaGVja2NoZWNr$' +
    'Z6nJ0m4p8oQ0v9r2yQ2m8bWv0V3f6yC1sK9pD2xR4tU8aN5hL7jM3qW1eT6zY0iX4cV8bN2mK5';
  const ok = verifyPassword(String(password), user ? user.password_hash : dummyHash) && !!user;

  if (!ok) {
    const cur = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
    cur.count += 1;
    if (cur.count >= settings.loginMaxAttempts) {
      cur.lockedUntil = now + settings.loginLockMinutes * 60000;
      cur.count = 0;
    }
    loginAttempts.set(key, cur);
    audit('auth.login_failed', { targetUserId: user?.id ?? null, metadata: { username: String(username).slice(0, 64) }, ip });
    return { error: '用户名或密码错误' };
  }

  const problem = accountProblem(user);
  if (problem) {
    audit('auth.login_blocked', { targetUserId: user.id, metadata: { reason: problem }, ip });
    return { error: problem };
  }

  loginAttempts.delete(key);
  query.run('UPDATE users SET last_login_at = ? WHERE id = ?', now, user.id);
  audit('auth.login_success', { targetUserId: user.id, metadata: { role: user.role }, ip });
  return { user };
}
