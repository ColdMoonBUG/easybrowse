/**
 * 远端浏览器音频静音。
 *
 * 背景：每个用户的浏览器进程都跑在宿主机上，网页声音默认从宿主机声卡播出。
 * 也就是说 A 用户在看视频，管理员（以及坐在服务器前的人）就会听到。
 * 平台目前并不回传声音给用户（screencast 只有画面），所以正确做法是全部静音。
 *
 * 两层保障：
 * 1. 新实例在启动参数里带 --mute-audio（进程级静音，最彻底）；
 * 2. 已经在跑的实例无法追加启动参数，于是在 Windows 音频会话层按进程树静音
 *    （scripts/mute-chrome-audio.ps1，走 Core Audio 的 ISimpleAudioVolume）。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, getSettings } from '../db.js';
import { config } from '../config.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'mute-chrome-audio.ps1');
const PS = process.platform === 'win32' ? 'powershell.exe' : null;

let lastRunAt = 0;
let running = false;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 调用 PowerShell 脚本，对给定 pid 的进程树执行静音。
 * @param {number[]} pids
 * @param {{ statusOnly?: boolean, timeout?: number }} [opts]
 * @returns {Promise<{ targets: number, sessions: string[] }>}
 */
export function muteChromePids(pids, { statusOnly = false, timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!PS) return resolve({ targets: 0, sessions: [] });
    const list = [...new Set(pids.filter((n) => Number.isInteger(n) && n > 0))];

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
    ];
    if (list.length) args.push('-RootPids', list.join(','));
    // 兜底识别：即使数据库里没有记录（服务重启前的孤儿进程），只要 user-data-dir
    // 指向平台的 profiles 目录，也一并静音
    args.push('-ProfileRoot', config.profileDir);
    if (statusOnly) args.push('-Status');

    execFile(PS, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const parsed = JSON.parse(String(stdout).trim().split('\n').pop());
        resolve({ targets: parsed.targets || 0, sessions: parsed.sessions || [] });
      } catch {
        resolve({ targets: 0, sessions: [] });
      }
    });
  });
}

/**
 * 把当前所有「未结束且进程还活着」的浏览器会话静音。
 * 孤儿进程（服务重启后没被接管）也在覆盖范围内——它们恰恰是最容易被忽略的声源。
 * @param {string} [reason] 仅用于日志
 */
export async function muteLiveSessions(reason = 'manual') {
  if (!PS) return { muted: 0, sessions: 0 };
  if (getSettings().muteRemoteAudio === false) return { muted: 0, sessions: 0, disabled: true };
  if (running) return { muted: 0, sessions: 0, skipped: true };
  running = true;
  try {
    const rows = query.all(
      `SELECT DISTINCT pid FROM browser_sessions
        WHERE pid IS NOT NULL AND ended_at IS NULL
          AND status IN ('RUNNING','DISCONNECTED','CREATING','IDLE')`,
    );
    const pids = rows.map((r) => Number(r.pid)).filter((pid) => pid && isAlive(pid));

    const { targets, sessions } = await muteChromePids(pids);
    const mutedCount = sessions.filter((s) => s.endsWith(':True')).length;
    lastRunAt = Date.now();
    if (sessions.length) {
      logger.info(`音频静音（${reason}）：${pids.length} 个实例进程树、${sessions.length} 个音频会话，已静音 ${mutedCount}`);
    } else {
      logger.debug?.(`音频静音（${reason}）：${pids.length} 个实例当前没有活跃音频会话`);
    }
    return { muted: mutedCount, sessions: sessions.length, targets };
  } catch (err) {
    logger.warn(`音频静音失败（${reason}）：${err.message}`);
    return { muted: 0, sessions: 0, error: err.message };
  } finally {
    running = false;
  }
}

/** 距上次静音超过 ms 才执行，避免高频调用 */
export async function muteLiveSessionsThrottled(ms = 60_000, reason = 'throttled') {
  if (Date.now() - lastRunAt < ms) return { muted: 0, sessions: 0, skipped: true };
  return muteLiveSessions(reason);
}

/** 查询某个进程树的音频会话静音状态（诊断用） */
export async function audioStatus(pids) {
  return muteChromePids(pids, { statusOnly: true });
}
