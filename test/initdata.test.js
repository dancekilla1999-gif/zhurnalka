const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateInitData, signInitData } = require('../srv/lib/telegram');
const { signedInit } = require('./helpers');

const token = process.env.TG_BOT_TOKEN;

test('синтетический initData проходит, чужой токен и порча — нет', () => {
  const raw = signedInit();
  const ok = validateInitData(raw, token, { maxAgeSec: 600 });
  assert.equal(ok.ok, true);
  assert.equal(ok.user.id, 4242);
  assert.equal(ok.user.username, 'rundego');
  assert.equal(validateInitData(raw, '99999999:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').ok, false);
  assert.equal(validateInitData(raw.replace('unit-signature-field', 'tampered-signature'), token).error, 'BAD_HASH');
  assert.equal(validateInitData(raw, token, { excludeSignature: true }).ok, false);
  const params = new URLSearchParams(raw);
  params.set('auth_date', String(Number(params.get('auth_date')) + 1));
  assert.equal(validateInitData(params.toString(), token).error, 'BAD_HASH');
});

test('auth_date: 10 минут, час и будущее', () => {
  const now = Math.floor(Date.now() / 1000);
  const old10 = signedInit({ authDate: now - 601 });
  assert.equal(validateInitData(old10, token, { maxAgeSec: 600 }).error, 'EXPIRED');
  assert.equal(validateInitData(old10, token, { maxAgeSec: 3600 }).ok, true);
  const oldHour = signedInit({ authDate: now - 3601 });
  assert.equal(validateInitData(oldHour, token, { maxAgeSec: 3600 }).error, 'EXPIRED');
  const future = signedInit({ authDate: now + 120 });
  assert.equal(validateInitData(future, token, { now: now * 1000 }).error, 'EXPIRED');
  const skew = signedInit({ authDate: now + 30 });
  assert.equal(validateInitData(skew, token, { now: now * 1000 }).ok, true);
});

test('реальный initData с signature', (t) => {
  const real = process.env.TG_REAL_INITDATA || '';
  const bot = process.env.TG_TEST_BOT_TOKEN || '';
  if (!real || !bot) {
    if (process.env.REQUIRE_REAL_INITDATA === '1') {
      throw new Error('нет фикстуры TG_REAL_INITDATA или TG_TEST_BOT_TOKEN');
    }
    t.skip();
    return;
  }
  const params = new URLSearchParams(real);
  const authDate = Number(params.get('auth_date'));
  const ok = validateInitData(real, bot, { now: authDate * 1000 });
  assert.equal(ok.ok, true);
  assert.equal(validateInitData(real, bot, { now: authDate * 1000, excludeSignature: true }).ok, false);
  console.log('real initData: ok');
  const testDc = process.env.TG_REAL_INITDATA_TESTDC || '';
  if (testDc) {
    const p2 = new URLSearchParams(testDc);
    const d2 = Number(p2.get('auth_date'));
    assert.equal(validateInitData(testDc, bot, { now: d2 * 1000 }).ok, true);
    console.log('real initData testdc: ok');
  }
});

test('signInitData совпадает с ручным HMAC', () => {
  const fields = { auth_date: '1700000000', query_id: 'q', user: '{"id":1,"first_name":"A"}' };
  const raw = signInitData(fields, token);
  assert.equal(validateInitData(raw, token, { now: 1700000000 * 1000, maxAgeSec: 10 }).ok, true);
});
