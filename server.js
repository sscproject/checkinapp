// Event Check-in server — zero dependencies, run with: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
// No default PIN: if ADMIN_PIN is not set, a random one is generated and printed at startup
const ADMIN_PIN = process.env.ADMIN_PIN || crypto.randomBytes(4).toString('hex');
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // e.g. https://checkin.example.org/ — used for the QR code
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // set when behind an AWS load balancer / reverse proxy
const DATA_DIR = process.env.DATA_DIR || __dirname; // point at persistent storage in production
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC = path.join(__dirname, 'public');

const FIELDS = ['firstName', 'lastName', 'role', 'organisation', 'email', 'phone', 'gender', 'consentWhatsapp', 'consentPhoto'];
const GENDERS = ['Woman or female', 'Man or male', 'Non-binary', 'I use a different term', 'Prefer not to say'];
const MAX_FIELD = 200;
const MAX_WALKINS = 500;

// ---------- storage ----------
let db = { participants: [] };
if (fs.existsSync(DATA_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) {
    // keep the damaged file for recovery instead of overwriting it on the next save
    const backup = DATA_FILE + '.corrupt-' + Date.now();
    fs.renameSync(DATA_FILE, backup);
    console.error('data.json unreadable — moved to ' + backup + ', starting empty');
  }
  if (!db || !Array.isArray(db.participants)) db = { participants: [] };
}
function save() {
  const tmp = DATA_FILE + '.tmp';
  const json = JSON.stringify(db, null, 2);
  fs.writeFileSync(tmp, json, { mode: 0o600 });
  // Windows antivirus/indexers can briefly lock the file; retry, then fall back to a direct write
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, DATA_FILE); return; } catch (e) { if (i === 4) break; }
    const until = Date.now() + 20; while (Date.now() < until);
  }
  fs.writeFileSync(DATA_FILE, json, { mode: 0o600 });
}
const newId = () => crypto.randomBytes(12).toString('hex');

// ---------- name matching ----------
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function tokenScore(q, t) {
  if (t === q) return 3;
  if (t.startsWith(q) && q.length >= 3) return 2;
  const tol = q.length >= 7 ? 2 : q.length >= 4 ? 1 : 0;
  return tol && lev(q, t) <= tol ? 1.5 : 0;
}
function search(query) {
  const qTokens = norm(query).slice(0, 80).split(' ').filter(Boolean);
  if (!qTokens.length || qTokens.join('').length < 3) return [];
  return db.participants.map(p => {
    const nTokens = norm(p.firstName + ' ' + p.lastName).split(' ').filter(Boolean);
    let score = 0, matched = 0;
    for (const q of qTokens) {
      const best = Math.max(0, ...nTokens.map(t => tokenScore(q, t)));
      if (best) matched++;
      score += best;
    }
    return { p, score, matched };
  })
    .filter(r => r.matched === qTokens.length || (qTokens.length > 1 && r.matched >= qTokens.length - 1 && r.score >= 3))
    .sort((a, b) => b.matched - a.matched || b.score - a.score)
    .slice(0, 6)
    .map(({ p }) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName, organisation: p.organisation, checkedIn: !!p.checkedInAt }));
}

// ---------- privacy: only partial email/phone is ever sent to the public page ----------
// Enough to recognise your own address, not enough to harvest it: "shaneel.prakash@health.gov.fj" -> "sha•••h@health.gov.fj"
function maskEmail(e) {
  const s = String(e || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return '';
  const user = s.slice(0, at), domain = s.slice(at + 1);
  if (user.length <= 2) return user[0] + '•••@' + domain;
  if (user.length <= 4) return user.slice(0, 2) + '•••@' + domain;
  return user.slice(0, 3) + '•••' + user.slice(-1) + '@' + domain;
}
function maskPhone(ph) {
  const s = String(ph || '').replace(/\s+/g, '');
  return s.length > 3 ? '•••' + s.slice(-3) : (s ? '•••' : '');
}
function publicRecord(p) {
  return {
    id: p.id, firstName: p.firstName, lastName: p.lastName, role: p.role, organisation: p.organisation, gender: p.gender,
    emailMasked: maskEmail(p.email), phoneMasked: maskPhone(p.phone), checkedIn: !!p.checkedInAt,
  };
}

// ---------- helpers ----------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
class TooLarge extends Error {}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > limit) { reject(new TooLarge()); req.destroy(); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
// Behind one trusted proxy (Caddy/ALB) the real client IP is the LAST X-Forwarded-For entry;
// earlier entries come from the client and could be spoofed to dodge the PIN lockout
const clientIp = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress;

// Short audit trail of admin activity (journald on the server); no participant details
const audit = (req, action) => console.log(new Date().toISOString() + ' AUDIT ' + action + ' ip=' + clientIp(req));

// simple in-memory rate limiter: max `limit` hits per `windowMs` per key
const buckets = new Map();
function limited(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  return b.count > limit;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();

// admin auth: constant-time compare + lockout after 10 wrong PINs per IP in 15 minutes
const pinHash = crypto.createHash('sha256').update(ADMIN_PIN).digest();
function checkAdmin(req) {
  const ip = clientIp(req);
  const fails = buckets.get('fail:' + ip);
  if (fails && fails.count >= 10 && Date.now() < fails.reset) { audit(req, 'admin-locked-out'); return 'locked'; }
  const given = crypto.createHash('sha256').update(String(req.headers['x-admin-pin'] || '')).digest();
  if (crypto.timingSafeEqual(given, pinHash)) return 'ok';
  limited('fail:' + ip, 10, 15 * 60000);
  audit(req, 'admin-wrong-pin');
  return 'bad';
}

const clean = v => String(v ?? '').trim().slice(0, MAX_FIELD);
// Map common spreadsheet values ("Male", "F", ...) onto the check-in dropdown options
function mapGender(v) {
  const g = norm(v);
  if (!g) return '';
  if (['male', 'm', 'man', 'man or male'].includes(g)) return 'Man or male';
  if (['female', 'f', 'woman', 'woman or female'].includes(g)) return 'Woman or female';
  if (['non binary', 'nonbinary', 'nb'].includes(g)) return 'Non-binary';
  if (g.startsWith('prefer not')) return 'Prefer not to say';
  return GENDERS.find(x => norm(x) === g) || '';
}
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254')) out.push(i.address);
  // Home/office Wi-Fi addresses (192.168.x, 10.x) first; VPN and virtual adapters (172.x) last
  const rank = ip => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 3 : 2;
  return out.sort((a, b) => rank(a) - rank(b)).map(ip => `http://${ip}:${PORT}/`);
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // pages
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && (p === '/' || p === '/checkin')) return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'checkin.html')), 'text/html; charset=utf-8');
    const asset = req.method === 'GET' && p.match(/^\/(vendor|app)\/([\w.-]+\.js)$/);
    if (asset) {
      const file = path.join(PUBLIC, asset[1], path.basename(asset[2]));
      if (fs.existsSync(file)) {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/javascript', 'Cache-Control': asset[1] === 'vendor' ? 'public, max-age=86400' : 'no-cache' });
        return res.end(fs.readFileSync(file));
      }
    }
    if (req.method === 'GET' && p === '/admin') return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'admin.html')), 'text/html; charset=utf-8');

    // public API — generous limit because everyone at the venue may share one IP address
    if (p.startsWith('/api/') && !p.startsWith('/api/admin/') && limited('pub:' + clientIp(req), 5000, 60000))
      return send(res, 429, { error: 'Too many requests, please wait a moment.' });

    if (req.method === 'GET' && p === '/api/search') return send(res, 200, search(url.searchParams.get('q') || ''));
    if (req.method === 'GET' && p.startsWith('/api/participant/')) {
      const rec = db.participants.find(x => x.id === p.split('/').pop());
      return rec ? send(res, 200, publicRecord(rec)) : send(res, 404, { error: 'Not found' });
    }
    if (req.method === 'POST' && p === '/api/checkin') {
      const b = await readBody(req, 20000);
      if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'Bad request.' });
      let rec = b.id ? db.participants.find(x => x.id === b.id) : null;
      if (b.id && !rec) return send(res, 404, { error: 'Registration not found. Please search again.' });

      // already checked in: details are locked, just show the confirmation again
      if (rec && rec.checkedInAt)
        return send(res, 200, { ok: true, already: true, id: rec.id, firstName: rec.firstName, lastName: rec.lastName, organisation: rec.organisation, checkedInAt: rec.checkedInAt });

      const data = {};
      for (const f of FIELDS) data[f] = clean(b[f]);
      // email/phone left blank = keep what's on file (the public page only ever sees a masked version)
      if (rec && !data.email && rec.email) data.email = rec.email;
      if (rec && !data.phone && rec.phone) data.phone = rec.phone;

      const missing = FIELDS.filter(f => !data[f]);
      if (missing.length) return send(res, 400, { error: 'Please complete all fields.', missing });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return send(res, 400, { error: 'Please enter a valid email.', missing: ['email'] });
      if (!GENDERS.includes(data.gender)) return send(res, 400, { error: 'Please select a gender option.', missing: ['gender'] });
      if (!['Yes', 'No'].includes(data.consentWhatsapp) || !['Yes', 'No'].includes(data.consentPhoto)) return send(res, 400, { error: 'Please answer both consent questions.' });

      if (!rec) {
        if (db.participants.filter(x => x.walkIn).length >= MAX_WALKINS) return send(res, 503, { error: 'Check-in is full. Please see the front desk.' });
        rec = { id: newId(), walkIn: true };
        db.participants.push(rec);
      }
      Object.assign(rec, data);
      rec.checkedInAt = new Date().toISOString();
      save();
      return send(res, 200, { ok: true, id: rec.id, firstName: rec.firstName, lastName: rec.lastName, organisation: rec.organisation, checkedInAt: rec.checkedInAt });
    }

    // admin API
    if (p.startsWith('/api/admin/')) {
      const auth = checkAdmin(req);
      if (auth === 'locked') return send(res, 429, { error: 'Too many wrong PINs. Try again in 15 minutes.' });
      if (auth !== 'ok') return send(res, 401, { error: 'Wrong PIN' });
      if (req.method === 'GET' && p === '/api/admin/participants') return send(res, 200, { participants: db.participants, publicUrl: PUBLIC_URL, urls: PUBLIC_URL ? [] : lanUrls() });
      if (req.method === 'POST' && p === '/api/admin/import') {
        const { rows = [], mode = 'merge' } = await readBody(req, 5e6);
        if (!Array.isArray(rows) || rows.length > 5000) return send(res, 400, { error: 'Too many rows (max 5000).' });
        if (!['merge', 'replace'].includes(mode)) return send(res, 400, { error: 'Bad import mode.' });
        if (mode === 'replace') db.participants = [];
        let added = 0, updated = 0;
        for (const r of rows) {
          const row = {
            firstName: clean(r.firstName), lastName: clean(r.lastName), role: clean(r.role),
            organisation: clean(r.organisation), email: clean(r.email), phone: clean(r.phone), gender: mapGender(r.gender),
          };
          if (!row.firstName && !row.lastName) continue;
          const existing = db.participants.find(x =>
            (row.email && norm(x.email) === norm(row.email)) ||
            (norm(x.firstName + x.lastName) === norm(row.firstName + row.lastName)));
          if (existing) {
            for (const [k, v] of Object.entries(row)) if (v && !existing.checkedInAt) existing[k] = v;
            updated++;
          } else { db.participants.push({ id: newId(), ...row }); added++; }
        }
        save();
        audit(req, 'import mode=' + mode + ' added=' + added + ' updated=' + updated);
        return send(res, 200, { added, updated, total: db.participants.length });
      }
      if (req.method === 'POST' && p === '/api/admin/undo') {
        const { id } = await readBody(req, 2000);
        const rec = db.participants.find(x => x.id === id);
        if (rec) { delete rec.checkedInAt; save(); audit(req, 'undo-checkin'); }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/admin/reset-checkins') {
        // keep the registration list, remove walk-ins and all check-in answers
        db.participants = db.participants.filter(x => !x.walkIn);
        for (const x of db.participants) {
          delete x.checkedInAt; delete x.consentWhatsapp; delete x.consentPhoto;
        }
        save();
        audit(req, 'clear-checkins');
        return send(res, 200, { ok: true, total: db.participants.length });
      }
      if (req.method === 'POST' && p === '/api/admin/clear') {
        db.participants = []; save();
        audit(req, 'delete-all-data');
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof TooLarge) return send(res, 413, { error: 'Request too large.' });
    if (e instanceof SyntaxError) return send(res, 400, { error: 'Bad request.' });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;

server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log('\n  Event Check-in is running\n');
  console.log('  Admin:  http://localhost:' + PORT + '/admin');
  if (process.env.ADMIN_PIN) console.log('  Admin PIN: (set via ADMIN_PIN)');
  else console.log('  Admin PIN for this run: ' + ADMIN_PIN + '   (set ADMIN_PIN to choose your own)');
  if (process.env.ADMIN_PIN && process.env.ADMIN_PIN.length < 8) console.log('  WARNING: ADMIN_PIN is short — use at least 8 characters in production.');
  console.log('  Check-in page for phones (same Wi-Fi):');
  (PUBLIC_URL ? [PUBLIC_URL] : lanUrls()).forEach(u => console.log('     ' + u));
  console.log('\n  Keep this window open during the event. Press Ctrl+C to stop.\n');
});
