/** 管理后台接口：用户 / 会话 / 流量 / 审计 / 系统配置 / 浏览数据 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { query, getSettings, setSetting, DEFAULT_SETTINGS } from '../db.js';
import { requireAdmin, clientIp } from '../auth.js';
import { manager, userUsedBytes } from '../browser/manager.js';
import { hashPassword, generatePassword, passwordStrengthError } from '../util/crypto.js';
import { audit, listAuditLogs } from '../audit.js';
import { logger } from '../util/logger.js';

export const adminRouter = express.Router();
adminRouter.use(requireAdmin);

const toInt = (v, d = 0) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

function userView(u) {
  const inst = manager.getInstance(u.id);
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    status: u.status,
    maxSessions: u.max_sessions,
    quotaBytes: u.quota_bytes,
    usedBytes: userUsedBytes(u.id),
    expiresAt: u.expires_at,
    note: u.note,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
    lastLoginAt: u.last_login_at,
    online: !!inst,
    sessionStatus: inst ? inst.status : null,
  };
}

/* ------------------------------ 仪表盘 ------------------------------ */

adminRouter.get('/dashboard', (req, res) => {
  const settings = getSettings();
  const now = Date.now();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const todayRow = query.get('SELECT COALESCE(SUM(total_bytes),0) AS t FROM traffic_daily WHERE date = ?', todayStr());
  const totalRow = query.get('SELECT COALESCE(SUM(total_bytes),0) AS t FROM traffic_daily');
  const usersCount = query.get('SELECT COUNT(*) AS c FROM users').c;
  const activeSessions = query.get(
    `SELECT COUNT(*) AS c FROM browser_sessions WHERE status IN ('RUNNING','DISCONNECTED','CREATING','IDLE')`,
  ).c;
  const liveSessions = query.all(
    `SELECT s.*, u.username FROM browser_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.status IN ('RUNNING','DISCONNECTED','CREATING','IDLE') ORDER BY s.created_at DESC LIMIT 20`,
  );
  let disk = null;
  try {
    const st = fs.statfsSync(process.cwd());
    disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch {
    /* 某些平台不支持 */
  }

  res.json({
    onlineUsers: manager.countActive(),
    activeSessions,
    totalUsers: usersCount,
    todayBytes: todayRow?.t || 0,
    totalBytes: totalRow?.t || 0,
    host: {
      cpuCount: os.cpus().length,
      loadAvg: os.loadavg(),
      memTotal: os.totalmem(),
      memFree: os.freemem(),
      uptime: os.uptime(),
      platform: `${os.type()} ${os.release()}`,
      disk,
      nodeVersion: process.version,
    },
    limits: {
      maxConcurrentSessions: settings.maxConcurrentSessions,
      chromeConfigured: !!settingChromePath(),
    },
    sessions: liveSessions.map((s) => ({
      id: s.id,
      userId: s.user_id,
      username: s.username,
      status: s.status,
      createdAt: s.created_at,
      lastActiveAt: s.last_active_at,
      txBytes: s.tx_bytes,
      rxBytes: s.rx_bytes,
      pid: s.pid,
    })),
    recentAudit: listAuditLogs({ limit: 12 }).rows,
    serverTime: now,
  });
});

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function settingChromePath() {
  return process.env.CHROME_PATH || null;
}

/* ------------------------------ 用户管理 ------------------------------ */

adminRouter.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = q
    ? query.all('SELECT * FROM users WHERE username LIKE ? ORDER BY created_at DESC', `%${q}%`)
    : query.all('SELECT * FROM users ORDER BY created_at DESC');
  res.json({ users: rows.map(userView) });
});

adminRouter.post('/users', (req, res) => {
  const { username, password, role = 'user', maxSessions, quotaBytes, expiresAt, note } = req.body || {};
  const name = String(username || '').trim();
  // 用户名 1-32 位即可（a 这种单字符也允许）；留字符白名单是为了避免空格/引号带来的边界问题
  if (!/^[a-zA-Z0-9_.-]{1,32}$/.test(name)) {
    return res.status(400).json({ error: '用户名需为 1-32 位字母、数字、下划线、点或短横线' });
  }
  if (query.get('SELECT 1 AS x FROM users WHERE username = ? COLLATE NOCASE', name)) {
    return res.status(409).json({ error: '用户名已存在' });
  }
  const pwd = password || generatePassword();
  const weak = passwordStrengthError(pwd);
  if (weak) return res.status(400).json({ error: weak });

  const now = Date.now();
  const id = randomUUID();
  query.run(
    `INSERT INTO users (id, username, password_hash, role, status, max_sessions, quota_bytes, expires_at, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    id,
    name,
    hashPassword(pwd),
    role === 'admin' ? 'admin' : 'user',
    Math.max(1, toInt(maxSessions, getSettings().defaultMaxSessions)),
    Math.max(0, toInt(quotaBytes, 0)),
    expiresAt ? toInt(expiresAt, 0) || null : null,
    note ? String(note).slice(0, 200) : null,
    now,
    now,
  );
  audit('admin.user_created', {
    actorId: req.user.id,
    targetUserId: id,
    metadata: { username: name, role, quotaBytes: toInt(quotaBytes, 0) },
    ip: clientIp(req),
  });
  const row = query.get('SELECT * FROM users WHERE id = ?', id);
  res.status(201).json({ user: userView(row), initialPassword: password ? undefined : pwd });
});

adminRouter.patch('/users/:id', (req, res) => {
  const target = query.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  const b = req.body || {};
  const fields = [];
  const params = [];
  if (b.status && ['active', 'disabled'].includes(b.status)) {
    fields.push('status = ?');
    params.push(b.status);
  }
  if (b.role && ['user', 'admin'].includes(b.role)) {
    fields.push('role = ?');
    params.push(b.role);
  }
  if (b.maxSessions !== undefined) {
    fields.push('max_sessions = ?');
    params.push(Math.max(1, toInt(b.maxSessions, 1)));
  }
  if (b.quotaBytes !== undefined) {
    fields.push('quota_bytes = ?');
    params.push(Math.max(0, toInt(b.quotaBytes, 0)));
  }
  if (b.expiresAt !== undefined) {
    fields.push('expires_at = ?');
    params.push(b.expiresAt ? toInt(b.expiresAt, 0) || null : null);
  }
  if (b.note !== undefined) {
    fields.push('note = ?');
    params.push(String(b.note).slice(0, 200));
  }
  if (!fields.length) return res.status(400).json({ error: '没有需要修改的字段' });
  fields.push('updated_at = ?');
  params.push(Date.now(), target.id);
  query.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...params);

  // 禁用账号时立即结束其浏览器会话
  if (b.status === 'disabled' && manager.getInstance(target.id)) {
    manager.stopForUser(target.id, 'account_disabled', { actorId: req.user.id, ip: clientIp(req) }).catch(() => {});
  }
  audit('admin.user_updated', {
    actorId: req.user.id,
    targetUserId: target.id,
    metadata: { changes: b, username: target.username },
    ip: clientIp(req),
  });
  res.json({ user: userView(query.get('SELECT * FROM users WHERE id = ?', target.id)) });
});

adminRouter.post('/users/:id/reset-password', (req, res) => {
  const target = query.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  const pwd = req.body?.password || generatePassword();
  const weak = passwordStrengthError(pwd);
  if (weak) return res.status(400).json({ error: weak });
  query.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(pwd), Date.now(), target.id);
  audit('admin.password_reset', { actorId: req.user.id, targetUserId: target.id, ip: clientIp(req) });
  res.json({ ok: true, password: pwd });
});

adminRouter.delete('/users/:id', async (req, res, next) => {
  try {
    const target = query.get('SELECT * FROM users WHERE id = ?', req.params.id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (target.id === req.user.id) return res.status(400).json({ error: '不能删除当前登录的管理员账号' });
    if (manager.getInstance(target.id)) {
      await manager.stopForUser(target.id, 'account_deleted', { actorId: req.user.id, ip: clientIp(req) });
    }
    const hard = req.query.hard === '1';
    if (hard) {
      query.run('DELETE FROM users WHERE id = ?', target.id);
    } else {
      query.run("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?", Date.now(), target.id);
    }
    audit('admin.user_deleted', {
      actorId: req.user.id,
      targetUserId: target.id,
      metadata: { username: target.username, hardDelete: hard },
      ip: clientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ 会话管理 ------------------------------ */

adminRouter.get('/sessions', (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const userId = req.query.userId ? String(req.query.userId) : null;
  const limit = Math.min(200, toInt(req.query.limit, 50));
  const where = [];
  const params = [];
  if (status === 'active') {
    where.push("s.status IN ('CREATING','RUNNING','DISCONNECTED','IDLE')");
  } else if (status) {
    where.push('s.status = ?');
    params.push(status);
  }
  if (userId) {
    where.push('s.user_id = ?');
    params.push(userId);
  }
  const rows = query.all(
    `SELECT s.*, u.username FROM browser_sessions s JOIN users u ON u.id = s.user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY s.created_at DESC LIMIT ?`,
    ...params,
    limit,
  );
  res.json({
    sessions: rows.map((s) => ({
      id: s.id,
      userId: s.user_id,
      username: s.username,
      status: s.status,
      pid: s.pid,
      createdAt: s.created_at,
      startedAt: s.started_at,
      lastActiveAt: s.last_active_at,
      endedAt: s.ended_at,
      endReason: s.end_reason,
      txBytes: s.tx_bytes,
      rxBytes: s.rx_bytes,
      live: !!manager.getInstance(s.user_id),
    })),
  });
});

/** 管理员强制结束任意会话 */
adminRouter.delete('/sessions/:id', async (req, res, next) => {
  try {
    const row = query.get('SELECT * FROM browser_sessions WHERE id = ?', req.params.id);
    if (!row) return res.status(404).json({ error: '会话不存在' });
    await manager.stopForUser(row.user_id, 'admin_forced', {
      actorId: req.user.id,
      status: 'STOPPED',
      ip: clientIp(req),
    });
    audit('admin.session_forced_stop', {
      actorId: req.user.id,
      targetUserId: row.user_id,
      sessionId: row.id,
      ip: clientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ 流量统计 ------------------------------ */

adminRouter.get('/traffic', (req, res) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  const userId = req.query.userId ? String(req.query.userId) : null;
  const where = [];
  const params = [];
  if (from) {
    where.push('d.date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('d.date <= ?');
    params.push(to);
  }
  if (userId) {
    where.push('d.user_id = ?');
    params.push(userId);
  }
  const rows = query.all(
    `SELECT d.*, u.username FROM traffic_daily d JOIN users u ON u.id = d.user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY d.date DESC, d.total_bytes DESC LIMIT 500`,
    ...params,
  );
  const totals = rows.reduce(
    (acc, r) => ({ tx: acc.tx + r.tx_bytes, rx: acc.rx + r.rx_bytes, total: acc.total + r.total_bytes }),
    { tx: 0, rx: 0, total: 0 },
  );

  if (req.query.format === 'csv') {
    const lines = ['用户名,日期,上行字节,下行字节,总字节'];
    for (const r of rows) lines.push([r.username, r.date, r.tx_bytes, r.rx_bytes, r.total_bytes].join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="traffic-${todayStr()}.csv"`);
    return res.send('\uFEFF' + lines.join('\r\n'));
  }
  return res.json({ rows, totals });
});

/* ------------------------------ 审计日志 ------------------------------ */

adminRouter.get('/audit-logs', (req, res) => {
  const { rows, total } = listAuditLogs({
    limit: Math.min(500, toInt(req.query.limit, 100)),
    offset: Math.max(0, toInt(req.query.offset, 0)),
    action: req.query.action ? String(req.query.action) : null,
    actorId: req.query.actorId ? String(req.query.actorId) : null,
  });
  res.json({ logs: rows, total });
});

/* ------------------------------ 系统配置 ------------------------------ */

adminRouter.get('/settings', (req, res) => {
  res.json({ settings: getSettings(), defaults: DEFAULT_SETTINGS, chromePath: process.env.CHROME_PATH || null });
});

adminRouter.patch('/settings', (req, res) => {
  const body = req.body || {};
  const changed = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in body)) continue;
    let value = body[key];
    const def = DEFAULT_SETTINGS[key];
    if (typeof def === 'number') {
      value = Number(value);
      if (!Number.isFinite(value)) return res.status(400).json({ error: `${key} 必须是数字` });
      value = Math.max(0, value);
    } else if (typeof def === 'boolean') {
      value = !!value;
    } else {
      value = String(value).slice(0, 500);
    }
    setSetting(key, value);
    changed[key] = value;
  }
  if (!Object.keys(changed).length) return res.status(400).json({ error: '没有需要修改的配置项' });
  audit('admin.settings_updated', { actorId: req.user.id, metadata: changed, ip: clientIp(req) });
  res.json({ settings: getSettings() });
});


/* ------------------------------ 用户浏览数据（profile） ------------------------------ */

adminRouter.get('/profiles', (req, res) => {
  const users = query.all('SELECT id, username, status FROM users ORDER BY username');
  const usage = manager.listProfileUsage(users);
  res.json({ profiles: usage, totalBytes: usage.reduce((a, b) => a + b.bytes, 0) });
});

adminRouter.post('/profiles/:userId/purge', async (req, res, next) => {
  try {
    const user = query.get('SELECT * FROM users WHERE id = ?', req.params.userId);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    await manager.purgeProfile(user.id, req.user.id, clientIp(req));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

