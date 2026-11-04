// Агенты «Журналки»: санконтроль по записям журналов. Цифры и правила — код, тексты-советы — ИИ (если подключён).
const ai = require('./ai');

const AGENTS = {
  sanitary: { name: 'Санинспектор', role: 'Каждое утро проверяет вчерашние журналы: что не заполнено, кто не отметился, какие отклонения без мер' },
  medbook: { name: 'Медкнижки', role: 'Следит за сроками медкнижек и напоминает заранее' },
  equipment: { name: 'Оборудование', role: 'Температура и влажность по каждому холодильнику и складу: тревоги, тренды, что пора чинить' },
  inspection: { name: 'Готовность к проверке', role: 'Оценивает, как пройдёт проверка Роспотребнадзора, и даёт список, что исправить' },
  chef: { name: 'Шеф-контроль', role: 'Собирает всё в план на неделю и отвечает на вопросы по санитарным нормам и журналам' }
};
const J = { health: 'Гигиенический журнал', fridge: 'Холодильники', store: 'Склады', fryer: 'Фритюрные жиры', brak: 'Бракераж', clean: 'Уборки' };
const ALL_J = ['health', 'fridge', 'store', 'fryer', 'brak', 'clean'];

function isoAdd(day, n) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dow(day) { return new Date(day + 'T12:00:00Z').getUTCDay(); }
function dayRu(iso) { return new Date(iso + 'T12:00:00Z').toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
function dates(from, to) { const out = []; for (let d = from; d <= to; d = isoAdd(d, 1)) out.push(d); return out; }
function pct(x) { return Math.round((Number(x) || 0) * 100) + '%'; }
function levelOf(items) { return items.some((i) => i.level === 'bad') ? 'bad' : items.some((i) => i.level === 'warn') ? 'warn' : 'ok'; }
function plural(n, a, b, c) { const m = Math.abs(n) % 100, l = m % 10; return m > 10 && m < 20 ? c : l > 1 && l < 5 ? b : l === 1 ? a : c; }
function weekOf(day) { const d = dow(day); const mon = isoAdd(day, d === 0 ? -6 : 1 - d); return { from: mon, to: isoAdd(mon, 6), key: 'w' + mon }; }

// Заполненность журналов точки за период: слоты «единица оборудования × день» и «журнал × день»
function coverage(p, from, to) {
  const days = dates(from, to).filter((d) => d >= String(p.created_at || '').slice(0, 10));
  const js = p.journals || ALL_J;
  const byDay = {};
  (p.entries || []).forEach((e) => { if (e.day >= from && e.day <= to) (byDay[e.day] = byDay[e.day] || []).push(e); });
  const staffName = {}; (p.staff || []).forEach((s) => { staffName[s.id] = s.name; });
  let req = 0, done = 0;
  const missing = [], skipped = [], empty = [], perJ = {};
  const units = (p.units || []).filter((u) => (u.kind === 'fridge' || u.kind === 'store') && js.indexOf(u.kind) >= 0);
  days.forEach((d) => {
    const es = byDay[d] || [];
    if (!es.length) empty.push(d);
    units.forEach((u) => {
      if (String(u.created_at || '').slice(0, 10) > d) return;
      req++; const ok = es.some((e) => e.u === u.id && (e.j === 'fridge' || e.j === 'store'));
      perJ[u.kind] = perJ[u.kind] || { req: 0, done: 0 }; perJ[u.kind].req++;
      if (ok) { done++; perJ[u.kind].done++; } else missing.push({ day: d, what: u.name, kind: u.kind });
    });
    ['health', 'brak'].forEach((k) => {
      if (js.indexOf(k) < 0) return;
      req++; perJ[k] = perJ[k] || { req: 0, done: 0 }; perJ[k].req++;
      if (es.some((e) => e.j === k)) { done++; perJ[k].done++; } else missing.push({ day: d, what: J[k], kind: k });
    });
    // кто работал (оставлял любые записи), но не прошёл гигиенический журнал
    if (js.indexOf('health') >= 0) {
      const worked = new Set(es.filter((e) => e.s && e.j !== 'health').map((e) => e.s));
      const healthy = new Set(es.filter((e) => e.j === 'health').map((e) => e.s));
      worked.forEach((s) => { if (!healthy.has(s)) skipped.push({ day: d, name: staffName[s] || 'сотрудник' }); });
    }
  });
  const alerts = (p.entries || []).filter((e) => e.day >= from && e.day <= to && e.alert);
  const noAction = alerts.filter((e) => (e.j === 'fridge' || e.j === 'store') && !(e.data && e.data.action));
  const unitName = {}; (p.units || []).forEach((u) => { unitName[u.id] = u.name; });
  return { days: days.length, req, done, score: req ? done / req : 1, missing, skipped, empty, alerts, noAction, perJ, unitName };
}

function alertText(e, unitName) {
  if (e.j === 'fridge' || e.j === 'store') return `${unitName[e.u] || 'Оборудование'}: ${e.data && e.data.t}°${e.data && e.data.h != null ? ', влажность ' + e.data.h + '%' : ''} (${dayRu(e.day)})${e.data && e.data.action ? ' — меры: ' + e.data.action : ' — меры не указаны'}`;
  if (e.j === 'health') return `${e.author}: отметил(а) признаки недомогания (${dayRu(e.day)})${e.data && e.data.admitted === false ? ' — не допущен(а)' : e.data && e.data.admitted === true ? ' — допущен(а)' : ' — решение о допуске не принято'}`;
  if (e.j === 'brak') return `Бракераж: «${e.data && e.data.dish}» — ${e.data && e.data.grade}${e.data && e.data.allowed === false ? ', к выдаче не допущено' : ''} (${dayRu(e.day)})`;
  if (e.j === 'fryer') return `Фритюр: жир «${e.data && e.data.fat}» в состоянии «${e.data && (e.data.q_end || e.data.q_start)}» (${dayRu(e.day)}) — замените жир`;
  return `${J[e.j] || e.j}: отклонение (${dayRu(e.day)})`;
}

// ------------------------------------------------------------------ Санинспектор (вчера по всем точкам)
function sanitary(ctx, day) {
  const items = [], points = [];
  (ctx.points || []).forEach((p) => {
    const c = coverage(p, day, day);
    const pre = (ctx.points.length > 1 ? p.name + ': ' : '');
    if (c.empty.length) items.push({ level: 'bad', text: `${pre}за ${dayRu(day)} нет ни одной записи. Если точка работала — журналы не велись` });
    else {
      const units = c.missing.filter((m) => m.kind === 'fridge' || m.kind === 'store').map((m) => m.what);
      if (units.length) items.push({ level: 'warn', text: `${pre}не записана температура: ${units.slice(0, 6).join(', ')}${units.length > 6 ? ` и ещё ${units.length - 6}` : ''}` });
      c.missing.filter((m) => m.kind === 'health' || m.kind === 'brak').forEach((m) => items.push({ level: m.kind === 'health' ? 'bad' : 'warn', text: `${pre}не заполнен журнал «${m.what}»` }));
    }
    if (c.skipped.length) items.push({ level: 'bad', text: `${pre}работали без отметки в гигиеническом журнале: ${[...new Set(c.skipped.map((x) => x.name))].join(', ')}` });
    c.noAction.forEach((e) => items.push({ level: 'bad', text: pre + alertText(e, c.unitName) }));
    c.alerts.filter((e) => e.j !== 'fridge' && e.j !== 'store').forEach((e) => items.push({ level: e.j === 'health' && e.data && e.data.admitted == null ? 'bad' : 'warn', text: pre + alertText(e, c.unitName) }));
    points.push({ id: p.id, name: p.name, score: Math.round(c.score * 1000) / 1000, req: c.req, done: c.done, missing: c.missing, skipped: c.skipped, alerts: c.alerts.length, no_action: c.noAction.length });
  });
  const req = points.reduce((s, x) => s + x.req, 0), done = points.reduce((s, x) => s + x.done, 0);
  const score = req ? done / req : 1;
  if (!req && !items.length) {
    const title0 = `${dayRu(day)}: проверять пока нечего — первый полный день работы ещё впереди`;
    return { agent: 'sanitary', pkey: day, level: 'ok', title: title0, data: { day, score: null, points }, items, text: title0 + '.' };
  }
  const title = `${dayRu(day)}: журналы заполнены на ${pct(score)}` + (items.filter((i) => i.level === 'bad').length ? ', есть нарушения' : items.length ? ', есть пропуски' : ', всё в порядке');
  return { agent: 'sanitary', pkey: day, level: levelOf(items), title, data: { day, score: Math.round(score * 1000) / 1000, points }, items, text: title + '.' };
}

// ------------------------------------------------------------------ Медкнижки
function medbook(ctx, today) {
  const items = [], rows = [];
  (ctx.points || []).forEach((p) => (p.staff || []).forEach((s) => {
    const pre = ctx.points.length > 1 ? ` (${p.name})` : '';
    if (!s.med_until) { rows.push({ name: s.name, role: s.role, point: p.name, status: 'none' }); return; }
    const left = Math.round((Date.parse(s.med_until) - Date.parse(today)) / 86400000);
    const st = left < 0 ? 'expired' : left <= 7 ? 'week' : left <= 30 ? 'month' : 'ok';
    rows.push({ name: s.name, role: s.role, point: p.name, med_until: s.med_until, left, status: st });
    if (st === 'expired') items.push({ level: 'bad', text: `${s.name}${pre}: медкнижка просрочена с ${s.med_until.split('-').reverse().join('.')} — до продления к работе с продуктами не допускать (штраф до 30 000 ₽ на юрлицо за каждого)` });
    else if (st === 'week') items.push({ level: 'bad', text: `${s.name}${pre}: медкнижка заканчивается через ${left} ${plural(left, 'день', 'дня', 'дней')} — запишите на медосмотр сейчас` });
    else if (st === 'month') items.push({ level: 'warn', text: `${s.name}${pre}: медкнижка до ${s.med_until.split('-').reverse().join('.')} — запланируйте продление` });
  }));
  const none = rows.filter((r) => r.status === 'none');
  if (none.length) items.push({ level: 'warn', text: `Не указан срок медкнижки: ${none.slice(0, 8).map((r) => r.name).join(', ')}${none.length > 8 ? ' и др.' : ''}. Впишите даты в разделе «Команда», чтобы агент напоминал заранее` });
  const title = rows.length ? `Медкнижки: ${rows.filter((r) => r.status === 'ok').length} из ${rows.length} в порядке` : 'Медкнижки: сотрудников ещё нет';
  return { agent: 'medbook', pkey: today, level: levelOf(items), title, data: { today, rows: rows.sort((a, b) => (a.left == null ? 9999 : a.left) - (b.left == null ? 9999 : b.left)) }, items, text: title + '.' };
}

// ------------------------------------------------------------------ Оборудование (неделя)
function equipment(ctx, week) {
  const items = [], units = [];
  const pw = { from: isoAdd(week.from, -7), to: isoAdd(week.to, -7) };
  (ctx.points || []).forEach((p) => (p.units || []).filter((u) => u.kind === 'fridge' || u.kind === 'store').forEach((u) => {
    const es = (p.entries || []).filter((e) => e.u === u.id && (e.j === 'fridge' || e.j === 'store'));
    const cur = es.filter((e) => e.day >= week.from && e.day <= week.to), prev = es.filter((e) => e.day >= pw.from && e.day <= pw.to);
    const t = cur.map((e) => Number(e.data && e.data.t)).filter((x) => isFinite(x));
    const tp = prev.map((e) => Number(e.data && e.data.t)).filter((x) => isFinite(x));
    const avg = t.length ? t.reduce((s, x) => s + x, 0) / t.length : null, avgP = tp.length ? tp.reduce((s, x) => s + x, 0) / tp.length : null;
    const al = cur.filter((e) => e.alert).length;
    const row = { point: p.name, name: u.name, kind: u.kind, t_min: u.t_min, t_max: u.t_max, entries: cur.length, alerts: al, avg: avg == null ? null : Math.round(avg * 10) / 10, min: t.length ? Math.min(...t) : null, max: t.length ? Math.max(...t) : null, prev_avg: avgP == null ? null : Math.round(avgP * 10) / 10 };
    units.push(row);
    const nm = (ctx.points.length > 1 ? p.name + ' · ' : '') + u.name;
    const fresh = String(u.created_at || '').slice(0, 10) > isoAdd(week.to, -2);
    if (!cur.length && fresh) return;
    if (!cur.length) items.push({ level: 'warn', text: `${nm}: за неделю ни одного замера — либо оборудование не используется (уберите его из списка), либо журнал не ведут` });
    else if (al >= 2) items.push({ level: 'bad', text: `${nm}: ${al} ${plural(al, 'выход', 'выхода', 'выходов')} за норму за неделю (от ${row.min}° до ${row.max}° при норме ${u.t_min ?? '…'}…${u.t_max ?? '…'}°). Проверьте уплотнитель и загрузку, при повторе вызовите мастера — продукты в зоне риска` });
    else if (u.t_max != null && avg != null && avg > u.t_max - 1 && u.t_max - (u.t_min ?? u.t_max - 4) > 1.5) items.push({ level: 'warn', text: `${nm}: средняя температура ${row.avg}° почти у верхней границы ${u.t_max}° — компрессор не справляется или часто открывают дверь` });
    if (avg != null && avgP != null && avg - avgP >= 1.5) items.push({ level: 'warn', text: `${nm}: за неделю стало теплее на ${Math.round((avg - avgP) * 10) / 10}° (было ${row.prev_avg}°, стало ${row.avg}°) — ранний признак неисправности` });
  }));
  const title = units.length ? `Оборудование: ${units.length} ${plural(units.length, 'единица', 'единицы', 'единиц')}, ${items.filter((i) => i.level === 'bad').length ? 'есть проблемы' : items.length ? 'есть на что посмотреть' : 'работает стабильно'}` : 'Оборудование: не добавлено ни одного холодильника';
  if (!units.length) items.push({ level: 'warn', text: 'Добавьте холодильники и склады в разделе «Оборудование» — без них температурный журнал не ведётся' });
  return { agent: 'equipment', pkey: week.key, level: levelOf(items), title, data: { week, units }, items, text: title + '.' };
}

// ------------------------------------------------------------------ Готовность к проверке (30 дней)
const CHECKLIST = ['Гигиенический журнал — на каждого сотрудника каждую смену', 'Температура всех холодильников и складов — ежедневно', 'Медкнижки всех, кто работает с продуктами, — действующие', 'Журнал бракеража готовой продукции', 'Учёт фритюрных жиров (если есть фритюр)', 'График и журнал генеральных уборок', 'Отклонения с записанными мерами (что сделали с продуктом и оборудованием)'];
function inspection(ctx, day) {
  const items = [], from = isoAdd(day, -29), pts = [];
  let sum = 0, n = 0;
  (ctx.points || []).forEach((p) => {
    const c = coverage(p, from, day);
    const js = p.journals || ALL_J;
    const pre = ctx.points.length > 1 ? p.name + ': ' : '';
    const offJ = ALL_J.filter((k) => js.indexOf(k) < 0 && k !== 'fryer');
    const gapsByJ = {};
    c.missing.forEach((m) => { gapsByJ[m.kind] = (gapsByJ[m.kind] || 0) + 1; });
    let score = c.score * 70; // заполненность — главное
    const staff = p.staff || [];
    const medBad = staff.filter((s) => !s.med_until || s.med_until < day).length;
    score += staff.length ? 20 * (1 - medBad / staff.length) : 0;
    score += c.noAction.length ? Math.max(0, 10 - c.noAction.length * 3) : 10;
    score -= offJ.length * 3;
    score = Math.max(0, Math.min(100, Math.round(score)));
    pts.push({ name: p.name, score, fill: Math.round(c.score * 1000) / 1000, empty_days: c.empty.length, gaps: gapsByJ, med_bad: medBad, no_action: c.noAction.length, off: offJ });
    sum += score; n++;
    if (c.empty.length >= 3) items.push({ level: 'bad', text: `${pre}${c.empty.length} ${plural(c.empty.length, 'день', 'дня', 'дней')} за месяц без единой записи — инспектор увидит пустые страницы` });
    Object.keys(gapsByJ).forEach((k) => { if (gapsByJ[k] >= 3) items.push({ level: gapsByJ[k] >= 7 ? 'bad' : 'warn', text: `${pre}«${J[k] || k}»: ${gapsByJ[k]} ${plural(gapsByJ[k], 'пропуск', 'пропуска', 'пропусков')} за 30 дней` }); });
    if (medBad) items.push({ level: 'bad', text: `${pre}${medBad} ${plural(medBad, 'сотрудник', 'сотрудника', 'сотрудников')} без действующей медкнижки (или срок не внесён)` });
    if (c.noAction.length) items.push({ level: 'warn', text: `${pre}${c.noAction.length} ${plural(c.noAction.length, 'отклонение', 'отклонения', 'отклонений')} температуры без записанных мер — допишите, что сделали` });
    const js2 = p.journals || ALL_J;
    if (js2.indexOf('clean') >= 0) {
      let weeksNo = 0;
      for (let k = 0; k < 4; k++) { const a = isoAdd(day, -7 * k - 6), b = isoAdd(day, -7 * k); if (a < String(p.created_at || '').slice(0, 10)) break; if (!(p.entries || []).some((e) => e.j === 'clean' && e.day >= a && e.day <= b)) weeksNo++; }
      if (weeksNo) items.push({ level: weeksNo >= 2 ? 'bad' : 'warn', text: `${pre}генеральная уборка не отмечена ${weeksNo} ${plural(weeksNo, 'неделю', 'недели', 'недель')} из последних 4 — проводите и записывайте хотя бы раз в неделю` });
    }
    if (offJ.length) items.push({ level: 'warn', text: `${pre}не ведутся журналы: ${offJ.map((k) => J[k]).join(', ')} — включите их в настройках точки, инспектор может их запросить` });
  });
  const minDays = Math.min.apply(null, (ctx.points || []).map((p) => Math.max(0, Math.round((Date.parse(day) - Date.parse(String(p.created_at).slice(0, 10))) / 86400000) + 1)).concat([999]));
  if (minDays < 3) {
    const t0 = `Готовность к проверке: мало данных — журналы ведутся ${minDays} ${plural(minDays, 'день', 'дня', 'дней')}`;
    return { agent: 'inspection', pkey: day, level: 'warn', title: t0, data: { day, from, score: null, verdict: 'мало данных', points: pts, checklist: CHECKLIST }, items: items.filter((i) => !/пропуск|без единой записи/.test(i.text)), text: t0 + '. Оценка появится через несколько дней работы.' };
  }
  const score = n ? Math.round(sum / n) : 0;
  const verdict = score >= 90 ? 'готовы к проверке' : score >= 75 ? 'почти готовы — пара пробелов' : score >= 50 ? 'есть риск штрафа' : 'высокий риск штрафа';
  const title = `Готовность к проверке: ${score} из 100 — ${verdict}`;
  return { agent: 'inspection', pkey: day, level: score >= 90 ? 'ok' : score >= 75 ? 'warn' : 'bad', title, data: { day, from, score, verdict, points: pts, checklist: CHECKLIST }, items, text: title + '.' };
}

// ------------------------------------------------------------------ Шеф-контроль
const CHEF_SYS = 'Ты — технолог общепита и эксперт по СанПиН 2.3/2.4.3590-20 в сервисе «Журналка». Тебе приходят выводы агентов по санитарным журналам заведения. ' +
  'Напиши владельцу короткий план на неделю: 1–2 предложения о состоянии журналов и 3–5 конкретных действий (кто делает: шеф, управляющий, ответственный за журналы), с цифрами из данных. Обращайся на «вы», до 1000 знаков, без вступлений.';
async function chef(period, results, opts = {}) {
  const items = [];
  results.filter(Boolean).forEach((r) => (r.items || []).forEach((i) => { if (i.level !== 'ok') items.push({ agent: r.agent, level: i.level, text: i.text }); }));
  const seen = new Set();
  for (let k = items.length - 1; k >= 0; k--) { if (seen.has(items[k].text)) items.splice(k, 1); else seen.add(items[k].text); }
  items.sort((a, b) => (a.level === 'bad' ? 0 : 1) - (b.level === 'bad' ? 0 : 1));
  const insp = results.find((r) => r && r.agent === 'inspection');
  const facts = { период: period.label, готовность: insp && { балл: insp.data.score, вердикт: insp.data.verdict }, выводы: items.slice(0, 16).map((i) => `[${AGENTS[i.agent] ? AGENTS[i.agent].name : i.agent}/${i.level}] ${i.text}`) };
  let text = opts.noAi ? null : await ai.write(CHEF_SYS, facts, { maxTokens: 800 });
  const byAi = !!text;
  if (!text) text = (insp ? insp.title + '.\n\n' : '') + (items.length ? 'Что сделать на этой неделе:\n' + items.slice(0, 5).map((i, n) => `${n + 1}. ${i.text}`).join('\n') : 'Журналы в порядке — так держать.');
  return { agent: 'chef', pkey: period.key, level: levelOf(items), title: `План на неделю после ${period.label}`, data: { period, actions: items.slice(0, 12), by_ai: byAi }, items: items.slice(0, 12), text };
}

const ASK_SYS = 'Ты — технолог общепита и помощник по санитарным нормам (СанПиН 2.3/2.4.3590-20, ТР ТС 021/2011, требования Роспотребнадзора) в сервисе «Журналка». ' +
  'Отвечай владельцу или шефу по-русски, на «вы», коротко и практично. Если вопрос о состоянии журналов заведения — опирайся на переданные данные. Если об общих нормах — отвечай по нормам и честно оговаривай, если не уверен и стоит уточнить в документе. До 1200 знаков, без markdown-таблиц.';
function compactCtx(ctx) {
  const ins = {};
  (ctx.insights || []).forEach((i) => { ins[i.agent] = { title: i.title, выводы: ((i.data && i.data.items) || []).map((x) => x.text).slice(0, 10), текст: i.agent === 'chef' ? i.text : undefined }; });
  const week = isoAdd(ctx.today, -7);
  return { сегодня: ctx.today, точки: (ctx.points || []).map((p) => { const c = coverage(p, week, isoAdd(ctx.today, -1)); return { name: p.name, журналы: p.journals, оборудование: (p.units || []).map((u) => `${u.name} (${u.t_min ?? ''}…${u.t_max ?? ''}°)`), сотрудники: (p.staff || []).map((s) => `${s.name}, ${s.role}, медкнижка до ${s.med_until || 'не указано'}`), заполненность_7_дней: pct(c.score), пропуски: c.missing.slice(0, 20).map((m) => `${m.day} ${m.what}`), отклонения: c.alerts.slice(0, 10).map((e) => alertText(e, c.unitName)) }; }), агенты: ins };
}
async function answer(question, ctx) {
  const q = String(question || '').trim().slice(0, 1500);
  if (ai.enabled()) {
    const msgs = [{ role: 'system', content: ASK_SYS + '\n\nДанные заведения (JSON):\n' + JSON.stringify(compactCtx(ctx)).slice(0, 24000) }];
    (ctx.chat || []).slice(-6).forEach((m) => msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.text).slice(0, 1500) }));
    msgs.push({ role: 'user', content: q });
    try { return { text: ai.clean(await ai.chat(msgs, { maxTokens: 900 })), by_ai: true }; } catch (e) { console.error('answer', e.message); }
  }
  const l = q.toLowerCase(), ins = {};
  (ctx.insights || []).forEach((i) => { ins[i.agent] = i; });
  const pick = (/медкниж|медосмотр/.test(l) && 'medbook') || (/холодильн|температур|склад|оборудован|морозил/.test(l) && 'equipment') || (/провер|роспотреб|инспект|штраф/.test(l) && 'inspection') || (/вчера|заполн|пропуск|гигиен/.test(l) && 'sanitary') || 'chef';
  const i = ins[pick] || ins.chef || ins.sanitary;
  const head = 'ИИ пока не подключён администратором сервиса, поэтому отвечаю выводами агентов.';
  if (!i) return { text: head + ' Агенты ещё не работали — они запустятся завтра утром или по кнопке «Проверить сейчас».', by_ai: false };
  return { text: `${head}\n\n${AGENTS[i.agent].name}: ${i.title}\n` + ((i.data && i.data.items) || []).slice(0, 5).map((x) => '• ' + x.text).join('\n'), by_ai: false };
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function dot(l) { return l === 'bad' ? '🔴' : l === 'warn' ? '🟡' : '🟢'; }
function tgDaily(san, med, link) {
  const L = [`<b>Журналы · ${esc(san.title)}</b>`];
  if (san.items.length) { L.push(''); san.items.slice(0, 8).forEach((i) => L.push(`${dot(i.level)} ${esc(i.text)}`)); } else { L.push(''); L.push('✅ Все журналы заполнены, отклонений нет'); }
  const medHot = (med && med.items || []).filter((i) => i.level === 'bad');
  if (medHot.length) { L.push(''); L.push('<b>Медкнижки:</b>'); medHot.slice(0, 4).forEach((i) => L.push(`🔴 ${esc(i.text)}`)); }
  if (link) { L.push(''); L.push(`<a href="${esc(link)}">Открыть агентов</a>`); }
  return L.join('\n').slice(0, 4000);
}
function tgWeekly(ch, insp, link) {
  const L = [`<b>Санконтроль · неделя ${esc(ch.data.period.label)}</b>`];
  if (insp) { L.push(''); L.push(`🛡 ${esc(insp.title)}`); }
  L.push(''); L.push('<b>👨‍🍳 Шеф-контроль:</b>'); L.push(esc(ch.text));
  if (link) { L.push(''); L.push(`<a href="${esc(link)}">Подробнее</a>`); }
  return L.join('\n').slice(0, 4000);
}

module.exports = { AGENTS, J, coverage, sanitary, medbook, equipment, inspection, chef, answer, weekOf, isoAdd, dow, dayRu, tgDaily, tgWeekly, CHECKLIST };
