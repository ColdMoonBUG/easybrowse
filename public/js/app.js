/** 用户工作区：会话启动、远端画面渲染、输入转发、标签页与状态展示 */
import { api, toast, fmtBytes, fmtDuration, fmtTime, escapeHtml, confirmDialog } from './common.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d', { alpha: false });
const stage = $('stage');
const overlay = $('overlay');
const overlayCard = $('overlayCard');
const addrInput = $('addrInput');
const tabstrip = $('tabstrip');
const statusPill = $('statusPill');
const statusText = $('statusText');

const state = {
  user: null,
  meta: null,
  session: null,
  ws: null,
  connected: false,
  connecting: false,
  ended: false,
  viewport: { w: 1280, h: 800 },
  // 远端渲染倍率：帧是「CSS 像素 × 倍率」。服务端 ready 会覆盖成真实值
  renderScale: 2,
  tabs: [],
  traffic: { tx: 0, rx: 0 },
  attempts: 0,
  lastMessageAt: 0,
  pingSentAt: 0,
  rtt: null,
  permissionDenied: false,
  /** 画质挡位：high | medium | low（只影响自己的会话） */
  quality: 'high',
  /** 远端当前焦点是否在输入框（由本次点击后的探测结果决定） */
  remoteEditable: false,
  /** 远端焦点元素的标签名：input / textarea / ''，用于决定「发送」要不要附带回车 */
  remoteTag: '',
  /** 服务端是否支持 text 消息里的 enter 字段（ready.enterKey） */
  serverEnter: false,
};

/* ------------------------------ 右上角实时网络读数 ------------------------------ */
/* 延迟 = ping/pong 往返（2.5s 一次，取平滑值）；码率 = 实际收到的画面字节折算 */
const netmeter = $('netmeter');
const nmPing = $('nmPing');
const nmPingVal = $('nmPingVal');
const nmRateVal = $('nmRateVal');

const net = {
  rtt: null,
  rate: 0,
  rxBytes: 0,
  lastRateAt: 0,
};

const isCompact = () => window.innerWidth <= 560;

function fmtMbps(v) {
  if (!Number.isFinite(v) || v <= 0.005) return isCompact() ? '0M' : '0 Mbps';
  if (v < 1) return isCompact() ? `${Math.round(v * 1000)}k` : `${Math.round(v * 1000)} kbps`;
  if (isCompact()) return `${v >= 10 ? Math.round(v) : v.toFixed(1)}M`;
  return `${v >= 10 ? v.toFixed(1) : v.toFixed(2)} Mbps`;
}

function paintNet() {
  if (!state.connected) {
    netmeter.dataset.state = 'off';
    nmPingVal.textContent = '--';
    nmRateVal.textContent = '--';
    nmPing.dataset.q = 'idle';
    return;
  }
  netmeter.dataset.state = 'on';
  if (net.rtt == null) {
    nmPingVal.textContent = '--';
    nmPing.dataset.q = 'idle';
  } else {
    nmPingVal.textContent = isCompact() ? `${Math.round(net.rtt)}ms` : `${Math.round(net.rtt)} ms`;
    nmPing.dataset.q = net.rtt < 80 ? 'good' : net.rtt < 180 ? 'fair' : 'poor';
  }
  nmRateVal.textContent = fmtMbps(net.rate);
}

/** 每秒结算一次画面码率：静止页面几乎没有帧，值会自然掉到 0 */
setInterval(() => {
  const now = Date.now();
  const dt = net.lastRateAt ? (now - net.lastRateAt) / 1000 : 0;
  net.lastRateAt = now;
  const mbps = dt > 0 ? (net.rxBytes * 8) / dt / 1e6 : 0;
  net.rxBytes = 0;
  // 平滑，数值不至于随单帧跳动
  net.rate = net.rate * 0.45 + mbps * 0.55;
  if (net.rate < 0.01) net.rate = 0;
  paintNet();
}, 1000);

/* ------------------------------ 画质三挡 ------------------------------ */
const QUALITY_LABELS = { high: '高清', medium: '均衡', low: '省流' };
const qualityMenu = $('qualityMenu');
const btnQuality = $('btnQuality');

function loadQualityLevel() {
  try {
    const v = localStorage.getItem('eb_quality_v1');
    if (v && QUALITY_LABELS[v]) return v;
  } catch {
    /* ignore */
  }
  return 'high';
}

function applyQuality(level, { notify = false } = {}) {
  const next = QUALITY_LABELS[level] ? level : 'high';
  state.quality = next;
  $('qLabel').textContent = QUALITY_LABELS[next];
  btnQuality.title = `画质：${QUALITY_LABELS[next]}（点击切换高清 / 均衡 / 省流）`;
  for (const b of qualityMenu.querySelectorAll('.qopt')) b.classList.toggle('on', b.dataset.level === next);
  try {
    localStorage.setItem('eb_quality_v1', next);
  } catch {
    /* ignore */
  }
  if (notify) toast(`画质已切换为「${QUALITY_LABELS[next]}」`);
}

btnQuality.addEventListener('click', (e) => {
  e.stopPropagation();
  $('moreMenu').classList.add('hidden');
  qualityMenu.classList.toggle('hidden');
});

qualityMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('.qopt');
  if (!btn) return;
  qualityMenu.classList.add('hidden');
  const level = btn.dataset.level;
  if (level === state.quality) return;
  applyQuality(level, { notify: true });
  if (!send({ t: 'quality', level })) toast('会话未连接，画质会在连接后生效', 'err');
});

document.addEventListener('click', (e) => {
  if (!qualityMenu.contains(e.target) && !btnQuality.contains(e.target)) qualityMenu.classList.add('hidden');
});

/* ------------------------------ 声音（各听各的） ------------------------------ */
/* 远端浏览器在服务器上静音运行，页面声音由注入钩子采成 24kHz 单声道 PCM，
   只沿当前用户的这条连接送回来，在本地用 WebAudio 排队播放。
   默认关闭：浏览器要求用户手势才能出声，用户点一下扬声器按钮即可。 */
const btnAudio = $('btnAudio');

const audioState = {
  available: true,
  /**
   * 默认开：用户进来就该听到远端页面的声音，不必先去点扬声器按钮。
   * 浏览器的 autoplay 策略要求先有用户手势，所以 AudioContext 会在首次点击/按键时
   * 解锁；解锁之前收到的帧直接丢弃（见 handleAudioFrame），不会在 suspended 状态下排队堆积。
   */
  enabled: true,
  rate: 24000,
  ctx: null,
  gain: null,
  /** 下一段音频应该排到的时间点（AudioContext 时钟） */
  nextAt: 0,
  packets: 0,
  resets: 0,
  /** 最近的音量峰值（0-1），用于排障确认「真的收到声音」而不是静音包 */
  peak: 0,
};

function loadAudioPref() {
  try {
    const v = localStorage.getItem('eb_audio_v1');
    // 从没存过（首次访问 / 换设备）默认开。以前默认关，用户会以为平台没声音。
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

/** 首次用户手势里解锁音频：浏览器不允许没有手势就出声 */
function unlockAudioFromGesture() {
  if (!audioState.enabled) return;
  const ctx = audioState.ctx;
  if (!ctx || ctx.state === 'running') return;
  ctx.resume().catch(() => {});
}

for (const evName of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(evName, unlockAudioFromGesture, { capture: true, passive: true });
}

function ensureAudioCtx() {
  if (audioState.ctx) return audioState.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  audioState.ctx = new AC();
  audioState.gain = audioState.ctx.createGain();
  audioState.gain.gain.value = 1;
  audioState.gain.connect(audioState.ctx.destination);
  audioState.nextAt = 0;
  return audioState.ctx;
}

function setAudioEnabled(on) {
  audioState.enabled = !!on;
  btnAudio.classList.toggle('is-on', !!on);
  btnAudio.title = on ? '声音：开启（点击静音）' : '声音：关闭（点击开启远端页面声音）';
  try {
    localStorage.setItem('eb_audio_v1', on ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (!on) {
    audioState.nextAt = 0;
    if (audioState.ctx && audioState.ctx.state === 'running') audioState.ctx.suspend().catch(() => {});
  }
}

async function toggleAudio() {
  if (!audioState.available) {
    toast('管理员已关闭音频回传', 'err');
    return;
  }
  const next = !audioState.enabled;
  if (next) {
    const ctx = ensureAudioCtx();
    if (!ctx) {
      toast('当前浏览器不支持音频播放', 'err');
      return;
    }
    try {
      await ctx.resume();
    } catch {
      /* ignore */
    }
  }
  if (!send({ t: 'audio', on: next })) {
    toast('会话未连接，声音将在连接后开启', 'err');
    return;
  }
  setAudioEnabled(next);
}

btnAudio.addEventListener('click', toggleAudio);

/** 服务端下发的音频元信息（是否可用 / 采样率 / 当前开关） */
function applyAudioMeta(meta) {
  audioState.available = meta?.available !== false;
  if (meta?.sampleRate) audioState.rate = meta.sampleRate;
  btnAudio.style.display = audioState.available ? '' : 'none';
  if (!audioState.available) {
    setAudioEnabled(false);
    return;
  }
  // 刷新/重连后是新的会话状态（默认关闭）：本地偏好为开就重新请求一次
  const wantOn = loadAudioPref();
  if (wantOn && !meta?.enabled) send({ t: 'audio', on: true });
  else if (!wantOn && meta?.enabled) send({ t: 'audio', on: false });
  setAudioEnabled(wantOn || !!meta?.enabled);
  if (audioState.enabled) {
    // 已有手势历史时可以直接 resume；被浏览器拦住也无妨，下次点按钮会再解锁
    ensureAudioCtx()?.resume().catch(() => {});
  }
}

/** 音频帧：[0x02][uint32 BE 采样率][Int16 LE 单声道 PCM] */
function handleAudioFrame(buffer) {
  if (!audioState.enabled) return;
  const view = new DataView(buffer);
  const rate = view.getUint32(1) || audioState.rate;
  const pcm = new Int16Array(buffer.slice(5));
  if (!pcm.length) return;
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  if (ctx.state !== 'running') {
    // 还没被手势解锁：AudioContext 挂起时 currentTime 不前进，照常排期会把队列
    // 无限拉长（内存涨、解锁后一堆迟到帧一起炸）。这里直接丢，解锁后自然接上。
    ctx.resume().catch(() => {});
    return;
  }
  audioState.rate = rate;

  const buf = ctx.createBuffer(1, pcm.length, rate);
  const ch = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768;
    ch[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  audioState.peak = Math.max(audioState.peak * 0.92, peak);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(audioState.gain);
  const now = ctx.currentTime;
  // 提前 80ms 排期，抵消网络抖动；落后超过 1.2s 说明卡了，直接跳到现在，避免越积越久
  if (audioState.nextAt < now + 0.02) audioState.nextAt = now + 0.08;
  if (audioState.nextAt - now > 1.2) {
    audioState.nextAt = now + 0.08;
    audioState.resets += 1;
  }
  src.start(audioState.nextAt);
  audioState.nextAt += buf.duration;
  audioState.packets += 1;
}

/* ------------------------------ 基础工具 ------------------------------ */

function setStatus(text, kind = 'idle') {
  statusText.textContent = text;
  statusPill.dataset.state = kind;
}

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function normalizeUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (/^(https?|about|chrome|data):/i.test(v)) return v;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(v)) return `http://${v}`;
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(v)) return `http://${v}`;
  if (/^[\w-]+(\.[\w-]+)+([:/?#].*)?$/.test(v) && !/\s/.test(v)) return `https://${v}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(v)}`;
}

function shortId(id) {
  return id ? String(id).slice(0, 8) : '—';
}

/* ------------------------------ 覆盖层 ------------------------------ */

const ICONS = {
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8"/><path d="M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
};

function showOverlay(html) {
  overlayCard.innerHTML = html;
  overlay.classList.remove('hidden');
}
function hideOverlay() {
  overlay.classList.add('hidden');
}

function overlayStart() {
  showOverlay(`
    <div class="overlay-icon">${ICONS.globe}</div>
    <h2>启动我的远程浏览器</h2>
    <p>浏览器运行在服务器上，你在这里看到的是它的实时画面。首次启动通常需要几秒钟。</p>
    <ul class="overlay-steps">
      <li>${ICONS.check}<span>独立浏览器进程，与你自己的电脑完全隔离</span></li>
      <li>${ICONS.check}<span>Cookie、登录态、历史记录长期保留，下次登录自动续上</span></li>
      <li>${ICONS.check}<span>网络出口跟随本机网络，不额外配置代理</span></li>
    </ul>
    <button class="btn btn-primary" id="btnStart">启动浏览器</button>
    <div class="overlay-meta"><span>空闲自动休眠</span><span>数据不丢失</span></div>
  `);
  $('btnStart').addEventListener('click', () => startSession());
  setStatus('未启动', 'idle');
}

function overlayLoading(title, desc) {
  showOverlay(`
    <div class="overlay-loading"><span class="spinner"></span><span>${escapeHtml(title)}</span></div>
    <p style="margin-top:14px">${escapeHtml(desc || '')}</p>
  `);
}

function overlayError(message, { retry = true } = {}) {
  showOverlay(`
    <div class="overlay-icon" style="background:rgba(207,47,47,.14);border-color:rgba(255,120,120,.25)">
      <span style="color:#ff9d9d;display:grid;place-items:center;width:26px;height:26px">${ICONS.alert}</span>
    </div>
    <h2>无法连接远程浏览器</h2>
    <p>${escapeHtml(message)}</p>
    ${retry ? '<button class="btn btn-primary" id="btnRetry">重新尝试</button>' : ''}
  `);
  if (retry) $('btnRetry').addEventListener('click', () => startSession());
  setStatus('连接失败', 'error');
}

function overlayReconnect(message) {
  showOverlay(`
    <div class="overlay-loading"><span class="spinner"></span><span>正在重新连接…</span></div>
    <p style="margin-top:14px">${escapeHtml(message || '网络波动，正在尝试恢复你的会话。浏览器仍在服务器上运行，数据不会丢失。')}</p>
  `);
  setStatus('重连中', 'connecting');
}

function overlayEnded(reason) {
  const reasonMap = {
    user_closed: '你已结束本次会话',
    admin_forced: '管理员已结束本次会话',
    idle_stop: '会话空闲过久，浏览器进程已休眠',
    account_disabled: '账号已被禁用，会话已结束',
    profile_purged: '管理员已清理该账号的浏览数据，会话已结束',
  };
  showOverlay(`
    <div class="overlay-icon">${ICONS.check}</div>
    <h2>${escapeHtml(reasonMap[reason] || '会话已结束')}</h2>
    <p>浏览数据已安全保留（Cookie、登录态、历史记录）。重新启动后会从上次的状态继续。</p>
    <button class="btn btn-primary" id="btnRestart">重新启动浏览器</button>
  `);
  $('btnRestart').addEventListener('click', () => startSession(true));
  setStatus('已结束', 'idle');
}

/* ------------------------------ 会话生命周期 ------------------------------ */

async function startSession(force = false) {
  if (state.connecting) return;
  state.connecting = true;
  state.ended = false;
  overlayLoading('正在为你准备浏览器…', '正在创建隔离的浏览器进程并连接网络出口');
  setStatus('启动中', 'connecting');
  try {
    const res = await api('/api/sessions', { method: 'POST' });
    state.session = res.session;
    $('stSession').textContent = `会话 ${shortId(res.session.id)}`;
    $('stProxy').textContent = res.egress === 'system' ? '出口 跟随本机' : '出口 指定代理';
    $('sessionMode').textContent = res.restored ? '已恢复上次环境' : '独立隔离会话';
    applyViewportHint(res.viewport);
    updateViewportLabel();
    connect(res.ticket, res.session.id);
  } catch (err) {
    state.connecting = false;
    overlayError(err.message);
  }
}

function connect(ticket, sessionId) {
  if (state.ws) {
    try {
      state.ws.onclose = null;
      state.ws.close();
    } catch {
      /* ignore */
    }
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/screen?ticket=${encodeURIComponent(ticket)}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  state.connecting = true;

  ws.onopen = () => {
    state.connecting = false;
    state.connected = true;
    state.attempts = 0;
    state.lastMessageAt = Date.now();
    setStatus('已连接', 'connected');
    hideOverlay();
    canvas.classList.remove('hidden');
    // 手机上输入面板常驻底部；不自动聚焦，避免一连上就弹键盘
    if (persistTextPanel && !textPanel) openTextPanel({ focus: false });
    paintNet();
    send({ t: 'ping' });
    state.pingSentAt = Date.now();
  };

  ws.onmessage = (ev) => {
    state.lastMessageAt = Date.now();
    if (typeof ev.data !== 'string') {
      net.rxBytes += ev.data?.byteLength || 0;
      // 二进制首字节区分类型：1 = 画面帧，2 = 音频 PCM
      if (ev.data?.byteLength > 5 && new Uint8Array(ev.data, 0, 1)[0] === 2) handleAudioFrame(ev.data);
      else handleFrame(ev.data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };

  ws.onclose = () => {
    if (state.ended) return;
    state.connected = false;
    state.connecting = false;
    net.rtt = null;
    net.rate = 0;
    paintNet();
    canvas.classList.add('hidden');
    scheduleReconnect(sessionId);
  };

  ws.onerror = () => {
    /* onclose 统一处理 */
  };
}

function handleMessage(msg) {
  switch (msg.t) {
    case 'ready':
      if (msg.viewport) {
        state.viewport = msg.viewport;
        if (msg.viewport.scale) state.renderScale = msg.viewport.scale;
      }
      if (msg.tabs) renderTabs(msg.tabs);
      if (msg.url && document.activeElement !== addrInput) {
        addrInput.value = msg.url === 'about:blank' ? '' : msg.url;
      }
      if (msg.egress) $('stProxy').textContent = msg.egress === 'system' ? '出口 跟随本机' : '出口 指定代理';
      if (msg.quality) {
        // 服务端挡位和本地偏好不一致时以本地为准同步过去：刷新后保持用户选过的画质
        if (msg.quality !== state.quality) send({ t: 'quality', level: state.quality });
        else applyQuality(msg.quality);
      }
      if (msg.audio) applyAudioMeta(msg.audio);
      // 服务端支持在 text 消息里串行补回车时，前端就不用再自己补一次
      state.serverEnter = !!msg.enterKey;
      paintNet();
      updateViewportLabel();
      hideOverlay();
      canvas.classList.remove('hidden');
      // ready 是服务端消息通道就绪的信号，此时再协商视口才不会丢消息。
      // 之前用固定 400ms 延迟，公网/frp 下经常来不及，整场会话停在 1280×800 被放大——这是「糊」的第二个原因。
      requestAnimationFrame(() => {
        fitCanvas();
        fitRemoteViewport(true);
      });
      break;
    case 'tabs':
      renderTabs(msg.tabs || []);
      break;
    case 'nav':
      if (document.activeElement !== addrInput) addrInput.value = msg.url === 'about:blank' ? '' : msg.url;
      state.remoteEditable = false;
      if (textPanel && textPanelAuto) closeTextPanel({ sendRest: false });
      break;
    case 'focus':
      handleRemoteFocus(msg);
      break;
    case 'viewport':
      state.viewport = { w: msg.w, h: msg.h, scale: msg.scale || state.renderScale };
      if (msg.scale) state.renderScale = msg.scale;
      updateViewportLabel();
      fitCanvas();
      break;
    case 'stats':
      state.traffic = msg.traffic || state.traffic;
      $('stTraffic').textContent = `↓${fmtBytes(state.traffic.rx)} ↑${fmtBytes(state.traffic.tx)}`;
      break;
    case 'pong':
      if (state.pingSentAt) {
        const sample = Date.now() - state.pingSentAt;
        state.pingSentAt = 0;
        state.rtt = sample;
        // 平滑：单次往返抖动大，直接显示会一直跳
        net.rtt = net.rtt == null ? sample : Math.round(net.rtt * 0.6 + sample * 0.4);
        paintNet();
      }
      break;
    case 'quality':
      applyQuality(msg.level);
      break;
    case 'audio':
      if (msg.message) toast(msg.message, 'err');
      if (msg.sampleRate) audioState.rate = msg.sampleRate;
      setAudioEnabled(!!msg.enabled);
      if (msg.enabled) ensureAudioCtx()?.resume().catch(() => {});
      break;
    case 'error':
      toast(msg.message, 'err');
      break;
    case 'blocked':
      toast(msg.reason || '该地址不允许访问', 'err');
      break;
    case 'ended':
      state.ended = true;
      state.connected = false;
      canvas.classList.add('hidden');
      overlayEnded(msg.reason || 'user_closed');
      break;
    default:
      break;
  }
}

function scheduleReconnect(sessionId) {
  if (state.ended) return;
  if (state.attempts >= 8) {
    overlayError('与服务器的连接已断开，请刷新页面后重试。', { retry: false });
    return;
  }
  const delay = Math.min(6000, 800 * 2 ** state.attempts);
  state.attempts += 1;
  overlayReconnect(state.attempts > 2 ? '连接不太稳定，正在继续尝试恢复…' : '');
  setTimeout(async () => {
    if (state.ended) return;
    try {
      const res = await api(`/api/sessions/${encodeURIComponent(sessionId)}/ticket`, { method: 'POST' });
      applyViewportHint(res.viewport);
      connect(res.ticket, sessionId);
    } catch (err) {
      if (err.status === 404) {
        state.session = null;
        let reason = 'idle_stop';
        try {
          const usage = await api('/api/sessions/usage');
          reason = usage.sessions?.[0]?.end_reason || reason;
        } catch {
          /* 取不到原因就用默认文案 */
        }
        overlayEnded(reason);
        setStatus('已结束', 'idle');
      } else {
        scheduleReconnect(sessionId);
      }
    }
  }, delay);
}

async function endSession() {
  const ok = await confirmDialog({
    title: '结束本次会话？',
    message: '浏览器进程将关闭，但 Cookie、登录态、历史记录等浏览数据会完整保留，下次启动可继续使用。',
    confirmText: '结束会话',
    danger: true,
  });
  if (!ok) return;
  state.ended = true;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ t: 'end' }));
  }
  try {
    if (state.session) await api(`/api/sessions/${state.session.id}`, { method: 'DELETE' });
  } catch {
    /* 会话可能已过期 */
  }
  state.connected = false;
  canvas.classList.add('hidden');
  // 会话结束后常驻面板没有意义，收起来，下次连接会重新出现
  if (textPanel) closeTextPanel({ sendRest: false });
  overlayEnded('user_closed');
}

/* ------------------------------ 画面渲染 ------------------------------ */

let pendingBitmap = null;
let decoding = false;
let frameSeq = 0;
let drawnSeq = 0;

function handleFrame(buffer) {
  if (!buffer || buffer.byteLength < 8) return;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== 1) return;
  const metaLen = view.getUint32(1);
  let meta = null;
  try {
    meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 5, metaLen)));
  } catch {
    meta = null;
  }
  if (meta && (meta.w !== state.viewport.w || meta.h !== state.viewport.h)) {
    state.viewport = { w: meta.w, h: meta.h, scale: state.renderScale };
    updateViewportLabel();
  }
  const jpeg = new Uint8Array(buffer, 5 + metaLen);
  frameSeq += 1;
  pendingBitmap = { seq: frameSeq, jpeg };
  pump();
}

async function pump() {
  if (decoding || !pendingBitmap) return;
  decoding = true;
  const { seq, jpeg } = pendingBitmap;
  pendingBitmap = null;
  try {
    const blob = new Blob([jpeg], { type: 'image/jpeg' });
    const bmp = await createImageBitmap(blob);
    if (seq < drawnSeq) {
      bmp.close();
    } else {
      drawnSeq = seq;
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        fitCanvas();
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
    }
  } catch {
    /* 个别帧解析失败可忽略，下一帧会覆盖 */
  } finally {
    decoding = false;
    if (pendingBitmap) pump();
  }
}

function fitCanvas() {
  if (!canvas.width) return;
  const rect = stage.getBoundingClientRect();
  const availW = rect.width - 20;
  const availH = rect.height - 20;
  if (availW <= 0 || availH <= 0) return;
  // 帧是物理像素，先换算成逻辑尺寸，再算缩放比。
  // 这样 1 个物理像素正好落在 1 个屏幕像素上（scale=1），不会二次插值变糊。
  const scale = state.renderScale || 1;
  const baseW = canvas.width / scale;
  const baseH = canvas.height / scale;
  const fit = Math.min(availW / baseW, availH / baseH);
  canvas.style.width = `${Math.floor(baseW * fit)}px`;
  canvas.style.height = `${Math.floor(baseH * fit)}px`;
  // 缩小显示时用高质量插值，避免细线闪断
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

let resizeTimer = null;
function fitRemoteViewport(force = false) {
  const rect = stage.getBoundingClientRect();
  const availW = Math.max(320, rect.width - 20);
  const availH = Math.max(320, rect.height - 20);
  let w = Math.round(availW);
  let h = Math.round(availH);
  // 视口上限 2560×1600：CSS 像素。真正决定清晰度的是下面的设备倍率。
  w = Math.min(2560, Math.max(360, w));
  h = Math.min(1600, Math.max(320, h));
  const sameSize = Math.abs(w - state.viewport.w) < 80 && Math.abs(h - state.viewport.h) < 80;
  if (!force && sameSize) return;
  send({ t: 'viewport', w, h });
}

window.addEventListener('resize', () => {
  fitCanvas();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.connected) fitRemoteViewport();
  }, 600);
});

// 布局变化（如标签条出现、状态栏渲染完成）后重新适配画面尺寸
if (typeof ResizeObserver !== 'undefined') {
  let lastW = 0;
  let lastH = 0;
  const ro = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (!box) return;
    if (Math.abs(box.width - lastW) < 2 && Math.abs(box.height - lastH) < 2) return;
    lastW = box.width;
    lastH = box.height;
    fitCanvas();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.connected) fitRemoteViewport();
    }, 700);
  });
  ro.observe(stage);
}

function updateViewportLabel() {
  const s = state.renderScale || 1;
  const tag = s > 1 ? ` · ${s}x` : '';
  $('stViewport').textContent = `${state.viewport.w}×${state.viewport.h}${tag}`;
}

/** 服务端下发的视口信息（含渲染倍率）统一入口 */
function applyViewportHint(v) {
  if (!v) return;
  state.viewport = { w: v.w, h: v.h, scale: v.scale || state.renderScale };
  if (v.scale) state.renderScale = v.scale;
}

/* ------------------------------ 输入转发 ------------------------------ */

function point(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
  };
}

let drag = null;
let lastMoveAt = 0;

canvas.addEventListener('pointerdown', (e) => {
  if (!state.connected) return;
  // 点一下画面就算手势：音频上下文若被浏览器挂起，这里恢复（全局手势里也有一次，双保险）
  unlockAudioFromGesture();
  canvas.setPointerCapture?.(e.pointerId);
  const p = point(e);
  drag = { x: p.x, y: p.y, lastY: p.y, moved: 0, scrolled: false, type: e.pointerType };
  if (e.pointerType === 'mouse') {
    send({ t: 'mouse', a: 'down', x: p.x, y: p.y, button: e.button === 2 ? 'right' : 'left' });
  } else {
    canvas.style.cursor = 'grabbing';
  }
  e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
  if (!state.connected) return;
  const p = point(e);
  if (!drag) {
    const now = Date.now();
    if (e.pointerType === 'mouse' && now - lastMoveAt > 40) {
      lastMoveAt = now;
      send({ t: 'mouse', a: 'move', x: p.x, y: p.y });
    }
    return;
  }
  const dx = p.x - drag.x;
  const dy = p.y - drag.y;
  drag.moved = Math.max(drag.moved, Math.abs(dx) * canvas.width + Math.abs(dy) * canvas.height);
  if (drag.type === 'touch') {
    if (drag.moved > 8) {
      drag.scrolled = true;
      const delta = -(p.y - drag.lastY) * state.viewport.h * 1.1;
      drag.lastY = p.y;
      if (Math.abs(delta) > 0.5) send({ t: 'wheel', x: p.x, y: p.y, dx: 0, dy: delta });
    }
  } else {
    send({ t: 'mouse', a: 'move', x: p.x, y: p.y, buttons: 1 });
  }
  e.preventDefault();
});

canvas.addEventListener('pointerup', (e) => {
  if (!state.connected) return;
  const p = point(e);
  const wasDrag = drag;
  drag = null;
  canvas.style.cursor = 'default';
  if (!wasDrag) return;
  if (wasDrag.type === 'touch') {
    if (!wasDrag.scrolled) {
      send({ t: 'mouse', a: 'down', x: p.x, y: p.y, button: 'left' });
      setTimeout(() => send({ t: 'mouse', a: 'up', x: p.x, y: p.y, button: 'left' }), 22);
      /*
       * 这里曾经有一次「预判」：只要 state.remoteEditable 为真就在手势内弹键盘。
       * 那是上一次点击的结果——点完搜索框再点链接，remoteEditable 还停在 true，
       * 于是点链接也弹输入法。现在改成等本次点击的探测结果（focus 消息）再决定，
       * 见 handleRemoteFocus。
       */
    }
  } else {
    send({ t: 'mouse', a: 'up', x: p.x, y: p.y, button: e.button === 2 ? 'right' : 'left' });
  }
  e.preventDefault();
});

canvas.addEventListener('pointercancel', () => {
  drag = null;
});

canvas.addEventListener('wheel', (e) => {
  if (!state.connected) return;
  e.preventDefault();
  const p = point(e);
  send({ t: 'wheel', x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY });
}, { passive: false });

canvas.addEventListener('dblclick', (e) => {
  if (!state.connected) return;
  const p = point(e);
  send({ t: 'mouse', a: 'dblclick', x: p.x, y: p.y });
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

const SPECIAL_KEYS = new Set([
  'Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
]);

window.addEventListener('keydown', (e) => {
  if (!state.connected) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

  const mods = { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    pasteFromClipboard();
    return;
  }
  if (SPECIAL_KEYS.has(e.key)) {
    e.preventDefault();
    send({ t: 'key', key: e.key, mods });
    return;
  }
  if (e.key.length === 1) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.altKey) send({ t: 'key', key: e.key, mods });
    else send({ t: 'text', text: e.key });
  }
});

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      send({ t: 'text', text });
      toast('已粘贴到远程页面', 'ok');
    }
  } catch {
    const text = window.prompt('浏览器未授权读取剪贴板，请在此粘贴：');
    if (text) send({ t: 'text', text });
  }
}

/* ------------------------------ 移动端文字输入面板 ------------------------------ */
/*
 * 手机上没有物理键盘，所有文字都得靠这个面板送进远端页面。
 * 三个关键点：
 * 1. 远端页面里的输入框被点中时，服务端会推 focus 消息，这里自动拉起面板；
 * 2. iOS 只认「用户手势内」的 focus()，所以打开时同步 focus 一次，再用 rAF / 延时补两次，
 *    即使键盘没弹，面板也是可见可点的，再点一下 textarea 就能唤起；
 * 3. 键盘弹出后 visualViewport 变矮，用 --kb-offset 把面板顶到键盘上方。
 */
const isTouchDevice = () => window.matchMedia('(hover: none)').matches;

let textPanel = null;
let textPanelAuto = false;
// 手机没有物理键盘：输入面板常驻底部，不随远端焦点变化开合
const persistTextPanel = isTouchDevice();

/** 面板是 fixed 定位，把它的高度写进 --panel-h，让 stage / 状态栏整体上移到面板之上 */
function syncPanelSpace() {
  const wsEl = $('ws');
  if (!wsEl) return;
  if (!textPanel) {
    wsEl.classList.remove('has-textpanel');
    wsEl.style.removeProperty('--panel-h');
    return;
  }
  const h = Math.round(textPanel.getBoundingClientRect().height);
  wsEl.style.setProperty('--panel-h', `${h}px`);
  wsEl.classList.add('has-textpanel');
}

function syncTextPanelOffset() {
  if (!textPanel) return;
  const vv = window.visualViewport;
  const gap = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  textPanel.style.setProperty('--kb-offset', `${Math.round(gap)}px`);
}

function focusTextPanel(force = false) {
  const ta = textPanel?.querySelector('textarea');
  if (!ta) return;
  // iOS：自动打开时的 focus() 不在用户手势里，键盘可能不弹；
  // 此时元素已聚焦，再点它不会触发 focus 事件，先 blur 再 focus 才能把键盘叫出来
  if (force && document.activeElement === ta) ta.blur();
  try {
    ta.focus({ preventScroll: true });
  } catch {
    ta.focus();
  }
}

function closeTextPanel({ sendRest = true } = {}) {
  if (!textPanel) return;
  const ta = textPanel.querySelector('textarea');
  const value = ta?.value || '';
  textPanel.remove();
  textPanel = null;
  textPanelAuto = false;
  panelObserver?.disconnect();
  syncPanelSpace();
  if (sendRest && value) send({ t: 'text', text: value });
}

let panelObserver = null;

function openTextPanel({ auto = false, focus = true } = {}) {
  if (textPanel) {
    textPanelAuto = textPanelAuto && auto;
    if (!auto) focusTextPanel();
    return;
  }
  const persist = persistTextPanel;
  textPanel = document.createElement('div');
  textPanel.className = persist ? 'textpanel is-persist' : 'textpanel';
  textPanel.innerHTML = `
    <textarea rows="1" inputmode="text" enterkeyhint="send" autocapitalize="sentences" spellcheck="false"
      placeholder="${persist ? '在此输入，回车发送' : '输入文字，回车发送'}"></textarea>
    <button class="tp-btn" type="button" id="tpSend">发送</button>
    <button class="tp-close" type="button" id="tpClose" aria-label="${persist ? '收起键盘' : '收起输入面板'}">${persist ? '⌄' : '✕'}</button>
  `;
  document.body.appendChild(textPanel);
  textPanelAuto = auto;

  const ta = textPanel.querySelector('textarea');
  const grow = () => {
    ta.style.height = 'auto';
    const h = ta.value ? Math.min(120, Math.max(40, ta.scrollHeight)) : 40;
    ta.style.height = `${h}px`;
  };
  const submit = () => {
    const v = ta.value;
    if (!v) return;
    /*
     * 必须带 enter：手机键盘的「发送/搜索」键按下去只送文字的话，远端搜索框里
     * 有字但表单没提交，页面就停在原地不跳转——这就是之前「搜了不跳」的原因。
     * 远端焦点是多行 textarea 时不自动回车（那是换行语义，交给 Shift+Enter）。
     */
    const withEnter = state.remoteTag !== 'textarea';
    send({ t: 'text', text: v, enter: withEnter });
    /*
     * 服务端能串行补回车就直接交给它（顺序可靠）；
     * 服务端还是旧版本（ready 里没带 enterKey）时自己补一次，留出 insertText 落地的余量。
     */
    if (withEnter && !state.serverEnter) {
      setTimeout(() => send({ t: 'key', key: 'Enter' }), 80);
    }
    ta.value = '';
    grow();
    focusTextPanel();
  };

  ta.addEventListener('input', grow);
  ta.addEventListener('compositionstart', () => {
    ta.dataset.composing = '1';
  });
  ta.addEventListener('compositionend', () => {
    delete ta.dataset.composing;
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // 中文输入法选词时的回车不能当成发送
    if (e.isComposing || ta.dataset.composing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  });
  // 用 pointerdown + preventDefault：点按钮不抢走 textarea 焦点，键盘不会一收一弹
  textPanel.querySelector('#tpSend').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    submit();
  });
  textPanel.querySelector('#tpClose').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // 常驻模式下这个按钮只收起手机键盘，面板本身不会消失
    if (persist) {
      ta.blur();
      return;
    }
    closeTextPanel({ sendRest: false });
  });
  textPanel.addEventListener('pointerdown', (e) => {
    if (e.target === textPanel) focusTextPanel(true);
  });
  // 面板已聚焦但键盘没弹出来时，再点输入框要能强制唤起
  ta.addEventListener('pointerdown', () => {
    if (!isTouchDevice()) return;
    const vv = window.visualViewport;
    const kbHeight = vv ? window.innerHeight - vv.height - vv.offsetTop : 0;
    if (kbHeight < 120 && document.activeElement === ta) {
      ta.blur();
      ta.focus({ preventScroll: true });
    }
  });

  syncPanelSpace();
  if (typeof ResizeObserver !== 'undefined') {
    panelObserver?.disconnect();
    panelObserver = new ResizeObserver(() => syncPanelSpace());
    panelObserver.observe(textPanel);
  }
  syncTextPanelOffset();
  if (focus) focusTextPanel();
  requestAnimationFrame(() => {
    grow();
    syncPanelSpace();
    if (focus) focusTextPanel();
  });
  if (focus) setTimeout(focusTextPanel, 160);
}

function toggleTextPanel() {
  if (textPanel) closeTextPanel({ sendRest: true });
  else openTextPanel({ auto: false });
}

/**
 * 远端焦点变化 = 本次点击的探测结果（服务端在 mouseReleased 之后才取值并推回）。
 * 只有这一份结果可用于决定「要不要把光标交给输入面板」，不能用上一次的旧状态预判。
 */
function handleRemoteFocus(msg) {
  state.remoteEditable = !!msg.editable;
  state.remoteTag = msg.tag || '';
  if (!isTouchDevice()) return;

  const ta = textPanel?.querySelector('textarea');

  if (!msg.editable) {
    // 点的不是输入框（链接 / 按钮 / 空白）：把还开着的键盘收起来。
    // 这正是「点链接却弹出输入法」的修法——以前用的是上一次点击留下的状态。
    if (!persistTextPanel && textPanel && textPanelAuto && !ta?.value) {
      closeTextPanel({ sendRest: false });
    } else if (ta && document.activeElement === ta) {
      ta.blur();
    }
    return;
  }

  if (document.activeElement === addrInput) return;

  if (persistTextPanel) {
    if (textPanel) {
      /*
       * 光标先落进输入区，让用户看到「可以打字了」。
       * 非用户手势里的 focus() 在 iOS / Android Chrome 上通常不弹软键盘，
       * 所以不强求——用户再点一下输入框时，ta 的 pointerdown 里那次 blur+focus
       * 会落在手势内，键盘就会正常弹出（见下面的 pointerdown 处理器）。
       */
      focusTextPanel();
    } else {
      openTextPanel({ auto: true });
    }
    return;
  }
  openTextPanel({ auto: true });
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncTextPanelOffset);
  window.visualViewport.addEventListener('scroll', syncTextPanelOffset);
}

/* ------------------------------ 工具栏 ------------------------------ */

$('addrForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = normalizeUrl(addrInput.value);
  if (!url) return;
  addrInput.blur();
  if (!send({ t: 'nav', url })) toast('会话未连接', 'err');
});

addrInput.addEventListener('focus', () => addrInput.select());

$('btnBack').addEventListener('click', () => send({ t: 'back' }));
$('btnForward').addEventListener('click', () => send({ t: 'forward' }));
$('btnReload').addEventListener('click', () => send({ t: 'reload' }));
$('btnKeyboard').addEventListener('click', toggleTextPanel);
$('btnFullscreen').addEventListener('click', toggleFullscreen);

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('ws').requestFullscreen();
    setTimeout(fitCanvas, 250);
  } catch {
    toast('当前浏览器不支持全屏', 'err');
  }
}

document.addEventListener('fullscreenchange', () => setTimeout(fitCanvas, 200));

const moreMenu = $('moreMenu');
$('btnMore').addEventListener('click', (e) => {
  e.stopPropagation();
  qualityMenu.classList.add('hidden');
  moreMenu.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!moreMenu.contains(e.target)) moreMenu.classList.add('hidden');
});
moreMenu.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  moreMenu.classList.add('hidden');
  if (act === 'usage') showUsage();
  // 手机上系统剪贴板 API 多半被拒，直接聚焦底部输入框（用键盘自带粘贴更顺）
  if (act === 'paste') {
    if (isTouchDevice()) {
      if (textPanel) focusTextPanel(true);
      else openTextPanel({ auto: false });
    } else {
      pasteFromClipboard();
    }
  }
  if (act === 'chrome') toggleChrome();
  if (act === 'fullscreen') toggleFullscreen();
  if (act === 'end') endSession();
});

/* ------------------------------ 标签页 ------------------------------ */

function renderTabs(tabs) {
  state.tabs = tabs;
  if (!tabs.length) {
    tabstrip.innerHTML = '';
    return;
  }
  tabstrip.innerHTML =
    tabs
      .map(
        (t) => `
      <div class="rtab ${t.active ? 'active' : ''}" data-id="${escapeHtml(t.id)}" title="${escapeHtml(t.url || t.title)}">
        <span class="txt">${escapeHtml(t.title || '新标签页')}</span>
        <span class="x" data-close="${escapeHtml(t.id)}" title="关闭标签页">×</span>
      </div>`,
      )
      .join('') + '<button class="tab-add" id="tabAdd" title="新建标签页">+</button>';

  tabstrip.querySelectorAll('.rtab').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset.close) {
        send({ t: 'tab', a: 'close', id: e.target.dataset.close });
        return;
      }
      send({ t: 'tab', a: 'activate', id: el.dataset.id });
    });
  });
  $('tabAdd')?.addEventListener('click', () => send({ t: 'tab', a: 'new', url: 'about:blank' }));

  const active = tabs.find((t) => t.active);
  document.title = active?.title ? `${active.title} · EasyBrowse` : '我的浏览器 · EasyBrowse';
}

/* ------------------------------ 用量弹窗 ------------------------------ */

async function showUsage() {
  let data;
  try {
    data = await api('/api/sessions/usage');
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  const quota = data.quotaBytes || 0;
  const pct = quota > 0 ? Math.min(100, (data.usedBytes / quota) * 100) : 0;
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  const sessionsRows = (data.sessions || [])
    .slice(0, 6)
    .map(
      (s) => `<tr>
        <td class="mono">${shortId(s.id)}</td>
        <td>${statusLabel(s.status)}</td>
        <td>${fmtTime(s.created_at)}</td>
        <td>${fmtDuration((s.ended_at || Date.now()) - s.created_at)}</td>
        <td class="mono">${fmtBytes((s.tx_bytes || 0) + (s.rx_bytes || 0))}</td>
      </tr>`,
    )
    .join('');
  back.innerHTML = `
    <div class="modal" style="max-width:560px">
      <div class="modal-head"><h3>我的用量</h3><button class="icon-btn" data-close="1">✕</button></div>
      <div class="modal-body">
        <div class="usage-grid">
          <div class="usage-cell"><div class="k">今日流量</div><div class="v">${fmtBytes(data.today.total)}</div></div>
          <div class="usage-cell"><div class="k">累计流量</div><div class="v">${fmtBytes(data.usedBytes)}</div></div>
        </div>
        <div style="font-size:12.5px;color:var(--ink-3);margin-bottom:4px">
          流量额度：${quota > 0 ? `${fmtBytes(data.usedBytes)} / ${fmtBytes(quota)}` : '不限额'}
        </div>
        ${quota > 0 ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}
        <div style="font-size:11.5px;color:var(--ink-4);margin-bottom:16px">
          仅统计远端浏览器访问互联网的字节数，不含画面传输流量。
        </div>
        <div style="font-size:13px;font-weight:560;margin-bottom:8px">最近会话</div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>会话</th><th>状态</th><th>开始时间</th><th>时长</th><th>流量</th></tr></thead>
            <tbody>${sessionsRows || '<tr><td colspan="5" class="empty">暂无记录</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <div class="modal-foot"><button class="btn" data-close="1">关闭</button></div>
    </div>`;
  back.addEventListener('click', (e) => {
    if (e.target === back || e.target.closest('[data-close]')) back.remove();
  });
  document.body.appendChild(back);
}

function statusLabel(s) {
  const map = {
    CREATING: '<span class="badge badge-warn">创建中</span>',
    RUNNING: '<span class="badge badge-ok">运行中</span>',
    DISCONNECTED: '<span class="badge">已断开</span>',
    IDLE: '<span class="badge">空闲</span>',
    STOPPED: '<span class="badge">已结束</span>',
    ERROR: '<span class="badge badge-danger">异常</span>',
  };
  return map[s] || `<span class="badge">${escapeHtml(s)}</span>`;
}

/* ------------------------------ 初始化 ------------------------------ */

$('btnLogout').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  location.href = '/login';
});

async function init() {
  overlayLoading('正在加载工作区…', '');
  try {
    const [me, meta, current] = await Promise.all([api('/api/auth/me'), api('/api/meta'), api('/api/sessions/current')]);
    state.user = me.user;
    state.meta = meta;
    $('uname').textContent = me.user.username;
    $('avatar').textContent = me.user.username.slice(0, 1).toUpperCase();
    if (meta?.siteName) $('brandName').textContent = meta.siteName;

    if (current.session) {
      $('stSession').textContent = `会话 ${shortId(current.session.id)}`;
      $('sessionMode').textContent = '已恢复上次环境';
    }
    if (current.session && current.session.live) {
      // 刷新页面后自动恢复到正在运行的会话
      overlayLoading('正在恢复你的浏览器…', '检测到正在运行的会话，正在重新连接画面');
      setStatus('连接中', 'connecting');
      const res = await api('/api/sessions', { method: 'POST' });
      state.session = res.session;
      applyViewportHint(res.viewport);
      updateViewportLabel();
      connect(res.ticket, res.session.id);
    } else if (current.session && (current.session.status === 'DISCONNECTED' || current.session.status === 'IDLE')) {
      state.session = current.session;
      overlayStart();
    } else {
      overlayStart();
    }
  } catch (err) {
    if (err.status === 401) {
      location.href = '/login';
      return;
    }
    overlayError(err.message);
  }
}

// 心跳与断线检测
setInterval(() => {
  if (!state.connected) {
    paintNet();
    return;
  }
  if (Date.now() - state.lastMessageAt > 30000) {
    try {
      state.ws?.close();
    } catch {
      /* ignore */
    }
    return;
  }
  // 上一次 ping 8 秒都没回来：链路已经不健康，延迟先显示 --
  if (state.pingSentAt && Date.now() - state.pingSentAt > 8000) {
    net.rtt = null;
    paintNet();
  }
  state.pingSentAt = Date.now();
  send({ t: 'ping' });
}, 2500);

window.addEventListener('beforeunload', () => {
  // 只断开画面连接，浏览器进程与数据留在服务端
  try {
    state.ws?.close();
  } catch {
    /* ignore */
  }
});

/* ------------------------------ 沉浸模式：顶部控制区自动收起 ------------------------------ */
/* 目标：进入工作区就只看画面。顶栏 / 地址栏 / 标签条整体作为浮层收起，
   鼠标贴到窗口最上沿（或触屏点顶部）再拉下来，离开后自动收起。 */
const wsRoot = $('ws');
const chromeBar = $('chrome');
const chromeSensor = $('chromeSensor');
let chromeHideTimer = null;

function setChromeHidden(hidden) {
  wsRoot.classList.toggle('is-immersive', hidden);
}

function cancelHideChrome() {
  if (chromeHideTimer) {
    clearTimeout(chromeHideTimer);
    chromeHideTimer = null;
  }
}

function revealChrome() {
  cancelHideChrome();
  setChromeHidden(false);
}

/** 延时收起；正在地址栏输入时不收。手机上控制栏常显，不参与自动收起 */
function scheduleHideChrome(delay = 1500) {
  if (isTouchDevice()) return;
  if (chromeHideTimer) return;
  chromeHideTimer = setTimeout(() => {
    chromeHideTimer = null;
    if (chromeBar.contains(document.activeElement)) return;
    setChromeHidden(true);
  }, delay);
}

/** 手机上手动收起 / 展开控制栏（走「更多」菜单或顶部感应条） */
function toggleChrome() {
  if (wsRoot.classList.contains('is-immersive')) revealChrome();
  else setChromeHidden(true);
}

// 用鼠标坐标判断，而不是依赖 :hover / mouseleave——
// 合成事件和快速移动下 mouseleave 不一定触发，会导致收起逻辑卡死。
document.addEventListener(
  'mousemove',
  (e) => {
    const y = e.clientY;
    if (y <= 9) {
      revealChrome();
      return;
    }
    if (wsRoot.classList.contains('is-immersive')) return;
    if (y > chromeBar.getBoundingClientRect().bottom) scheduleHideChrome();
    else cancelHideChrome();
  },
  { passive: true },
);

chromeBar.addEventListener('mouseenter', revealChrome);
chromeBar.addEventListener('mouseleave', () => scheduleHideChrome());

// 触屏没有 hover：点顶部感应条切换
chromeSensor.addEventListener('click', toggleChrome);

// 打开更多菜单时不要收起（菜单在控制区内，但避免误收）
$('btnMore').addEventListener('click', revealChrome);

// 手机默认常显控制栏（没有 hover，自动收起后地址栏和按钮都很难再找到），
// 想全屏看画面时再从「更多 → 收起控制栏」手动收起，点顶部把手可再拉下来。
if (window.matchMedia('(hover: none)').matches) {
  revealChrome();
}

// 首次进入提示一次（触屏和鼠标说法不同）
try {
  if (!localStorage.getItem('eb_chrome_hint_v2')) {
    localStorage.setItem('eb_chrome_hint_v2', '1');
    const touchOnly = !window.matchMedia('(hover: hover)').matches;
    setTimeout(
      () => toast(touchOnly ? '底部输入框常驻，可直接输入；点页面里的输入框会自动聚焦' : '鼠标移到窗口最上沿，可显示地址栏与标签页'),
      1500,
    );
  }
} catch {
  /* ignore */
}

// 排障用：控制台里 window.__ebDiag() 可看到画质/音频/网络的实时状态
window.__ebDiag = () => ({
  quality: state.quality,
  audio: {
    available: audioState.available,
    enabled: audioState.enabled,
    rate: audioState.rate,
    packets: audioState.packets,
    resets: audioState.resets,
    peak: Number(audioState.peak.toFixed(3)),
    ctx: audioState.ctx?.state || 'none',
    nextAt: Number(audioState.nextAt.toFixed(2)),
    ctxTime: Number((audioState.ctx?.currentTime || 0).toFixed(2)),
  },
  net: { rtt: net.rtt, rate: Number(net.rate.toFixed(2)) },
  viewport: state.viewport,
});

// 画质偏好是本地的：先按上次选择渲染按钮，连上后再和服务端对齐
applyQuality(loadQualityLevel());
paintNet();

init();
