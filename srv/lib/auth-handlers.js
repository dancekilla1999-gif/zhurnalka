// HTTP-обработчики /api/tg/* и /api/auth/*. initData в логи и ответы не попадает.
const { validateInitData, parseInitData } = require('./telegram');
const { rpc } = require('./sb');
const { readBody, send } = require('./common');
const net = require('./net');

function secret() {
  return net.sessionSecret();
}

function serviceRpc(fn, args) {
  const s = secret();
  if (!net.secretMatches(s)) {
    const e = new Error('forbidden');
    e.status = 403;
    e.hint = 'forbidden';
    throw e;
  }
  const body = Object.assign({}, args || {}, { p_secret: s });
  return rpc(fn, body, { role: 'service' });
}

function userRpc(fn, args) {
  return rpc(fn, args || {}, { role: 'anon' });
}

async function noteSignal(kind) {
  try {
    const r = await serviceRpc('zh_auth_note', { p_kind: kind });
    if (r && r.alert) console.log(JSON.stringify({ alert: 'spike', count: r.count }));
  } catch (e) { /* счётчик не должен ронять вход */ }
}

function hintStatus(data) {
  const hint = data && data.hint;
  if (hint === 'rate') return 429;
  if (hint === 'consent' || hint === 'invite' || hint === 'invalid' || hint === 'exists') return 400;
  if (hint === 'disabled' || hint === 'forbidden') return 403;
  if (data && (data.error === 'REPLAY' || hint === 'replay')) return 401;
  return 401;
}

async function sendResult(res, data) {
  if (!data || data.error) {
    const status = hintStatus(data);
    if (status === 429 || status === 401) await noteSignal(String(status));
    const error = data && data.error === 'REPLAY' ? 'REPLAY' : (data && data.error) || 'Нужно войти';
    send(res, status, { error, hint: (data && data.hint) || 'auth' });
    return true;
  }
  return false;
}

async function finishWeb(res, data) {
  const bad = await sendResult(res, data);
  if (bad) return bad;
  res.setHeader('Set-Cookie', net.refreshCookie(data.refresh));
  return send(res, 200, { token: data.token, email: data.email, name: data.name });
}

async function readInit(req, maxAgeSec) {
  const body = await readBody(req);
  const initData = String(body.initData || '');
  if (!initData || initData.length > 4096) {
    net.authLog({ code: 'BAD_HASH' });
    return { body, error: 'BAD_HASH' };
  }
  let v;
  try { v = validateInitData(initData, process.env.TG_BOT_TOKEN || '', { maxAgeSec }); }
  catch (e) { v = { ok: false, error: 'BAD_HASH' }; }
  if (!v.ok) {
    net.authLog({ code: v.error });
    return { body, error: v.error || 'BAD_HASH' };
  }
  const hash = String((parseInitData(initData).hash || '')).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    net.authLog({ code: 'BAD_HASH' });
    return { body, error: 'BAD_HASH' };
  }
  return { body, initData, user: v.user, hash: hash };
}

function tgArgs(parsed, ip) {
  const body = parsed.body || {};
  const user = parsed.user;
  return {
    p_init_hash: parsed.hash,
    p_tg_user_id: String(user.id),
    p_username: user.username,
    p_first_name: user.first_name,
    p_device_key: net.deviceKey(body.platform, body.device_id),
    p_device_label: String(body.device_label || ((body.platform || 'Telegram') + ' · Telegram')).slice(0, 80),
    p_ip_hash: ip,
    p_consent_version: net.CONSENT_VERSION
  };
}

async function tgAuth(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const ip = net.ipHash(net.clientIp(req));
  const gate = await serviceRpc('zh_rate_allow', { p_kind: 'tg_auth', p_ip_hash: ip, p_limit: 60, p_window_sec: 60 });
  if (gate && gate.error) {
    await noteSignal('429');
    return send(res, 429, { error: gate.error });
  }
  const parsed = await readInit(req, 600);
  if (parsed.error) {
    await noteSignal('401');
    return send(res, 401, { error: parsed.error });
  }
  const a = tgArgs(parsed, ip);
  const data = await serviceRpc('zh_tg_session', {
    p_tg_user_id: a.p_tg_user_id,
    p_device_key: a.p_device_key,
    p_device_label: a.p_device_label,
    p_ip_hash: ip,
    p_username: a.p_username,
    p_first_name: a.p_first_name
  });
  if (data && data.need_link) {
    return send(res, 200, { need_link: true, tg: { first_name: (data.tg && data.tg.first_name) || parsed.user.first_name || '' } });
  }
  const bad = await sendResult(res, data);
  if (bad) return bad;
  return send(res, 200, { token: data.token, email: data.email, name: data.name });
}

async function tgLink(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const parsed = await readInit(req, 3600);
  if (parsed.error) {
    await noteSignal('401');
    return send(res, 401, { error: parsed.error });
  }
  if (parsed.body.consent !== true) {
    return send(res, 400, { error: 'Нужно согласие на обработку Telegram ID, имени и username', hint: 'consent' });
  }
  let code = String(parsed.body.code || '').trim();
  if (code.startsWith('l_')) code = code.slice(2);
  let data;
  try {
    data = await serviceRpc('zh_tg_link', Object.assign(tgArgs(parsed, net.ipHash(net.clientIp(req))), {
      p_code: code,
      p_consent: true
    }));
  } catch (e) {
    return send(res, e.hint === 'replay' ? 401 : 409, { error: e.hint === 'replay' ? 'REPLAY' : String(e.message || 'Не удалось привязать').split('\n')[0], hint: e.hint || 'taken' });
  }
  const bad = await sendResult(res, data);
  if (bad) return bad;
  return send(res, 200, { token: data.token, email: data.email, name: data.name });
}

async function tgLogin(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const parsed = await readInit(req, 3600);
  if (parsed.error) {
    await noteSignal('401');
    return send(res, 401, { error: parsed.error });
  }
  if (parsed.body.consent !== true) {
    return send(res, 400, { error: 'Нужно согласие на обработку Telegram ID, имени и username', hint: 'consent' });
  }
  let data;
  try {
    data = await serviceRpc('zh_tg_login', Object.assign(tgArgs(parsed, net.ipHash(net.clientIp(req))), {
      p_email: parsed.body.email,
      p_password: parsed.body.password,
      p_consent: true
    }));
  } catch (e) {
    return send(res, e.hint === 'replay' ? 401 : 409, { error: e.hint === 'replay' ? 'REPLAY' : String(e.message || 'Не удалось войти').split('\n')[0], hint: e.hint || 'taken' });
  }
  const bad = await sendResult(res, data);
  if (bad) return bad;
  return send(res, 200, { token: data.token, email: data.email, name: data.name });
}

async function tgUnbind(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const token = net.bearer(req);
  if (!token) return send(res, 401, { error: 'Нужно войти', hint: 'auth' });
  try {
    const data = await userRpc('zh_tg_unbind', { p_token: token });
    const bad = await sendResult(res, data);
    if (bad) return bad;
    return send(res, 200, { ok: true });
  } catch (e) {
    return send(res, e.hint === 'disabled' ? 403 : 401, { error: 'Нужно войти', hint: e.hint || 'auth' });
  }
}

function guardOrigin(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    send(res, 405, { error: 'method' });
    return false;
  }
  if (!net.originOk(req)) {
    send(res, 403, { error: 'forbidden' });
    return false;
  }
  return true;
}

async function authLogin(req, res) {
  if (!guardOrigin(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const body = await readBody(req);
  const data = await serviceRpc('zh_web_login', {
    p_email: body.email,
    p_password: body.password,
    p_ip_hash: net.ipHash(net.clientIp(req)),
    p_device_label: net.deviceLabelFromUa(req.headers['user-agent'])
  });
  return finishWeb(res, data);
}

async function authRegister(req, res) {
  if (!guardOrigin(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const body = await readBody(req);
  if (body && body.role != null && String(body.role) !== '') {
    return send(res, 400, { error: 'Роль задаёт администратор платформы', hint: 'forbidden' });
  }
  const data = await serviceRpc('zh_web_register', {
    p_email: body.email,
    p_password: body.password,
    p_name: body.name || '',
    p_invite: body.invite || '',
    p_ip_hash: net.ipHash(net.clientIp(req)),
    p_device_label: net.deviceLabelFromUa(req.headers['user-agent'])
  });
  return finishWeb(res, data);
}

async function authRefresh(req, res) {
  if (!guardOrigin(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const old = net.readCookie(req, 'zh_rt');
  if (!/^[0-9a-f]{40,128}$/.test(old)) return send(res, 401, { error: 'Нужно войти', hint: 'auth' });
  const access = net.newToken();
  const refresh = net.newToken();
  let cipher;
  try { cipher = net.encryptGrace({ token: access, refresh }); }
  catch (e) { return send(res, 500, { error: 'Сервер не настроен' }); }
  const data = await serviceRpc('zh_web_refresh', {
    p_refresh: old,
    p_new_access: access,
    p_new_refresh: refresh,
    p_cipher: cipher,
    p_device_label: net.deviceLabelFromUa(req.headers['user-agent'])
  });
  if (data && data.status === 'issued') {
    res.setHeader('Set-Cookie', net.refreshCookie(refresh));
    return send(res, 200, { token: access, email: data.email, name: data.name });
  }
  if (data && data.status === 'grace') {
    let same;
    try { same = net.decryptGrace(data.cipher); }
    catch (e) { return send(res, 401, { error: 'Нужно войти', hint: 'auth' }); }
    res.setHeader('Set-Cookie', net.refreshCookie(same.refresh));
    return send(res, 200, { token: same.token, email: data.email, name: data.name });
  }
  if (data && data.status === 'reuse') {
    console.log(JSON.stringify({ alert: 'refresh_reuse', count: 1 }));
    res.setHeader('Set-Cookie', net.clearCookie());
    return send(res, 401, { error: 'Сессия закончилась, войдите снова', hint: 'revoked' });
  }
  res.setHeader('Set-Cookie', net.clearCookie());
  return send(res, 401, { error: 'Нужно войти', hint: (data && data.hint) || 'auth' });
}

async function authMigrate(req, res) {
  if (!guardOrigin(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const body = await readBody(req);
  const data = await serviceRpc('zh_migrate', {
    p_token: body.token,
    p_ip_hash: net.ipHash(net.clientIp(req)),
    p_device_label: net.deviceLabelFromUa(req.headers['user-agent'])
  }).catch((e) => ({ error: 'Нужно войти', hint: e.hint || 'auth' }));
  return finishWeb(res, data);
}

async function withUser(req, res, fn, args) {
  if (!guardOrigin(req, res)) return null;
  const token = net.bearer(req);
  if (!token) {
    send(res, 401, { error: 'Нужно войти', hint: 'auth' });
    return null;
  }
  try {
    const data = await userRpc(fn, Object.assign({ p_token: token }, args || {}));
    if (data && data.error) {
      send(res, hintStatus(data), { error: data.error, hint: data.hint });
      return null;
    }
    return data;
  } catch (e) {
    send(res, e.hint === 'disabled' ? 403 : 401, { error: e.hint === 'disabled' ? 'Аккаунт отключён' : 'Нужно войти', hint: e.hint || 'auth' });
    return null;
  }
}

async function authLogout(req, res) {
  if (!guardOrigin(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const token = net.bearer(req);
  if (token) {
    try { await userRpc('zh_logout', { p_token: token }); } catch (e) { /* cookie всё равно гасим */ }
  }
  res.setHeader('Set-Cookie', net.clearCookie());
  return send(res, 200, { ok: true });
}

async function authLogoutAll(req, res) {
  const data = await withUser(req, res, 'zh_logout_all', {});
  if (!data) return;
  res.setHeader('Set-Cookie', net.clearCookie());
  return send(res, 200, { ok: true });
}

async function authPassword(req, res) {
  if (req.method !== 'POST') {
    if (!net.originOk(req)) return send(res, 403, { error: 'forbidden' });
    return send(res, 405, { error: 'POST only' });
  }
  const body = await readBody(req);
  const data = await withUser(req, res, 'zh_password', { p_current: body.current, p_new: body.new });
  if (!data) return;
  return send(res, 200, { ok: true });
}

async function authLinkCode(req, res) {
  if (req.method !== 'POST') {
    if (!net.originOk(req)) return send(res, 403, { error: 'forbidden' });
    return send(res, 405, { error: 'POST only' });
  }
  const data = await withUser(req, res, 'zh_link_code_issue', {});
  if (!data) return;
  return send(res, 200, {
    code: data.code,
    start_param: 'l_' + data.code,
    url: net.linkUrl(data.code),
    expires_at: data.expires_at
  });
}

async function authLinkStatus(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!net.originOk(req)) return send(res, 403, { error: 'forbidden' });
  const body = req.method === 'POST' ? await readBody(req) : {};
  const code = (req.query && req.query.code) || body.code || '';
  const token = net.bearer(req);
  if (!token) return send(res, 401, { error: 'Нужно войти', hint: 'auth' });
  try {
    const data = await userRpc('zh_link_status', { p_token: token, p_code: String(code).replace(/^l_/, '') });
    return send(res, 200, data);
  } catch (e) {
    return send(res, e.hint === 'disabled' ? 403 : 401, { error: 'Нужно войти', hint: e.hint || 'auth' });
  }
}

async function authLinkDispute(req, res) {
  if (req.method !== 'POST') {
    if (!net.originOk(req)) return send(res, 403, { error: 'forbidden' });
    return send(res, 405, { error: 'POST only' });
  }
  const body = await readBody(req);
  const data = await withUser(req, res, 'zh_link_dispute', { p_code: body.code || '' });
  if (!data) return;
  return send(res, 200, { ok: true });
}

async function authDevices(req, res) {
  if (req.method !== 'GET') {
    if (!net.originOk(req)) return send(res, 403, { error: 'forbidden' });
    return send(res, 405, { error: 'GET only' });
  }
  if (!net.originOk(req)) return send(res, 403, { error: 'forbidden' });
  const token = net.bearer(req);
  if (!token) return send(res, 401, { error: 'Нужно войти', hint: 'auth' });
  try {
    const data = await userRpc('zh_devices', { p_token: token });
    return send(res, 200, data);
  } catch (e) {
    return send(res, e.hint === 'disabled' ? 403 : 401, { error: e.hint === 'disabled' ? 'Аккаунт отключён' : 'Нужно войти', hint: e.hint || 'auth' });
  }
}

async function authDeviceEnd(req, res) {
  if (req.method !== 'POST') {
    if (!net.originOk(req)) return send(res, 403, { error: 'forbidden' });
    return send(res, 405, { error: 'POST only' });
  }
  const id = (req.query && req.query.id) || '';
  const data = await withUser(req, res, 'zh_device_end', { p_id: id });
  if (!data) return;
  return send(res, 200, { ok: true });
}

async function authInvite(req, res) {
  if (req.method !== 'POST') {
    if (!net.originOk(req)) return send(res, 403, { error: 'forbidden' });
    return send(res, 405, { error: 'POST only' });
  }
  if (!net.originOk(req)) return send(res, 403, { error: 'forbidden' });
  const body = await readBody(req);
  if (body && body.role != null && String(body.role) !== '') {
    return send(res, 400, { error: 'Роль задаёт администратор платформы', hint: 'forbidden' });
  }
  const token = net.bearer(req);
  if (!token) return send(res, 401, { error: 'Нужно войти', hint: 'auth' });
  let data;
  try {
    data = await serviceRpc('zh_invite_issue_admin', { p_token: token, p_admin_ids: process.env.ADMIN_TELEGRAM_IDS || '' });
  } catch (e) {
    return send(res, e.hint === 'disabled' ? 403 : 401, { error: e.hint === 'disabled' ? 'Аккаунт отключён' : 'Нужно войти', hint: e.hint || 'auth' });
  }
  if (await sendResult(res, data)) return;
  return send(res, 200, { code: data.code, expires_at: data.expires_at });
}

module.exports = {
  tgAuth, tgLink, tgLogin, tgUnbind,
  authLogin, authRegister, authRefresh, authMigrate, authLogout, authLogoutAll,
  authPassword, authLinkCode, authLinkStatus, authLinkDispute, authDevices, authDeviceEnd, authInvite
};
