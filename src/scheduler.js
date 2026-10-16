// ─────────────────────────────────────────────────────────────
// scheduler.js — the "bot". Every few seconds it looks for items
// whose check is due, checks them ONE at a time, and fires an alert
// the moment an item flips to in stock.
// ─────────────────────────────────────────────────────────────
const store = require('./store');
const config = require('./config');
const { safeFetchHtml } = require('./safeFetch');
const { detectStock } = require('./checker');
const { restockAlert } = require('./notify');

// ±20% random spread so checks don't hit the shop like a metronome.
const jitter = sec => Math.round(sec * 1000 * (0.8 + Math.random() * 0.4));

let running = false;

async function checkItem(item) {
  const prev = item.status;
  try {
    const { status: http, html } = await safeFetchHtml(item.url);

    if (http === 403 || http === 429) {
      // The shop's bot protection said no. Back off (double the wait,
      // capped) instead of hammering — that's how you get IP-banned.
      const backoff = Math.min((item.backoffSec || item.intervalSec) * 2, config.maxIntervalSec);
      return store.update(item.id, {
        status: 'error', lastError: `Shop blocked the check (HTTP ${http}). Slowing down.`,
        lastChecked: Date.now(), backoffSec: backoff, nextCheckAt: Date.now() + jitter(backoff),
      });
    }
    if (http >= 400) throw new Error(`Shop returned HTTP ${http}`);

    const { status, via } = detectStock(html, item.outPhrase);
    const changed = status !== prev;
    store.update(item.id, {
      status, via, lastError: '', lastChecked: Date.now(), backoffSec: 0,
      lastChanged: changed ? Date.now() : item.lastChanged,
      nextCheckAt: Date.now() + jitter(item.intervalSec),
    });

    // The money moment: alert only on the flip INTO stock, so you
    // get one ping per restock instead of one every 3 minutes.
    if (status === 'in_stock' && prev !== 'in_stock') {
      console.log(`🚨 RESTOCK: ${item.name}`);
      await restockAlert(item);
    }
  } catch (err) {
    store.update(item.id, {
      status: 'error', lastError: String(err.message || err).slice(0, 200),
      lastChecked: Date.now(), nextCheckAt: Date.now() + jitter(item.intervalSec),
    });
  }
}

async function tick() {
  if (running) return;          // never overlap two rounds
  running = true;
  try {
    const due = store.all().filter(i => i.nextCheckAt <= Date.now());
    for (const item of due) await checkItem(item);   // sequential = gentle
  } finally {
    running = false;
  }
}

function start() {
  setInterval(tick, 5_000).unref();
  console.log('🤖 Restock bot started.');
}

module.exports = { start, checkItem };
