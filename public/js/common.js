/** 前端公共工具：请求封装、提示、格式化 */

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (raw) return res;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `请求失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function toast(message, kind = '') {
  let host = document.getElementById('toast');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast';
    document.body.appendChild(host);
  }
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, 2600);
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  let i = 0;
  let x = v;
  while (x >= 1024 && i < UNITS.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)} ${UNITS[i]}`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - Number(ts);
  if (diff < 15000) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 轻量确认框，替代 window.confirm 以保持视觉一致 */
export function confirmDialog({ title = '请确认', message = '', confirmText = '确认', danger = false } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `
      <div class="modal" style="max-width:420px">
        <div class="modal-head"><h3>${escapeHtml(title)}</h3></div>
        <div class="modal-body"><p style="margin:0;color:var(--ink-2)">${escapeHtml(message)}</p></div>
        <div class="modal-foot">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    const close = (v) => {
      back.remove();
      resolve(v);
    };
    back.addEventListener('click', (e) => {
      if (e.target === back) close(false);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') close(false);
      if (act === 'ok') close(true);
    });
    document.body.appendChild(back);
  });
}
