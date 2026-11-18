/**
 * SQLite 数据访问层（使用 Node 22 内置 node:sqlite，无需编译原生依赖）。
 * 所有时间字段统一存储为毫秒时间戳（INTEGER）。
 */
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { config } from './config.js';
import { hashPassword } from './util/crypto.js';
import { logger } from './util/logger.js';

export const db = new DatabaseSync(config.dbFile);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  status        TEXT NOT NULL DEFAULT 'active',
  max_sessions  INTEGER NOT NULL DEFAULT 1,
  quota_bytes   INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS browser_sessions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         TEXT NOT NULL,
  instance_id    TEXT,
  pid            INTEGER,
  profile_dir    TEXT,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  last_active_at INTEGER,
  ended_at       INTEGER,
  end_reason     TEXT,
  tx_bytes       INTEGER NOT NULL DEFAULT 0,
  rx_bytes       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_user ON browser_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_created ON browser_sessions(created_at);

CREATE TABLE IF NOT EXISTS traffic_samples (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  user_id    TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  tx_bytes   INTEGER NOT NULL DEFAULT 0,
  rx_bytes   INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'http'
);
CREATE INDEX IF NOT EXISTS idx_traffic_user_ts ON traffic_samples(user_id, ts);

CREATE TABLE IF NOT EXISTS traffic_daily (
  user_id     TEXT NOT NULL,
  date        TEXT NOT NULL,
  tx_bytes    INTEGER NOT NULL DEFAULT 0,
  rx_bytes    INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id  TEXT,
  target_user_id TEXT,
  session_id     TEXT,
  action         TEXT NOT NULL,
  metadata       TEXT,
  created_at     INTEGER NOT NULL,
  ip_address     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id);

-- 旧版本内置过「代理出口」管理，现已改为跟随宿主机系统代理，启动时顺手清掉遗留表
DROP TABLE IF EXISTS proxy_profiles;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

db.exec(SCHEMA);

function toPlain(row) {
  return row ? { ...row } : row;
}

export const query = {
  all(sql, ...params) {
    return db.prepare(sql).all(...params).map(toPlain);
  },
  get(sql, ...params) {
    return toPlain(db.prepare(sql).get(...params));
  },
  run(sql, ...params) {
    return db.prepare(sql).run(...params);
  },
  exec(sql) {
    db.exec(sql);
  },
};

/** ---------- settings ---------- */

export const DEFAULT_SETTINGS = {
  /** 会话空闲多少分钟后断开画面（浏览器进程继续保留，数据不丢） */
  idleTimeoutMinutes: 30,
  /** 会话空闲多少分钟后停止浏览器进程（profile 与全部浏览数据仍保留，下次登录原样恢复） */
  idleStopMinutes: 240,
  /** 单用户默认并发会话数 */
  defaultMaxSessions: 1,
  /** 是否开放自助注册（注册页 /register） */
  registrationEnabled: true,
  /** 自助注册账号的默认并发会话数（流量不限、有效期无限） */
  registerMaxSessions: 2,
  /** 全平台最大并发浏览器实例数 */
  maxConcurrentSessions: 8,
  /**
   * 画面 JPEG 质量。配合 2 倍分辨率，75 已看不出压缩痕迹；
   * 再高只涨流量（实测 90 比 75 多 76% 带宽，肉眼差异极小）。
   * 用户端「画质」三挡（高清 / 均衡 / 省流）会按挡位覆盖这个值。
   */
  screencastQuality: 75,
  /** 画质挡位默认值：high | medium | low（用户可在工作区自行切换，仅对本人会话生效） */
  qualityLevel: 'high',
  /**
   * 允许把页面声音回传给用户（各听各的）。
   * 浏览器在服务器上静音运行，页面音频由注入钩子采集成 PCM，
   * 只沿该用户自己的连接送回他的浏览器播放，服务器与管理员这边始终无声。
   * 关闭后前端不显示声音按钮，服务端也拒绝开启。
   */
  remoteAudioEnabled: true,
  /** 远端浏览器视口（CSS 像素） */
  viewportWidth: 1280,
  viewportHeight: 800,
  /**
   * 渲染倍率（原画档）。2 = 按 2 倍物理像素渲染推流，文字锐利；
   * 1 = 省流量但会发虚。改这里只对新启动的浏览器生效（进程级参数）。
   */
  renderScale: 2,
  /** 是否以 headless 模式运行远端浏览器 */
  headless: true,
  /**
   * 远端浏览器在宿主机静音。
   * 打开浏览器跑在服务器上，声音默认从服务器声卡播出——任何一个用户播放视频，
   * 管理员这边都会听到。开启后一律静音（平台目前也不回传声音给用户）。
   * 只对新启动的实例生效；已在跑的实例由启动时的静音任务兜底。
   */
  muteRemoteAudio: true,
  /** 是否允许用户下载文件到自己的下载目录 */
  allowDownloads: true,
  /** 登录失败最大次数与锁定分钟数 */
  loginMaxAttempts: 8,
  loginLockMinutes: 15,
  /** 会话创建时是否自动打开起始页 */
  homePage: 'https://www.bing.com',
  /** 平台对外站点名称 */
  siteName: 'EasyBrowse 远程浏览器',
  /** 隐私告知文案 */
  privacyNotice:
    '系统会记录登录时间、会话创建与结束、流量字节数等安全元数据，用于账号安全与用量统计。不会解密 HTTPS 内容、不保存网页正文、表单内容或密码。',
};

export function getSetting(key, fallback) {
  const row = query.get('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return key in DEFAULT_SETTINGS ? DEFAULT_SETTINGS[key] : fallback;
  const raw = row.value;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of query.all('SELECT key, value FROM settings')) {
    if (!(row.key in DEFAULT_SETTINGS)) continue;
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

export function setSetting(key, value) {
  const raw = JSON.stringify(value);
  query.run(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    raw,
  );
}

/** ---------- 初始化 ---------- */

export function seed() {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    const row = query.get('SELECT 1 AS x FROM settings WHERE key = ?', k);
    if (!row) setSetting(k, v);
  }

  const admin = query.get("SELECT * FROM users WHERE role = 'admin' LIMIT 1");
  if (!admin) {
    const password = config.initialAdminPassword || crypto.randomBytes(9).toString('base64url');
    const now = Date.now();
    query.run(
      `INSERT INTO users (id, username, password_hash, role, status, max_sessions, quota_bytes, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', 'active', 2, 0, ?, ?)`,
      crypto.randomUUID(),
      'admin',
      hashPassword(password),
      now,
      now,
    );
    logger.warn('已创建初始管理员账号：admin');
    if (!config.initialAdminPassword) {
      logger.warn(`初始管理员密码（仅本次显示，请立即登录后修改）：${password}`);
    }
    query.run(
      `INSERT INTO audit_logs (actor_user_id, action, metadata, created_at)
       VALUES (NULL, 'system.bootstrap', ?, ?)`,
      JSON.stringify({ note: '初始化管理员账号' }),
      now,
    );
  }
}
