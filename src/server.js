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
import { logger } from './util/logger.js';

ensureDirs();
seed();

const app = express();
let muteTimer = null;
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true);

app.use(express.json({ limit: '256kb' }));
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

const PUBLIC_DIR = path.resolve(config.root, 'public');
// JS/CSS 不设长缓存：登录页/工作区都是无构建产物，改完必须让用户刷新就生效
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
attachScreenWebSocket(server);

// 可选的原生 TLS 监听：证书放在本机，frp 只做 TCP 透传
let tlsServer = null;
if (config.tls.enabled) {
  try {
    tlsServer = https.createServer(
      { cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) },
      app,
    );
    attachScreenWebSocket(tlsServer);
  } catch (err) {
    logger.error(`TLS 证书加载失败，已退回纯 HTTP：${err.message}`);
    tlsServer = null;
  }
}

server.listen(config.port, config.host, async () => {
  await manager.recoverOnBoot();
  manager.startTimers();
  const settings = getSettings();
  logger.info(`EasyBrowse 已启动：http://localhost:${config.port}`);
  if (config.publicUrl) logger.info(`对外访问地址：${config.publicUrl}`);
  if (tlsServer) {
    tlsServer.listen(config.tls.port, config.host, () => {
      logger.info(`TLS 监听已开启：https://localhost:${config.tls.port}`);
    });
  }
  logger.info(`数据目录：${config.dataDir}`);
  logger.info(`浏览器内核：${config.chromePath || '未找到（请设置 CHROME_PATH）'}`);
  logger.info(
    `会话策略：空闲 ${settings.idleTimeoutMinutes} 分钟断开画面，空闲 ${settings.idleStopMinutes} 分钟停止进程（浏览数据长期保留）`,
  );
  // 远端浏览器一律在宿主机静音：新实例带 --mute-audio，已在跑的实例在这里兜底
  setTimeout(() => muteLiveSessions('startup').catch(() => {}), 3000);
  muteTimer = setInterval(() => muteLiveSessions('periodic').catch(() => {}), 5 * 60 * 1000);
  muteTimer.unref?.();
  // 可选：把 frpc 交给本服务托管（配置了 FRPC_CONFIG 才启用）
  startFrpc().catch((err) => logger.warn('启动 frpc 失败', err.message));
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
