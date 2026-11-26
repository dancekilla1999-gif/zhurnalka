#!/usr/bin/env node
// Локальный сервер для демо и скриншотов. Не для прода.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { projectRules, apply } = require('../srv/lib/security-headers');
const handlers = require('../srv/lib/auth-handlers');

const root = path.join(__dirname, '..', 'public');
const rules = projectRules();
const routes = {
  'POST /api/tg/auth': handlers.tgAuth,
  'POST /api/tg/link': handlers.tgLink,
  'POST /api/tg/login': handlers.tgLogin,
  'POST /api/tg/unbind': handlers.tgUnbind,
  'POST /api/auth/login': handlers.authLogin,
  'POST /api/auth/register': handlers.authRegister,
  'POST /api/auth/refresh': handlers.authRefresh,
  'POST /api/auth/migrate': handlers.authMigrate,
  'POST /api/auth/logout': handlers.authLogout,
  'POST /api/auth/logout-all': handlers.authLogoutAll,
  'POST /api/auth/password': handlers.authPassword,
  'POST /api/auth/link-code': handlers.authLinkCode,
  'GET /api/auth/link-status': handlers.authLinkStatus,
  'POST /api/auth/link-status': handlers.authLinkStatus,
  'POST /api/auth/link-dispute': handlers.authLinkDispute,
  'GET /api/auth/devices': handlers.authDevices,
  'POST /api/auth/invite': handlers.authInvite
};

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/tg') {
    res.statusCode = 302;
    res.setHeader('Location', '/tg/' + url.search);
    return res.end();
  }
  apply(res, url.pathname, rules);
  const device = url.pathname.match(/^\/api\/auth\/devices\/([^/]+)\/end$/);
  if (req.method === 'POST' && device) {
    req.body = await readBody(req);
    req.query = { id: decodeURIComponent(device[1]) };
    return handlers.authDeviceEnd(req, res);
  }
  const key = req.method + ' ' + url.pathname;
  if (routes[key]) {
    req.body = req.method === 'GET' ? {} : await readBody(req);
    req.query = Object.fromEntries(url.searchParams.entries());
    return routes[key](req, res);
  }
  let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) { res.statusCode = 403; return res.end('forbidden'); }
  if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

const port = Number(process.env.PORT || 4173);
server.listen(port, '127.0.0.1', () => console.log('demo http://127.0.0.1:' + port));
