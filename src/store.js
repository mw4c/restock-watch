// ─────────────────────────────────────────────────────────────
// store.js — tiny JSON-file "database". Fine for one person
// watching up to ~50 items; swap for SQLite/Postgres later when
// this becomes a paid multi-user feature of Recco.
// Writes go to a temp file then rename, so a crash mid-write can
// never leave you with a corrupted file.
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const FILE = path.join(config.dataDir, 'items.json');
const SETTINGS_FILE = path.join(config.dataDir, 'settings.json');

let items = [];
let settings = {};   // e.g. { telegramChatId } saved by the "Connect Telegram" button

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function load() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  items = readJson(FILE, []);
  settings = readJson(SETTINGS_FILE, {});
}

const save = () => writeJson(FILE, items);

const store = {
  load,
  getSetting: key => settings[key],
  setSetting(key, value) { settings[key] = value; writeJson(SETTINGS_FILE, settings); },
  all: () => items,
  get: id => items.find(i => i.id === id),
  add({ name, url, intervalSec, outPhrase }) {
    const item = {
      id: crypto.randomUUID(),
      name, url, intervalSec, outPhrase: outPhrase || '',
      status: 'pending',      // pending | in_stock | out_of_stock | unknown | error
      via: '',
      lastChecked: null,
      lastChanged: null,
      lastError: '',
      nextCheckAt: Date.now() + 5_000, // first check ~5s after adding
    };
    items.push(item);
    save();
    return item;
  },
  update(id, patch) {
    const item = store.get(id);
    if (!item) return null;
    Object.assign(item, patch);
    save();
    return item;
  },
  remove(id) {
    const before = items.length;
    items = items.filter(i => i.id !== id);
    if (items.length !== before) save();
    return items.length !== before;
  },
};

module.exports = store;
