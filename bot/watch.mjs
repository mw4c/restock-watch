// ─────────────────────────────────────────────────────────────
// bot/watch.mjs — the FREE, no-server version of Restock Watch.
//
// GitHub Actions runs this file every ~5 minutes (see
// .github/workflows/watch.yml). Each run:
//   1. Reads new Telegram messages → handles /add, /list, /remove.
//      (You manage everything by chatting with your bot.)
//   2. Checks every watched product page once.
//   3. Pings you on Telegram if something flipped to IN STOCK.
//   4. Saves state to bot/state.json (committed back to GitHub
//      only when something actually changed).
//
// Zero npm packages → nothing to install, fast runs, and less
// third-party code that could be compromised.
// ─────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectStock } from './checker.mjs';

const STATE_FILE = fileURLToPath(new URL('./state.json', import.meta.url));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const OWNER_CHAT = (process.env.TELEGRAM_CHAT_ID || '').trim();   // only this chat can give commands
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ||
  'www.dyson.com.sg,dyson.com.sg,www.courts.com.sg,www.fairprice.com.sg,www.harveynorman.com.sg,www.bestdenki.com.sg')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
const MAX_ITEMS = 30;

if (!TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN secret is missing. See README.'); process.exit(1); }

// ── State ─────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { offset: 0, items: [], heartbeat: 0 }; }
}
const state = loadState();
const before = JSON.stringify(state);

// ── Telegram helpers ──────────────────────────────────────────
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error(`Telegram ${method} failed: HTTP ${res.status}`); // never log the token
  return data;
}
const say = (chatId, text) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });

// ── URL safety ────────────────────────────────────────────────
// Only https pages on shops you allow. (This runs on a throwaway
// GitHub machine, but we still refuse anything unexpected.)
function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'That doesn\'t look like a link.'; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return 'Only normal https:// shop links, please.';
  if (!ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) return `I'm not allowed to check ${esc(u.hostname)} yet. Shops I can check: ${ALLOWED_HOSTS.join(', ')}`;
  return null;
}

const LABEL = { in_stock: '🟢 In stock', out_of_stock: '🔴 Sold out', unknown: '🟡 Not sure', error: '⚠️ Can\'t read page', pending: '⏳ Checking soon' };

// ── 1. Handle chat commands ───────────────────────────────────
async function handleCommands() {
  const { result = [] } = await tg('getUpdates', { offset: state.offset, timeout: 0, allowed_updates: ['message'] });
  for (const u of result) {
    state.offset = u.update_id + 1;                 // mark as read
    const msg = u.message;
    if (!msg?.text || msg.chat?.type !== 'private') continue;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    // Strangers (or you, before setup) only get told their chat ID.
    if (chatId !== OWNER_CHAT) {
      if (text.startsWith('/start')) {
        await say(chatId, `👋 Your chat ID is <code>${chatId}</code>\n\nAdd it on GitHub as the secret <b>TELEGRAM_CHAT_ID</b> (see README), then send /start again.`);
      }
      continue;
    }

    const [cmd, ...rest] = text.split(/\s+/);
    const looksLikeLink = /^https?:\/\//i.test(text);

    if (cmd === '/start' || cmd === '/help') {
      await say(chatId,
        '🛒 <b>Restock Watch</b>\n\n' +
        'Just <b>send me a product link</b> and I\'ll watch it.\n\n' +
        '/list – what I\'m watching\n/remove 2 – stop watching item 2\n' +
        '/add link name – add with a nickname\n/phrase 2 Notify me – sold-out wording for item 2\n\n' +
        '<i>I check about every 5 minutes, so replies can take a few minutes.</i>');
    } else if (looksLikeLink || cmd === '/add') {
      const url = looksLikeLink ? cmd : rest[0];   // "link [nickname]" or "/add link [nickname]"
      const name = (looksLikeLink ? rest : rest.slice(1)).join(' ').slice(0, 80);
      const problem = !url ? 'Send /add followed by a link.' : checkUrl(url);
      if (problem) { await say(chatId, '❌ ' + problem); continue; }
      if (state.items.length >= MAX_ITEMS) { await say(chatId, '❌ List full (30). /remove something first.'); continue; }
      if (state.items.some(i => i.url === url)) { await say(chatId, '👍 Already watching that.'); continue; }
      const fallback = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'item').replace(/[-_]+/g, ' ');
      state.items.push({ url, name: name || fallback.slice(0, 80), outPhrase: '', status: 'pending', lastChanged: Date.now(), lastError: '' });
      await say(chatId, `✅ Watching <b>${esc(name || fallback)}</b>. I'll ping you when it's in stock.`);
    } else if (cmd === '/list') {
      if (!state.items.length) { await say(chatId, 'Nothing yet. Send me a product link lah.'); continue; }
      await say(chatId, state.items.map((it, n) =>
        `${n + 1}. ${LABEL[it.status] || it.status} – <a href="${esc(it.url)}">${esc(it.name)}</a>` +
        (it.lastError ? `\n    <i>${esc(it.lastError)}</i>` : '')).join('\n'));
    } else if (cmd === '/remove') {
      const n = Number(rest[0]);
      if (!Number.isInteger(n) || n < 1 || n > state.items.length) { await say(chatId, 'Which one? e.g. /remove 2 (see /list)'); continue; }
      const [gone] = state.items.splice(n - 1, 1);
      await say(chatId, `🗑️ Stopped watching ${esc(gone.name)}.`);
    } else if (cmd === '/phrase') {
      const n = Number(rest[0]);
      const phrase = rest.slice(1).join(' ').slice(0, 60);
      if (!Number.isInteger(n) || !state.items[n - 1] || !phrase) { await say(chatId, 'e.g. /phrase 2 Notify me'); continue; }
      state.items[n - 1].outPhrase = phrase;
      await say(chatId, `👌 Item ${n}: I'll treat "${esc(phrase)}" on the page as sold out.`);
    } else {
      await say(chatId, 'Send me a product link, or /help.');
    }
  }
}

// ── 2. Check each product page ────────────────────────────────
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-SG,en;q=0.9',
};

async function fetchPage(url) {
  // Follow redirects ourselves so each hop is re-checked against the allowlist.
  for (let hop = 0; hop <= 3; hop++) {
    const res = await fetch(url, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      if (checkUrl(url)) throw new Error('Redirected to a shop not on the allowlist');
      continue;
    }
    const html = await res.text();
    if (html.length > 5_000_000) throw new Error('Page too large');
    return { status: res.status, html };
  }
  throw new Error('Too many redirects');
}

async function checkAll() {
  for (const it of state.items) {
    const prev = it.status;
    let status, error = '';
    try {
      const page = await fetchPage(it.url);
      if (page.status === 403 || page.status === 429) { status = 'error'; error = `Shop blocked the check (HTTP ${page.status})`; }
      else if (page.status >= 400) { status = 'error'; error = `Shop returned HTTP ${page.status}`; }
      else status = detectStock(page.html, it.outPhrase).status;
    } catch (e) {
      status = 'error'; error = String(e.message || e).slice(0, 120);
    }
    console.log(`${status.padEnd(12)} ${it.name}${error ? ' — ' + error : ''}`);

    if (status !== prev) it.lastChanged = Date.now();
    it.status = status;
    it.lastError = error;

    if (!OWNER_CHAT) continue;
    // One ping per restock — only on the flip INTO stock.
    if (status === 'in_stock' && prev !== 'in_stock') {
      await say(OWNER_CHAT, `🚨 <b>Back in stock!</b>\n\n${esc(it.name)}\n\n👉 <a href="${esc(it.url)}">Tap here to buy now</a>\n<i>Go go go — restocks don't last.</i>`);
    }
    // Tell you once when a page becomes unreadable, so it doesn't fail silently.
    if (status === 'error' && prev !== 'error') {
      await say(OWNER_CHAT, `⚠️ Can't read <b>${esc(it.name)}</b> right now: ${esc(error)}.\nI'll keep trying.`);
    }
    await new Promise(r => setTimeout(r, 2_000 + Math.random() * 3_000)); // be polite between shops
  }
}

// ── Run ───────────────────────────────────────────────────────
await handleCommands();
await checkAll();

// GitHub pauses scheduled jobs in repos with no commits for 60 days.
// A weekly heartbeat commit keeps the bot alive while nothing changes.
const WEEK = 7 * 24 * 3600 * 1000;
if (Date.now() - (state.heartbeat || 0) > WEEK) state.heartbeat = Date.now();

const after = JSON.stringify(state);
if (after !== before) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  console.log('State changed — will be saved.');
} else {
  console.log('No changes.');
}
