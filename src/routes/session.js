/** 普通用户会话接口：创建 / 恢复 / 查询 / 结束自己的浏览器会话 */
import express from 'express';
import { query, getSettings } from '../db.js';
import { requireAuth, clientIp } from '../auth.js';
import { manager, userUsedBytes } from '../browser/manager.js';
import { issueTicket, revokeTicketsForSession } from '../ws/tickets.js';
import { audit } from '../audit.js';
import { config } from '../config.js';

export const sessionRouter = express.Router();
sessionRouter.use(requireAuth);

function sessionView(row, instance) {
  if (!row) return null;
  return {
    id: row.id,
    status: instance && instance.status === 'RUNNING' ? row.status === 'DISCONNECTED' ? 'DISCONNECTED' : 'RUNNING' : row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    txBytes: row.tx_bytes,
    rxBytes: row.rx_bytes,
    live: !!instance,
  };
}

/** 创建或恢复当前用户的浏览器会话 */
sessionRouter.post('/', async (req, res, next) => {
  try {
    const user = req.user;
    const { instance, sessionId, restored } = await manager.startForUser(user, { ip: clientIp(req) });
    const row = query.get('SELECT * FROM browser_sessions WHERE id = ?', sessionId);
    const { ticket, expiresIn } = issueTicket(user.id, sessionId);
    return res.json({
      session: sessionView(row, instance),
      restored,
      ticket,
      ticketExpiresIn: expiresIn,
      viewport: {
        w: instance.settings.viewportWidth,
        h: instance.settings.viewportHeight,
        scale: instance.renderScale,
      },
      egress: config.chromeProxy || 'system',
    });
  } catch (err) {
    return next(err);
  }
});

/** 当前会话状态（页面刷新后用它决定直接恢复画面还是重新创建） */
sessionRouter.get('/current', (req, res) => {
  const instance = manager.getInstance(req.user.id);
  const row = instance
    ? query.get('SELECT * FROM browser_sessions WHERE id = ?', instance.id)
    : manager.currentSessionRow(req.user.id);
  const settings = getSettings();
  res.json({
    session: sessionView(row, instance),
    egress: config.chromeProxy || 'system',
    settings: {
      idleTimeoutMinutes: settings.idleTimeoutMinutes,
      allowDownloads: settings.allowDownloads,
      homePage: settings.homePage,
    },
  });
});

/** 为已存在的会话换取新的短时连接票据（断线重连用） */
sessionRouter.post('/:id/ticket', (req, res) => {
  const instance = manager.getInstance(req.user.id);
  if (!instance || instance.id !== req.params.id) {
    return res.status(404).json({ error: '会话不存在或不属于当前用户' });
  }
  const { ticket, expiresIn } = issueTicket(req.user.id, instance.id);
  return res.json({ ticket, ticketExpiresIn: expiresIn, viewport: { w: instance.settings.viewportWidth, h: instance.settings.viewportHeight } });
});

/** 结束自己的会话（后端强制校验所有权） */
sessionRouter.delete('/:id', async (req, res, next) => {
  try {
    const instance = manager.getInstance(req.user.id);
    if (!instance || instance.id !== req.params.id) {
      return res.status(404).json({ error: '会话不存在或不属于当前用户' });
    }
    revokeTicketsForSession(instance.id);
    await manager.stopForUser(req.user.id, 'user_closed', { actorId: req.user.id, status: 'STOPPED', ip: clientIp(req) });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

/** 我的用量 */
sessionRouter.get('/usage', (req, res) => {
  const used = userUsedBytes(req.user.id);
  const todayRow = query.get(
    `SELECT * FROM traffic_daily WHERE user_id = ? AND date = ?`,
    req.user.id,
    new Date().toISOString().slice(0, 10),
  );
  const recent = query.all(
    `SELECT id, status, created_at, ended_at, tx_bytes, rx_bytes, end_reason
       FROM browser_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
    req.user.id,
  );
  const profileBytes = manager.getInstance(req.user.id)?.profileSizeBytes() ?? null;
  res.json({
    quotaBytes: req.user.quota_bytes,
    usedBytes: used,
    today: todayRow ? { tx: todayRow.tx_bytes, rx: todayRow.rx_bytes, total: todayRow.total_bytes } : { tx: 0, rx: 0, total: 0 },
    sessions: recent,
    profileBytes,
  });
});
