const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { headersFor, projectRules } = require('../srv/lib/security-headers');
const { routeUpdate } = require('../srv/api/tg');
const { tariffText } = require('../public/app/auth-logic');

test('заголовки /app и /tg', async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.deepEqual(cfg.regions, ['fra1']);
  const rules = projectRules();
  const app = headersFor('/app/', rules);
  const tg = headersFor('/tg/', rules);
  assert.equal(app['x-frame-options'], 'DENY');
  assert.match(app['content-security-policy'], /script-src 'self'/);
  assert.match(app['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(app['content-security-policy'].includes('unsafe-inline'), false);
  assert.equal(tg['x-frame-options'], undefined);
  assert.match(tg['content-security-policy'], /frame-ancestors https:\/\/web\.telegram\.org/);
  assert.match(tg['content-security-policy'], /script-src 'self' https:\/\/telegram\.org/);
  await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const h = headersFor(req.url, rules);
      Object.keys(h).forEach((k) => res.setHeader(k, h[k]));
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      Promise.all(['/app/', '/tg/'].map((p) => fetch('http://127.0.0.1:' + port + p).then((r) => ({ p, xfo: r.headers.get('x-frame-options'), csp: r.headers.get('content-security-policy') }))))
        .then((rows) => {
          assert.equal(rows[0].xfo, 'DENY');
          assert.equal(rows[1].xfo, null);
          assert.match(rows[1].csp, /telegram\.org/);
          server.close();
          resolve();
        })
        .catch((e) => { server.close(); reject(e); });
    });
  });
});

test('в public нет токенов бота и initData', () => {
  const root = path.join(__dirname, '..', 'public');
  const bot = /\d{8,10}:[A-Za-z0-9_-]{35}/;
  const hits = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else {
        const text = fs.readFileSync(full, 'utf8');
        if (bot.test(text) || text.includes('sb_secret_') || (text.includes('auth_date=') && text.includes('hash='))) hits.push(full);
      }
    }
  }
  walk(root);
  assert.deepEqual(hits, []);
});

test('тариф в Mini App без оплаты, скрипты /tg/ без trio-bill', () => {
  assert.equal(tariffText({ name: 'Журналка', active: true, until: '2026-01-12' }), 'Тариф: Журналка, активен до 12.01');
  assert.equal(tariffText({ active: false }), 'Подписка неактивна');
  assert.equal(/оплат|продл|yookassa/i.test(tariffText({ name: 'Журналка', active: true, until: '2026-01-12' })), false);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'tg', 'index.html'), 'utf8');
  assert.equal(html.includes('trio-bill'), false);
  assert.equal(html.includes('yookassa'), false);
  assert.match(html, /telegram-web-app\.js/);
  assert.match(html, /Откройте в Telegram|tg\.js/);
  const tgJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'tg', 'tg.js'), 'utf8');
  assert.match(tgJs, /Откройте в Telegram/);
  assert.equal(/оплат|продл/.test(tgJs), false);
});

test('l_ не привязывает чат, 18-hex привязывает', () => {
  assert.equal(routeUpdate('/start abcdabcdabcdabcdab').kind, 'bind');
  assert.equal(routeUpdate('/start l_abcdefghijklmnopqrstuv').kind, 'app');
  assert.equal(routeUpdate('/app').kind, 'app');
  assert.equal(routeUpdate('/help').kind, 'app');
  assert.equal(routeUpdate('/today').kind, 'other');
});

test('вебхук: l_ не вызывает tg_bind, секрет проверяется', async () => {
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'cron-test-secret';
  const { loadDb, query } = require('./helpers');
  await loadDb();
  const handler = require('../srv/api/tg');
  const secret = crypto.createHash('sha256').update('tg:' + process.env.CRON_SECRET).digest('hex').slice(0, 48);
  const prev = process.env.TG_BOT_TOKEN;
  delete process.env.TG_BOT_TOKEN;
  function run(text, header) {
    return new Promise((resolve) => {
      const res = { statusCode: 0, headers: {}, setHeader() {}, end() { resolve(res); } };
      handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': header == null ? secret : header }, body: { message: { chat: { id: 1, type: 'private' }, text } } }, res);
    });
  }
  try {
    const bad = await run('/start', 'wrong');
    assert.equal(bad.statusCode, 401);
    await query('delete from zh.agent_sys_calls');
    await run('/start l_abcdefghijklmnopqrstuv');
    const calls = await query('select op from zh.agent_sys_calls');
    assert.equal(calls.some((c) => c.op === 'tg_bind'), false);
    await run('/start abcdabcdabcdabcdab');
    const calls2 = await query('select op from zh.agent_sys_calls');
    assert.equal(calls2.some((c) => c.op === 'tg_bind'), true);
  } finally {
    if (prev) process.env.TG_BOT_TOKEN = prev;
  }
});

test('TG_SETUP по умолчанию ничего не делает', async () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['scripts/tg-setup.js'], { encoding: 'utf8', env: Object.assign({}, process.env, { TG_SETUP: '0' }) });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /TG_SETUP=0/);
});
