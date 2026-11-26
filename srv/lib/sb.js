// Вызовы функций базы. Прод — PostgREST. Тесты и Этап 2 — Postgres по DATABASE_URL / TEST_DATABASE_URL.
// Публичный ключ уже лежит в кабинете. Сервисный ключ только из env и только для функций service_role.
const PUBLISHABLE = 'sb_publishable_Us9CgaJDpwIpAHSQYN7QMg_ADy35Uov';

function dbUrl() {
  return process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
}

async function rpc(fn, args, opts) {
  if (dbUrl()) return require('./pg-rpc').rpc(fn, args, opts);
  const service = opts && opts.role === 'service';
  const key = service ? process.env.SB_SERVICE_KEY : (process.env.SB_KEY || PUBLISHABLE);
  if (service && !process.env.SB_SERVICE_KEY) {
    const e = new Error('SB_SERVICE_KEY is not set');
    e.status = 500;
    throw e;
  }
  const url = process.env.SB_URL || 'https://qozyihhlocvgpkchyqsp.supabase.co';
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
    signal: AbortSignal.timeout(20000)
  });
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
  if (!r.ok) {
    const e = new Error((data && data.message) || `База ответила ${r.status}`);
    e.hint = data && data.hint;
    e.status = r.status;
    throw e;
  }
  return data;
}

module.exports = { rpc };
