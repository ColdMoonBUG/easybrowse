/** 管理后台：单页应用（hash 路由） */
import { api, toast, fmtBytes, fmtTime, fmtDate, fmtDuration, relTime, escapeHtml, confirmDialog } from './common.js';

const view = document.getElementById('view');
const pageTitle = document.getElementById('pageTitle');
const pageSub = document.getElementById('pageSub');
const headActions = document.getElementById('headActions');
const nav = document.getElementById('sideNav');

const state = { me: null, users: [] };

/* ------------------------------ 通用组件 ------------------------------ */

function setHead(title, sub, actionsHtml = '') {
  pageTitle.textContent = title;
  pageSub.textContent = sub;
  headActions.innerHTML = actionsHtml;
}

function openModal(html, { width = 480 } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal" style="max-width:${width}px">${html}</div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener('click', (e) => {
    if (e.target === back || e.target.closest('[data-close]')) close();
  });
  return { el: back, close };
}

const STATUS_BADGE = {
  CREATING: '<span class="badge badge-warn"><span class="dot"></span>创建中</span>',
  RUNNING: '<span class="badge badge-ok"><span class="dot"></span>运行中</span>',
  DISCONNECTED: '<span class="badge"><span class="dot"></span>已断开</span>',
  IDLE: '<span class="badge"><span class="dot"></span>空闲</span>',
  STOPPED: '<span class="badge">已结束</span>',
  ERROR: '<span class="badge badge-danger">异常</span>',
};

function statusBadge(s) {
  return STATUS_BADGE[s] || `<span class="badge">${escapeHtml(s)}</span>`;
}

function userStatusBadge(u) {
  if (u.status === 'disabled') return '<span class="badge badge-danger">已禁用</span>';
  if (u.expiresAt && u.expiresAt < Date.now()) return '<span class="badge badge-warn">已过期</span>';
  return '<span class="badge badge-ok">正常</span>';
}

/* ------------------------------ 概览 ------------------------------ */

async function renderDashboard() {
  setHead('概览', '平台运行状态与资源概览', '<button class="btn btn-sm" id="btnRefresh">刷新</button>');
  const d = await api('/api/admin/dashboard');
  document.getElementById('navSessions').textContent = String(d.activeSessions);
  document.getElementById('btnRefresh').addEventListener('click', () => renderDashboard());

  const memUsed = d.host.memTotal - d.host.memFree;
  const memPct = (memUsed / d.host.memTotal) * 100;
  const diskPct = d.host.disk ? ((d.host.disk.total - d.host.disk.free) / d.host.disk.total) * 100 : null;
  const slotPct = Math.min(100, (d.onlineUsers / Math.max(1, d.limits.maxConcurrentSessions)) * 100);

  view.innerHTML = `
    ${
      !d.limits.chromeConfigured
        ? `<div class="notice">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/></svg>
            <span>当前使用系统自动探测的 Chrome/Edge 路径。如需指定自定义 Chromium，请设置环境变量 <code>CHROME_PATH</code> 后重启服务。</span>
           </div>`
        : ''
    }

    <div class="stat-grid">
      <div class="stat accent">
        <div class="k">在线用户</div>
        <div class="v">${d.onlineUsers} <span style="font-size:13px;color:var(--ink-3);font-weight:500">/ ${d.limits.maxConcurrentSessions}</span></div>
        <div class="d">浏览器实例并发上限 ${d.limits.maxConcurrentSessions}</div>
        <span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="8" r="3.4"/><path d="M5.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"/></svg></span>
      </div>
      <div class="stat">
        <div class="k">活动会话</div>
        <div class="v">${d.activeSessions}</div>
        <div class="d">含创建中与断线待恢复</div>
        <span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="3" y="4.5" width="18" height="13" rx="2"/><path d="M8 21h8"/></svg></span>
      </div>
      <div class="stat">
        <div class="k">今日流量</div>
        <div class="v">${fmtBytes(d.todayBytes)}</div>
        <div class="d">仅统计浏览器访问互联网的字节</div>
        <span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg></span>
      </div>
      <div class="stat">
        <div class="k">累计流量</div>
        <div class="v">${fmtBytes(d.totalBytes)}</div>
        <div class="d">账号总数 ${d.totalUsers}</div>
        <span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7"/></svg></span>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <h3>实时会话</h3>
          <a href="#/sessions" style="font-size:12.5px">查看全部 →</a>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>用户</th><th>状态</th><th>开始时间</th><th>持续</th><th>流量</th></tr></thead>
            <tbody>
              ${
                d.sessions.length
                  ? d.sessions
                      .map(
                        (s) => `<tr>
                          <td><b>${escapeHtml(s.username)}</b></td>
                          <td>${statusBadge(s.status)}</td>
                          <td class="muted">${fmtTime(s.createdAt)}</td>
                          <td>${fmtDuration(Date.now() - s.createdAt)}</td>
                          <td class="mono">${fmtBytes((s.txBytes || 0) + (s.rxBytes || 0))}</td>
                        </tr>`,
                      )
                      .join('')
                  : '<tr><td colspan="5" class="empty">当前没有活动会话</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>主机资源</h3><span class="chip">${escapeHtml(d.host.platform)}</span></div>
        <div class="card-body">
          <div class="meter ${slotPct > 80 ? 'warn' : ''}">
            <div class="top"><span>会话槽位</span><span>${d.onlineUsers} / ${d.limits.maxConcurrentSessions}</span></div>
            <div class="bar"><i style="width:${slotPct.toFixed(0)}%"></i></div>
          </div>
          <div class="meter ${memPct > 85 ? 'warn' : ''}">
            <div class="top"><span>内存占用</span><span>${fmtBytes(memUsed)} / ${fmtBytes(d.host.memTotal)}</span></div>
            <div class="bar"><i style="width:${memPct.toFixed(0)}%"></i></div>
          </div>
          ${
            diskPct !== null
              ? `<div class="meter ${diskPct > 88 ? 'warn' : ''}">
                  <div class="top"><span>磁盘占用</span><span>${fmtBytes(d.host.disk.total - d.host.disk.free)} / ${fmtBytes(d.host.disk.total)}</span></div>
                  <div class="bar"><i style="width:${diskPct.toFixed(0)}%"></i></div>
                </div>`
              : ''
          }
          <div class="kv"><span class="k">CPU 核心</span><span class="v">${d.host.cpuCount} 核 · 负载 ${d.host.loadAvg[0]?.toFixed(2) ?? '—'}</span></div>
          <div class="kv"><span class="k">运行时长</span><span class="v">${fmtDuration(d.host.uptime * 1000)}</span></div>
          <div class="kv"><span class="k">Node 版本</span><span class="v mono">${escapeHtml(d.host.nodeVersion)}</span></div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>最近操作</h3><a href="#/audit" style="font-size:12.5px">完整日志 →</a></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>来源 IP</th></tr></thead>
          <tbody>
            ${
              d.recentAudit.length
                ? d.recentAudit
                    .map(
                      (l) => `<tr>
                        <td class="muted">${fmtTime(l.created_at)}</td>
                        <td>${escapeHtml(l.actor_name || '系统')}</td>
                        <td><span class="log-action">${escapeHtml(l.action)}</span></td>
                        <td>${escapeHtml(l.target_name || l.session_id?.slice(0, 8) || '—')}</td>
                        <td class="mono muted">${escapeHtml(l.ip_address || '—')}</td>
                      </tr>`,
                    )
                    .join('')
                : '<tr><td colspan="5" class="empty">暂无记录</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* ------------------------------ 用户管理 ------------------------------ */

async function renderUsers() {
  setHead('用户管理', '创建账号、分配额度与并发上限、重置密码', '<button class="btn btn-primary btn-sm" id="btnNewUser">新建用户</button>');
  const data = await api('/api/admin/users');
  state.users = data.users;
  document.getElementById('btnNewUser').addEventListener('click', () => userModal());

  view.innerHTML = `
    <div class="notice">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8l.01 0M11 12h1v5h1"/></svg>
      <span>每个用户的浏览器数据（Cookie、登录态、历史记录、下载文件）独立存放且默认长期保留；删除账号时可选择一并清理其浏览数据。</span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>用户名</th><th>角色</th><th>状态</th><th>并发</th><th>流量额度</th><th>有效期</th><th>最近登录</th><th style="text-align:right">操作</th>
            </tr>
          </thead>
          <tbody>
            ${
              data.users.length
                ? data.users.map(userRow).join('')
                : '<tr><td colspan="8" class="empty">还没有用户，点击右上角新建</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  view.querySelectorAll('[data-uid]').forEach((btn) => {
    btn.addEventListener('click', () => userAction(btn.dataset.act, btn.dataset.uid));
  });
}

function userRow(u) {
  const quota = u.quotaBytes > 0 ? `${fmtBytes(u.usedBytes)} / ${fmtBytes(u.quotaBytes)}` : '不限额';
  return `<tr>
    <td>
      <div style="font-weight:560">${escapeHtml(u.username)}</div>
      ${u.online ? '<div style="font-size:11px;color:var(--ok)">● 浏览器运行中</div>' : u.note ? `<div style="font-size:11px;color:var(--ink-4)">${escapeHtml(u.note)}</div>` : ''}
    </td>
    <td>${u.role === 'admin' ? '<span class="badge badge-brand">管理员</span>' : '<span class="badge">普通用户</span>'}</td>
    <td>${userStatusBadge(u)}</td>
    <td class="mono">${u.maxSessions}</td>
    <td class="mono" style="font-size:11.5px">${quota}</td>
    <td class="muted">${u.expiresAt ? fmtDate(u.expiresAt) : '长期有效'}</td>
    <td class="muted">${u.lastLoginAt ? relTime(u.lastLoginAt) : '从未登录'}</td>
    <td>
      <div class="row-actions">
        <button class="link-btn" data-act="edit" data-uid="${u.id}">编辑</button>
        <button class="link-btn" data-act="pwd" data-uid="${u.id}">重置密码</button>
        <button class="link-btn" data-act="toggle" data-uid="${u.id}">${u.status === 'disabled' ? '启用' : '禁用'}</button>
        <button class="link-btn danger" data-act="del" data-uid="${u.id}">删除</button>
      </div>
    </td>
  </tr>`;
}

async function userAction(act, id) {
  const u = state.users.find((x) => x.id === id);
  if (!u) return;
  if (act === 'edit') return userModal(u);
  if (act === 'pwd') {
    const ok = await confirmDialog({
      title: `重置 ${u.username} 的密码`,
      message: '系统将生成一个新的随机密码并显示一次，请线下告知该用户。',
      confirmText: '生成新密码',
    });
    if (!ok) return;
    const res = await api(`/api/admin/users/${id}/reset-password`, { method: 'POST' });
    return showPassword(`用户 ${u.username} 的新密码`, res.password);
  }
  if (act === 'toggle') {
    await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { status: u.status === 'disabled' ? 'active' : 'disabled' } });
    toast(u.status === 'disabled' ? '账号已启用' : '账号已禁用，其会话已结束', 'ok');
    return renderUsers();
  }
  if (act === 'del') {
    const ok = await confirmDialog({
      title: `删除用户 ${u.username}？`,
      message: '账号会被停用并立即结束会话。其浏览器数据仍保留在服务器上，如需彻底清理请到「浏览数据」中执行清理。',
      confirmText: '删除账号',
      danger: true,
    });
    if (!ok) return;
    await api(`/api/admin/users/${id}`, { method: 'DELETE' });
    toast('账号已停用', 'ok');
    return renderUsers();
  }
}

function showPassword(title, password) {
  const m = openModal(`
    <div class="modal-head"><h3>${escapeHtml(title)}</h3><button class="icon-btn" data-close="1">✕</button></div>
    <div class="modal-body">
      <p style="margin:0 0 10px;color:var(--ink-2);font-size:13px">密码只在此处显示一次，请立即复制并通过安全渠道交给用户。</p>
      <div class="code-box" id="pwdBox" style="color:#d7e3ff;font-size:15px;letter-spacing:.5px">${escapeHtml(password)}</div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close="1">关闭</button>
      <button class="btn btn-primary" id="btnCopyPwd">复制密码</button>
    </div>`);
  m.el.querySelector('#btnCopyPwd').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast('已复制到剪贴板', 'ok');
    } catch {
      toast('复制失败，请手动选择文本复制', 'err');
    }
  });
}

function userModal(user = null) {
  const isEdit = !!user;
  const m = openModal(`
    <div class="modal-head"><h3>${isEdit ? '编辑用户' : '新建用户'}</h3><button class="icon-btn" data-close="1">✕</button></div>
    <div class="modal-body">
      <div class="form-error hidden" id="uErr"></div>
      <div class="field">
        <label>用户名</label>
        <input class="input" id="fUsername" ${isEdit ? 'disabled' : ''} value="${isEdit ? escapeHtml(user.username) : ''}" placeholder="3-32 位字母、数字、下划线" />
      </div>
      ${
        isEdit
          ? ''
          : `<div class="field">
              <label>初始密码</label>
              <input class="input" id="fPassword" placeholder="留空则自动生成随机密码" />
              <div class="hint">随便设，不强制大小写或符号</div>
            </div>`
      }
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div class="field">
          <label>并发会话数</label>
          <input class="input" id="fMaxSessions" type="number" min="1" max="10" value="${isEdit ? user.maxSessions : 1}" />
        </div>
        <div class="field">
          <label>流量额度（GB，0 为不限）</label>
          <input class="input" id="fQuota" type="number" min="0" step="1" value="${isEdit ? (user.quotaBytes / 1024 / 1024 / 1024).toFixed(0) : 0}" />
        </div>
      </div>
      <div class="field">
        <label>账号有效期（留空为长期）</label>
        <input class="input" id="fExpires" type="date" value="${isEdit && user.expiresAt ? new Date(user.expiresAt).toISOString().slice(0, 10) : ''}" />
      </div>
      <div class="field">
        <label>备注</label>
        <input class="input" id="fNote" value="${isEdit ? escapeHtml(user.note || '') : ''}" placeholder="例如：市场部 张三" />
      </div>
      <div class="field" style="margin-bottom:0">
        <label>角色</label>
        <select class="select" id="fRole">
          <option value="user" ${isEdit && user.role === 'user' ? 'selected' : ''}>普通用户</option>
          <option value="admin" ${isEdit && user.role === 'admin' ? 'selected' : ''}>管理员</option>
        </select>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close="1">取消</button>
      <button class="btn btn-primary" id="btnSaveUser">${isEdit ? '保存' : '创建用户'}</button>
    </div>`, { width: 520 });

  m.el.querySelector('#btnSaveUser').addEventListener('click', async () => {
    const errBox = m.el.querySelector('#uErr');
    errBox.classList.add('hidden');
    const body = {
      role: m.el.querySelector('#fRole').value,
      maxSessions: Number(m.el.querySelector('#fMaxSessions').value) || 1,
      quotaBytes: Math.round((Number(m.el.querySelector('#fQuota').value) || 0) * 1024 * 1024 * 1024),
      note: m.el.querySelector('#fNote').value,
      expiresAt: m.el.querySelector('#fExpires').value ? new Date(m.el.querySelector('#fExpires').value + 'T23:59:59').getTime() : null,
    };
    try {
      if (isEdit) {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body });
        toast('已保存', 'ok');
      } else {
        body.username = m.el.querySelector('#fUsername').value.trim();
        const pwd = m.el.querySelector('#fPassword').value;
        if (pwd) body.password = pwd;
        const res = await api('/api/admin/users', { method: 'POST', body });
        toast('用户已创建', 'ok');
        m.close();
        if (res.initialPassword) showPassword(`用户 ${res.user.username} 的初始密码`, res.initialPassword);
        return renderUsers();
      }
      m.close();
      renderUsers();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  });
}

/* ------------------------------ 会话管理 ------------------------------ */

async function renderSessions() {
  setHead('会话管理', '查看全部浏览器会话，必要时可强制结束', '<button class="btn btn-sm" id="btnRefresh">刷新</button>');
  const data = await api('/api/admin/sessions?limit=100');
  document.getElementById('navSessions').textContent = String(data.sessions.filter((s) => s.live).length);
  document.getElementById('btnRefresh').addEventListener('click', () => renderSessions());

  view.innerHTML = `
    <div class="card">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>会话</th><th>用户</th><th>状态</th><th>开始时间</th><th>持续</th><th>上下行</th><th>结束原因</th><th style="text-align:right">操作</th></tr>
          </thead>
          <tbody>
            ${
              data.sessions.length
                ? data.sessions
                    .map((s) => {
                      const live = ['RUNNING', 'DISCONNECTED', 'CREATING', 'IDLE'].includes(s.status);
                      return `<tr>
                        <td class="mono">${s.id.slice(0, 8)}</td>
                        <td><b>${escapeHtml(s.username)}</b></td>
                        <td>${statusBadge(s.status)}</td>
                        <td class="muted">${fmtTime(s.createdAt)}</td>
                        <td>${fmtDuration((s.endedAt || Date.now()) - s.createdAt)}</td>
                        <td class="mono" style="font-size:11.5px">↑${fmtBytes(s.txBytes)} ↓${fmtBytes(s.rxBytes)}</td>
                        <td class="muted" style="font-size:12px">${escapeHtml(s.endReason || '—')}</td>
                        <td>
                          <div class="row-actions">
                            ${live ? `<button class="link-btn danger" data-stop="${s.id}">强制结束</button>` : '<span class="muted" style="font-size:12px">—</span>'}
                          </div>
                        </td>
                      </tr>`;
                    })
                    .join('')
                : '<tr><td colspan="8" class="empty">暂无会话记录</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  view.querySelectorAll('[data-stop]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '强制结束该会话？',
        message: '用户与远程浏览器的连接会立即中断，浏览器进程按策略销毁。用户的浏览数据（Cookie、历史记录）仍会保留。',
        confirmText: '结束会话',
        danger: true,
      });
      if (!ok) return;
      await api(`/api/admin/sessions/${btn.dataset.stop}`, { method: 'DELETE' });
      toast('会话已结束', 'ok');
      renderSessions();
    }),
  );
}

/* ------------------------------ 流量统计 ------------------------------ */

async function renderTraffic() {
  setHead('流量统计', '按用户与日期查看远端浏览器访问互联网的字节数', '<button class="btn btn-sm" id="btnExport">导出 CSV</button>');
  const today = new Date();
  const from = new Date(today.getTime() - 6 * 86400000).toISOString().slice(0, 10);
  view.innerHTML = `
    <div class="toolbar">
      <input class="select-sm" type="date" id="fFrom" value="${from}" />
      <span class="muted">至</span>
      <input class="select-sm" type="date" id="fTo" value="${today.toISOString().slice(0, 10)}" />
      <select class="select-sm" id="fUser"><option value="">全部用户</option></select>
      <button class="btn btn-sm" id="btnQuery">查询</button>
    </div>
    <div class="stat-grid" id="trafficStats" style="grid-template-columns:repeat(3,minmax(0,1fr))"></div>
    <div class="card" style="margin-top:14px">
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>日期</th><th>用户</th><th>上行</th><th>下行</th><th>合计</th></tr></thead>
          <tbody id="trafficBody"><tr><td colspan="5" class="empty">加载中…</td></tr></tbody>
        </table>
      </div>
    </div>
    <p class="hint" style="margin-top:12px">
      统计口径：Chromium Network 域累计的响应字节（含 HTTP 头，不含 TLS 记录层开销）与 WebSocket 帧负载；
      远程画面传输流量单独计量，不计入互联网流量。
    </p>
  `;

  const users = (await api('/api/admin/users')).users;
  const sel = view.querySelector('#fUser');
  users.forEach((u) => {
    const o = document.createElement('option');
    o.value = u.id;
    o.textContent = u.username;
    sel.appendChild(o);
  });

  const query = async () => {
    const params = new URLSearchParams();
    const f = view.querySelector('#fFrom').value;
    const t = view.querySelector('#fTo').value;
    const u = view.querySelector('#fUser').value;
    if (f) params.set('from', f);
    if (t) params.set('to', t);
    if (u) params.set('userId', u);
    const data = await api(`/api/admin/traffic?${params}`);
    view.querySelector('#trafficStats').innerHTML = `
      <div class="stat"><div class="k">上行合计</div><div class="v">${fmtBytes(data.totals.tx)}</div><div class="d">浏览器发往互联网</div></div>
      <div class="stat"><div class="k">下行合计</div><div class="v">${fmtBytes(data.totals.rx)}</div><div class="d">互联网返回浏览器</div></div>
      <div class="stat accent"><div class="k">总流量</div><div class="v">${fmtBytes(data.totals.total)}</div><div class="d">上行 + 下行</div></div>`;
    view.querySelector('#trafficBody').innerHTML = data.rows.length
      ? data.rows
          .map(
            (r) => `<tr>
              <td class="mono">${r.date}</td>
              <td>${escapeHtml(r.username)}</td>
              <td class="mono">${fmtBytes(r.tx_bytes)}</td>
              <td class="mono">${fmtBytes(r.rx_bytes)}</td>
              <td class="mono" style="font-weight:560">${fmtBytes(r.total_bytes)}</td>
            </tr>`,
          )
          .join('')
      : '<tr><td colspan="5" class="empty">该时间段没有流量记录</td></tr>';
  };

  view.querySelector('#btnQuery').addEventListener('click', query);
  view.querySelector('#btnExport').addEventListener('click', () => {
    const params = new URLSearchParams({ format: 'csv' });
    const f = view.querySelector('#fFrom').value;
    const t = view.querySelector('#fTo').value;
    const u = view.querySelector('#fUser').value;
    if (f) params.set('from', f);
    if (t) params.set('to', t);
    if (u) params.set('userId', u);
    window.location.href = `/api/admin/traffic?${params}`;
  });
  await query();
}

/* ------------------------------ 审计日志 ------------------------------ */

async function renderAudit() {
  setHead('审计日志', '登录、会话生命周期、管理员操作与配额事件', '<button class="btn btn-sm" id="btnRefresh">刷新</button>');
  const data = await api('/api/admin/audit-logs?limit=200');
  document.getElementById('btnRefresh').addEventListener('click', () => renderAudit());

  view.innerHTML = `
    <div class="toolbar">
      <div class="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="fFilter" placeholder="按动作前缀过滤，如 admin. 或 auth." />
      </div>
      <span class="spacer"></span>
      <span class="chip">共 ${data.total} 条</span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>详情</th><th>IP</th></tr></thead>
          <tbody id="auditBody">${auditRows(data.logs)}</tbody>
        </table>
      </div>
    </div>
  `;

  const filter = view.querySelector('#fFilter');
  let timer;
  filter.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = filter.value.trim();
      const res = await api(`/api/admin/audit-logs?limit=200${q ? `&action=${encodeURIComponent(q)}` : ''}`);
      view.querySelector('#auditBody').innerHTML = auditRows(res.logs);
    }, 260);
  });
}

function auditRows(logs) {
  if (!logs.length) return '<tr><td colspan="6" class="empty">暂无日志</td></tr>';
  return logs
    .map((l) => {
      let detail = '';
      try {
        const meta = l.metadata ? JSON.parse(l.metadata) : null;
        if (meta) detail = Object.entries(meta).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
      } catch {
        detail = l.metadata || '';
      }
      return `<tr>
        <td class="muted" style="white-space:nowrap">${fmtTime(l.created_at)}</td>
        <td>${escapeHtml(l.actor_name || '系统')}</td>
        <td><span class="log-action">${escapeHtml(l.action)}</span></td>
        <td>${escapeHtml(l.target_name || l.session_id?.slice(0, 8) || '—')}</td>
        <td class="muted" style="font-size:11.5px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(detail)}">${escapeHtml(detail.slice(0, 90) || '—')}</td>
        <td class="mono muted">${escapeHtml(l.ip_address || '—')}</td>
      </tr>`;
    })
    .join('');
}

/* ------------------------------ 浏览数据 ------------------------------ */

async function renderProfiles() {
  setHead('浏览数据', '每个用户的独立 profile 目录：Cookie、缓存、历史记录与下载文件', '<button class="btn btn-sm" id="btnRefresh">刷新</button>');
  const data = await api('/api/admin/profiles');
  document.getElementById('btnRefresh').addEventListener('click', () => renderProfiles());

  view.innerHTML = `
    <div class="notice">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7"/></svg>
      <span>浏览数据默认长期保留，用户下线或服务重启都不会丢失。清理会删除该用户的全部 Cookie、登录态、历史记录与下载文件，且不可恢复。</span>
    </div>
    <div class="stat-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      <div class="stat"><div class="k">已占用的浏览数据空间</div><div class="v">${fmtBytes(data.totalBytes)}</div><div class="d">所有用户 profile 目录合计</div></div>
      <div class="stat"><div class="k">账号数量</div><div class="v">${data.profiles.length}</div><div class="d">包含管理员账号</div></div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>用户</th><th>目录状态</th><th>占用空间</th><th>浏览器实例</th><th>存储路径</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>
            ${
              data.profiles.length
                ? data.profiles
                    .map(
                      (p) => `<tr>
                        <td><b>${escapeHtml(p.username)}</b></td>
                        <td>${p.exists ? '<span class="badge badge-ok">已创建</span>' : '<span class="badge">未创建</span>'}</td>
                        <td class="mono">${fmtBytes(p.bytes)}</td>
                        <td>${p.running ? '<span class="badge badge-brand">运行中</span>' : '<span class="muted" style="font-size:12px">未运行</span>'}</td>
                        <td class="mono muted" style="font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(p.profileDir)}">${escapeHtml(p.profileDir)}</td>
                        <td><div class="row-actions"><button class="link-btn danger" data-purge="${p.userId}" data-name="${escapeHtml(p.username)}">清理数据</button></div></td>
                      </tr>`,
                    )
                    .join('')
                : '<tr><td colspan="6" class="empty">暂无用户</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  view.querySelectorAll('[data-purge]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: `清理 ${btn.dataset.name} 的浏览数据？`,
        message: '将删除该用户的全部 Cookie、登录态、历史记录、缓存与下载文件，操作不可恢复。正在运行的浏览器会被先结束。',
        confirmText: '确认清理',
        danger: true,
      });
      if (!ok) return;
      await api(`/api/admin/profiles/${btn.dataset.purge}/purge`, { method: 'POST' });
      toast('浏览数据已清理', 'ok');
      renderProfiles();
    }),
  );
}

/* ------------------------------ 系统配置 ------------------------------ */

async function renderSettings() {
  setHead('系统配置', '会话策略、资源限制与平台文案');
  const data = await api('/api/admin/settings');
  const s = data.settings;

  view.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>会话与资源</h3></div>
        <div class="card-body">
          <div class="field">
            <label>空闲断开画面（分钟）</label>
            <input class="input" id="sIdleTimeout" type="number" min="1" value="${s.idleTimeoutMinutes}" />
            <div class="hint">超过该时长无操作时断开画面连接，浏览器进程继续保留</div>
          </div>
          <div class="field">
            <label>空闲停止进程（分钟）</label>
            <input class="input" id="sIdleStop" type="number" min="1" value="${s.idleStopMinutes}" />
            <div class="hint">进程停止但 profile 目录保留，用户下次启动自动恢复全部浏览数据</div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <div class="field">
              <label>全平台并发上限</label>
              <input class="input" id="sMaxConcurrent" type="number" min="1" value="${s.maxConcurrentSessions}" />
            </div>
            <div class="field">
              <label>默认单用户并发</label>
              <input class="input" id="sDefaultMax" type="number" min="1" value="${s.defaultMaxSessions}" />
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <div class="field">
              <label>远端视口宽度</label>
              <input class="input" id="sVw" type="number" min="360" max="2560" value="${s.viewportWidth}" />
            </div>
            <div class="field">
              <label>远端视口高度</label>
              <input class="input" id="sVh" type="number" min="320" max="1600" value="${s.viewportHeight}" />
            </div>
          </div>
          <div class="field">
            <label>渲染倍率（清晰度）</label>
            <select class="input" id="sRenderScale">
              <option value="1" ${Number(s.renderScale) === 1 ? 'selected' : ''}>1x — 省流量，字会发虚</option>
              <option value="2" ${Number(s.renderScale) !== 1 && Number(s.renderScale) !== 3 ? 'selected' : ''}>2x — 原画（推荐）</option>
              <option value="3" ${Number(s.renderScale) === 3 ? 'selected' : ''}>3x — 超采样（很吃带宽）</option>
            </select>
            <div class="hint">远端按 N 倍物理像素渲染推流。2x 在 1080p 屏上相当于超采样，文字边缘干净。改完需重新启动会话生效</div>
          </div>
          <div class="field">
            <label>默认画质挡位</label>
            <select class="input" id="sQualityLevel">
              <option value="high" ${s.qualityLevel === 'high' ? 'selected' : ''}>高清 — 92 质量，原画帧（最清晰，最吃带宽）</option>
              <option value="medium" ${s.qualityLevel === 'medium' ? 'selected' : ''}>均衡 — 76 质量，全分辨率，带宽约省一半</option>
              <option value="low" ${s.qualityLevel === 'low' ? 'selected' : ''}>省流 — 58 质量 + 0.62 倍分辨率，弱网可用</option>
            </select>
            <div class="hint">新会话的默认挡位。用户在工作区右上角可自行切换高清 / 均衡 / 省流，只影响本人会话</div>
          </div>
          <div class="field" style="margin-bottom:0">
            <label>首页地址</label>
            <input class="input" id="sHome" value="${escapeHtml(s.homePage)}" />
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>安全策略</h3></div>
        <div class="card-body">
          <label style="display:flex;gap:10px;align-items:flex-start;margin-bottom:16px;cursor:pointer">
            <input type="checkbox" id="sAllowDownloads" ${s.allowDownloads ? 'checked' : ''} style="width:16px;height:16px;margin-top:2px" />
            <span><b style="font-size:13px">允许下载文件</b><br /><span class="hint" style="margin:0">文件保存在用户自己的 profile/Downloads 目录内，互相隔离</span></span>
          </label>
          <label style="display:flex;gap:10px;align-items:flex-start;margin-bottom:16px;cursor:pointer">
            <input type="checkbox" id="sRegistration" ${s.registrationEnabled ? 'checked' : ''} style="width:16px;height:16px;margin-top:2px" />
            <span><b style="font-size:13px">开放自助注册</b><br /><span class="hint" style="margin:0">登录页展示「立即注册」入口；新注册账号默认不限流量、有效期无限</span></span>
          </label>
          <div class="field">
            <label>注册账号默认并发</label>
            <input class="input" id="sRegisterMax" type="number" min="1" max="10" value="${s.registerMaxSessions}" />
            <div class="hint">自助注册账号可同时开启的浏览器会话数，默认 2</div>
          </div>
          <label style="display:flex;gap:10px;align-items:flex-start;margin-bottom:16px;cursor:pointer">
            <input type="checkbox" id="sMuteAudio" ${s.muteRemoteAudio ? 'checked' : ''} style="width:16px;height:16px;margin-top:2px" />
            <span><b style="font-size:13px">远端浏览器在服务器静音</b><br /><span class="hint" style="margin:0">强烈建议保持开启：浏览器跑在服务器上，关掉后任何用户网页里的声音都会从服务器音箱放出来。新会话生效</span></span>
          </label>
          <label style="display:flex;gap:10px;align-items:flex-start;margin-bottom:16px;cursor:pointer">
            <input type="checkbox" id="sRemoteAudio" ${s.remoteAudioEnabled !== false ? 'checked' : ''} style="width:16px;height:16px;margin-top:2px" />
            <span><b style="font-size:13px">允许用户听到自己浏览器的声音</b><br /><span class="hint" style="margin:0">页面音频在服务器端被采集成 PCM，只沿该用户自己的连接送回他的浏览器；服务器与管理员始终无声。关掉后工作区不显示声音按钮</span></span>
          </label>
          <label style="display:flex;gap:10px;align-items:flex-start;margin-bottom:16px;cursor:pointer">
            <input type="checkbox" id="sHeadless" ${s.headless ? 'checked' : ''} style="width:16px;height:16px;margin-top:2px" />
            <span><b style="font-size:13px">无头模式运行</b><br /><span class="hint" style="margin:0">不显示服务器桌面窗口；关闭后会弹出可见窗口，便于调试</span></span>
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <div class="field"><label>登录失败上限</label><input class="input" id="sLoginMax" type="number" min="3" value="${s.loginMaxAttempts}" /></div>
            <div class="field"><label>锁定时长（分钟）</label><input class="input" id="sLoginLock" type="number" min="1" value="${s.loginLockMinutes}" /></div>
          </div>
          <div class="field">
            <label>平台名称</label>
            <input class="input" id="sSiteName" value="${escapeHtml(s.siteName)}" />
          </div>
          <div class="field" style="margin-bottom:0">
            <label>隐私告知文案（展示在登录页）</label>
            <textarea class="input" id="sPrivacy" rows="4">${escapeHtml(s.privacyNotice)}</textarea>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>运行环境</h3><span class="chip">只读</span></div>
      <div class="card-body">
        <div class="kv"><span class="k">浏览器内核</span><span class="v mono">${escapeHtml(data.chromePath || '自动探测')}</span></div>
        <div class="kv"><span class="k">数据库</span><span class="v mono">SQLite（data/easybrowse.db）</span></div>
        <div class="kv"><span class="k">部署提示</span><span class="v" style="font-weight:400;font-size:12.5px;color:var(--ink-3)">公网仅暴露 HTTPS 入口，CDP / 容器端口不对公网开放</span></div>
      </div>
    </div>

    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px">
      <button class="btn" id="btnResetSettings">放弃修改</button>
      <button class="btn btn-primary" id="btnSaveSettings">保存配置</button>
    </div>
  `;

  view.querySelector('#btnResetSettings').addEventListener('click', () => renderSettings());
  view.querySelector('#btnSaveSettings').addEventListener('click', async () => {
    const body = {
      idleTimeoutMinutes: Number(view.querySelector('#sIdleTimeout').value),
      idleStopMinutes: Number(view.querySelector('#sIdleStop').value),
      maxConcurrentSessions: Number(view.querySelector('#sMaxConcurrent').value),
      defaultMaxSessions: Number(view.querySelector('#sDefaultMax').value),
      viewportWidth: Number(view.querySelector('#sVw').value),
      viewportHeight: Number(view.querySelector('#sVh').value),
      qualityLevel: view.querySelector('#sQualityLevel').value,
      renderScale: Number(view.querySelector('#sRenderScale').value),
      homePage: view.querySelector('#sHome').value,
      allowDownloads: view.querySelector('#sAllowDownloads').checked,
      registrationEnabled: view.querySelector('#sRegistration').checked,
      registerMaxSessions: Number(view.querySelector('#sRegisterMax').value),
      headless: view.querySelector('#sHeadless').checked,
      muteRemoteAudio: view.querySelector('#sMuteAudio').checked,
      remoteAudioEnabled: view.querySelector('#sRemoteAudio').checked,
      loginMaxAttempts: Number(view.querySelector('#sLoginMax').value),
      loginLockMinutes: Number(view.querySelector('#sLoginLock').value),
      siteName: view.querySelector('#sSiteName').value,
      privacyNotice: view.querySelector('#sPrivacy').value,
    };
    try {
      await api('/api/admin/settings', { method: 'PATCH', body });
      toast('配置已保存，新会话生效', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ------------------------------ 路由 ------------------------------ */

const ROUTES = {
  dashboard: { title: '概览', render: renderDashboard },
  users: { title: '用户管理', render: renderUsers },
  sessions: { title: '会话管理', render: renderSessions },
  traffic: { title: '流量统计', render: renderTraffic },
  profiles: { title: '浏览数据', render: renderProfiles },
  audit: { title: '审计日志', render: renderAudit },
  settings: { title: '系统配置', render: renderSettings },
};

async function navigate() {
  const route = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  const cfg = ROUTES[route] || ROUTES.dashboard;
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
  view.innerHTML = '<div class="empty">加载中…</div>';
  try {
    await cfg.render();
  } catch (err) {
    view.innerHTML = `<div class="notice danger">${escapeHtml(err.message)}</div>`;
    if (err.status === 401) location.href = '/login';
  }
}

document.getElementById('btnLogout').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  location.href = '/login';
});

window.addEventListener('hashchange', navigate);

(async function init() {
  try {
    const me = await api('/api/auth/me');
    state.me = me.user;
    if (me.user.role !== 'admin') {
      location.href = '/';
      return;
    }
    document.getElementById('sideName').textContent = me.user.username;
    document.getElementById('sideAvatar').textContent = me.user.username.slice(0, 1).toUpperCase();
    await navigate();
  } catch (err) {
    if (err.status === 401) location.href = '/login';
    else view.innerHTML = `<div class="notice danger">${escapeHtml(err.message)}</div>`;
  }
})();

// 每 20 秒刷新概览页的会话计数
setInterval(async () => {
  if ((location.hash.replace(/^#\/?/, '') || 'dashboard') !== 'dashboard') return;
  try {
    const d = await api('/api/admin/dashboard');
    document.getElementById('navSessions').textContent = String(d.activeSessions);
  } catch {
    /* ignore */
  }
}, 20000);
