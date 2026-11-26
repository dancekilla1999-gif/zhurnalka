const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/zhurnalka';
process.env.IP_SALT = process.env.IP_SALT || 'test-ip-salt-value';
process.env.REFRESH_GRACE_KEY = process.env.REFRESH_GRACE_KEY || 'test-grace-key-not-a-secret';
process.env.TG_SESSION_SECRET = process.env.TG_SESSION_SECRET || 'test-session-secret-value-32';
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '5990001111:AAHtestTokenForUnitTestsOnly00000';
process.env.TG_BOT_USERNAME = process.env.TG_BOT_USERNAME || 'trio_zhurnalka_bot';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'cron-test-secret';

const { query } = require('../srv/lib/pg-rpc');
const { rpc } = require('../srv/lib/sb');
const handlers = require('../srv/lib/auth-handlers');
const { signInitData } = require('../srv/lib/telegram');

async function loadDb() {
  await query('drop schema if exists bill cascade');
  await query('drop schema if exists zh cascade');
  await query(fs.readFileSync(path.join(__dirname, '..', 'sql', 'test_schema.sql'), 'utf8'));
  await query(fs.readFileSync(path.join(__dirname, '..', 'sql', '20261126_tg_auth.sql'), 'utf8'));
}

async function reset() {
  await query(`truncate zh.auth_alerts, zh.auth_events, zh.tg_initdata_used, zh.tg_link_codes, zh.tg_links,
    zh.consents, zh.sessions, zh.login_attempts, zh.owner_invites, zh.subscription, zh.points,
    zh.agent_sys_calls, zh.owners restart identity cascade`);
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    json: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(s) {
      this.body = s || '';
      try { this.json = this.body ? JSON.parse(this.body) : null; } catch (e) { this.json = null; }
    }
  };
}

function mockReq(opts) {
  const o = opts || {};
  return {
    method: o.method || 'POST',
    headers: Object.assign({
      host: 'zhurnalka.local',
      origin: 'https://zhurnalka.local',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0',
      'x-real-ip': '203.0.113.10'
    }, o.headers || {}),
    body: o.body || {},
    query: o.query || {}
  };
}

async function call(fn, opts) {
  const res = mockRes();
  await handlers[fn](mockReq(opts), res);
  return res;
}

function cookieToken(res) {
  const raw = res.headers['set-cookie'] || '';
  const m = raw.match(/zh_rt=([0-9a-f]+)/);
  return m ? m[1] : '';
}

async function inviteCode() {
  const code = crypto.randomBytes(16).toString('hex');
  await query('insert into zh.owner_invites (code_hash, expires_at) values (zh.hash_token($1), now() + interval \'7 days\')', [code]);
  return code;
}

async function register(email, password) {
  const invite = await inviteCode();
  const res = await call('authRegister', { body: { email, password, name: 'Егор', invite } });
  if (res.statusCode !== 200) throw new Error('register ' + res.statusCode + ' ' + res.body);
  return { res, token: res.json.token, refresh: cookieToken(res), email };
}

function userJson(id, extra) {
  return JSON.stringify(Object.assign({ id: id || 4242, first_name: 'Егор', username: 'rundego', language_code: 'ru' }, extra || {}));
}

function signedInit(opts) {
  const o = opts || {};
  const fields = {
    auth_date: String(o.authDate == null ? Math.floor(Date.now() / 1000) : o.authDate),
    query_id: o.queryId || 'AAEunit',
    user: o.user || userJson(o.userId || 4242),
    signature: o.signature == null ? 'unit-signature-field' : o.signature
  };
  if (o.extra) Object.assign(fields, o.extra);
  return signInitData(fields, o.token || process.env.TG_BOT_TOKEN);
}

module.exports = {
  loadDb, reset, query, rpc, handlers, call, mockReq, mockRes, cookieToken,
  inviteCode, register, signedInit, userJson
};
