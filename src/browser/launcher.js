/**
 * 远端浏览器进程的启动与关闭。
 *
 * 隔离要点：
 * 1. 每个用户使用独立的 user-data-dir（profile 目录），Cookie / LocalStorage / IndexedDB /
 *    缓存 / 历史记录 / 下载文件全部落在该目录内，天然互相隔离，并在会话结束后长期保留。
 * 2. CDP 端口使用 0（随机端口）并只监听 127.0.0.1，端口号从 DevToolsActivePort 文件读取，
 *    绝不通过 API 或前端暴露。
 * 3. 出口沿用宿主机的网络环境：默认不传任何代理参数，Chrome 直接读 Windows 系统代理，
 *    也就是说本机开着 v2rayN / Clash / sing-box 是什么出口，远端浏览器就是什么出口；
 *    只有显式配置 CHROME_PROXY 时才会强制指定代理。
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CDPConnection } from './cdp.js';
import { config } from '../config.js';
import { logger } from '../util/logger.js';

/**
 * 组装与出口相关的命令行参数。
 * 默认返回 null（跟随系统代理）；仅当 CHROME_PROXY 有值时才强制指定。
 */
export function buildProxyArgs(proxyUrl = config.chromeProxy) {
  if (!proxyUrl) return null;
  return [
    `--proxy-server=${proxyUrl}`,
    // 走代理时避免 WebRTC 泄露真实出口 IP
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
}

export function buildChromeArgs({
  profileDir,
  proxy,
  viewportWidth,
  viewportHeight,
  headless,
  downloadDir,
  renderScale = config.renderScale,
  muteAudio = true,
}) {
  const scale = Math.min(3, Math.max(1, Number(renderScale) || 1));
  // 窗口按物理像素给足：视口是运行期协商的，窗口给得太小会把 2x surface 裁掉，
  // 帧就卡在初始尺寸上（表现为「怎么调都糊」）。这里按 1080p 起点预留。
  const winW = Math.round(Math.max(viewportWidth, 1920) * scale);
  const winH = Math.round(Math.max(viewportHeight, 1080) * scale);
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-breakpad',
    '--disable-dev-shm-usage',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider',
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=zh-CN',
    '--accept-lang=zh-CN,zh,en',
    // 关键：把整个渲染管线的 surface scale 提到 N 倍。
    // Page.startScreencast 只按 surface scale 出图，不认 Emulation 的 deviceScaleFactor。
    `--force-device-scale-factor=${scale}`,
    `--window-size=${winW},${winH}`,
  ];
  if (headless) args.push('--headless=new', '--hide-scrollbars');
  // 远端浏览器跑在宿主机上，声音会从宿主机声卡播出（别的用户看视频，管理员这边就响）。
  // --mute-audio 是进程级静音，最彻底；已在跑的实例另由音频会话静音兜底。
  if (muteAudio) args.push('--mute-audio');
  const proxyArgs = buildProxyArgs(proxy);
  if (proxyArgs) args.push(...proxyArgs);
  if (downloadDir) args.push(`--download-default-directory=${downloadDir}`);
  if (config.chromeExtraArgs) args.push(...config.chromeExtraArgs.split(/\s+/).filter(Boolean));
  return args;
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
      resolve();
    }
  });
}

export { killTree };

/** 等待 DevToolsActivePort 出现并返回 { port, browserPath } */
function waitForDevToolsPort(profileDir, timeoutMs) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (fs.existsSync(portFile)) {
          const [port, browserPath] = fs.readFileSync(portFile, 'utf-8').split('\n');
          if (port && browserPath) {
            resolve({ port: Number(port), browserPath: browserPath.trim() });
            return;
          }
        }
      } catch {
        /* 文件可能正在写入，下一轮重试 */
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('浏览器启动超时（未生成 DevToolsActivePort）'));
        return;
      }
      setTimeout(tick, 120);
    };
    tick();
  });
}

/**
 * 启动一个用户专属的 Chromium 进程并连上 CDP。
 * proxy 为空表示跟随宿主机系统代理（默认行为）。
 * @returns {Promise<{proc, cdp, port}>}
 */
export async function launchBrowser({
  chromePath,
  profileDir,
  proxy,
  viewportWidth,
  viewportHeight,
  headless,
  downloadDir,
  renderScale,
  muteAudio,
}) {
  if (!chromePath) throw new Error('未找到可用的 Chrome/Chromium 可执行文件，请设置 CHROME_PATH');
  fs.mkdirSync(profileDir, { recursive: true });
  if (downloadDir) fs.mkdirSync(downloadDir, { recursive: true });

  // 清理上一次异常退出残留的端口文件，避免读到过期端口
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  try {
    if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
  } catch {
    /* ignore */
  }

  const args = buildChromeArgs({
    profileDir,
    proxy,
    viewportWidth,
    viewportHeight,
    headless,
    downloadDir,
    renderScale,
    muteAudio,
  });
  logger.info(`启动浏览器实例：${path.basename(profileDir)}`);

  const proc = spawn(chromePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  let stderrBuf = '';
  proc.stderr?.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
  });
  proc.stdout?.on('data', () => {});

  const exited = new Promise((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal }));
  });

  let info;
  try {
    info = await Promise.race([
      waitForDevToolsPort(profileDir, 30000),
      exited.then(({ code }) => {
        throw new Error(`浏览器进程提前退出（code=${code}）：${stderrBuf.slice(-500)}`);
      }),
    ]);
  } catch (err) {
    await killTree(proc.pid);
    throw err;
  }

  const wsUrl = `ws://127.0.0.1:${info.port}${info.browserPath}`;
  let cdp;
  try {
    cdp = await CDPConnection.connect(wsUrl, 15000);
  } catch (err) {
    await killTree(proc.pid);
    throw new Error(`连接浏览器调试端口失败：${err.message}`);
  }

  return { proc, cdp, port: info.port, exited };
}
