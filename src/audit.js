/** 审计日志：管理员操作、登录事件、会话生命周期、配额触发等 */
import { query } from './db.js';
import { logger } from './util/logger.js';

export function audit(action, { actorId = null, targetUserId = null, sessionId = null, metadata = null, ip = null } = {}) {
  const now = Date.now();
  try {
    query.run(
      `INSERT INTO audit_logs (actor_user_id, target_user_id, session_id, action, metadata, created_at, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      actorId,
      targetUserId,
      sessionId,
      action,
      metadata ? JSON.stringify(metadata) : null,
      now,
      ip,
    );
  } catch (err) {
    logger.error('写入审计日志失败', err.message);
  }
}

export function listAuditLogs({ limit = 100, offset = 0, action = null, actorId = null } = {}) {
  const where = [];
  const params = [];
  if (action) {
    where.push('action LIKE ?');
    params.push(`${action}%`);
  }
  if (actorId) {
    where.push('actor_user_id = ?');
    params.push(actorId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = query.all(
    `SELECT a.*, u.username AS actor_name, t.username AS target_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
       LEFT JOIN users t ON t.id = a.target_user_id
       ${clause}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  const total = query.get(`SELECT COUNT(*) AS c FROM audit_logs ${clause}`, ...params).c;
  return { rows, total };
}
