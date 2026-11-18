/** 登录页逻辑 */
import { api, toast } from './common.js';

const form = document.getElementById('loginForm');
const errBox = document.getElementById('loginError');
const submitBtn = document.getElementById('submitBtn');
const pwdInput = document.getElementById('password');
const pwdToggle = document.getElementById('pwdToggle');

function showError(msg) {
  errBox.textContent = msg;
  errBox.classList.remove('hidden');
}

pwdToggle.addEventListener('click', () => {
  const isPwd = pwdInput.type === 'password';
  pwdInput.type = isPwd ? 'text' : 'password';
  pwdToggle.setAttribute('aria-label', isPwd ? '隐藏密码' : '显示密码');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errBox.classList.add('hidden');
  const username = form.username.value.trim();
  const password = form.password.value;
  if (!username || !password) {
    showError('请输入用户名和密码');
    return;
  }
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="spinner"></span> 正在登录';
  try {
    const res = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    window.location.href = res.redirect || '/';
  } catch (err) {
    showError(err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = '登录';
    pwdInput.focus();
    pwdInput.select();
  }
});

// 站点信息（名称 / 隐私告知）
api('/api/meta')
  .then((meta) => {
    if (meta?.siteName) {
      document.title = `登录 · ${meta.siteName}`;
      document.getElementById('brandName').textContent = meta.siteName;
    }
    if (meta?.privacyNotice) document.getElementById('privacyNotice').textContent = meta.privacyNotice;
    if (meta?.version) document.getElementById('verLabel').textContent = `v${meta.version}`;
    // 管理员关闭自助注册时，不再展示注册入口
    if (meta && meta.registrationEnabled === false) {
      document.getElementById('registerTip').textContent = '没有账号？请联系管理员开通';
    }
  })
  .catch(() => {});

document.getElementById('username').focus();

// 会话过期 / 注册关闭提示
const params = new URLSearchParams(location.search);
if (params.get('expired')) toast('登录已过期，请重新登录');
if (params.get('register') === 'closed') toast('自助注册已关闭，请联系管理员开通');
