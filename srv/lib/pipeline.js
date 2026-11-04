// Конвейер агентов Журналки: данные из базы → агенты → выводы и Telegram
const { rpc } = require('./sb');
const { tgSend, moscowDay } = require('./common');
const A = require('./agents');

function dbFor(who) {
  return { op: (op, args) => who.token ? rpc('zh_agent', { p_token: who.token, p_op: op, p_args: args || {} })
    : rpc('zh_agent_sys', { p_secret: who.secret, p_owner: who.owner, p_op: op, p_args: args || {} }) };
}
function save(db, r) { return r ? db.op('insight_save', { agent: r.agent, pkey: r.pkey, level: r.level, title: r.title, data: Object.assign({ items: r.items }, r.data), text: r.text }) : null; }

// day — вчерашний день; неделя считается по воскресеньям (или по запросу)
async function runAll(db, opts = {}) {
  const day = opts.day || moscowDay(-1);
  const ctx = await db.op('ctx', { days: 40 });
  if (!(ctx.points || []).length) return { empty: true };
  const today = ctx.today || moscowDay(0);
  const san = A.sanitary(ctx, day), med = A.medbook(ctx, today);
  await Promise.all([save(db, san), save(db, med)]);
  let week = null;
  if (opts.week === true || (opts.week !== false && A.dow(day) === 0)) {
    const w = A.weekOf(day);
    const eq = A.equipment(ctx, w), insp = A.inspection(ctx, day);
    const ch = await A.chef({ key: w.key, label: `${A.dayRu(w.from)} – ${A.dayRu(w.to)}` }, [san, med, eq, insp], { noAi: opts.noAi });
    await Promise.all([save(db, eq), save(db, insp)]);
    await save(db, ch);
    week = { equipment: eq, inspection: insp, chef: ch };
  }
  let sent = false;
  if (opts.chatId) {
    sent = await tgSend(opts.chatId, A.tgDaily(san, med, opts.base ? opts.base + '/app/#/o/agents' : null)).catch(() => false);
    if (week) await tgSend(opts.chatId, A.tgWeekly(week.chef, week.inspection, opts.base ? opts.base + '/app/#/o/agents' : null)).catch(() => false);
  }
  return { sanitary: san, medbook: med, week, sent };
}
module.exports = { dbFor, runAll, save };
