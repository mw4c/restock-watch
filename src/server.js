// ─────────────────────────────────────────────────────────────
// server.js — the web dashboard + JSON API.
//
// Security checklist (what each piece below is for):
//  • helmet            → strict security headers + Content-Security-Policy
//                        (blocks injected scripts / clickjacking)
//  • login rate limit  → 5 wrong passwords per 15 min, stops brute force
//  • signed cookie     → HttpOnly (JS can't steal it), SameSite=Strict
//                        (other sites can't make you click buttons = CSRF)
//  • JSON-only API     → forms on evil sites can't post JSON cross-site
//  • input validation  → length limits, URL allowlist, number clamps
// ─────────────────────────────────────────────────────────────
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const store = require('./store');
const scheduler = require('./scheduler');
const { assertAllowedUrl } = require('./safeFetch');
const { testAlert, startConnect, finishConnect, telegramStatus } = require('./notify');

store.load();
const app = express();
app.set('trust proxy', 1); // correct client IP behind Render/Fly/etc.

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],                       // no inline scripts at all
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(express.json({ limit: '10kb' }));

// Render pings this to know the app is alive (no login, no data).
app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Session cookie: "<expiry>.<HMAC signature>" ───────────────
const COOKIE = 'rw_sess';
const SESSION_MS = 7 * 24 * 3600 * 1000;

const sign = data => crypto.createHmac('sha256', config.sessionSecret).update(data).digest('hex');

// Constant-time compare: response time doesn't leak how close a guess was.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim())
    .find(s => s.startsWith(COOKIE + '='));
  return raw ? decodeURIComponent(raw.slice(COOKIE.length + 1)) : '';
}

function isLoggedIn(req) {
  const [exp, sig] = readCookie(req).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}

function setCookie(res, value, maxAgeMs) {
  res.setHeader('Set-Cookie', [
    `${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`, config.secureCookies ? 'Secure' : '',
  ].filter(Boolean).join('; '));
}

function requireAuth(req, res, next) {
  if (!isLoggedIn(req)) return res.status(401).json({ error: 'Please log in' });
  // Belt-and-braces CSRF guard: state-changing calls must be JSON.
  if (req.method !== 'GET' && !req.is('application/json')) {
    return res.status(415).json({ error: 'JSON only' });
  }
  next();
}

// ── Auth routes ───────────────────────────────────────────────
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many tries. Wait 15 minutes.' } });

app.post('/api/login', loginLimiter, (req, res) => {
  if (typeof req.body?.password !== 'string' || !safeEqual(req.body.password, config.adminPassword)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const exp = String(Date.now() + SESSION_MS);
  setCookie(res, `${exp}.${sign(exp)}`, SESSION_MS);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { setCookie(res, '', 0); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ loggedIn: isLoggedIn(req) }));

// ── Watchlist API ─────────────────────────────────────────────
const api = express.Router();
api.use(requireAuth);
api.use(rateLimit({ windowMs: 60 * 1000, limit: 60 }));

// Only send the browser the fields it needs.
const view = i => ({
  id: i.id, name: i.name, url: i.url, intervalSec: i.intervalSec, outPhrase: i.outPhrase,
  status: i.status, via: i.via, lastChecked: i.lastChecked, lastChanged: i.lastChanged, lastError: i.lastError,
});

api.get('/items', (req, res) => res.json(store.all().map(view)));

api.post('/items', (req, res) => {
  const { name, url, intervalSec, outPhrase } = req.body || {};
  if (store.all().length >= config.maxItems) return res.status(400).json({ error: 'Watchlist full' });
  if (typeof url !== 'string' || url.length > 500) return res.status(400).json({ error: 'Bad link' });
  try { assertAllowedUrl(url); } catch (e) { return res.status(400).json({ error: e.message }); }

  const cleanName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 80) : new URL(url).pathname.split('/').pop() || 'Item';
  const cleanPhrase = typeof outPhrase === 'string' ? outPhrase.trim().slice(0, 60) : '';
  const n = Number(intervalSec) || config.defaultIntervalSec;
  const interval = Math.min(Math.max(Math.round(n), config.minIntervalSec), config.maxIntervalSec);

  res.status(201).json(view(store.add({ name: cleanName, url, intervalSec: interval, outPhrase: cleanPhrase })));
});

api.delete('/items/:id', (req, res) => {
  store.remove(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
});

api.post('/items/:id/check', async (req, res) => {
  const item = store.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  // Don't let the button be spammed into hammering the shop.
  if (item.lastChecked && Date.now() - item.lastChecked < 30_000) {
    return res.status(429).json({ error: 'Just checked — try again in 30s' });
  }
  await scheduler.checkItem(item);
  res.json(view(store.get(item.id)));
});

api.post('/test-alert', async (req, res) => {
  const ok = await testAlert();
  ok ? res.json({ ok }) : res.status(500).json({ error: 'Telegram not connected yet — tap Connect Telegram' });
});

// Phone-friendly Telegram linking (see notify.js for how it works).
api.get('/telegram', (req, res) => res.json(telegramStatus()));
api.post('/telegram/start', (req, res) => {
  try { res.json({ code: startConnect() }); } catch (e) { res.status(400).json({ error: e.message }); }
});
api.post('/telegram/finish', async (req, res) => {
  try { await finishConnect(); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});

app.use('/api', api);

// Generic error handler: never leak stack traces to the browser.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(config.port, () => {
  console.log(`🌐 Dashboard on http://localhost:${config.port}`);
  scheduler.start();
});
