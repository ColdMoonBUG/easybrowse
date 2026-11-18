/**
 * 短时连接票据：前端拿到的是 TTL 很短的一次性凭证，用它建立画面 WebSocket，
 * 避免把会话 Token 直接放在 URL 上（防止日志/Referer 泄露）。
 */
import { randomToken } from '../util/crypto.js';
import { config } from '../config.js';

const tickets = new Map(); // ticket -> { userId, sessionId, expires }

export function issueTicket(userId, sessionId) {
  const ticket = randomToken(24);
  tickets.set(ticket, { userId, sessionId, expires: Date.now() + config.ticketTtlSeconds * 1000 });
  // 顺手清理过期票据
  for (const [k, v] of tickets) if (v.expires < Date.now()) tickets.delete(k);
  return { ticket, expiresIn: config.ticketTtlSeconds };
}

export function consumeTicket(ticket) {
  const rec = tickets.get(ticket);
  if (!rec) return null;
  if (rec.expires < Date.now()) {
    tickets.delete(ticket);
    return null;
  }
  return rec;
}

/** 会话结束时立即吊销相关票据 */
export function revokeTicketsForSession(sessionId) {
  for (const [k, v] of tickets) if (v.sessionId === sessionId) tickets.delete(k);
}
