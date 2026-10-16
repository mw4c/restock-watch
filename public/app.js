// ─────────────────────────────────────────────────────────────
// app.js — dashboard logic in plain JS (no framework to learn).
// SECURITY: page data is only ever inserted with .textContent,
// never innerHTML, so a sneaky product name can't run code here.
// ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const LABELS = {
  in_stock: 'In stock!', out_of_stock: 'Sold out', pending: 'Checking…',
  unknown: 'Not sure', error: 'Problem',
};

// Small helper around fetch that always sends/receives JSON.
async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') showLogin();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function ago(ts) {
  if (!ts) return 'not yet';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function render(items) {
  const list = $('list');
  list.replaceChildren();
  $('empty').hidden = items.length > 0;

  // In-stock items float to the top.
  items.sort((a, b) => (b.status === 'in_stock') - (a.status === 'in_stock'));

  for (const it of items) {
    const node = $('itemTpl').content.firstElementChild.cloneNode(true);
    node.classList.add('s-' + it.status);
    node.querySelector('.pill').textContent = LABELS[it.status] || it.status;
    node.querySelector('.when').textContent = 'checked ' + ago(it.lastChecked);
    const title = node.querySelector('.title');
    title.textContent = it.name;
    title.href = it.url;           // server already validated it's https + allowlisted
    node.querySelector('.buy').href = it.url;
    node.querySelector('.meta').textContent = it.lastError
      ? it.lastError
      : `every ${Math.round(it.intervalSec / 60)} min · ${new URL(it.url).hostname}${it.via ? ' · via ' + it.via : ''}`;

    node.querySelector('.check').onclick = async e => {
      e.target.disabled = true;
      try { await api(`/items/${it.id}/check`, 'POST', {}); } catch (err) { alert(err.message); }
      refresh();
    };
    node.querySelector('.del').onclick = async () => {
      if (!confirm(`Stop watching "${it.name}"?`)) return;
      await api(`/items/${it.id}`, 'DELETE', {});
      refresh();
    };
    list.appendChild(node);
  }
}

let lastInStock = null;   // null = first load, don't buzz for old news
async function refresh() {
  try {
    const items = await api('/items');
    // If the tab is open when something restocks, buzz the phone too.
    const nowIn = new Set(items.filter(i => i.status === 'in_stock').map(i => i.id));
    if (lastInStock && [...nowIn].some(id => !lastInStock.has(id))) {
      navigator.vibrate?.([200, 100, 200]);
      document.title = '🚨 RESTOCK — Restock Watch';
    }
    lastInStock = nowIn;
    render(items);
  } catch { /* handled in api() */ }
}

function showLogin() { $('app').hidden = true; $('login').hidden = false; }
function showApp() { $('login').hidden = true; $('app').hidden = false; refresh(); loadTelegram(); }

// ── Connect Telegram card ─────────────────────────────────────
async function loadTelegram() {
  try { const t = await api('/telegram'); $('tgCard').hidden = t.connected; } catch {}
}
$('tgStart').onclick = async () => {
  $('tgErr').textContent = '';
  try {
    const { code } = await api('/telegram/start', 'POST', {});
    $('tgCode').textContent = code;
    $('tgStep2').hidden = false;
    $('tgStart').hidden = true;
  } catch (err) { $('tgErr').textContent = err.message; }
};
$('tgFinish').onclick = async () => {
  $('tgErr').textContent = '';
  try { await api('/telegram/finish', 'POST', {}); $('tgCard').hidden = true; alert('Connected! Check Telegram for a test ping.'); }
  catch (err) { $('tgErr').textContent = err.message; }
};

$('loginForm').onsubmit = async e => {
  e.preventDefault();
  $('loginErr').textContent = '';
  try { await api('/login', 'POST', { password: $('password').value }); $('password').value = ''; showApp(); }
  catch (err) { $('loginErr').textContent = err.message; }
};

$('addForm').onsubmit = async e => {
  e.preventDefault();
  $('addErr').textContent = '';
  try {
    await api('/items', 'POST', {
      url: $('url').value.trim(), name: $('name').value.trim(),
      intervalSec: Number($('interval').value), outPhrase: $('outPhrase').value.trim(),
    });
    e.target.reset();
    refresh();
  } catch (err) { $('addErr').textContent = err.message; }
};

$('logoutBtn').onclick = async () => { await api('/logout', 'POST', {}); showLogin(); };
$('testBtn').onclick = async () => {
  try { await api('/test-alert', 'POST', {}); alert('Sent! Check Telegram.'); }
  catch (err) { alert(err.message); }
};

// Boot: are we already logged in?
fetch('/api/me').then(r => r.json()).then(d => (d.loggedIn ? showApp() : showLogin()));
setInterval(() => { if (!$('app').hidden) refresh(); }, 15_000);
