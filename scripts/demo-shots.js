#!/usr/bin/env node
// Скриншоты 390px и короткое видео демо. Сервер scripts/demo-server.js уже слушает PORT.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { query, rpc } = require('../srv/lib/pg-rpc');
const { signInitData } = require('../srv/lib/telegram');

const base = process.env.DEMO_ORIGIN || 'http://127.0.0.1:4173';
const out = '/opt/cursor/artifacts';
fs.mkdirSync(out, { recursive: true });

const light = { bg_color: '#f4f7fb', secondary_bg_color: '#ffffff', text_color: '#13233a', hint_color: '#55657a', button_color: '#0b7a68', section_separator_color: '#d2dae3' };
const dark = { bg_color: '#0c1522', secondary_bg_color: '#132033', text_color: '#e6edf5', hint_color: '#a2b1c3', button_color: '#37c2a8', section_separator_color: '#263852' };

function initDataFor(start, userId) {
  const authDate = Math.floor(Date.now() / 1000);
  return signInitData({
    auth_date: String(authDate),
    query_id: 'demo' + authDate + (userId || ''),
    user: JSON.stringify({ id: userId || 900001, first_name: 'Егор', username: 'rundego', language_code: 'ru' }),
    signature: 'demo-signature',
    start_param: start || ''
  }, process.env.TG_BOT_TOKEN);
}

async function invite() {
  const code = require('node:crypto').randomBytes(16).toString('hex');
  await query("insert into zh.owner_invites (code_hash, expires_at) values (zh.hash_token($1), now() + interval '1 day')", [code]);
  return code;
}

function webapp(initData, scheme, start) {
  const theme = scheme === 'light' ? light : dark;
  return `(() => {
    try {
    console.log('tg-boot', location.pathname, location.search);
    if (!location.pathname.startsWith('/tg')) return;
    if (location.search.indexOf('plain=1') >= 0) return;
    const theme = ${JSON.stringify(theme)};
    window.Telegram = { WebApp: {
      initData: ${JSON.stringify(initData)},
      initDataUnsafe: { start_param: ${JSON.stringify(start || '')}, user: { id: 900001, first_name: 'Егор', username: 'rundego' } },
      platform: 'ios', colorScheme: ${JSON.stringify(scheme)}, themeParams: theme,
      viewportStableHeight: 780, isExpanded: true,
      ready() {}, expand() {}, close() {},
      setHeaderColor() {}, setBackgroundColor() {},
      enableClosingConfirmation() {}, disableClosingConfirmation() {}, disableVerticalSwipes() {},
      openLink(url) { location.href = url; }, openTelegramLink(url) { location.href = url; },
      onEvent() {},
      BackButton: { show() {}, hide() {}, onClick() {} },
      HapticFeedback: { impactOccurred() {} }
    } };
    console.log('tg-boot-ok', !!window.Telegram.WebApp.initData);
    } catch (e) { console.log('tg-boot-fail', e && e.message); }
  })();`;
}

async function shot(page, name) {
  const file = path.join(out, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log('shot', file);
}

(async () => {
  await query(`truncate zh.auth_alerts, zh.auth_events, zh.tg_initdata_used, zh.tg_link_codes, zh.tg_links,
    zh.consents, zh.sessions, zh.login_attempts, zh.owner_invites, zh.subscription, zh.points,
    zh.agent_sys_calls, zh.owners restart identity cascade`);
  const code = await invite();
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  async function openTg(scheme, query) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, deviceScaleFactor: 2 });
    await context.addInitScript({ content: webapp('', scheme, '') });
    const page = await context.newPage();
    await page.goto(base + '/tg/' + (query || ''), { waitUntil: 'domcontentloaded' });
    return { context, page };
  }

  const lightOpen = await openTg('light', '?plain=1');
  await lightOpen.page.waitForSelector('text=Откройте в Telegram');
  await shot(lightOpen.page, 'tg-390-light.png');
  await lightOpen.context.close();

  const darkOpen = await openTg('dark', '?plain=1');
  await darkOpen.page.waitForSelector('text=Откройте в Telegram');
  await shot(darkOpen.page, 'tg-390-dark.png');
  await darkOpen.context.close();

  const videoDir = path.join(out, 'video-tmp');
  fs.mkdirSync(videoDir, { recursive: true });
  async function blockOfficial(context) {
    await context.route('**/*telegram-web-app.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* demo */' }));
    await context.route('**/rest/v1/rpc/**', async (route) => {
      const fn = decodeURIComponent(route.request().url().split('/rpc/')[1].split('?')[0]);
      const body = route.request().postDataJSON() || {};
      try {
        const data = await rpc(fn, body, { role: 'anon' });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      } catch (e) {
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: String(e.message || 'Ошибка').split('\n')[0], hint: e.hint || null }) });
      }
    });
  }
  const videoContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    deviceScaleFactor: 2,
    recordVideo: { dir: videoDir, size: { width: 390, height: 844 } }
  });
  await blockOfficial(videoContext);
  const page = await videoContext.newPage();
  await page.goto(base + '/app/#/register', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Регистрация по приглашению');
  await shot(page, 'app-register-closed.png');
  await page.waitForTimeout(800);
  await page.goto(base + '/app/?r=1#/register?invite=' + code, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Создать аккаунт');
  await page.locator('input[autocomplete="name"]').fill('Егор');
  await page.locator('input[type="email"]').fill('egor@example.com');
  await page.locator('input[type="password"]').fill('password-ok');
  const agree = page.locator('#tb_agree');
  if (await agree.count()) await agree.check();
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('text=Новая точка', { timeout: 15000 });
  await shot(page, 'app-cabinet-390.png');
  await page.waitForTimeout(600);
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || t.indexOf('tg-boot') === 0) console.log('CONSOLE', t); });
  page.on('response', (r) => { if (r.url().includes('/api/')) console.log('API', r.status(), r.url()); });
  await page.locator('a', { hasText: 'Аккаунт' }).first().click();
  await page.waitForSelector('text=Привязать Telegram');
  await page.locator('button', { hasText: 'Привязать Telegram' }).click();
  await page.waitForSelector('text=Открыть в Telegram');
  await shot(page, 'app-link-qr.png');
  const linkText = (await page.locator('.invite-link').first().innerText()).replace(/\s+/g, '');
  const start = (linkText.match(/startapp=(l_[A-Za-z0-9_-]+)/) || [])[1] || '';
  console.log('start', start);
  const initData = initDataFor(start.slice(2) ? start : '');
  await page.waitForTimeout(700);
  await videoContext.addInitScript({ content: webapp(initData, 'dark', start) });
  await page.goto(base + '/tg/?plain=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Откройте в Telegram');
  await page.waitForTimeout(700);
  await page.goto(base + '/tg/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Привязать', { timeout: 10000 }).catch(async (e) => {
    console.log('TGTEXT', await page.locator('body').innerText());
    console.log('HAS', await page.evaluate(() => !!(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData)));
    await shot(page, 'tg-fail.png');
    throw e;
  });
  await shot(page, 'tg-390-consent-dark.png');
  await page.waitForTimeout(500);
  const box = page.locator('input[type="checkbox"]');
  const bind = page.locator('button', { hasText: 'Привязать' });
  if (await bind.isEnabled()) throw new Error('кнопка привязки активна без галочки');
  await box.check();
  await bind.click();
  await page.waitForSelector('text=Новая точка', { timeout: 15000 });
  await shot(page, 'tg-390-cabinet-dark.png');
  await page.waitForTimeout(800);

  const lightConsent = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', deviceScaleFactor: 2 });
  await blockOfficial(lightConsent);
  const init2 = initDataFor('', 900002);
  await lightConsent.addInitScript({ content: webapp(init2, 'light', '') });
  const p2 = await lightConsent.newPage();
  await p2.goto(base + '/tg/', { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('text=Почта');
  await shot(p2, 'tg-390-login-light.png');
  await lightConsent.close();

  await page.close().catch(() => {});
  await videoContext.close();
  await browser.close();
  const videos = fs.readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
  if (videos[0]) {
    fs.copyFileSync(path.join(videoDir, videos[0]), path.join(out, 'tg-demo-390.webm'));
    console.log('video', path.join(out, 'tg-demo-390.webm'));
  }
  console.log('done');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
