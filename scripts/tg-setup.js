#!/usr/bin/env node
// Разовая настройка бота. По умолчанию ничего не делает (TG_SETUP=0).
// Человек запускает сам: TG_SETUP=1 TG_BOT_TOKEN=… PUBLIC_URL=… node scripts/tg-setup.js
// Скрипт не вызывается при деплое и не должен попадать в превью.
const crypto = require('node:crypto');

if (process.env.TG_SETUP !== '1') {
  console.log('TG_SETUP=0, бота не трогаю. Для настройки: TG_SETUP=1 node scripts/tg-setup.js');
  process.exit(0);
}

const token = process.env.TG_BOT_TOKEN || '';
const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || crypto.createHash('sha256').update('tg:' + (process.env.CRON_SECRET || '')).digest('hex').slice(0, 48);
if (!token || !base) {
  console.error('Нужны TG_BOT_TOKEN и PUBLIC_URL');
  process.exit(1);
}

async function api(method, body) {
  const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) {
    console.error(method, 'не выполнен');
    process.exit(1);
  }
  return data.result;
}

(async function () {
  await api('setWebhook', { url: base + '/api/tg', secret_token: secret, allowed_updates: ['message'] });
  await api('setMyCommands', { commands: [
    { command: 'app', description: 'Открыть кабинет' },
    { command: 'today', description: 'Журналы за вчера' },
    { command: 'med', description: 'Медкнижки' },
    { command: 'check', description: 'Готовность к проверке' },
    { command: 'fridge', description: 'Оборудование' },
    { command: 'plan', description: 'План на неделю' },
    { command: 'help', description: 'Помощь' }
  ] });
  await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Кабинет', web_app: { url: base + '/tg/' } } });
  const info = await api('getWebhookInfo', {});
  console.log('webhook', info.url ? 'задан' : 'пуст');
})().catch(() => { console.error('настройка не выполнена'); process.exit(1); });
