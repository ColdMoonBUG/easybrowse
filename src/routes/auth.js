/** 认证相关接口 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { query, getSetting } from '../db.js';
import {
  clearSessionCookie,
  clientIp,
  createAuthSession,
  destroyAuthSession,
  login,
  parseCookies,
  requireAuth,
  setSessionCookie,
  COOKIE_NAME,
} from '../auth.js';
import { config } from '../config.js';
import { hashPassword, passwordStrengthError, verifyPassword } from '../util/crypto.js';
import { audit } from '../audit.js';

export const authRouter = express.Router();

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    status: u.status,
    maxSessions: u.max_sessions,
    quotaBytes: u.quota_bytes,
    expiresAt: u.expires_at,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  };
}

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });

  const result = login(req, username, password);
  if (result.error) return res.status(401).json({ error: result.error });

  const { token } = createAuthSession(result.user.id, req);
  setSessionCookie(res, token, config.sessionTtlHours);
  return res.json({ user: publicUser(result.user), redirect: result.user.role === 'admin' ? '/admin' : '/' });
});

/* ------------------------------ 自助注册 ------------------------------ */

/**
 * 每个 IP 每小时的注册次数上限。
 * 公网自助注册最容易被人当免费资源刷，加一层简单限流；正常用户远用不到 6 个。
 */
const REGISTER_LIMIT = 6;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const registerHits = new Map(); // ip -> number[]

function allowRegister(ip) {
  const now = Date.now();
  const list = (registerHits.get(ip) || []).filter((t) => now - t < REGISTER_WINDOW_MS);
  if (list.length >= REGISTER_LIMIT) {
    registerHits.set(ip, list);
    return false;
  }
  list.push(now);
  registerHits.set(ip, list);
  // 顺手清理过期 IP，避免 Map 无限增长
  if (registerHits.size > 5000) {
    for (const [k, v] of registerHits) {
      if (!v.some((t) => now - t < REGISTER_WINDOW_MS)) registerHits.delete(k);
    }
  }
  return true;
}

authRouter.post('/register', (req, res) => {
  if (!getSetting('registrationEnabled')) {
    return res.status(403).json({ error: '自助注册已关闭，请联系管理员开通账号' });
  }

  const { username, password } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{1,32}$/.test(name)) {
    return res.status(400).json({ error: '用户名需为 1-32 位字母、数字、下划线、点或短横线' });
  }
  const weak = passwordStrengthError(password);
  if (weak) return res.status(400).json({ error: weak });
  if (!allowRegister(clientIp(req))) {
    return res.status(429).json({ error: '注册过于频繁，请稍后再试' });
  }
  if (query.get('SELECT 1 AS x FROM users WHERE username = ? COLLATE NOCASE', name)) {
    return res.status(409).json({ error: '用户名已被占用，换一个试试' });
  }

  const now = Date.now();
  const id = randomUUID();
  const maxSessions = Math.max(1, Number(getSetting('registerMaxSessions')) || 2);
  // 自助注册的账号统一：流量不限（quota_bytes = 0 表示不限额）、有效期无限（expires_at = NULL）
  query.run(
    `INSERT INTO users (id, username, password_hash, role, status, max_sessions, quota_bytes, expires_at, note, created_at, updated_at)
     VALUES (?, ?, ?, 'user', 'active', ?, 0, NULL, ?, ?, ?)`,
    id,
    name,
    hashPassword(password),
    maxSessions,
    '自助注册',
    now,
    now,
  );
  audit('auth.register', { targetUserId: id, metadata: { username: name, maxSessions }, ip: clientIp(req) });

  const user = query.get('SELECT * FROM users WHERE id = ?', id);
  // 注册完直接登录，省一次手动输入
  const { token } = createAuthSession(user.id, req);
  setSessionCookie(res, token, config.sessionTtlHours);
  return res.status(201).json({ user: publicUser(user), redirect: '/' });
});

authRouter.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  if (token) {
    const row = query.get('SELECT * FROM auth_sessions WHERE token = ?', token);
    destroyAuthSession(token);
    if (row) audit('auth.logout', { targetUserId: row.user_id, ip: clientIp(req) });
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

authRouter.post('/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(String(currentPassword || ''), req.user.password_hash)) {
    return res.status(400).json({ error: '当前密码不正确' });
  }
  const weak = passwordStrengthError(newPassword);
  if (weak) return res.status(400).json({ error: weak });
  query.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(newPassword), Date.now(), req.user.id);
  audit('user.password_changed', { actorId: req.user.id, targetUserId: req.user.id, ip: clientIp(req) });
  return res.json({ ok: true });
});

export { publicUser };
