// Ежедневно в 06:00 по Москве: санинспектор и медкнижки по каждому владельцу, по понедельникам — неделя и план шеф-контроля
const { rpc } = require('../lib/sb');
const { dbFor, runAll } = require('../lib/pipeline');
const { moscowDay, publicUrl, hookSecret, send, same } = require('../lib/common');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret || !same(req.headers.authorization, `Bearer ${secret}`)) return send(res, 401, { error: 'unauthorized' });
  const base = publicUrl(req);
  if (process.env.TG_BOT_TOKEN) {
    await fetch(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/setWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${base}/api/tg`, secret_token: hookSecret(), allowed_updates: ['message'] }), signal: AbortSignal.timeout(10000) }).catch(() => {});
  }
  const day = (req.query && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '')) ? req.query.day : moscowDay(-1);
  const jobs = await rpc('zh_agent_sys', { p_secret: secret, p_owner: null, p_op: 'jobs', p_args: {} });
  const queue = jobs.slice(); let ok = 0;
  async function worker() {
    while (queue.length) {
      const j = queue.shift();
      try { await runAll(dbFor({ secret, owner: j.owner_id }), { day, chatId: j.chat_id, base }); ok++; } catch (e) { console.error('zh cron', j.owner_id, e.message); }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return send(res, 200, { day, total: jobs.length, ok });
};
