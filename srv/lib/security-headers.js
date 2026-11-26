// Те же правила, что vercel.json: Vercel применяет все совпавшие source.
const fs = require('node:fs');
const path = require('node:path');

function loadRules(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (cfg.headers || []).map((rule) => ({
    re: new RegExp('^' + rule.source + '$'),
    headers: rule.headers
  }));
}

function headersFor(urlPath, rules) {
  const out = {};
  rules.forEach((rule) => {
    if (rule.re.test(urlPath)) {
      rule.headers.forEach((h) => { out[h.key.toLowerCase()] = h.value; });
    }
  });
  return out;
}

function apply(res, urlPath, rules) {
  const h = headersFor(urlPath, rules);
  Object.keys(h).forEach((k) => res.setHeader(k, h[k]));
  return h;
}

let cached;
function projectRules() {
  if (!cached) cached = loadRules(path.join(__dirname, '..', '..', 'vercel.json'));
  return cached;
}

module.exports = { loadRules, headersFor, apply, projectRules };
