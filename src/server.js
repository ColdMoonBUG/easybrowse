/**
 * EasyBrowse 多用户远程浏览器平台 —— 服务入口。
 *
 * 启动：npm start（默认 http://localhost:8080）
 * 首次启动会创建管理员账号 admin，随机密码打印在控制台。
 */
import express from 'express';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config, ensureDirs } from './config.js';
import { seed, getSettings } from './db.js';
import { userByToken } from './auth.js';
import { authRouter } from './routes/auth.js';
import { sessionRouter } from './routes/session.js';
import { adminRouter } from './routes/admin.js';
import { attachScreenWebSocket } from './ws/stream.js';
import { manager } from './browser/manager.js';
import { muteLiveSessions } from './util/mute-audio.js';
import { startFrpc, stopFrpc } from './util/frpc.js';
import { getCurrentNode } from './util/nodeinfo.js';
import { logger } from './util/logger.js';

ensureDirs();
seed();

const app = express();
let muteTimer = null;
app.disable('x-powered-by');
// 传具体跳数而不是 true：true 等于采信任意 X-Forwarded-For，可被伪造（见 config.trustProxy）
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self' ws: wss:",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  next();
});

/**
 * 极简模式放行的接口清单（除 /nowapi 之外）。
 *
 * 认证接口是纯 JSON API、不依赖任何前端页面，所以一并放行；其余页面、静态资源、
 * 会话接口、画面 WebSocket 仍然全 404。用白名单而不是前缀匹配 —— 前缀匹配会把
 * 以后新增的 /api/auth/xxx 偷偷放出去。
 */
const NOWAPI_EXTRA_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/password',
]);

/**
 * 极简模式（NOWAPI_ONLY=1）：只放行 /nowapi 与上表的认证接口，其余一切 404。
 *
 * 必须挂在静态资源与所有路由之前 —— express 是按注册顺序匹配的，晚挂就会被
 * /login、/api/* 这些先命中。也要挂在 express.json 之前，否则畸形 JSON 会先
 * 被 body 解析器挡掉、吐出 express 风格的错误，反而暴露这里本来是个 API 站点。
 * 返回值刻意做成裸 404，不透露原本是什么服务。
 * WebSocket 不经过 express，另在下面跳过 attachScreenWebSocket。
 */
if (config.nowapiOnly) {
  app.use((req, res, next) => {
    // 与 express 的路由匹配保持一致：忽略大小写、容忍结尾斜杠
    const p = req.path.replace(/\/+$/, '').toLowerCase() || '/';
    if (p === '/nowapi' || NOWAPI_EXTRA_PATHS.has(p)) return next();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).type('text/plain').send('404 not found\n');
  });
}

app.use(express.json({ limit: '256kb' }));

const PUBLIC_DIR = path.resolve(config.root, 'public');// JS/CSS 不设长缓存：登录页/工作区都是无构建产物，改完必须让用户刷新就生效
app.use('/css', express.static(path.join(PUBLIC_DIR, 'css')));
app.use('/js', express.static(path.join(PUBLIC_DIR, 'js')));
app.use('/img', express.static(path.join(PUBLIC_DIR, 'img'), { maxAge: '1d' }));

const page = (file) => path.join(PUBLIC_DIR, file);

app.get('/', (req, res) => {
  const user = userByToken(req);
  if (!user) return res.redirect('/login');
  return res.sendFile(page('app.html'));
});

app.get('/login', (req, res) => {
  const user = userByToken(req);
  if (user) return res.redirect(user.role === 'admin' ? '/admin' : '/');
  return res.sendFile(page('login.html'));
});

app.get('/register', (req, res) => {
  const user = userByToken(req);
  if (user) return res.redirect(user.role === 'admin' ? '/admin' : '/');
  if (!getSettings().registrationEnabled) return res.redirect('/login?register=closed');
  return res.sendFile(page('register.html'));
});

app.get('/admin', (req, res) => {
  const user = userByToken(req);
  if (!user) return res.redirect('/login');
  if (user.role !== 'admin') return res.redirect('/');
  return res.sendFile(page('admin.html'));
});

/** 定长比较，避免按字符逐位比较泄漏 token 长度与内容 */
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf-8');
  const b = Buffer.from(String(expected), 'utf-8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * /nowapi 的鉴权。
 *
 * 节点分享链接本身就是代理凭据，拿到就能连 —— 所以默认只认登录态：
 *   1) Authorization: Bearer <登录令牌>（脚本），或浏览器带来的 eb_sid Cookie
 *   2) 静态口令 ?token= / X-Nowapi-Token，仅在 NOWAPI_ALLOW_STATIC_TOKEN=1 时生效
 *
 * 会话校验走的是 auth_sessions 同一张表，所以用户在管理台被停用、被删号、
 * 主动退出登录，这里会立刻跟着失效 —— 这正是固定口令做不到的事。
 */
function authorizeNowapi(req) {
  const user = userByToken(req);
  if (user) return { ok: true, via: 'session', user };

  if (config.nowapiAllowStaticToken && config.nowapiToken) {
    const given = req.query.token ?? req.get('x-nowapi-token') ?? '';
    if (tokenMatches(given, config.nowapiToken)) return { ok: true, via: 'static', user: null };
    return { ok: false, hint: 'token 无效' };
  }

  return {
    ok: false,
    hint: config.nowapiAllowStaticToken
      ? '需要登录令牌或静态口令'
      : '需要登录令牌（Authorization: Bearer <token>）',
  };
}

/**
 * 带 Authorization 头的跨域 GET 会先发预检，没有这个路由预检会落到 404 ——
 * 浏览器里直连的客户端就永远拿不到节点。
 */
app.options('/nowapi', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Nowapi-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  res.status(204).end();
});

/**
 * GET /nowapi —— 返回本机代理（v2rayN）当前选中的节点。
 *
 * 默认吐纯文本，就是一行分享链接，curl / 手机快捷指令可以直接取；
 * 加 ?format=json 返回结构化信息（协议、名称、地址、端口、链接、读取时间）。
 *
 * 鉴权失败统一 401 + WWW-Authenticate，方便客户端判断是「该登录」而不是「没权限」。
 */
app.get('/nowapi', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  // 允许前端在浏览器里直读响应体（否则带 Authorization 的跨域请求读不到内容）
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Nowapi-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  const wantsJson = String(req.query.format || '').toLowerCase() === 'json';
  const auth = authorizeNowapi(req);

  if (!auth.ok) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="nowapi"');
    if (wantsJson) return res.status(401).json({ error: auth.hint });
    return res.status(401).type('text/plain').send(`401 unauthorized：${auth.hint}\n`);
  }
  // 取节点等于取代理凭据，成功留痕但不打到默认级别，避免被轮询刷满日志
  logger.debug(`/nowapi 鉴权通过（${auth.via}${auth.user ? `: ${auth.user.username}` : ''}）from ${req.ip}`);

  const info = getCurrentNode();

  if (!info.ok) {
    if (wantsJson) return res.status(503).json(info);
    return res
      .status(503)
      .type('text/plain')
      .send(`# 取不到当前节点：${info.error}\n# ${info.message}\n`);
  }

  if (wantsJson) return res.json(info);

  if (!info.link) {
    return res
      .status(501)
      .type('text/plain')
      .send(`# 当前节点是 ${info.protocol}（${info.name}），该协议没有单条分享链接的表示\n# 加 ?format=json 可拿到结构化字段\n`);
  }

  return res.type('text/plain').send(`${info.link}\n`);
});

app.use('/api/auth', authRouter);
app.use('/api/sessions', sessionRouter);
app.use('/api/admin', adminRouter);

app.get('/api/meta', (req, res) => {
  const settings = getSettings();
  res.json({
    siteName: settings.siteName,
    privacyNotice: settings.privacyNotice,
    registrationEnabled: !!settings.registrationEnabled,
    version: '1.0.0',
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// 统一错误处理：不把堆栈返回给前端
app.use((err, req, res, _next) => {
  const status = err.statusCode || 500;
  if (status >= 500) logger.error(`${req.method} ${req.originalUrl} 处理失败：`, err.message);
  res.status(status).json({ error: status >= 500 ? err.message || '服务内部错误' : err.message });
});

const server = http.createServer(app);
// 极简模式不挂画面通道：WebSocket 升级不经过 express，光靠上面那个 404 中间件挡不住
if (!config.nowapiOnly) attachScreenWebSocket(server);

// 可选的原生 TLS 监听：证书放在本机，frp 只做 TCP 透传
let tlsServer = null;
if (config.tls.enabled) {
  try {
    tlsServer = https.createServer(
      { cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) },
      app,
    );
    if (!config.nowapiOnly) attachScreenWebSocket(tlsServer);
  } catch (err) {
    logger.error(`TLS 证书加载失败，已退回纯 HTTP：${err.message}`);
    tlsServer = null;
  }
}

server.listen(config.port, config.host, async () => {
  // 两种情况都先收敛：现在跑的浏览器除了登记在册的，还有数据库里查不到的孤儿进程
  await manager.recoverOnBoot();

  if (tlsServer) {
    tlsServer.listen(config.tls.port, config.host, () => {
      logger.info(`TLS 监听已开启：https://localhost:${config.tls.port}`);
    });
  }

  if (config.nowapiOnly) {
    // 极简模式：不启动定时器、不恢复会话、不接受任何浏览器请求，只留 /nowapi 与认证接口
    const entry = config.publicUrl || `http://localhost:${config.port}`;
    logger.info(`EasyBrowse 已启动（极简模式）：http://localhost:${config.port}`);
    logger.info(`开放接口：${entry}/nowapi   |   ${entry}/api/auth/{login,register,me,logout,password}`);
    logger.warn('其余页面 / 接口 / WebSocket 一律 404，远端浏览器功能已关闭（遗留进程已在启动时清理）');
  } else {
    manager.startTimers();
    const settings = getSettings();
    logger.info(`EasyBrowse 已启动：http://localhost:${config.port}`);
    if (config.publicUrl) logger.info(`对外访问地址：${config.publicUrl}`);
    logger.info(`数据目录：${config.dataDir}`);
    logger.info(`浏览器内核：${config.chromePath || '未找到（请设置 CHROME_PATH）'}`);
    logger.info(
      `会话策略：空闲 ${settings.idleTimeoutMinutes} 分钟断开画面，空闲 ${settings.idleStopMinutes} 分钟停止进程（浏览数据长期保留）`,
    );
    // 远端浏览器一律在宿主机静音：新实例带 --mute-audio，已在跑的实例在这里兜底
    setTimeout(() => muteLiveSessions('startup').catch(() => {}), 3000);
    muteTimer = setInterval(() => muteLiveSessions('periodic').catch(() => {}), 5 * 60 * 1000);
    muteTimer.unref?.();
  }
  // 可选：把 frpc 交给本服务托管（配置了 FRPC_CONFIG 才启用）
  startFrpc().catch((err) => logger.warn('启动 frpc 失败', err.message));
  // /nowapi 会原文吐出当前节点链接，等于代理凭据；鉴权模式要显式打出来，方便排查
  if (config.nowapiAllowStaticToken) {
    if (config.nowapiToken) {
      logger.warn(
        '/nowapi 静态口令回退已开启（?token=… / X-Nowapi-Token）：知道这串固定口令的人无需账号即可取节点，取完即用；不需要机器对机器调用时请置 NOWAPI_ALLOW_STATIC_TOKEN=0',
      );
    } else {
      logger.warn('/nowapi 静态口令回退已开启但 NOWAPI_TOKEN 为空，该回退不生效 —— 仍然只认登录令牌');
    }
  } else {
    logger.info(
      `/nowapi 鉴权：仅接受登录令牌（Authorization: Bearer <token> 或 eb_sid Cookie），匿名请求返回 401`,
    );
  }
});

const shutdown = async (signal) => {
  logger.warn(`收到 ${signal}，正在关闭会话并退出…`);
  if (muteTimer) clearInterval(muteTimer);
  stopFrpc();
  manager.stopTimers();
  await manager.shutdownAll().catch(() => {});
  tlsServer?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error('未处理的 Promise 拒绝：', reason));

export { app, server };
