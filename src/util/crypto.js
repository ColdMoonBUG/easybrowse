/**
 * 加密与口令工具。
 * - 口令：scrypt（内存硬 KDF，比 bcrypt 更强的抗 GPU 暴力破解能力），格式 scrypt$N$r$p$salt$hash
 * - 代理凭据：AES-256-GCM，密钥由 sessionSecret 派生，数据库中不出现明文
 */
import crypto from 'node:crypto';
import { config } from '../config.js';

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function uuid() {
  return crypto.randomUUID();
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function deriveKey() {
  return crypto.createHash('sha256').update(`proxy-secret:${config.sessionSecret}`).digest();
}

export function encryptSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(payload) {
  if (!payload) return null;
  try {
    const [ver, ivB64, tagB64, dataB64] = String(payload).split(':');
    if (ver !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf-8');
  } catch {
    return null;
  }
}

/** 生成不含易混淆字符的随机口令，便于管理员线下分发 */
export function generatePassword(len = 14) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** 判断是否弱口令（长度 + 字符种类） */
/**
 * 密码校验。
 *
 * 只做「非空 + 长度上限」两项检查，不强制大小写/数字/符号组合。
 * 单人自用的公网工具，强制 10 位混合字符只会让密码被写在便签上；
 * 真正该防的是撞库——登录失败锁定（loginMaxAttempts）已经覆盖。
 * 需要更严时把 minLength 调大即可。
 */
export function passwordStrengthError(password, minLength = 1) {
  if (typeof password !== 'string' || password.length < minLength) {
    return minLength <= 1 ? '密码不能为空' : `密码长度至少 ${minLength} 位`;
  }
  if (password.length > 128) return '密码不能超过 128 位';
  return null;
}
