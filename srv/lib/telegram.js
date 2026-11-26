// Проверка initData Mini App по документации Telegram.
// signature входит в data_check_string: на реальных клиентах без него HMAC не сходится.
// Ed25519 по публичному ключу Telegram в v1 не делаем — есть токен бота.
const crypto = require('node:crypto');

function dataCheckString(params, opts) {
  const excludeSignature = opts && opts.excludeSignature;
  return Object.keys(params)
    .filter((k) => k !== 'hash' && !(excludeSignature && k === 'signature'))
    .sort()
    .map((k) => k + '=' + params[k])
    .join('\n');
}

function secretKey(botToken) {
  return crypto.createHmac('sha256', 'WebAppData').update(String(botToken)).digest();
}

function parseInitData(initData) {
  const sp = new URLSearchParams(String(initData || ''));
  const params = {};
  for (const [k, v] of sp.entries()) params[k] = v;
  return params;
}

function signInitData(fields, botToken) {
  const params = {};
  Object.keys(fields || {}).forEach((k) => {
    if (k === 'hash' || fields[k] == null) return;
    params[k] = String(fields[k]);
  });
  const hash = crypto.createHmac('sha256', secretKey(botToken)).update(dataCheckString(params)).digest('hex');
  const sp = new URLSearchParams();
  Object.keys(params).sort().forEach((k) => sp.append(k, params[k]));
  sp.append('hash', hash);
  return sp.toString();
}

function fail(code) {
  return { ok: false, error: code };
}

function validateInitData(initData, botToken, opts) {
  const options = opts || {};
  const maxAgeSec = options.maxAgeSec == null ? 600 : options.maxAgeSec;
  const nowMs = options.now == null ? Date.now() : options.now;
  let params;
  try { params = parseInitData(initData); }
  catch (e) { return fail('BAD_HASH'); }
  if (!params.hash || !/^[0-9a-f]{64}$/.test(params.hash)) return fail('BAD_HASH');
  if (!botToken) return fail('BAD_HASH');
  const expected = crypto.createHmac('sha256', secretKey(botToken)).update(dataCheckString(params, options)).digest();
  const got = Buffer.from(params.hash, 'hex');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return fail('BAD_HASH');
  const authDate = Number(params.auth_date);
  if (!Number.isFinite(authDate)) return fail('EXPIRED');
  const nowSec = Math.floor(nowMs / 1000);
  if (authDate - nowSec > 60) return fail('EXPIRED');
  if (nowSec - authDate > maxAgeSec) return fail('EXPIRED');
  let user;
  try { user = JSON.parse(params.user || ''); }
  catch (e) { return fail('BAD_HASH'); }
  if (!user || typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) return fail('BAD_HASH');
  return {
    ok: true,
    user: {
      id: user.id,
      first_name: typeof user.first_name === 'string' ? user.first_name.slice(0, 80) : '',
      username: typeof user.username === 'string' ? user.username.slice(0, 64) : '',
      language_code: typeof user.language_code === 'string' ? user.language_code.slice(0, 16) : ''
    }
  };
}

module.exports = { dataCheckString, secretKey, parseInitData, signInitData, validateInitData };
