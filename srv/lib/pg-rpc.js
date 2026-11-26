// Вызов функций Postgres для тестов и для Этапа 2 (свой API). На Этапе 1 прод ходит в PostgREST.
const { Pool } = require('pg');

const CASTS = {
  p_tg_user_id: 'bigint',
  p_consent: 'boolean',
  p_admitted: 'boolean',
  p_limit: 'int',
  p_window_sec: 'int',
  p_args: 'jsonb',
  p_patch: 'jsonb',
  p_data: 'jsonb',
  p_id: 'uuid',
  p_point: 'uuid',
  p_owner: 'uuid',
  p_entry: 'uuid',
  p_staff: 'uuid',
  p_from: 'date',
  p_to: 'date'
};

const ROLES = { anon: 'anon', authenticated: 'authenticated', service: 'service_role', service_role: 'service_role' };

let pool;

function getPool() {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!pool) pool = new Pool({ connectionString: url, max: 30 });
  return pool;
}

function ident(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('bad ident');
  return name;
}

async function rpc(fn, args, opts) {
  const keys = Object.keys(args || {});
  const vals = keys.map((k) => {
    const v = args[k];
    if (v && typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'bigint') return v.toString();
    return v;
  });
  const assigns = keys.map((k, i) => ident(k) + ' := $' + (i + 1) + '::' + (CASTS[k] || 'text')).join(', ');
  const role = ROLES[(opts && opts.role) || 'anon'];
  if (!role) throw new Error('bad role');
  const sql = 'select public.' + ident(fn) + '(' + assigns + ') as result';
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('set local role ' + role);
    await client.query("set local statement_timeout = '20s'");
    const r = await client.query(sql, vals);
    await client.query('commit');
    return r.rows[0] ? r.rows[0].result : null;
  } catch (e) {
    try { await client.query('rollback'); } catch (x) { /* уже оборвано */ }
    const err = new Error(e.message || 'db');
    err.hint = e.hint || null;
    err.code = e.code;
    err.status = e.code === '42501' ? 403 : 400;
    throw err;
  } finally {
    client.release();
  }
}

async function query(sql, params) {
  const r = await getPool().query(sql, params);
  return r.rows;
}

async function close() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { rpc, query, close };
