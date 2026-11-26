const { describe, before, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers');

describe('sessions', { concurrency: false }, () => {
before(async () => { await h.loadDb(); });
beforeEach(async () => { await h.reset(); });

async function linkOwner(email) {
  const acc = await h.register(email, 'password-ok');
  const codeRes = await h.call('authLinkCode', { headers: { authorization: 'Bearer ' + acc.token } });
  assert.equal(codeRes.statusCode, 200);
  return { acc, code: codeRes.json.code };
}

test('регистрация без приглашения закрыта, с приглашением выдаёт cookie', async () => {
  const denied = await h.call('authRegister', { body: { email: 'a@b.c', password: 'password-ok', name: 'А' } });
  assert.equal(denied.statusCode, 400);
  assert.match(denied.json.error, /приглашен/);
  const pub = await h.rpc('zh_register', { p_email: 'a@b.c', p_password: 'password-ok', p_name: 'А' }, { role: 'anon' });
  assert.equal(pub.hint, 'invite');
  const acc = await h.register('egor@example.com', 'password-ok');
  assert.equal(acc.res.json.refresh, undefined);
  assert.match(acc.res.headers['set-cookie'], /HttpOnly/);
  assert.match(acc.res.headers['set-cookie'], /Secure/);
  assert.match(acc.res.headers['set-cookie'], /SameSite=Strict/);
  assert.match(acc.res.headers['set-cookie'], /Path=\/api\/auth/);
  assert.equal(acc.res.headers['access-control-allow-credentials'], undefined);
});

test('чужой Origin на /api/auth не обновляет сессию', async () => {
  const acc = await h.register('egor@example.com', 'password-ok');
  const res = await h.call('authRefresh', {
    headers: { origin: 'https://evil.example', host: 'zhurnalka.local', cookie: 'zh_rt=' + acc.refresh }
  });
  assert.equal(res.statusCode, 403);
});

test('refresh ротируется, в окне 60 с та же пара, потом кража', async () => {
  const acc = await h.register('egor@example.com', 'password-ok');
  const first = await h.call('authRefresh', { headers: { cookie: 'zh_rt=' + acc.refresh } });
  assert.equal(first.statusCode, 200);
  const again = await h.call('authRefresh', { headers: { cookie: 'zh_rt=' + acc.refresh } });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json.token, first.json.token);
  assert.equal(h.cookieToken(again), h.cookieToken(first));
  const rows = await h.query('select grace_cipher from zh.sessions where grace_cipher is not null');
  assert.ok(rows.length >= 1);
  assert.equal(rows.some((r) => String(r.grace_cipher).includes(first.json.token)), false);
  await h.query("update zh.sessions set grace_expires_at = now() - interval '1 second' where grace_cipher is not null");
  const stolen = await h.call('authRefresh', { headers: { cookie: 'zh_rt=' + acc.refresh } });
  assert.equal(stolen.statusCode, 401);
  assert.equal(stolen.json.hint, 'revoked');
  const events = await h.query("select kind from zh.auth_events where kind = 'refresh_reuse'");
  assert.equal(events.length, 1);
  await assert.rejects(() => h.rpc('zh_me', { p_token: first.json.token }, { role: 'anon' }), (e) => e.hint === 'revoked');
});

test('два параллельных refresh отдают одну пару', async () => {
  const acc = await h.register('egor@example.com', 'password-ok');
  const pair = await Promise.all([
    h.call('authRefresh', { headers: { cookie: 'zh_rt=' + acc.refresh } }),
    h.call('authRefresh', { headers: { cookie: 'zh_rt=' + acc.refresh } })
  ]);
  assert.equal(pair[0].statusCode, 200);
  assert.equal(pair[1].statusCode, 200);
  assert.equal(pair[0].json.token, pair[1].json.token);
});

test('неверный пароль не говорит, есть ли почта, 11-я попытка — 429', async () => {
  await h.register('egor@example.com', 'password-ok');
  const unknown = await h.call('authLogin', { body: { email: 'no@example.com', password: 'password-ok' } });
  const bad = await h.call('authLogin', { body: { email: 'egor@example.com', password: 'wrong-pass' } });
  assert.equal(unknown.json.error, bad.json.error);
  assert.equal(unknown.json.error, 'Неверная почта или пароль');
  for (let i = 0; i < 9; i++) {
    await h.call('authLogin', { body: { email: 'egor@example.com', password: 'wrong-pass' } });
  }
  const blocked = await h.call('authLogin', { body: { email: 'egor@example.com', password: 'wrong-pass' } });
  assert.equal(blocked.statusCode, 429);
  assert.match(blocked.json.error, /Слишком много попыток, подождите \d+ мин/);
});

test('лимит по x-real-ip, подмена x-forwarded-for не помогает', async () => {
  for (let i = 0; i < 30; i++) {
    const res = await h.call('authLogin', {
      headers: { 'x-real-ip': '198.51.100.8', 'x-forwarded-for': '1.2.3.' + i },
      body: { email: 'u' + i + '@example.com', password: 'wrong-pass' }
    });
    assert.equal(res.statusCode, 401);
  }
  const spoof = await h.call('authLogin', {
    headers: { 'x-real-ip': '198.51.100.8', 'x-forwarded-for': '8.8.8.8' },
    body: { email: 'fresh@example.com', password: 'wrong-pass' }
  });
  assert.equal(spoof.statusCode, 429);
  const other = await h.call('authLogin', {
    headers: { 'x-real-ip': '198.51.100.9', 'x-forwarded-for': '198.51.100.8' },
    body: { email: 'fresh@example.com', password: 'wrong-pass' }
  });
  assert.equal(other.statusCode, 401);
});

test('anon не вызывает функции сессии даже с верным секретом', async () => {
  const secret = process.env.TG_SESSION_SECRET;
  const args = {
    zh_tg_session: { p_tg_user_id: '7', p_device_key: 'k', p_device_label: 'd', p_ip_hash: null, p_username: '', p_first_name: 'А', p_secret: secret },
    zh_tg_link: { p_init_hash: 'ab', p_tg_user_id: '7', p_username: '', p_first_name: '', p_code: 'x', p_consent: false, p_consent_version: 'v', p_device_key: 'k', p_device_label: 'd', p_ip_hash: null, p_secret: secret },
    zh_tg_login: { p_init_hash: 'ab', p_tg_user_id: '7', p_username: '', p_first_name: '', p_email: 'a@b.c', p_password: 'password-ok', p_consent: true, p_consent_version: 'v', p_device_key: 'k', p_device_label: 'd', p_ip_hash: null, p_secret: secret },
    zh_link_code_consume: { p_code: 'not-a-real-code', p_secret: secret }
  };
  for (const fn of Object.keys(args)) {
    await assert.rejects(() => h.rpc(fn, args[fn], { role: 'anon' }), (e) => e.code === '42501');
  }
  const ok = await h.rpc('zh_tg_session', args.zh_tg_session, { role: 'service' });
  assert.equal(ok.need_link, true);
});

test('owner_id стабильный, session_touch изменчивый', async () => {
  const rows = await h.query(`select p.proname, p.provolatile
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'zh' and p.proname in ('owner_id', 'session_touch')`);
  const map = Object.fromEntries(rows.map((r) => [r.proname, r.provolatile]));
  assert.equal(map.owner_id, 's');
  assert.equal(map.session_touch, 'v');
});

test('hint для каждой причины и для bill_*', async () => {
  const acc = await h.register('egor@example.com', 'password-ok');
  const reasons = {
    rotated: 'expired',
    logout: 'revoked',
    logout_all: 'revoked',
    password: 'revoked',
    admin: 'revoked',
    unbind: 'revoked',
    device_end: 'revoked',
    refresh_reuse: 'revoked'
  };
  for (const reason of Object.keys(reasons)) {
    await h.query('update zh.sessions set revoked_at = now(), revoke_reason = $1, expires_at = now() + interval \'1 day\' where token_hash = zh.hash_token($2)', [reason, acc.token]);
    await assert.rejects(() => h.rpc('zh_me', { p_token: acc.token }, { role: 'anon' }), (e) => e.hint === reasons[reason]);
    await h.query('update zh.sessions set revoked_at = null, revoke_reason = null, expires_at = now() + interval \'15 minutes\' where token_hash = zh.hash_token($1)', [acc.token]);
  }
  await h.query('update zh.sessions set expires_at = now() - interval \'1 minute\' where token_hash = zh.hash_token($1)', [acc.token]);
  await assert.rejects(() => h.rpc('zh_me', { p_token: acc.token }, { role: 'anon' }), (e) => e.hint === 'expired');
  await h.query('update zh.sessions set expires_at = now() + interval \'15 minutes\', abs_expires_at = now() - interval \'1 minute\' where token_hash = zh.hash_token($1)', [acc.token]);
  await assert.rejects(() => h.rpc('zh_point_get', { p_token: acc.token }, { role: 'anon' }), (e) => e.hint === 'expired');
  await h.query('update zh.sessions set abs_expires_at = now() + interval \'15 minutes\', revoked_at = null where token_hash = zh.hash_token($1)', [acc.token]);
  await h.query('update zh.owners set disabled_at = now() where email = $1', ['egor@example.com']);
  await assert.rejects(() => h.rpc('bill_status', { p_product: 'zh', p_token: acc.token }, { role: 'anon' }), (e) => e.hint === 'disabled');
  await assert.rejects(() => h.rpc('bill_invoices', { p_product: 'zh', p_token: acc.token }, { role: 'anon' }), (e) => e.hint === 'disabled');
  const names = ['zh_admit', 'zh_agent', 'zh_entries', 'zh_entry_void', 'zh_invite_new', 'zh_logout', 'zh_me', 'zh_owner_entry', 'zh_point_archive', 'zh_point_create', 'zh_point_get', 'zh_point_update', 'zh_staff_link', 'zh_staff_update', 'zh_unit_remove', 'zh_unit_save'];
  for (const name of names) {
    await assert.rejects(() => h.rpc(name, { p_token: acc.token }, { role: 'anon' }), (e) => e.hint === 'disabled');
  }
});

test('код привязки: 128 бит, в базе только хеш, срок, повтор, лимит, не 18-hex', async () => {
  const { acc, code } = await linkOwner('egor@example.com');
  assert.equal(Buffer.from(code, 'base64url').length, 16);
  const row = await h.query('select code_hash from zh.tg_link_codes');
  assert.equal(row[0].code_hash, crypto.createHash('sha256').update(code, 'utf8').digest('hex'));
  assert.notEqual(row[0].code_hash, code);
  const init = h.signedInit({ userId: 9001 });
  const badHex = await h.call('tgLink', { body: { initData: init, code: 'ab'.repeat(9), consent: true, device_id: 'd1', platform: 'ios' } });
  assert.notEqual(badHex.statusCode, 200);
  const no = await h.call('tgLink', { body: { initData: init, code, consent: false, device_id: 'd1', platform: 'ios' } });
  assert.equal(no.statusCode, 400);
  const links = await h.query('select count(*)::int as n from zh.tg_links');
  assert.equal(links[0].n, 0);
  const yes = await h.call('tgLink', { body: { initData: init, code, consent: true, device_id: 'd1', platform: 'ios' } });
  assert.equal(yes.statusCode, 200, yes.body);
  const cons = await h.query("select kind, version from zh.consents");
  assert.equal(cons[0].kind, 'tg_login');
  assert.equal(cons[0].version, '2026-11-26-1');
  const again = await h.call('tgLink', { body: { initData: h.signedInit({ userId: 9001, queryId: 'other' }), code, consent: true, device_id: 'd2', platform: 'ios' } });
  assert.notEqual(again.statusCode, 200);
  const { code: code2 } = await linkOwner('other@example.com');
  await h.query('update zh.tg_link_codes set expires_at = now() - interval \'1 minute\' where code_hash = zh.hash_token($1)', [code2]);
  const late = await h.call('tgLink', { body: { initData: h.signedInit({ userId: 9002 }), code: code2, consent: true, device_id: 'd3', platform: 'ios' } });
  assert.notEqual(late.statusCode, 200);
  for (let i = 0; i < 4; i++) {
    const more = await h.call('authLinkCode', { headers: { authorization: 'Bearer ' + acc.token } });
    assert.equal(more.statusCode, 200);
  }
  const sixth = await h.call('authLinkCode', { headers: { authorization: 'Bearer ' + acc.token } });
  assert.equal(sixth.statusCode, 429);
});

test('два параллельных /link с одним кодом — одна привязка', async () => {
  const { code } = await linkOwner('egor@example.com');
  const calls = [];
  for (let i = 0; i < 2; i++) {
    calls.push(h.call('tgLink', { body: { initData: h.signedInit({ userId: 77, queryId: 'q' + i }), code, consent: true, device_id: 'dev' + i, platform: 'ios' } }));
  }
  const res = await Promise.all(calls);
  const wins = res.filter((r) => r.statusCode === 200);
  assert.equal(wins.length, 1);
  const n = await h.query('select count(*)::int as n from zh.tg_links');
  assert.equal(n[0].n, 1);
});

test('20 параллельных /login с одним initData — один успех; опечатка initData не сжигает', async () => {
  await h.register('egor@example.com', 'password-ok');
  const init = h.signedInit({ userId: 55 });
  const bad = await h.call('tgLogin', { body: { initData: init, email: 'egor@example.com', password: 'nope-nope', consent: true, device_id: 'phone', platform: 'ios' } });
  assert.equal(bad.statusCode, 401);
  assert.notEqual(bad.json.error, 'REPLAY');
  const good = await h.call('tgLogin', { body: { initData: init, email: 'egor@example.com', password: 'password-ok', consent: true, device_id: 'phone', platform: 'ios' } });
  assert.equal(good.statusCode, 200, good.body);
  await h.query('delete from zh.tg_links');
  await h.query('delete from zh.tg_initdata_used');
  await h.query('delete from zh.sessions where kind = \'tg\'');
  const init2 = h.signedInit({ userId: 56, queryId: 'race' });
  const all = await Promise.all(Array.from({ length: 20 }, () => h.call('tgLogin', {
    body: { initData: init2, email: 'egor@example.com', password: 'password-ok', consent: true, device_id: 'phone', platform: 'ios' }
  })));
  assert.equal(all.filter((r) => r.statusCode === 200).length, 1);
  assert.ok(all.filter((r) => r.statusCode !== 200).every((r) => r.json.error === 'REPLAY'));
});

test('один Telegram на аккаунт', async () => {
  const a = await linkOwner('a@example.com');
  const b = await linkOwner('b@example.com');
  const first = await h.call('tgLink', { body: { initData: h.signedInit({ userId: 1 }), code: a.code, consent: true, device_id: 'a', platform: 'ios' } });
  assert.equal(first.statusCode, 200);
  const otherTg = await h.call('tgLink', { body: { initData: h.signedInit({ userId: 2 }), code: (await h.call('authLinkCode', { headers: { authorization: 'Bearer ' + a.acc.token } })).json.code, consent: true, device_id: 'b', platform: 'ios' } });
  assert.notEqual(otherTg.statusCode, 200);
  const sameTg = await h.call('tgLink', { body: { initData: h.signedInit({ userId: 1, queryId: 'move' }), code: b.code, consent: true, device_id: 'c', platform: 'ios' } });
  assert.notEqual(sameTg.statusCode, 200);
  assert.match(sameTg.json.error, /другому аккаунту/);
});

test('устройства: ротация своего, чужое живёт, шестое вытесняет старое', async () => {
  await h.register('egor@example.com', 'password-ok');
  const init = () => h.signedInit({ userId: 321 });
  async function enter(device) {
    return h.call('tgLogin', { body: { initData: init(), email: 'egor@example.com', password: 'password-ok', consent: true, device_id: device, platform: 'tdesktop' } });
  }
  const a = await enter('device-a');
  assert.equal(a.statusCode, 200, a.body);
  const b = await h.call('tgAuth', { body: { initData: init(), device_id: 'device-b', platform: 'ios' } });
  assert.equal(b.statusCode, 200, b.body);
  const aStill = await h.rpc('zh_me', { p_token: a.json.token }, { role: 'anon' });
  assert.equal(aStill.email, 'egor@example.com');
  const a2 = await h.call('tgAuth', { body: { initData: init(), device_id: 'device-a', platform: 'tdesktop' } });
  assert.equal(a2.statusCode, 200);
  await assert.rejects(() => h.rpc('zh_me', { p_token: a.json.token }, { role: 'anon' }), (e) => e.hint === 'expired');
  const bStill = await h.rpc('zh_me', { p_token: b.json.token }, { role: 'anon' });
  assert.equal(bStill.email, 'egor@example.com');
  const tokens = [b.json.token];
  for (let i = 0; i < 4; i++) {
    const r = await h.call('tgAuth', { body: { initData: init(), device_id: 'extra-' + i, platform: 'web' } });
    assert.equal(r.statusCode, 200, r.body);
    tokens.push(r.json.token);
    await h.query('update zh.sessions set last_used_at = now() - ($1 || \' minutes\')::interval where token_hash = zh.hash_token($2)', [String(30 - i), r.json.token]);
  }
  await h.query('update zh.sessions set last_used_at = now() - interval \'2 hours\' where token_hash = zh.hash_token($1)', [b.json.token]);
  const sixth = await h.call('tgAuth', { body: { initData: init(), device_id: 'device-f', platform: 'android' } });
  assert.equal(sixth.statusCode, 200);
  await assert.rejects(() => h.rpc('zh_me', { p_token: b.json.token }, { role: 'anon' }), (e) => e.hint === 'expired');
  const back = await h.call('tgAuth', { body: { initData: init(), device_id: 'device-b', platform: 'ios' } });
  assert.equal(back.statusCode, 200);
  const active = await h.query("select count(*)::int as n from zh.sessions where kind = 'tg' and revoked_at is null and expires_at > now()");
  assert.ok(active[0].n <= 5);
});

test('смена пароля: с сайта снимает Telegram, из Mini App оставляет эту сессию', async () => {
  const acc = await h.register('egor@example.com', 'password-ok');
  const tg = await h.call('tgLogin', { body: { initData: h.signedInit({ userId: 88 }), email: 'egor@example.com', password: 'password-ok', consent: true, device_id: 'phone', platform: 'ios' } });
  assert.equal(tg.statusCode, 200);
  const other = await h.call('authLogin', { body: { email: 'egor@example.com', password: 'password-ok' } });
  const badPw = await h.call('authPassword', { headers: { authorization: 'Bearer ' + acc.token }, body: { current: 'nope-nope', new: 'new-password-1' } });
  assert.notEqual(badPw.statusCode, 200);
  const fromWeb = await h.call('authPassword', { headers: { authorization: 'Bearer ' + acc.token }, body: { current: 'password-ok', new: 'new-password-1' } });
  assert.equal(fromWeb.statusCode, 200, fromWeb.body);
  const me = await h.rpc('zh_me', { p_token: acc.token }, { role: 'anon' });
  assert.equal(me.email, 'egor@example.com');
  await assert.rejects(() => h.rpc('zh_me', { p_token: tg.json.token }, { role: 'anon' }), (e) => e.hint === 'revoked');
  await assert.rejects(() => h.rpc('zh_me', { p_token: other.json.token }, { role: 'anon' }), (e) => e.hint === 'revoked');
  const links = await h.query('select count(*)::int as n from zh.tg_links');
  assert.equal(links[0].n, 0);
  const tg2 = await h.call('tgLogin', { body: { initData: h.signedInit({ userId: 88, queryId: 'again' }), email: 'egor@example.com', password: 'new-password-1', consent: true, device_id: 'phone', platform: 'ios' } });
  assert.equal(tg2.statusCode, 200, tg2.body);
  const web2 = await h.call('authLogin', { body: { email: 'egor@example.com', password: 'new-password-1' } });
  const fromTg = await h.call('authPassword', { headers: { authorization: 'Bearer ' + tg2.json.token }, body: { current: 'new-password-1', new: 'new-password-2' } });
  assert.equal(fromTg.statusCode, 200, fromTg.body);
  const meTg = await h.rpc('zh_me', { p_token: tg2.json.token }, { role: 'anon' });
  assert.equal(meTg.tg.username, 'rundego');
  await assert.rejects(() => h.rpc('zh_me', { p_token: web2.json.token }, { role: 'anon' }), (e) => e.hint === 'revoked');
});

test('завершить tg-сессию снимает привязку, веб-сессию — только её', async () => {
  const acc = await h.register('egor@example.com', 'password-ok');
  const tg = await h.call('tgLogin', { body: { initData: h.signedInit({ userId: 15 }), email: 'egor@example.com', password: 'password-ok', consent: true, device_id: 'phone', platform: 'ios' } });
  const list = await h.call('authDevices', { method: 'GET', headers: { authorization: 'Bearer ' + acc.token } });
  assert.equal(list.statusCode, 200);
  const tgRow = list.json.devices.find((d) => d.kind === 'tg');
  const webRow = list.json.devices.find((d) => d.current);
  const endTg = await h.call('authDeviceEnd', { headers: { authorization: 'Bearer ' + acc.token }, query: { id: tgRow.id } });
  assert.equal(endTg.statusCode, 200);
  await assert.rejects(() => h.rpc('zh_me', { p_token: tg.json.token }, { role: 'anon' }), (e) => e.hint === 'revoked');
  const me = await h.rpc('zh_me', { p_token: acc.token }, { role: 'anon' });
  assert.equal(me.email, 'egor@example.com');
  assert.equal(me.tg, null);
  const withdrawn = await h.query('select withdrawn_at is not null as gone from zh.consents');
  assert.equal(withdrawn[0].gone, true);
  const endWeb = await h.call('authDeviceEnd', { headers: { authorization: 'Bearer ' + webRow.id && acc.token ? 'Bearer ' + acc.token : '' }, query: { id: webRow.id } });
  assert.equal(endWeb.statusCode, 200);
  await assert.rejects(() => h.rpc('zh_me', { p_token: acc.token }, { role: 'anon' }));
});

test('отвязка ставит withdrawn_at, спор пишет событие', async () => {
  const acc = await h.register('egor@example.com', 'password-ok');
  const tg = await h.call('tgLogin', { body: { initData: h.signedInit({ userId: 16 }), email: 'egor@example.com', password: 'password-ok', consent: true, device_id: 'phone', platform: 'ios' } });
  const dispute = await h.call('authLinkDispute', { headers: { authorization: 'Bearer ' + acc.token }, body: { code: '' } });
  assert.equal(dispute.statusCode, 200);
  const ev = await h.query("select kind from zh.auth_events where kind = 'tg_unlink_disputed'");
  assert.equal(ev.length, 1);
  const relink = await h.call('tgLogin', { body: { initData: h.signedInit({ userId: 16, queryId: 're' }), email: 'egor@example.com', password: 'password-ok', consent: true, device_id: 'phone', platform: 'ios' } });
  assert.equal(relink.statusCode, 200);
  const un = await h.call('tgUnbind', { headers: { authorization: 'Bearer ' + tg.json.token } });
  assert.notEqual(un.statusCode, 200);
  const un2 = await h.call('tgUnbind', { headers: { authorization: 'Bearer ' + relink.json.token } });
  assert.equal(un2.statusCode, 200);
  const gone = await h.query('select count(*)::int as n from zh.consents where withdrawn_at is null');
  assert.equal(gone[0].n, 0);
});

test('сессия tg старше 7 и 30 суток — expired, новый вход без пароля', async () => {
  await h.register('egor@example.com', 'password-ok');
  const first = await h.call('tgLogin', { body: { initData: h.signedInit({ userId: 70 }), email: 'egor@example.com', password: 'password-ok', consent: true, device_id: 'phone', platform: 'ios' } });
  await h.query("update zh.sessions set expires_at = now() - interval '8 days', last_used_at = now() - interval '8 days' where token_hash = zh.hash_token($1)", [first.json.token]);
  await assert.rejects(() => h.rpc('zh_me', { p_token: first.json.token }, { role: 'anon' }), (e) => e.hint === 'expired');
  const again = await h.call('tgAuth', { body: { initData: h.signedInit({ userId: 70 }), device_id: 'phone', platform: 'ios' } });
  assert.equal(again.statusCode, 200, again.body);
  await h.query('update zh.sessions set abs_expires_at = now() - interval \'1 day\' where token_hash = zh.hash_token($1)', [again.json.token]);
  await assert.rejects(() => h.rpc('zh_me', { p_token: again.json.token }, { role: 'anon' }), (e) => e.hint === 'expired');
  const fresh = await h.call('tgAuth', { body: { initData: h.signedInit({ userId: 70, queryId: 'new' }), device_id: 'phone', platform: 'ios' } });
  assert.equal(fresh.statusCode, 200);
});

test('/api/tg/auth старше 10 минут и логи без initData', async () => {
  const old = h.signedInit({ authDate: Math.floor(Date.now() / 1000) - 700 });
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    const res = await h.call('tgAuth', { body: { initData: old, device_id: 'd', platform: 'ios' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json.error, 'EXPIRED');
    assert.equal(res.body.includes('unit-signature-field'), false);
    assert.equal(lines.join('\n').includes('unit-signature-field'), false);
    assert.equal(lines.join('\n').includes(old.slice(0, 24)), false);
  } finally { console.log = orig; }
});

test('лимит неверных кодов и /auth по IP', async () => {
  await h.register('egor@example.com', 'password-ok');
  for (let i = 0; i < 10; i++) {
    const res = await h.call('tgLink', { body: { initData: h.signedInit({ userId: 3, queryId: 'c' + i }), code: 'missing-code-' + i, consent: true, device_id: 'd', platform: 'ios' }, headers: { 'x-real-ip': '203.0.113.50' } });
    assert.equal(res.statusCode, 401);
  }
  const blocked = await h.call('tgLink', { body: { initData: h.signedInit({ userId: 3, queryId: 'c-last' }), code: 'missing-code-x', consent: true, device_id: 'd', platform: 'ios' }, headers: { 'x-real-ip': '203.0.113.77' } });
  assert.equal(blocked.statusCode, 429);
});

test('migrate принимает только legacy, access и tg отклоняет', async () => {
  const acc = await h.register('egor@example.com', 'password-ok');
  const access = await h.rpc('zh_login', { p_email: 'egor@example.com', p_password: 'password-ok' }, { role: 'anon' });
  assert.ok(access.token);
  const deniedAccess = await h.call('authMigrate', { body: { token: access.token } });
  assert.equal(deniedAccess.statusCode, 403);
  assert.equal(deniedAccess.json.hint, 'forbidden');
  const tg = await h.call('tgLogin', {
    body: { initData: h.signedInit({ userId: 81 }), email: 'egor@example.com', password: 'password-ok', consent: true, device_id: 'phone', platform: 'ios' }
  });
  assert.equal(tg.statusCode, 200, tg.body);
  const deniedTg = await h.call('authMigrate', { body: { token: tg.json.token } });
  assert.equal(deniedTg.statusCode, 403);
  await h.query("update zh.sessions set kind = 'legacy' where token_hash = zh.hash_token($1)", [access.token]);
  const moved = await h.call('authMigrate', { body: { token: access.token } });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.ok(h.cookieToken(moved));
  await assert.rejects(() => h.rpc('zh_me', { p_token: access.token }, { role: 'anon' }), (e) => e.hint === 'expired');
  const me = await h.rpc('zh_me', { p_token: moved.json.token }, { role: 'anon' });
  assert.equal(me.email, 'egor@example.com');
  const still = await h.rpc('zh_me', { p_token: acc.token }, { role: 'anon' });
  assert.equal(still.email, 'egor@example.com');
});

test('переставленный и перекодированный initData — тот же hash, второй вход REPLAY', async () => {
  await h.register('egor@example.com', 'password-ok');
  const { signInitData } = require('../srv/lib/telegram');
  const raw = signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'reorder',
    user: JSON.stringify({ id: 5151, first_name: 'Egor Test', username: 'rundego', language_code: 'ru' }),
    signature: 'sig value'
  }, process.env.TG_BOT_TOKEN);
  const first = await h.call('tgLogin', {
    body: { initData: raw, email: 'egor@example.com', password: 'password-ok', consent: true, device_id: 'd', platform: 'ios' }
  });
  assert.equal(first.statusCode, 200, first.body);
  const sp = new URLSearchParams(raw);
  const hash = sp.get('hash');
  const pairs = [];
  for (const [k, v] of sp.entries()) if (k !== 'hash') pairs.push([k, v]);
  pairs.reverse();
  const reordered = pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&') + '&hash=' + hash;
  const second = await h.call('tgLogin', {
    body: { initData: reordered, email: 'egor@example.com', password: 'password-ok', consent: true, device_id: 'd2', platform: 'ios' }
  });
  assert.equal(second.statusCode, 401);
  assert.equal(second.json.error, 'REPLAY');
  const plus = pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v).replace(/%20/g, '+')).join('&') + '&hash=' + hash;
  assert.notEqual(plus, reordered);
  const third = await h.call('tgLogin', {
    body: { initData: plus, email: 'egor@example.com', password: 'password-ok', consent: true, device_id: 'd3', platform: 'ios' }
  });
  assert.equal(third.statusCode, 401);
  assert.equal(third.json.error, 'REPLAY');
  const n = await h.query('select count(*)::int as n from zh.tg_links');
  assert.equal(n[0].n, 1);
});

test('приглашения только у платформенного админа и только с сайта', async () => {
  const owner = await h.register('owner@example.com', 'password-ok');
  const manager = await h.register('manager@example.com', 'password-ok');
  const user = await h.register('user@example.com', 'password-ok');
  await h.query("update zh.owners set role = 'manager' where email = 'manager@example.com'");
  const strangerDenied = await h.call('authRegister', { body: { email: 'stranger@example.com', password: 'password-ok', name: 'Чужой', role: 'owner' } });
  assert.equal(strangerDenied.statusCode, 400);
  for (const token of [owner.token, manager.token, user.token]) {
    const res = await h.call('authInvite', { headers: { authorization: 'Bearer ' + token } });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json.hint, 'forbidden');
  }
  const admin = await h.register('admin@example.com', 'password-ok');
  await h.query('update zh.owners set platform_admin = true where email = $1', ['admin@example.com']);
  const tg = await h.call('tgLogin', {
    body: { initData: h.signedInit({ userId: 424242 }), email: 'admin@example.com', password: 'password-ok', consent: true, device_id: 'phone', platform: 'ios' }
  });
  assert.equal(tg.statusCode, 200, tg.body);
  const viaTg = await h.call('authInvite', { headers: { authorization: 'Bearer ' + tg.json.token } });
  assert.equal(viaTg.statusCode, 403);
  const withRole = await h.call('authInvite', { headers: { authorization: 'Bearer ' + admin.token }, body: { role: 'manager' } });
  assert.equal(withRole.statusCode, 400);
  const issued = await h.call('authInvite', { headers: { authorization: 'Bearer ' + admin.token } });
  assert.equal(issued.statusCode, 200, issued.body);
  const row = await h.query('select role from zh.owner_invites where code_hash = zh.hash_token($1)', [issued.json.code]);
  assert.equal(row[0].role, 'owner');
  const newbie = await h.call('authRegister', {
    body: { email: 'newbie@example.com', password: 'password-ok', name: 'Новый', invite: issued.json.code, role: 'admin' }
  });
  assert.equal(newbie.statusCode, 400);
  const joined = await h.call('authRegister', {
    body: { email: 'newbie@example.com', password: 'password-ok', name: 'Новый', invite: issued.json.code }
  });
  assert.equal(joined.statusCode, 200, joined.body);
  const chain = await h.call('authInvite', { headers: { authorization: 'Bearer ' + joined.json.token } });
  assert.equal(chain.statusCode, 403, chain.body);
  const next = await h.call('authRegister', { body: { email: 'next@example.com', password: 'password-ok', name: 'Дальше' } });
  assert.equal(next.statusCode, 400);
  const prev = process.env.ADMIN_TELEGRAM_IDS;
  process.env.ADMIN_TELEGRAM_IDS = '777001';
  try {
    const byId = await h.call('authInvite', { headers: { authorization: 'Bearer ' + owner.token } });
    assert.equal(byId.statusCode, 403);
    const linked = await h.call('tgLogin', {
      body: { initData: h.signedInit({ userId: 777001, queryId: 'link-owner' }), email: 'owner@example.com', password: 'password-ok', consent: true, device_id: 'desk', platform: 'tdesktop' }
    });
    assert.equal(linked.statusCode, 200, linked.body);
    const byWeb = await h.call('authInvite', { headers: { authorization: 'Bearer ' + owner.token } });
    assert.equal(byWeb.statusCode, 200, byWeb.body);
    const ownerTg = await h.call('tgAuth', { body: { initData: h.signedInit({ userId: 777001, queryId: 'again' }), device_id: 'desk', platform: 'tdesktop' } });
    assert.equal(ownerTg.statusCode, 200, ownerTg.body);
    const byTg = await h.call('authInvite', { headers: { authorization: 'Bearer ' + ownerTg.json.token } });
    assert.equal(byTg.statusCode, 403);
  } finally {
    if (prev == null) delete process.env.ADMIN_TELEGRAM_IDS;
    else process.env.ADMIN_TELEGRAM_IDS = prev;
  }
});

test('без device_id сессии одной платформы не вытесняют друг друга', async () => {
  await h.register('egor@example.com', 'password-ok');
  const init = () => h.signedInit({ userId: 77 });
  const first = await h.call('tgLogin', {
    body: { initData: init(), email: 'egor@example.com', password: 'password-ok', consent: true, platform: 'ios' }
  });
  assert.equal(first.statusCode, 200, first.body);
  const second = await h.call('tgAuth', { body: { initData: init(), platform: 'ios' } });
  assert.equal(second.statusCode, 200, second.body);
  const a = await h.rpc('zh_me', { p_token: first.json.token }, { role: 'anon' });
  const b = await h.rpc('zh_me', { p_token: second.json.token }, { role: 'anon' });
  assert.equal(a.email, 'egor@example.com');
  assert.equal(b.email, 'egor@example.com');
});
});
