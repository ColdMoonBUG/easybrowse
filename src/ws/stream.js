/**
 * 远端画面 + 输入通道（WebSocket）。
 *
 * 帧格式（二进制）：
 *   0x01 + uint32 BE metaLength + meta JSON + JPEG 数据   画面帧
 *   0x02 + uint32 BE sampleRate + Int16 LE PCM            页面音频（单声道）
 * 元信息里带画面尺寸，前端按画布实际显示尺寸做坐标归一化，服务端再换算回视口 CSS 坐标。
 */
import { WebSocketServer } from 'ws';
import { consumeTicket } from './tickets.js';
import { manager } from '../browser/manager.js';
import { query, getSettings } from '../db.js';
import { logger } from '../util/logger.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { AUDIO_SAMPLE_RATE } from '../browser/audio-hook.js';

const T = { frame: 1, audio: 2 };

function encodeFrame(jpegB64, meta) {
  const jpeg = Buffer.from(jpegB64, 'base64');
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf-8');
  const head = Buffer.allocUnsafe(5);
  head.writeUInt8(T.frame, 0);
  head.writeUInt32BE(metaBuf.length, 1);
  return Buffer.concat([head, metaBuf, jpeg]);
}

function encodeAudio(pcm, sampleRate = AUDIO_SAMPLE_RATE) {
  const head = Buffer.allocUnsafe(5);
  head.writeUInt8(T.audio, 0);
  head.writeUInt32BE(sampleRate, 1);
  return Buffer.concat([head, pcm]);
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

export function attachScreenWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws/screen') {
      socket.destroy();
      return;
    }
    const ticket = url.searchParams.get('ticket') || '';
    const rec = consumeTicket(ticket);
    if (!rec) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._ticket = rec;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws, req) => {
    const { userId, sessionId } = ws._ticket;
    const settings = getSettings();
    const instance = manager.getInstance(userId);

    if (!instance || instance.id !== sessionId) {
      sendJson(ws, { t: 'error', message: '会话不存在或已结束，请重新进入工作区' });
      ws.close();
      return;
    }
    const user = query.get('SELECT id, username FROM users WHERE id = ?', userId);
    if (!user) {
      sendJson(ws, { t: 'error', message: '账号不可用' });
      ws.close();
      return;
    }

    let closed = false;
    let frameCount = 0;
    let droppedFrames = 0;

    const onFrame = (frame) => {
      if (closed || ws.readyState !== ws.OPEN) return;
      // 背压保护：2 倍分辨率下单帧 200KB 左右，阈值不能太高，
      // 否则滚动时会堆出几秒的延迟（输入也会跟着变慢）。宁可丢几帧。
      if (ws.bufferedAmount > 800_000) {
        droppedFrames += 1;
        return;
      }
      frameCount += 1;
      ws.send(
        encodeFrame(frame.data, {
          w: instance.settings.viewportWidth,
          h: instance.settings.viewportHeight,
          at: frame.at,
        }),
        { binary: true },
      );
    };

    const onAudio = (pcm) => {
      if (closed || ws.readyState !== ws.OPEN) return;
      // 音频是实时流：宁可丢包也别堆延迟（堆积后会与画面不同步）
      if (ws.bufferedAmount > 400_000) return;
      ws.send(encodeAudio(pcm, AUDIO_SAMPLE_RATE), { binary: true });
    };

    const onTabs = (tabs) => sendJson(ws, { t: 'tabs', tabs });
    const onNav = ({ url }) => sendJson(ws, { t: 'nav', url });
    const onBlocked = ({ url, reason }) => sendJson(ws, { t: 'blocked', url, reason });

    instance.on('frame', onFrame);
    instance.on('audio', onAudio);
    instance.on('tabs', onTabs);
    instance.on('nav', onNav);
    instance.on('blocked', onBlocked);

    manager.touch(userId);
    manager.markRunning(userId);
    await instance.setStreaming(true).catch((err) => logger.warn('启动画面流失败', err.message));

    const sessionRow = query.get('SELECT * FROM browser_sessions WHERE id = ?', sessionId);
    const tabs = instance.getTabs();
    sendJson(ws, {
      t: 'ready',
      session: {
        id: sessionId,
        status: 'RUNNING',
        createdAt: sessionRow?.created_at ?? null,
      },
      viewport: { w: instance.settings.viewportWidth, h: instance.settings.viewportHeight, scale: instance.renderScale },
      quality: instance.qualityLevel,
      audio: { available: settings.remoteAudioEnabled !== false, enabled: instance.audioEnabled, sampleRate: AUDIO_SAMPLE_RATE },
      tabs,
      url: tabs.find((t) => t.active)?.url || null,
      egress: config.chromeProxy || 'system',
      blockPrivateNetwork: config.blockPrivateNetwork,
      allowDownloads: settings.allowDownloads,
      /*
       * 能力探测：true 表示 text 消息支持 enter 字段（服务端在同一条消息里
       * 串行 insertText → pressKey('Enter')，顺序 100% 可靠）。
       * 前端据此决定还要不要自己补一次回车，这样旧服务端上也能立即生效。
       */
      enterKey: true,
    });

    const statsTimer = setInterval(() => {
      sendJson(ws, {
        t: 'stats',
        fps: frameCount,
        dropped: droppedFrames,
        traffic: { tx: instance.traffic.tx, rx: instance.traffic.rx },
      });
      frameCount = 0;
      droppedFrames = 0;
    }, 5000);

    const vw = () => instance.settings.viewportWidth;
    const vh = () => instance.settings.viewportHeight;
    const px = (n, max) => Math.max(0, Math.min(max, Math.round(n * max)));

    // 点击后探测远端焦点：手机端点中页面里的输入框时，前端据此自动拉起输入面板
    let focusTimer = null;
    const probeFocusSoon = () => {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(async () => {
        focusTimer = null;
        if (closed) return;
        try {
          const info = await instance.focusInfo();
          sendJson(ws, { t: 'focus', editable: !!info.editable, tag: info.tag || '', type: info.type || '' });
        } catch {
          /* 页面切换的瞬间可能取不到，忽略 */
        }
      }, 80);
    };

    const handlers = {
      async mouse(msg) {
        const x = px(msg.x, vw());
        const y = px(msg.y, vh());
        if (msg.a === 'move') {
          await instance.pointer('mouseMoved', x, y, { button: 'none', buttons: msg.buttons || 0 });
        } else if (msg.a === 'down') {
          await instance.pointer('mousePressed', x, y, { button: msg.button || 'left', buttons: 1, clickCount: 1 });
        } else if (msg.a === 'up') {
          await instance.pointer('mouseReleased', x, y, { button: msg.button || 'left', buttons: 0, clickCount: 1 });
          probeFocusSoon();
        } else if (msg.a === 'dblclick') {
          await instance.pointer('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 2 });
          await instance.pointer('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 2 });
          probeFocusSoon();
        }
      },
      async wheel(msg) {
        await instance.wheel(px(msg.x, vw()), px(msg.y, vh()), msg.dx || 0, msg.dy || 0);
      },
      async key(msg) {
        await instance.pressKey(msg.key, msg.mods || {});
      },
      async text(msg) {
        if (typeof msg.text !== 'string' || !msg.text) return;
        await instance.insertText(msg.text.slice(0, 4000));
        /*
         * enter 由客户端在「发送 / 搜索」时带上：手机上文字是从底部面板送进来的，
         * 框架的提交动作得靠这一下回车触发，否则搜索框填了字页面也不跳转。
         * 放在同一条消息里串行执行，避免 text 和 key 两条消息并发导致回车先到。
         */
        if (msg.enter) await instance.pressKey('Enter');
      },
      async nav(msg) {
        await instance.navigate(msg.url);
      },
      async back() {
        await instance.history(-1);
      },
      async forward() {
        await instance.history(1);
      },
      async reload(msg) {
        await instance.reload(!!msg.ignoreCache);
      },
      async tab(msg) {
        if (msg.a === 'new') await instance.newTab(msg.url || 'about:blank');
        else if (msg.a === 'close') await instance.closeTab(msg.id);
        else if (msg.a === 'activate') await instance.activateTab(msg.id);
        sendJson(ws, { t: 'tabs', tabs: instance.getTabs() });
      },
      async audio(msg) {
        if (settings.remoteAudioEnabled === false) {
          sendJson(ws, { t: 'audio', enabled: false, message: '音频回传已被管理员关闭' });
          return;
        }
        const enabled = await instance.setAudioEnabled(!!msg.on);
        sendJson(ws, { t: 'audio', enabled, sampleRate: AUDIO_SAMPLE_RATE });
      },
      async quality(msg) {
        // 三挡：high | medium | low。只影响当前会话，不写全局设置
        const level = msg.level
          ? msg.level
          : Number(msg.v) >= 85
            ? 'high'
            : Number(msg.v) >= 65
              ? 'medium'
              : 'low';
        const applied = await instance.setQuality(level);
        sendJson(ws, { t: 'quality', level: applied });
      },
      async viewport(msg) {
        // 视口用 CSS 像素协商；渲染倍率由进程级参数锁定，不接受客户端改
        const w = Math.max(360, Math.min(2560, Number(msg.w) || vw()));
        const h = Math.max(320, Math.min(1600, Number(msg.h) || vh()));
        await instance.setViewport(w, h);
        sendJson(ws, {
          t: 'viewport',
          w: instance.settings.viewportWidth,
          h: instance.settings.viewportHeight,
          scale: instance.renderScale,
        });
      },
      async end() {
        await manager.stopForUser(userId, 'user_closed', { actorId: userId, status: 'STOPPED' });
        sendJson(ws, { t: 'ended', reason: 'user_closed' });
        ws.close();
      },
    };

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || !msg.t) return;
      if (msg.t === 'ping') {
        sendJson(ws, { t: 'pong', at: Date.now() });
        return;
      }
      const fn = handlers[msg.t];
      if (!fn) return;
      manager.touch(userId);
      try {
        await fn(msg);
      } catch (err) {
        sendJson(ws, { t: 'error', message: err.message });
      }
    });

    ws.on('close', () => {
      closed = true;
      clearInterval(statsTimer);
      instance.off('frame', onFrame);
      instance.off('audio', onAudio);
      instance.off('tabs', onTabs);
      instance.off('nav', onNav);
      instance.off('blocked', onBlocked);
      clearTimeout(focusTimer);
      if (instance.listenerCount('frame') === 0) {
        instance.setStreaming(false).catch(() => {});
        manager.markDisconnected(userId);
      }
    });

    ws.on('error', () => {
      /* close 会统一收尾 */
    });

    audit('session.view_connected', { actorId: userId, targetUserId: userId, sessionId });
    logger.info(`用户 ${user.username} 已连接到浏览器画面`);
  });

  return wss;
}
