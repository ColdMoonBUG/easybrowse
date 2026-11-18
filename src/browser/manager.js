/**
 * 浏览器实例编排：按用户创建 / 复用 / 停止实例，落库会话状态，统计流量，空闲回收。
 *
 * 会话策略说明（与产品需求第 4.3 节对应）：
 * - 每个用户在同一时间只有一个浏览器实例（默认并发 1，可被管理员调大但 MVP 按 1 实现）。
 * - 用户断开或退出时只停止“画面连接”，浏览器进程是否停止由 idleStopMinutes 决定；
 *   无论进程是否停止，profile 目录（全部浏览数据）都会保留，下次登录自动恢复。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserInstance, dirSize } from './session.js';
import { query, getSettings } from '../db.js';
import { config } from '../config.js';
import { audit } from '../audit.js';
import { muteChromePids } from '../util/mute-audio.js';
import { logger } from '../util/logger.js';

const ACTIVE_STATUSES = ['CREATING', 'RUNNING', 'DISCONNECTED', 'IDLE'];

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 用户累计已用流量（字节） */
export function userUsedBytes(userId) {
  const row = query.get('SELECT COALESCE(SUM(total_bytes), 0) AS s FROM traffic_daily WHERE user_id = ?', userId);
  return row?.s || 0;
}

class BrowserManager {
  constructor() {
    this.instances = new Map(); // userId -> BrowserInstance
    this.dbSessionIds = new Map(); // userId -> browser_sessions.id
    this.lastActive = new Map(); // userId -> ts
    this.timers = [];
  }

  profileDirFor(userId) {
    return path.join(config.profileDir, userId);
  }

  getInstance(userId) {
    return this.instances.get(userId) || null;
  }

  touch(userId) {
    this.lastActive.set(userId, Date.now());
    const sid = this.dbSessionIds.get(userId);
    if (sid) query.run('UPDATE browser_sessions SET last_active_at = ? WHERE id = ?', Date.now(), sid);
  }

  countActive() {
    return this.instances.size;
  }

  /** 当前库里记录的该用户活跃会话 */
  currentSessionRow(userId) {
    return query.get(
      `SELECT * FROM browser_sessions WHERE user_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
       ORDER BY created_at DESC LIMIT 1`,
      userId,
      ...ACTIVE_STATUSES,
    );
  }

  async startForUser(user, { ip = null } = {}) {
    const settings = getSettings();
    const existing = this.instances.get(user.id);
    if (existing && existing.status === 'RUNNING') {
      return { instance: existing, sessionId: this.dbSessionIds.get(user.id), restored: true };
    }

    // 并发上限
    if (this.instances.size >= settings.maxConcurrentSessions) {
      const err = new Error('平台并发会话已满，请稍后重试');
      err.statusCode = 503;
      throw err;
    }
    // 流量配额
    if (user.quota_bytes > 0 && userUsedBytes(user.id) >= user.quota_bytes) {
      audit('quota.exceeded', { targetUserId: user.id, metadata: { quota: user.quota_bytes }, ip });
      const err = new Error('本月流量额度已用尽，请联系管理员调整配额');
      err.statusCode = 403;
      throw err;
    }
    const sessionId = randomUUID();
    const now = Date.now();
    query.run(
      `INSERT INTO browser_sessions (id, user_id, status, profile_dir, created_at, started_at, last_active_at)
       VALUES (?, ?, 'CREATING', ?, ?, ?, ?)`,
      sessionId,
      user.id,
      this.profileDirFor(user.id),
      now,
      now,
      now,
    );
    audit('session.creating', { actorId: user.id, targetUserId: user.id, sessionId, ip });

    const instance = new BrowserInstance({
      id: sessionId,
      userId: user.id,
      profileDir: this.profileDirFor(user.id),
      chromePath: config.chromePath,
      settings: { ...settings },
      // 不指定出口 → Chrome 跟随宿主机系统代理
      proxy: config.chromeProxy || null,
    });

    try {
      await instance.start();
    } catch (err) {
      instance.stop().catch(() => {});
      this.instances.delete(user.id);
      query.run(
        `UPDATE browser_sessions SET status = 'ERROR', ended_at = ?, end_reason = ? WHERE id = ?`,
        Date.now(),
        `启动失败：${err.message}`.slice(0, 300),
        sessionId,
      );
      audit('session.create_failed', { targetUserId: user.id, sessionId, metadata: { error: err.message }, ip });
      const e = new Error(`浏览器启动失败：${err.message}`);
      e.statusCode = 500;
      throw e;
    }

    this.instances.set(user.id, instance);
    this.dbSessionIds.set(user.id, sessionId);
    this.lastActive.set(user.id, Date.now());

    // 双保险：--mute-audio 是进程级静音，这里再从 Windows 音频会话层把它的进程树静音一次，
    // 保证宿主机音箱绝不会替别人放声音。异步执行，不拖慢启动。
    if (settings.muteRemoteAudio !== false && instance.proc?.pid) {
      const pid = instance.proc.pid;
      setTimeout(() => muteChromePids([pid]).catch(() => {}), 1500);
    }

    // 首次启动（或用户只剩空白新标签页）时打开配置的首页
    try {
      const tabs = instance.getTabs();
      const onlyBlank = tabs.length === 1 && /^(about:blank|chrome:\/\/newtab\/?)$/.test(tabs[0].url || '');
      if (onlyBlank && settings.homePage) await instance.navigate(settings.homePage).catch(() => {});
    } catch {
      /* 首页打开失败不影响会话可用 */
    }

    query.run(
      `UPDATE browser_sessions SET status = 'RUNNING', pid = ?, instance_id = ?, started_at = ? WHERE id = ?`,
      instance.proc?.pid ?? null,
      instance.id,
      Date.now(),
      sessionId,
    );
    audit('session.created', {
      targetUserId: user.id,
      sessionId,
      metadata: { pid: instance.proc?.pid },
      ip,
    });

    instance.on('crashed', ({ code }) => {
      this.#finalize(user.id, 'ERROR', `浏览器异常退出（code=${code}）`);
    });
    instance.on('nav', () => this.touch(user.id));

    return { instance, sessionId, restored: false };
  }

  markDisconnected(userId) {
    const sid = this.dbSessionIds.get(userId);
    const inst = this.instances.get(userId);
    if (!sid || !inst || inst.status !== 'RUNNING') return;
    query.run("UPDATE browser_sessions SET status = 'DISCONNECTED' WHERE id = ?", sid);
  }

  markRunning(userId) {
    const sid = this.dbSessionIds.get(userId);
    if (!sid) return;
    query.run("UPDATE browser_sessions SET status = 'RUNNING', last_active_at = ? WHERE id = ?", Date.now(), sid);
  }

  #finalize(userId, status, reason) {
    try {
      this.#flushTraffic(userId, true);
    } catch {
      /* ignore */
    }
    const sid = this.dbSessionIds.get(userId);
    this.dbSessionIds.delete(userId);
    this.lastActive.delete(userId);
    this.instances.delete(userId);
    if (!sid) return;
    query.run(
      `UPDATE browser_sessions SET status = ?, ended_at = ?, end_reason = ? WHERE id = ?`,
      status,
      Date.now(),
      reason,
      sid,
    );
  }

  /** 停止某用户浏览器进程（profile 目录保留） */
  async stopForUser(userId, reason = 'user_closed', { actorId = null, status = 'STOPPED', ip = null } = {}) {
    const instance = this.instances.get(userId);
    const sid = this.dbSessionIds.get(userId);
    if (!instance) {
      // 进程可能已经停止，仅收敛数据库状态
      query.run(
        `UPDATE browser_sessions SET status = 'STOPPED', ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, ?)
          WHERE user_id = ? AND status IN ('CREATING','RUNNING','DISCONNECTED','IDLE')`,
        Date.now(),
        reason,
        userId,
      );
      const row = query.get('SELECT * FROM browser_sessions WHERE id = ?', sid || '');
      return row || null;
    }

    const traffic = instance.drainTraffic();
    this.#recordTraffic(userId, sid, traffic, 'flush');
    await instance.stop().catch(() => {});
    this.instances.delete(userId);
    this.dbSessionIds.delete(userId);
    this.lastActive.delete(userId);

    query.run(
      `UPDATE browser_sessions SET status = ?, ended_at = ?, end_reason = ? WHERE id = ?`,
      status,
      Date.now(),
      reason,
      sid,
    );
    audit(status === 'ERROR' ? 'session.error' : 'session.stopped', {
      actorId,
      targetUserId: userId,
      sessionId: sid,
      metadata: { reason },
      ip,
    });
    return query.get('SELECT * FROM browser_sessions WHERE id = ?', sid);
  }

  /** 后台释放进程但仍保留会话记录为 IDLE，用户可一键恢复 */
  async suspendForUser(userId, reason = 'idle_timeout') {
    const instance = this.instances.get(userId);
    if (!instance) return;
    await this.stopForUser(userId, reason, { status: 'STOPPED' });
  }

  #recordTraffic(userId, sessionId, traffic, source) {
    if (!traffic || (traffic.tx === 0 && traffic.rx === 0)) return;
    const now = Date.now();
    query.run(
      `INSERT INTO traffic_samples (session_id, user_id, ts, tx_bytes, rx_bytes, source) VALUES (?, ?, ?, ?, ?, ?)`,
      sessionId,
      userId,
      now,
      traffic.tx,
      traffic.rx,
      source,
    );
    query.run(
      `INSERT INTO traffic_daily (user_id, date, tx_bytes, rx_bytes, total_bytes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET
         tx_bytes = tx_bytes + excluded.tx_bytes,
         rx_bytes = rx_bytes + excluded.rx_bytes,
         total_bytes = total_bytes + excluded.total_bytes`,
      userId,
      today(),
      traffic.tx,
      traffic.rx,
      traffic.tx + traffic.rx,
    );
    if (sessionId) {
      query.run('UPDATE browser_sessions SET tx_bytes = tx_bytes + ?, rx_bytes = rx_bytes + ? WHERE id = ?', traffic.tx, traffic.rx, sessionId);
    }
  }

  #flushTraffic(userId, force = false) {
    const instance = this.instances.get(userId);
    if (!instance) return;
    const traffic = instance.drainTraffic();
    if (!force && traffic.tx + traffic.rx === 0) return;
    this.#recordTraffic(userId, this.dbSessionIds.get(userId), traffic, 'flush');
  }

  /** 周期性任务：流量落库 + 空闲回收 */
  startTimers() {
    const trafficTimer = setInterval(() => {
      for (const userId of this.instances.keys()) {
        try {
          this.#flushTraffic(userId);
        } catch (err) {
          logger.error('流量落库失败', err.message);
        }
      }
    }, 15000);

    const idleTimer = setInterval(() => {
      const settings = getSettings();
      const now = Date.now();
      for (const [userId, instance] of this.instances) {
        if (instance.status !== 'RUNNING') continue;
        const last = this.lastActive.get(userId) || instance.startedAt || now;
        const idleMinutes = (now - last) / 60000;
        if (idleMinutes >= (settings.idleStopMinutes || Infinity)) {
          logger.info(`用户 ${userId} 空闲 ${Math.round(idleMinutes)} 分钟，停止浏览器进程（数据保留）`);
          this.stopForUser(userId, 'idle_stop', { status: 'STOPPED' }).catch(() => {});
        } else if (idleMinutes >= (settings.idleTimeoutMinutes || Infinity) && instance.streaming) {
          instance.setStreaming(false).catch(() => {});
          this.markDisconnected(userId);
        }
      }
    }, 30000);

    this.timers.push(trafficTimer, idleTimer);
  }

  stopTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** 服务启动时收敛上一轮残留状态，并尝试清理孤儿浏览器进程 */
  async recoverOnBoot() {
    const stale = query.all(
      `SELECT * FROM browser_sessions WHERE status IN ('CREATING','RUNNING','DISCONNECTED','IDLE')`,
    );
    for (const row of stale) {
      if (row.pid) {
        try {
          process.kill(row.pid, 0);
          if (process.platform === 'win32') {
            const { execFile } = await import('node:child_process');
            execFile('taskkill', ['/PID', String(row.pid), '/T', '/F'], { windowsHide: true }, () => {});
          } else {
            process.kill(row.pid, 'SIGKILL');
          }
        } catch {
          /* 进程已不存在 */
        }
      }
      query.run(
        `UPDATE browser_sessions SET status = 'STOPPED', ended_at = ?, end_reason = ?
          WHERE id = ? AND status IN ('CREATING','RUNNING','DISCONNECTED','IDLE')`,
        Date.now(),
        'service_restart',
        row.id,
      );
    }
    if (stale.length) logger.info(`已收敛 ${stale.length} 个上一次运行遗留的会话状态`);
  }

  async shutdownAll() {
    const ids = [...this.instances.keys()];
    await Promise.all(
      ids.map((id) => this.stopForUser(id, 'service_shutdown', { status: 'STOPPED' }).catch(() => {})),
    );
  }

  /* ---------------- profile（用户浏览数据）管理 ---------------- */

  listProfileUsage(users) {
    return users.map((u) => {
      const dir = this.profileDirFor(u.id);
      return {
        userId: u.id,
        username: u.username,
        profileDir: dir,
        exists: fs.existsSync(dir),
        bytes: fs.existsSync(dir) ? dirSize(dir) : 0,
        running: this.instances.has(u.id),
      };
    });
  }

  async purgeProfile(userId, actorId, ip = null) {
    if (this.instances.has(userId)) {
      await this.stopForUser(userId, 'profile_purged', { actorId, ip });
    }
    const dir = this.profileDirFor(userId);
    if (fs.existsSync(dir)) {
      // Windows 上 Chrome 刚退出时文件句柄可能还没释放，rmSync 会 EPERM；
      // 带重试地删，避免「点了清理但目录还在」。
      let lastErr = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (err.code === 'ENOENT') {
            lastErr = null;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
      if (lastErr) {
        const e = new Error('浏览数据目录仍被浏览器占用，请等进程完全退出后再重试');
        e.statusCode = 409;
        throw e;
      }
    }
    audit('profile.purged', { actorId, targetUserId: userId, metadata: { dir }, ip });
  }
}

export const manager = new BrowserManager();
