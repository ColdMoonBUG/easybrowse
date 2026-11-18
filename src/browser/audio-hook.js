/**
 * 远端页面音频采集（注入到用户正在浏览的页面里执行）。
 *
 * 为什么用这种方式：
 * - 浏览器跑在服务器上，声音默认从服务器声卡播出（别人看视频，管理员这边就响）。
 * - 平台只推画面（Page.startScreencast 不含音频），因此「各听各的」需要单独把音频取出来，
 *   沿用户自己的连接送回他的浏览器里播放。
 * - Chrome 的新版本已经不再支持 --load-extension 加载未打包扩展，tabCapture 路线走不通；
 *   这里直接在页面世界里挂钩 AudioContext 与 media 元素，把声音旁路到一条静音的采集链路上。
 *
 * 能捕到：页面 WebAudio（游戏、播放器）、同源媒体、MSE 流（B 站 / YouTube / Netflix 等主流视频站）。
 * 捕不到：未声明 crossorigin 的跨域直链媒体（浏览器安全策略会把这类音轨静音）。
 *
 * 数据出口走 CDP 的 Runtime.addBinding：页面调用 window.__ebAudio(base64)，
 * 服务端在 Runtime.bindingCalled 事件里拿到，不经过页面网络栈，因此不受站点 CSP 影响。
 */
export const AUDIO_SAMPLE_RATE = 24000;

/**
 * 生成注入脚本。autoStart 决定「新文档里的钩子是否直接开始采集」：
 * 用户开着声音时导航到下一页，新页面必须自动继续采集，否则会出现「跳转后没声音」。
 *
 * 注意：这段代码会被原样注入页面，只能用 ES5 语法（老站点的 polyfill 环境更稳），
 * 且不能出现反引号与模板插值，避免破坏外层模板字符串。
 */
export function buildAudioHookSource(autoStart = false) {
  return `(function () {
  if (window.__ebAudioHook) return;
  window.__ebAudioHook = true;

  var OUT_RATE = ${AUDIO_SAMPLE_RATE};
  var ctx = null;
  var mix = null;
  var proc = null;
  var sink = null;
  var running = ${autoStart ? 'true' : 'false'};

  function b64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function ensure() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch (e) {
      return null;
    }
    mix = ctx.createGain();
    mix.gain.value = 1;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(11000, OUT_RATE * 0.45);
    proc = ctx.createScriptProcessor(1024, 2, 1);
    var ratio = Math.max(1, (ctx.sampleRate || OUT_RATE) / OUT_RATE);

    proc.onaudioprocess = function (e) {
      if (!running || !window.__ebAudio) return;
      var L = e.inputBuffer.getChannelData(0);
      var R = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : L;
      var n = Math.floor(L.length / ratio);
      if (n < 1) return;
      var out = new Int16Array(n);
      for (var i = 0; i < n; i++) {
        var idx = Math.floor(i * ratio);
        var v = (L[idx] + R[idx]) * 0.5;
        if (v > 1) v = 1;
        else if (v < -1) v = -1;
        out[i] = v * 32767;
      }
      try {
        window.__ebAudio(b64(new Uint8Array(out.buffer)));
      } catch (err) {}
    };

    mix.connect(lp);
    lp.connect(proc);
    // 必须连到 destination，ScriptProcessor 才会被调度；sink 增益 0，所以不会出声
    sink = ctx.createGain();
    sink.gain.value = 0;
    proc.connect(sink);
    sink.connect(ctx.destination);
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    return ctx;
  }

  // 1) 页面自己的 WebAudio：节点连到 destination 时，额外旁路一份到采集链路。
  //    页面常用独立的 AudioContext，跨 context 不能直连，用 MediaStreamDestination 过桥。
  var origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target) {
    try {
      if (target && this.context && target === this.context.destination) {
        var pageCtx = this.context;
        if (ensure()) {
          if (pageCtx === ctx) {
            origConnect.call(this, mix);
          } else {
            if (!pageCtx.__ebDest) {
              pageCtx.__ebDest = pageCtx.createMediaStreamDestination();
              var bridge = ctx.createMediaStreamSource(pageCtx.__ebDest.stream);
              bridge.connect(mix);
            }
            origConnect.call(this, pageCtx.__ebDest);
          }
        }
      }
    } catch (e) {}
    return origConnect.apply(this, arguments);
  };

  // 2) media 元素：优先 captureStream（不打断原播放），音轨还没就绪时下次扫描再试
  function hookMedia(el) {
    if (!el || el.__ebHooked) return;
    // 元素还没真正开始播放时，captureStream 给到的是空流，接了也没声音。
    // 等它开始出数据（paused=false 或已缓冲到可播）再接。
    if (el.paused && el.readyState < 2) return;
    // 刚开播的头几百毫秒轨道里还是空的，等它真正出流再接，否则会一直静音
    if (!el.paused && el.currentTime < 0.35) {
      if (!el.__ebTimer) {
        el.__ebTimer = setTimeout(function () {
          el.__ebTimer = null;
          hookMedia(el);
        }, 400);
      }
      return;
    }
    if (!ensure()) return;
    // 首选元素音源：MSE / 同源媒体都能拿到真实数据。
    // 注意 captureStream 的音轨有时是「有轨道但没数据」，所以它只作回退。
    try {
      el.__ebSrc = ctx.createMediaElementSource(el);
      el.__ebSrc.connect(mix);
      el.__ebHooked = true;
      return;
    } catch (e) {}
    // 元素已被站点自己接管（同一个元素只能建一次音源）时，退回 captureStream
    try {
      var stream = el.captureStream ? el.captureStream() : null;
      if (stream && stream.getAudioTracks && stream.getAudioTracks().length) {
        el.__ebSrc = ctx.createMediaStreamSource(stream);
        el.__ebSrc.connect(mix);
        el.__ebHooked = true;
      }
    } catch (e) {}
  }

  var origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    hookMedia(this);
    return origPlay.apply(this, arguments);
  };
  var mediaEvent = function (e) {
    if (e.target && e.target.tagName && /^(AUDIO|VIDEO)$/.test(e.target.tagName)) hookMedia(e.target);
  };
  document.addEventListener('play', mediaEvent, true);
  document.addEventListener('loadeddata', mediaEvent, true);
  document.addEventListener('canplay', mediaEvent, true);
  document.addEventListener('playing', mediaEvent, true);
  var scan = function () {
    var list = document.querySelectorAll('audio,video');
    for (var i = 0; i < list.length; i++) hookMedia(list[i]);
  };
  if (document.readyState !== 'loading') scan();
  document.addEventListener('DOMContentLoaded', scan);
  setInterval(scan, 800);

  // 3) 开关：服务端在用户点开声音 / 页面导航后调用
  window.__ebAudioStart = function () {
    running = true;
    if (ensure() && ctx.state === 'suspended') ctx.resume().catch(function () {});
    scan();
    return true;
  };
  window.__ebAudioStop = function () {
    running = false;
    return true;
  };
  window.__ebAudioState = function () {
    return { running: running, rate: OUT_RATE, sampleRate: ctx ? ctx.sampleRate : 0, state: ctx ? ctx.state : 'none' };
  };
})();`;
}

/** 默认（不自动采集）版本，保留给直接引用的场景 */
export const AUDIO_HOOK_SOURCE = buildAudioHookSource(false);
