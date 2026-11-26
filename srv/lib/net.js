const crypto = require('node:crypto');

const CONSENT_VERSION = '2026-11-26-1';

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function clientIp(req) {
  const raw = req && req.headers && req.headers['x-real-ip'];
  if (!raw) return '';
  return String(raw).split(',')[0].trim();
}

function ipHash(ip) {
  const salt = process.env.IP_SALT || '';
  if (!ip || !salt) return null;
  return crypto.createHmac('sha256', salt).update(String(ip)).digest('hex');
}

function deviceKey(platform, deviceId) {
  const id = String(deviceId || '');
  // Без device_id это не одно устройство: иначе все клиенты платформы вытесняют друг друга.
  const distinct = id || ('anon:' + crypto.randomBytes(16).toString('hex'));
  return sha256(String(platform || '') + ':' + distinct);
}

function graceKey() {
  const raw = process.env.REFRESH_GRACE_KEY || '';
  if (raw.length < 16) {
    const e = new Error('REFRESH_GRACE_KEY is too short');
    e.status = 500;
    throw e;
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function timingEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

function secretMatches(value) {
  const cur = process.env.TG_SESSION_SECRET || '';
  const prev = process.env.TG_SESSION_SECRET_PREV || '';
  if (cur.length < 16) return false;
  if (timingEqual(value, cur)) return true;
  return prev.length >= 16 && timingEqual(value, prev);
}

function encryptGrace(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', graceKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString('base64');
}

function decryptGrace(payload) {
  const buf = Buffer.from(String(payload || ''), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', graceKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

function refreshCookie(token, maxAge) {
  const age = maxAge == null ? 31536000 : maxAge;
  return 'zh_rt=' + token + '; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=' + age;
}

function clearCookie() {
  return 'zh_rt=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0';
}

function readCookie(req, name) {
  const raw = (req && req.headers && req.headers.cookie) || '';
  const parts = String(raw).split(/; */);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    if (p.slice(0, eq).trim() === name) return decodeURIComponent(p.slice(eq + 1));
  }
  return '';
}

function bearer(req) {
  const h = String((req && req.headers && req.headers.authorization) || '');
  const m = h.match(/^Bearer\s+([A-Za-z0-9]+)$/);
  return m ? m[1] : '';
}

function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return ''; }
}

function originOk(req) {
  const headers = (req && req.headers) || {};
  const origin = String(headers.origin || '');
  const reqHost = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();
  if (origin && origin !== 'null') {
    const host = hostOf(origin);
    if (host && host === reqHost) return true;
    if (process.env.PUBLIC_URL && hostOf(process.env.PUBLIC_URL) === host) return true;
    return false;
  }
  // Обычный GET с той же страницы иногда приходит без Origin. Чужой сайт так не представится.
  const site = String(headers['sec-fetch-site'] || '');
  if (site === 'same-origin' || site === 'none') return true;
  const referer = String(headers.referer || headers.referrer || '');
  if (referer && hostOf(referer) === reqHost) return true;
  return false;
}

function deviceLabelFromUa(ua) {
  const s = String(ua || '');
  let os = 'устройство';
  if (/Windows/i.test(s)) os = 'Windows';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/iPhone|iPad/i.test(s)) os = 'iPhone';
  else if (/Mac OS/i.test(s)) os = 'macOS';
  else if (/Linux/i.test(s)) os = 'Linux';
  let br = 'браузер';
  if (/Edg\//.test(s)) br = 'Edge';
  else if (/Chrome\//.test(s) && !/Edg\//.test(s)) br = 'Chrome';
  else if (/Firefox\//.test(s)) br = 'Firefox';
  else if (/Safari\//.test(s)) br = 'Safari';
  return (br + ' · ' + os).slice(0, 80);
}

function botUsername() {
  return String(process.env.TG_BOT_USERNAME || 'trio_zhurnalka_bot').replace(/^@/, '');
}

function linkUrl(code) {
  return 'https://t.me/' + botUsername() + '/app?startapp=l_' + code;
}

function authLog(fields) {
  const safe = {
    code: fields && fields.code ? String(fields.code) : null,
    tg_user_id: fields && fields.tg_user_id ? fields.tg_user_id : null
  };
  console.log(JSON.stringify(safe));
}

function sessionSecret() {
  return process.env.TG_SESSION_SECRET || '';
}

module.exports = {
  CONSENT_VERSION, sha256, newToken, clientIp, ipHash, deviceKey,
  encryptGrace, decryptGrace, refreshCookie, clearCookie, readCookie, bearer, secretMatches,
  originOk, deviceLabelFromUa, botUsername, linkUrl, authLog, sessionSecret
};
