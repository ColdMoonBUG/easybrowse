/**
 * frpc 客户端托管（可选）。
 *
 * 为什么放在服务里：本平台对外完全依赖 frp 映射，frpc 一挂公网就断。
 * 把 frpc 作为本进程的子进程托管后，服务由计划任务开机自启时 frpc 会一起起来，
 * 服务停止时也会一起收掉，不会出现「网页在跑、隧道没了」的割裂状态。
 *
 * 未配置 FRPC_CONFIG 时完全不介入，行为与之前一致（自己起 frpc）。
 * 启动前会检测已有的 frpc 进程，避免和手动启动的实例抢同一个 remotePort。
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

let child = null;
let stopping = false;
let restartTimer = null;
let restarts = 0;
const MAX_RESTARTS = 5;

function tasklistHasFrpc() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('tasklist', ['/FI', 'IMAGENAME eq frpc.exe', '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(/frpc\.exe/i.test(stdout || ''));
    });
  });
}

function logLine(line) {
  const text = line.trim();
  if (!text) return;
  // 只把关键行写进平台日志，避免 frp 的流量日志刷屏
  if (/\b(error|warn|\[E\]|\[W\])/i.test(text) || /start proxy success|proxy added|login to server/i.test(text)) {
    logger.info(`[frpc] ${text}`);
  }
}

export async function startFrpc() {
  const cfgPath = config.frpcConfig;
  if (!cfgPath) return { enabled: false, reason: 'not_configured' };
  if (!fs.existsSync(cfgPath)) {
    logger.warn(`frpc 配置不存在，跳过托管：${cfgPath}`);
    return { enabled: false, reason: 'missing_config' };
  }
  if (child) return { enabled: true, reason: 'already_managed' };

  const dir = path.dirname(cfgPath);
  const exe = path.join(dir, process.platform === 'win32' ? 'frpc.exe' : 'frpc');
  if (!fs.existsSync(exe)) {
    logger.warn(`找不到 frpc 可执行文件，跳过托管：${exe}`);
    return { enabled: false, reason: 'missing_binary' };
  }

  if (await tasklistHasFrpc()) {
    logger.info('检测到已在运行的 frpc 进程，交给它自己管理（不重复启动）');
    return { enabled: false, reason: 'external_process' };
  }

  stopping = false;
  const proc = spawn(exe, ['-c', cfgPath], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  logger.info(`已托管 frpc：${path.basename(cfgPath)}`);

  const feed = (stream) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) logLine(line);
    });
  };
  if (proc.stdout) feed(proc.stdout);
  if (proc.stderr) feed(proc.stderr);

  proc.on('exit', (code) => {
    child = null;
    if (stopping) {
      logger.info('frpc 已停止');
      return;
    }
    logger.warn(`frpc 退出（code=${code}）`);
    if (restarts >= MAX_RESTARTS) {
      logger.error(`frpc 连续失败 ${MAX_RESTARTS} 次，停止自动重启，请检查配置或服务端`);
      return;
    }
    restarts += 1;
    const delay = Math.min(30000, 3000 * restarts);
    logger.info(`${Math.round(delay / 1000)} 秒后重启 frpc（第 ${restarts} 次）`);
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      startFrpc().catch((err) => logger.error('重启 frpc 失败', err.message));
    }, delay);
  });

  return { enabled: true };
}

export function stopFrpc() {
  stopping = true;
  clearTimeout(restartTimer);
  if (!child) return;
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  child = null;
}

export function frpcStatus() {
  return { managed: !!child, configured: !!config.frpcConfig };
}
