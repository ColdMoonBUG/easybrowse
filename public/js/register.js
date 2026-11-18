/** 注册页逻辑 */
import { api } from './common.js';

const form = document.getElementById('registerForm');
const errBox = document.getElementById('registerError');
const submitBtn = document.getElementById('submitBtn');
const pwdInput = document.getElementById('password');
const pwd2Input = document.getElementById('password2');
const pwdToggle = document.getElementById('pwdToggle');

function showError(msg) {
  errBox.textContent = msg;
  errBox.classList.remove('hidden');
}

pwdToggle.addEventListener('click', () => {
  const isPwd = pwdInput.type === 'password';
  pwdInput.type = isPwd ? 'text' : 'password';
  pwd2Input.type = isPwd ? 'text' : 'password';
  pwdToggle.setAttribute('aria-label', isPwd ? '隐藏密码' : '显示密码');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errBox.classList.add('hidden');
  const username = form.username.value.trim();
  const password = form.password.value;
  const password2 = form.password2.value;

  if (!/^[a-zA-Z0-9_.-]{1,32}$/.test(username)) {
    showError('用户名需为 1-32 位字母、数字、下划线、点或短横线');
    return;
  }
  if (!password) {
    showError('请设置密码');
    return;
  }
  if (password !== password2) {
    showError('两次输入的密码不一致');
    pwd2Input.focus();
    pwd2Input.select();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="spinner"></span> 正在创建账号';
  try {
    const res = await api('/api/auth/register', { method: 'POST', body: { username, password } });
    window.location.href = res.redirect || '/';
  } catch (err) {
    showError(err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = '注册并登录';
    if (err.status === 409) {
      form.username.focus();
      form.username.select();
    }
  }
});

// 站点信息（名称 / 隐私告知 / 是否开放注册）
api('/api/meta')
  .then((meta) => {
    if (meta?.siteName) {
      document.title = `注册 · ${meta.siteName}`;
      document.getElementById('brandName').textContent = meta.siteName;
    }
    if (meta?.privacyNotice) document.getElementById('privacyNotice').textContent = meta.privacyNotice;
    if (meta?.version) document.getElementById('verLabel').textContent = `v${meta.version}`;
    if (meta && meta.registrationEnabled === false) {
      submitBtn.disabled = true;
      submitBtn.textContent = '注册已关闭';
      showError('当前未开放自助注册，请联系管理员开通账号');
    }
  })
  .catch(() => {});

document.getElementById('username').focus();
