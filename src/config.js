// ─────────────────────────────────────────────────────────────
// config.js — every setting comes from environment variables.
// Secrets (password, Telegram token) NEVER live in code or git.
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// On your own computer settings live in a .env file. On a cloud host
// (Render) there's no file — you type them into the host's dashboard
// and they arrive as real environment variables. Support both.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Missing env var ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

const config = {
  port: Number(process.env.PORT || 3000),

  // Login password for the web dashboard. Enforce a minimum length so
  // nobody deploys this with "1234".
  adminPassword: required('ADMIN_PASSWORD'),

  // Used to sign the login cookie. If unset we generate a random one,
  // which simply means you get logged out when the server restarts.
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),

  // Telegram is how alerts reach your phone (most Singaporeans already have it).
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // SECURITY: the server will ONLY fetch URLs on these hosts.
  // This stops anyone abusing the app to make requests to your
  // home network / cloud metadata (an attack called SSRF).
  allowedHosts: (process.env.ALLOWED_HOSTS ||
    'www.dyson.com.sg,dyson.com.sg,www.courts.com.sg,www.fairprice.com.sg,www.harveynorman.com.sg,www.bestdenki.com.sg')
    .split(',').map(h => h.trim().toLowerCase()).filter(Boolean),

  // Be polite to the shops: never check faster than once a minute.
  minIntervalSec: 60,
  maxIntervalSec: 3600,
  defaultIntervalSec: 180,
  maxItems: 50,

  // Set to "true" when running behind HTTPS (Render, Fly, Railway etc.)
  secureCookies: process.env.SECURE_COOKIES === 'true',

  // Where the watchlist is saved. On Render this points at a persistent
  // disk so your list survives restarts and redeploys.
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
};

if (config.adminPassword.length < 12) {
  console.error('❌ ADMIN_PASSWORD must be at least 12 characters.');
  process.exit(1);
}

module.exports = config;
