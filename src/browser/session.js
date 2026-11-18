/**
 * 单个用户的远端浏览器实例：进程 + CDP 会话 + 画面流 + 输入 + 流量计数。
 *
 * 每个实例独占一个 profile 目录，用户关闭会话后进程停止但目录完整保留，
 * 下次登录用同一个目录启动，Cookie / 登录态 / 历史记录 / 书签 / 下载文件原样恢复。
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { launchBrowser, killTree } from './launcher.js';
import { checkUrl, assertNavigable } from './netguard.js';
import { AUDIO_HOOK_SOURCE, buildAudioHookSource, AUDIO_SAMPLE_RATE } from './audio-hook.js';
import { config } from '../config.js';
import { logger } from '../util/logger.js';

const KEY_CODES = {
  Enter: 13,
  Tab: 9,
  Backspace: 8,
  Escape: 27,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  F5: 116,
};

const KEY_TEXT = {
  Enter: '\r',
};

/**
 * 渲染倍率：让远端页面按「访问设备的物理像素」渲染，而不是永远 1x。
 *
 * 手机 / Retina 笔记本的 devicePixelRatio 是 2 或 3，若远端只渲 1x，
 * 前端就必须把 1 个 CSS 像素的图铺到 2×2 个物理像素上，文字边缘必然发虚。
 * 上限 3：再高帧体积按平方增长，frp 上行撑不住，肉眼也难分辨。
 */
const MIN_SCALE = 1;
const MAX_SCALE = 3;
/** 单帧像素上限（≈4K）。超过这个量级，frp 上行带宽会先崩，清晰度收益已经很小 */
const MAX_FRAME_PIXELS = 8_300_000;

export function clampScale(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(n * 100) / 100));
}

/**
 * 画质三挡。用户在工作区右上角切换，只影响自己的会话（不写全局设置）。
 *
 * sample 是推流分辨率相对「视口 × 渲染倍率」的系数：小于 1 时服务端先降采样再编码，
 * 帧体积按平方下降，客户端再把图放大铺满——挡位越低越省流量、越糊。
 * 注意 renderScale 是进程级参数，改它必须重开浏览器进程，所以三挡只能在编码这一层做，
 * 高挡拿到的就是完整原画帧（2x 渲染 + 92 质量）。
 */
export const QUALITY_PRESETS = {
  high: { label: '高清', quality: 92, sample: 1 },
  medium: { label: '均衡', quality: 76, sample: 1 },
  low: { label: '省流', quality: 58, sample: 0.62 },
};

export function normalizeQualityLevel(v) {
  const k = String(v || '').trim().toLowerCase();
  return QUALITY_PRESETS[k] ? k : 'high';
}

export class BrowserInstance extends EventEmitter {
  constructor({ id, userId, profileDir, chromePath, settings, proxy = null }) {
    super();
    this.id = id;
    this.userId = userId;
    this.profileDir = profileDir;
    this.chromePath = chromePath;
    this.settings = settings;
    this.proxy = proxy;
    this.proc = null;
    this.cdp = null;
    this.port = null;
    this.pages = new Map(); // targetId -> { targetId, sessionId, url, title, ready, cleanup }
    this.activeTargetId = null;
    this.streaming = false;
    this.streamingSession = null;
    this.startedAt = null;
    this.status = 'CREATING';
    this.traffic = { tx: 0, rx: 0 };
    this.lastFrame = null;
    // 渲染倍率：由进程级 --force-device-scale-factor 决定，运行期不可变
    this.renderScale = clampScale(
      Number(settings.renderScale) > 0 ? settings.renderScale : config.renderScale,
    );
    // 画质挡位：实例级可变（切换时重启 screencast 即可生效，无需重开进程）
    this.qualityLevel = normalizeQualityLevel(settings.qualityLevel);
    /** 是否把页面声音回传给用户（默认关闭，由用户点开声音时打开） */
    this.audioEnabled = false;
    this.audio = { frames: 0, bytes: 0, lastAt: 0 };
    this.#pageReady = null;
    this.#readyPromise = new Promise((resolve) => {
      this.#pageReady = resolve;
    });
  }

  #pageReady;
  #readyPromise;

  get downloadDir() {
    return path.join(this.profileDir, 'Downloads');
  }

  async start() {
    const { proc, cdp, port, exited } = await launchBrowser({
      chromePath: this.chromePath,
      profileDir: this.profileDir,
      proxy: this.proxy,
      viewportWidth: this.settings.viewportWidth,
      viewportHeight: this.settings.viewportHeight,
      headless: this.settings.headless,
      downloadDir: this.downloadDir,
      renderScale: this.renderScale,
      muteAudio: this.settings.muteRemoteAudio !== false,
    });
    this.proc = proc;
    this.cdp = cdp;
    this.port = port;
    this.startedAt = Date.now();
    this.status = 'RUNNING';

    exited.then(({ code, signal }) => {
      if (this.status === 'STOPPING' || this.status === 'STOPPED') return;
      logger.warn(`浏览器实例 ${this.id} 意外退出 code=${code} signal=${signal}`);
      this.status = 'ERROR';
      this.emit('crashed', { code, signal });
    });

    cdp.on('', 'Target.attachedToTarget', (p) => {
      this.#handleAttached(p).catch((err) => logger.error('初始化标签页失败', err.message));
    });
    // 页面音频钩子通过 CDP binding 回传 PCM：不经过页面网络栈，绕开站点 CSP
    cdp.on('*', 'Runtime.bindingCalled', (p) => this.#onAudioBinding(p));
    cdp.on('', 'Target.detachedFromTarget', (p) => this.#handleDetached(p.sessionId));
    cdp.on('', 'Target.targetInfoChanged', (p) => this.#handleTargetInfo(p.targetInfo));
    cdp.on('', 'Target.targetDestroyed', (p) => this.#handleTargetDestroyed(p.targetId));
    cdp.on('', 'Target.targetCreated', (p) => this.#handleTargetInfo(p.targetInfo));

    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: this.settings.allowDownloads ? 'allow' : 'deny',
      downloadPath: this.downloadDir,
      eventsEnabled: false,
    });
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      // 只接管 page，避免把 worker / service worker 也纳管进来徒增开销
      filter: [{ type: 'page', exclude: false }],
    }).catch(async () => {
      // 老版本 Chrome 不支持 filter 参数，退回无过滤模式
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    });

    // 已有 profile 首次启动可能没有页面，主动开一个
    const existing = await cdp.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
    if (!existing.targetInfos.some((t) => t.type === 'page')) {
      await cdp.send('Target.createTarget', { url: 'about:blank' });
    }

    await Promise.race([
      this.#readyPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('等待浏览器标签页就绪超时')), 20000)),
    ]);
    return this;
  }

  async #handleAttached({ sessionId, targetInfo, waitingForDebugger }) {
    if (targetInfo.type !== 'page') {
      if (waitingForDebugger) this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      return;
    }
    const page = {
      targetId: targetInfo.targetId,
      sessionId,
      url: targetInfo.url,
      title: targetInfo.title,
      ready: false,
      cleanups: [],
      audioScriptId: null,
    };
    this.pages.set(targetInfo.targetId, page);

    await Promise.allSettled([
      this.cdp.send('Page.enable', {}, sessionId),
      this.cdp.send('Network.enable', {}, sessionId),
      this.cdp.send('Runtime.enable', {}, sessionId),
      this.#applyMetrics(sessionId),
    ]);
    await this.#injectAudioHook(page);
    if (this.audioEnabled) {
      this.cdp
        .send('Runtime.evaluate', { expression: 'window.__ebAudioStart && window.__ebAudioStart()' }, sessionId)
        .catch(() => {});
    }

    if (waitingForDebugger) this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    this.#bindPageEvents(page);

    if (config.blockPrivateNetwork) {
      // 只拦 Document 级导航：既能挡住直接输地址访问内网，又不对每个子资源都做一次 DNS 判定
      this.cdp
        .send(
          'Fetch.enable',
          { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] },
          sessionId,
        )
        .catch(() => {});
    }

    page.ready = true;
    if (!this.activeTargetId) {
      await this.activateTab(targetInfo.targetId).catch(() => {});
    }
    this.#pageReady();
    this.#emitTabs();
  }

  #bindPageEvents(page) {
    const { cdp, sessionId } = { cdp: this.cdp, sessionId: page.sessionId };

    page.cleanups.push(
      cdp.on(sessionId, 'Page.frameNavigated', (p) => {
        if (p.frame.parentId) return;
        page.url = p.frame.url;
        this.emit('nav', { targetId: page.targetId, url: page.url, title: page.title });
        this.#emitTabs();
        // 新文档的钩子默认是关闭的：用户开着声音时导航后要重新打开
        if (this.audioEnabled) {
          setTimeout(() => {
            if (!this.audioEnabled || this.status !== 'RUNNING') return;
            cdp.send('Runtime.evaluate', { expression: 'window.__ebAudioStart && window.__ebAudioStart()' }, sessionId).catch(() => {});
          }, 1200);
        }
      }),
    );

    page.cleanups.push(
      cdp.on(sessionId, 'Page.screencastFrame', (p) => {
        this.lastFrame = { data: p.data, metadata: p.metadata, at: Date.now() };
        if (this.listenerCount('frame') > 0) {
          this.emit('frame', this.lastFrame);
        }
        cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sessionId).catch(() => {});
      }),
    );

    page.cleanups.push(
      cdp.on(sessionId, 'Page.javascriptDialogOpening', () => {
        cdp.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
      }),
    );

    page.cleanups.push(
      cdp.on(sessionId, 'Inspector.targetCrashed', () => {
        this.emit('pageCrashed', { targetId: page.targetId });
      }),
    );

    // 互联网流量统计：只统计浏览器与目标站点之间的数据，不含远端画面
    page.cleanups.push(
      cdp.on(sessionId, 'Network.loadingFinished', (p) => {
        this.traffic.rx += p.encodedDataLength || 0;
      }),
    );
    page.cleanups.push(
      cdp.on(sessionId, 'Network.requestWillBeSent', (p) => {
        if (p.request?.postData) this.traffic.tx += Buffer.byteLength(p.request.postData, 'utf-8');
      }),
    );
    page.cleanups.push(
      cdp.on(sessionId, 'Network.webSocketFrameReceived', (p) => {
        this.traffic.rx += p.response?.payloadLength || 0;
      }),
    );
    page.cleanups.push(
      cdp.on(sessionId, 'Network.webSocketFrameSent', (p) => {
        this.traffic.tx += p.response?.payloadLength || 0;
      }),
    );

    if (config.blockPrivateNetwork) {
      page.cleanups.push(
        cdp.on(sessionId, 'Fetch.requestPaused', async (p) => {
          try {
            const verdict = await checkUrl(p.request?.url || '');
            if (verdict.blocked) {
              await cdp.send(
                'Fetch.failRequest',
                { requestId: p.requestId, errorReason: 'BlockedByClient' },
                sessionId,
              );
              this.emit('blocked', { targetId: page.targetId, url: p.request?.url, reason: verdict.reason });
              return;
            }
          } catch {
            /* 判定异常时放行，交由浏览器自身处理 */
          }
          cdp.send('Fetch.continueRequest', { requestId: p.requestId }, sessionId).catch(() => {});
        }),
      );
    }
  }

  #handleDetached(sessionId) {
    for (const [targetId, page] of this.pages) {
      if (page.sessionId !== sessionId) continue;
      for (const off of page.cleanups) off();
      this.pages.delete(targetId);
      if (this.activeTargetId === targetId) {
        this.activeTargetId = null;
        this.streamingSession = null;
        const next = [...this.pages.values()][0];
        if (next && this.streaming) this.activateTab(next.targetId).catch(() => {});
      }
      this.#emitTabs();
      return;
    }
  }

  #handleTargetDestroyed(targetId) {
    const page = this.pages.get(targetId);
    if (!page) return;
    for (const off of page.cleanups) off();
    this.pages.delete(targetId);
    if (this.activeTargetId === targetId) {
      this.activeTargetId = null;
      const next = [...this.pages.values()].find((p) => p.ready);
      if (next) this.activateTab(next.targetId).catch(() => {});
    }
    this.#emitTabs();
  }

  #handleTargetInfo(info) {
    if (!info || info.type !== 'page') return;
    const page = this.pages.get(info.targetId);
    if (!page) return;
    page.url = info.url || page.url;
    page.title = info.title || page.title;
    this.#emitTabs();
  }

  getTabs() {
    const list = [...this.pages.values()]
      .filter((p) => p.ready)
      .map((p) => ({
        id: p.targetId,
        url: p.url,
        title: p.title || this.#hostOf(p.url),
        active: p.targetId === this.activeTargetId,
      }));
    return list;
  }

  #hostOf(url) {
    try {
      return new URL(url).host || '新标签页';
    } catch {
      return '新标签页';
    }
  }

  #emitTabs() {
    this.emit('tabs', this.getTabs());
  }

  #activePage() {
    const page = this.activeTargetId ? this.pages.get(this.activeTargetId) : null;
    if (!page || !page.ready) throw new Error('浏览器页面尚未就绪');
    return page;
  }

  /**
   * 把视口（CSS 像素）与渲染倍率下发给页面。
   * deviceScaleFactor > 1 时，Chromium 会按物理像素栅格化字体与图片，帧也更清晰。
   */
  #applyMetrics(sessionId) {
    return this.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: Math.round(this.settings.viewportWidth),
        height: Math.round(this.settings.viewportHeight),
        deviceScaleFactor: this.renderScale,
        mobile: false,
      },
      sessionId,
    );
  }

  /** 推流分辨率必须是「视口 × 倍率」，否则 CDP 会把高清帧降采样回逻辑像素 */
  #frameSize() {
    const preset = QUALITY_PRESETS[this.qualityLevel] || QUALITY_PRESETS.high;
    const sample = Math.min(1, Math.max(0.3, Number(preset.sample) || 1));
    return {
      w: Math.max(1, Math.round(this.settings.viewportWidth * this.renderScale * sample)),
      h: Math.max(1, Math.round(this.settings.viewportHeight * this.renderScale * sample)),
    };
  }

  async #startScreencast(sessionId) {
    const { w, h } = this.#frameSize();
    const preset = QUALITY_PRESETS[this.qualityLevel] || QUALITY_PRESETS.high;
    await this.cdp.send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: preset.quality,
        maxWidth: w,
        maxHeight: h,
        everyNthFrame: 1,
      },
      sessionId,
    );
    this.streamingSession = sessionId;
  }

  /** 切换画质挡位：重启 screencast 生效，返回实际生效的挡位 */
  async setQuality(level) {
    const next = normalizeQualityLevel(level);
    this.qualityLevel = next;
    if (this.streaming) await this.setStreaming(true).catch((err) => logger.warn('切换画质失败', err.message));
    return next;
  }

  async setStreaming(on) {
    if (!this.cdp) return;
    this.streaming = on;
    const page = this.activeTargetId ? this.pages.get(this.activeTargetId) : null;
    if (!page) return;
    if (on) {
      // 必须先 stop 再 start：重复调用 startScreencast 时 Chromium 会沿用第一次的
      // maxWidth/maxHeight，视口变大后帧仍被压在旧分辨率上（表现为怎么调都糊）。
      const prev = this.streamingSession || page.sessionId;
      await this.cdp.send('Page.stopScreencast', {}, prev).catch(() => {});
      this.streamingSession = null;
      await this.#startScreencast(page.sessionId).catch((err) => logger.warn('开启画面流失败', err.message));
    } else {
      await this.cdp.send('Page.stopScreencast', {}, page.sessionId).catch(() => {});
      this.streamingSession = null;
    }
  }

  async activateTab(targetId) {
    const page = this.pages.get(targetId);
    if (!page) throw new Error('标签页不存在');
    await this.cdp.send('Target.activateTarget', { targetId }).catch(() => {});
    const changed = this.activeTargetId !== targetId;
    this.activeTargetId = targetId;
    if (this.streaming) {
      if (this.streamingSession && this.streamingSession !== page.sessionId) {
        await this.cdp.send('Page.stopScreencast', {}, this.streamingSession).catch(() => {});
      }
      await this.#startScreencast(page.sessionId).catch(() => {});
    }
    if (changed) this.#emitTabs();
    return this.getTabs();
  }

  async newTab(url = 'about:blank') {
    if (url && url !== 'about:blank') await assertNavigable(url);
    // 先建空标签再导航，避免内网地址在拦截前就被加载
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    // 等待 attachedToTarget 完成初始化
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const page = this.pages.get(targetId);
      if (page?.ready) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    await this.activateTab(targetId).catch(() => {});
    if (url && url !== 'about:blank') {
      const page = this.pages.get(targetId);
      if (page?.ready) await this.navigate(url);
    }
    return this.getTabs();
  }

  async closeTab(targetId) {
    if (this.pages.size <= 1) throw new Error('至少保留一个标签页');
    await this.cdp.send('Target.closeTarget', { targetId });
    return this.getTabs();
  }

  async navigate(url) {
    const page = this.#activePage();
    await assertNavigable(url);
    const res = await this.cdp.send('Page.navigate', { url, transitionType: 'typed' }, page.sessionId);
    this.emit('nav', { targetId: page.targetId, url });
    return res;
  }

  async reload(ignoreCache = false) {
    const page = this.#activePage();
    await this.cdp.send('Page.reload', { ignoreCache }, page.sessionId);
  }

  async history(delta) {
    const page = this.#activePage();
    const { currentIndex, entries } = await this.cdp.send('Page.getNavigationHistory', {}, page.sessionId);
    const idx = currentIndex + delta;
    if (idx < 0 || idx >= entries.length) return false;
    await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entries[idx].id }, page.sessionId);
    return true;
  }

  async captureScreenshot(quality = 70) {
    const page = this.#activePage();
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality }, page.sessionId);
    return data;
  }

  /* ---------------- 输入事件（坐标均为远端视口 CSS 像素） ---------------- */

  async pointer(type, x, y, { button = 'left', buttons = 0, clickCount = 1 } = {}) {
    const page = this.#activePage();
    await this.cdp.send(
      'Input.dispatchMouseEvent',
      { type, x, y, button, buttons, clickCount, pointerType: 'mouse' },
      page.sessionId,
    );
  }

  async wheel(x, y, deltaX, deltaY) {
    const page = this.#activePage();
    await this.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x, y, deltaX, deltaY, button: 'none', buttons: 0 },
      page.sessionId,
    );
  }

  async pressKey(key, { shift = false, ctrl = false, alt = false, meta = false } = {}) {
    const page = this.#activePage();
    const code = KEY_CODES[key];
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
    const base = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      windowsVirtualKeyCode: code || 0,
      nativeVirtualKeyCode: code || 0,
      modifiers,
    };
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: KEY_TEXT[key] || '' }, page.sessionId);
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, page.sessionId);
  }

  async insertText(text) {
    const page = this.#activePage();
    await this.cdp.send('Input.insertText', { text }, page.sessionId);
  }

  /**
   * 远端当前焦点是否落在可输入控件上。
   * 手机端据此自动拉起本地输入面板（否则用户点了页面里的搜索框也不会弹键盘）。
   * 会穿透 shadow DOM 与同源 iframe，最多三层。
   */
  async focusInfo() {
    const page = this.#activePage();
    const expression = `(() => {
      const dig = (doc, depth) => {
        let el = doc && doc.activeElement;
        if (!el) return null;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        if (el && el.tagName === 'IFRAME' && depth < 3) {
          try { return dig(el.contentDocument, depth + 1); } catch (_) { return null; }
        }
        return el;
      };
      const el = dig(document, 0);
      if (!el) return { editable: false };
      const tag = String(el.tagName || '').toLowerCase();
      const type = String(el.getAttribute ? el.getAttribute('type') || '' : '').toLowerCase();
      const blocked = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image', 'hidden'];
      const editable = (el.isContentEditable || tag === 'input' || tag === 'textarea') && !blocked.includes(type);
      return { editable: !!(editable && !el.readOnly && !el.disabled), tag: tag || '', type };
    })()`;
    try {
      const { result } = await this.cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: false, timeout: 800 },
        page.sessionId,
      );
      return result?.value || { editable: false };
    } catch {
      return { editable: false };
    }
  }

  /**
   * 注入音频钩子：
   * - binding 让页面能把 PCM 直接交给服务端（不走页面网络栈，绕开站点 CSP）；
   * - addScriptToEvaluateOnNewDocument 保证之后打开的每个新文档都带钩子，
   *   并且把「当前是否要求采集」写进脚本，导航后无需再靠定时器补救；
   * - 再对当前已加载的文档补一次完整注入（它可能早于钩子注入就加载完了）。
   */
  async #injectAudioHook(page) {
    const { sessionId } = page;
    await this.cdp.send('Runtime.addBinding', { name: '__ebAudio' }, sessionId).catch(() => {});
    await this.#registerAudioHook(page);
    await this.cdp.send('Runtime.evaluate', { expression: AUDIO_HOOK_SOURCE }, sessionId).catch(() => {});
  }

  /** 重新注册「新文档」脚本，让后续导航继承当前的采集开关 */
  async #registerAudioHook(page) {
    const { sessionId } = page;
    if (page.audioScriptId) {
      await this.cdp
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: page.audioScriptId }, sessionId)
        .catch(() => {});
      page.audioScriptId = null;
    }
    const res = await this.cdp
      .send('Page.addScriptToEvaluateOnNewDocument', { source: buildAudioHookSource(this.audioEnabled) }, sessionId)
      .catch(() => null);
    if (res?.identifier) page.audioScriptId = res.identifier;
  }

  /** 页面把 PCM 通过 binding 推上来（base64 Int16 单声道 24kHz） */
  #onAudioBinding(params) {
    if (params?.name !== '__ebAudio' || !this.audioEnabled) return;
    const payload = params.payload;
    if (typeof payload !== 'string' || payload.length < 8 || payload.length > 200000) return;
    let buf;
    try {
      buf = Buffer.from(payload, 'base64');
    } catch {
      return;
    }
    if (buf.length < 2) return;
    this.audio.frames += 1;
    this.audio.bytes += buf.length;
    this.audio.lastAt = Date.now();
    if (this.listenerCount('audio') > 0) this.emit('audio', buf);
  }

  /** 打开/关闭页面音频回传（用户点声音按钮时切换） */
  async setAudioEnabled(on) {
    this.audioEnabled = !!on;
    const expression = this.audioEnabled
      ? 'window.__ebAudioStart && window.__ebAudioStart()'
      : 'window.__ebAudioStop && window.__ebAudioStop()';
    for (const page of this.pages.values()) {
      if (!page.ready) continue;
      await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, page.sessionId).catch(() => {});
      // 之后导航到的新页面也要跟随当前开关，否则会「跳转后突然没声音」
      await this.#registerAudioHook(page);
    }
    this.emit('audioState', { enabled: this.audioEnabled, rate: AUDIO_SAMPLE_RATE });
    return this.audioEnabled;
  }

  /**
   * 只调整视口与倍率。倍率由进程级参数锁定，这里只协商 CSS 尺寸，
   * 并按「单帧像素上限」反推可用视口，避免 2x 渲染把 frp 上行压垮。
   */
  async setViewport(width, height, scale) {
    const s = this.renderScale;
    const maxArea = MAX_FRAME_PIXELS / (s * s);
    let w = Math.round(width);
    let h = Math.round(height);
    if (w * h > maxArea) {
      const k = Math.sqrt(maxArea / (w * h));
      w = Math.floor(w * k);
      h = Math.floor(h * k);
    }
    if (w === this.settings.viewportWidth && h === this.settings.viewportHeight) return false;
    this.settings.viewportWidth = w;
    this.settings.viewportHeight = h;

    for (const page of this.pages.values()) {
      if (!page.ready) continue;
      await this.#applyMetrics(page.sessionId).catch(() => {});
    }
    if (this.streaming) await this.setStreaming(true).catch(() => {});
    return true;
  }

  /** 取出并清零累计流量，供统计落库 */
  drainTraffic() {
    const out = { tx: this.traffic.tx, rx: this.traffic.rx };
    this.traffic.tx = 0;
    this.traffic.rx = 0;
    return out;
  }

  profileSizeBytes() {
    return dirSize(this.profileDir);
  }

  async stop() {
    if (this.status === 'STOPPED') return;
    this.status = 'STOPPING';
    try {
      if (this.cdp && !this.cdp.closed) {
        await this.cdp.send('Browser.close', {}, undefined, 3000).catch(() => {});
        this.cdp.close();
      }
    } catch {
      /* ignore */
    }
    await killTree(this.proc?.pid);
    this.pages.clear();
    this.status = 'STOPPED';
  }
}

/** 递归统计目录大小（用于展示每个用户占用的浏览器数据空间） */
export function dirSize(dir) {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      } catch {
        /* 文件可能在统计期间被删除 */
      }
    }
  }
  return total;
}
