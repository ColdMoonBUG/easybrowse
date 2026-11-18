/**
 * 全局配置加载。
 * 优先级：环境变量 / .env 文件 > 内置默认值。
 * 运行期可在管理后台修改的参数存放在数据库 settings 表中（见 src/settings.js）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(process.cwd());

/** 极简 .env 解析，避免引入额外依赖 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf-8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** 会话签名密钥：没有配置时生成一次并落盘，保证重启后登录态不失效 */
function resolveSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretFile = path.join(DATA_DIR, '.session_secret');
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf-8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

/** 自动探测本机 Chrome / Edge 可执行文件 */
function detectChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const bool = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  profileDir: path.join(DATA_DIR, 'profiles'),
  dbFile: path.join(DATA_DIR, 'easybrowse.db'),
  port: num(process.env.PORT, 28471),
  host: process.env.HOST || '0.0.0.0',
  /** 部署在 HTTPS 反代 / TLS 直连之后时设为 1，Cookie 会带 Secure */
  behindHttps: bool(process.env.BEHIND_HTTPS, false),
  /** 可选：本机原生 TLS 监听（自签或自有证书），不填则只跑 HTTP 由 frp 透传 */
  tls: {
    enabled: !!process.env.TLS_CERT && !!process.env.TLS_KEY,
    cert: process.env.TLS_CERT || '',
    key: process.env.TLS_KEY || '',
    port: num(process.env.TLS_PORT, 28472),
  },
  /**
   * 浏览器出口：留空表示跟随 Windows 系统代理（本机开着 v2rayN/Clash 就是什么出口）。
   * 仅当需要强制指定时才设置，例如 http://127.0.0.1:10808。
   */
  chromeProxy: process.env.CHROME_PROXY || '',
  /** 额外的 Chrome 命令行参数，空格分隔 */
  chromeExtraArgs: process.env.CHROME_EXTRA_ARGS || '',
  /**
   * 远端渲染倍率（原画的关键）。
   *
   * CDP 的 Page.startScreencast 不认 deviceScaleFactor，只按窗口的 surface scale 出图，
   * 所以必须用 --force-device-scale-factor 把整个渲染管线提到 N 倍，推流才是 N 倍物理像素。
   * 2 = 在 1080p 屏上相当于超采样，文字非常锐利；1 = 省流量但会发虚。
   */
  renderScale: num(process.env.RENDER_SCALE, 2),
  /**
   * 是否拦截远端浏览器访问回环 / 内网 / 链路本地地址。
   * 平台一旦通过 frp 暴露到公网，不拦截等于把宿主内网交给陌生人，默认开启。
   */
  blockPrivateNetwork: bool(process.env.BLOCK_PRIVATE_NETWORK, true),
  /** 对外访问地址，仅用于启动日志提示 */
  publicUrl: process.env.PUBLIC_URL || '',
  /**
   * 可选：把 frpc 客户端交给本服务托管。
   * 指向 frpc 的 toml 配置文件；留空表示不托管（由使用者自己启动 frpc）。
   * 托管后 frpc 作为本进程的子进程运行，服务随计划任务自启时 frpc 一起起来。
   */
  frpcConfig: process.env.FRPC_CONFIG || '',
  /**
   * /nowapi 读取的 v2rayN 便携版目录；留空则按常见落点自动探测。
   * 这个接口会把当前节点的分享链接原样吐出来，等价于公开代理凭据，
   * 所以对外部署时务必配 NOWAPI_TOKEN。
   */
  v2rayNDir: process.env.V2RAYN_DIR || '',
  nowapiToken: process.env.NOWAPI_TOKEN || '',
  sessionSecret: resolveSecret(),
  sessionTtlHours: num(process.env.SESSION_TTL_HOURS, 12),
  chromePath: detectChrome(),
  /** 首次启动自动创建的管理员口令，未设置则随机生成并打印在控制台 */
  initialAdminPassword: process.env.ADMIN_INITIAL_PASSWORD || null,
  logLevel: process.env.LOG_LEVEL || 'info',
  trustProxy: bool(process.env.TRUST_PROXY, true),
  /** WebSocket 短时连接票据有效期（秒） */
  ticketTtlSeconds: num(process.env.TICKET_TTL_SECONDS, 120),
};

export function ensureDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.profileDir, { recursive: true });
}
