// ─────────────────────────────────────────────────────────────
// notify.js — sends the "WAH, BACK IN STOCK!" ping to Telegram,
// and handles the phone-friendly "Connect Telegram" flow.
// Telegram is the only outside host besides the shops; it's a fixed
// official URL, so it doesn't go through the shop allowlist.
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');
const config = require('./config');
const store = require('./store');

const TG = method => `https://api.telegram.org/bot${config.telegramToken}/${method}`;

// Telegram's HTML mode: escape anything coming from a web page so a
// product name can't inject formatting or fake links into your alert.
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Chat ID can come from the env var OR from the Connect button.
const chatId = () => config.telegramChatId || store.getSetting('telegramChatId') || '';

async function sendTelegram(text) {
  if (!config.telegramToken || !chatId()) {
    console.warn('⚠️  Telegram not connected — alert only printed to console:\n' + text);
    return false;
  }
  const res = await fetch(TG('sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId(), text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Never log the token — only the status code.
    console.error(`Telegram send failed: HTTP ${res.status}`);
    return false;
  }
  return true;
}

function restockAlert(item) {
  return sendTelegram(
    `🚨 <b>Back in stock!</b>\n\n${esc(item.name)}\n\n` +
    `👉 <a href="${esc(item.url)}">Tap here to buy now</a>\n` +
    `<i>Go go go — restocks don't last.</i>`
  );
}

function testAlert() {
  return sendTelegram('✅ Restock Watch is connected. Steady — we\'ll ping you here when stuff restocks.');
}

// ── Connect Telegram without hunting for a chat ID ────────────
// 1. Dashboard asks for a one-time code (e.g. "RW-483920").
// 2. You send that exact code to your bot in Telegram.
// 3. Dashboard taps "Done" → we look for that code in the bot's
//    recent messages and save the sender's chat ID.
// The random code means a stranger messaging your bot can't hijack
// your alerts — only whoever sends the code gets linked.
let pending = null; // { code, expires }

function startConnect() {
  if (!config.telegramToken) throw new Error('Add TELEGRAM_BOT_TOKEN in your host settings first');
  pending = { code: 'RW-' + crypto.randomInt(100000, 999999), expires: Date.now() + 10 * 60_000 };
  return pending.code;
}

async function finishConnect() {
  if (!pending || pending.expires < Date.now()) throw new Error('Code expired — tap Connect again');
  const res = await fetch(TG('getUpdates') + '?allowed_updates=%5B%22message%22%5D', {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error('Telegram rejected the bot token — check it in your host settings');
  const { result = [] } = await res.json();
  const match = result.reverse().find(u =>
    u.message?.chat?.type === 'private' && u.message?.text?.trim().toUpperCase() === pending.code);
  if (!match) throw new Error(`Didn't see "${pending.code}" yet — send it to your bot, then tap again`);
  store.setSetting('telegramChatId', String(match.message.chat.id));
  pending = null;
  await testAlert();
  return true;
}

const telegramStatus = () => ({ hasToken: Boolean(config.telegramToken), connected: Boolean(chatId()) });

module.exports = { restockAlert, testAlert, startConnect, finishConnect, telegramStatus };
