// End-to-end test of bot/watch.mjs with fake Telegram + fake shop. Run: node --test test/
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStock } from '../bot/checker.mjs';

const ld = a => `<script type="application/ld+json">{"@type":"Product","offers":{"availability":"https://schema.org/${a}"}}</script>`;

test('checker: structured data', () => {
  assert.equal(detectStock(ld('InStock')).status, 'in_stock');
  assert.equal(detectStock(ld('OutOfStock')).status, 'out_of_stock');
});
test('checker: phrases & disabled button', () => {
  assert.equal(detectStock('<body>Notify me</body>', 'notify me').status, 'out_of_stock');
  assert.equal(detectStock('<body><button class="x" disabled>Add to cart</button></body>').status, 'out_of_stock');
  assert.equal(detectStock('<body><button>Add to bag</button></body>').status, 'in_stock');
  assert.equal(detectStock('<body><script>"sold out"</script>hello</body>').status, 'unknown');
});

// Run watch.mjs in a sandbox dir with fetch mocked via --import.
function run(dir, scenario) {
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  execFileSync('node', ['--import', join(dir, 'mock.mjs'), join(dir, 'bot', 'watch.mjs')],
    { env: { ...process.env, TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '42', SCN: join(dir, 'scenario.json') }, stdio: 'pipe' });
  return { state: JSON.parse(readFileSync(join(dir, 'bot', 'state.json'), 'utf8')), sent: JSON.parse(readFileSync(join(dir, 'sent.json'), 'utf8')) };
}

test('bot: add via link, restock alert once, stranger gets only chat id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-'));
  execFileSync('mkdir', ['-p', join(dir, 'bot')]);
  for (const f of ['watch.mjs', 'checker.mjs']) copyFileSync(new URL('../bot/' + f, import.meta.url), join(dir, 'bot', f));
  writeFileSync(join(dir, 'bot', 'state.json'), '{"offset":0,"items":[],"heartbeat":0}');
  writeFileSync(join(dir, 'mock.mjs'), `
    import { readFileSync, writeFileSync } from 'node:fs';
    const s = JSON.parse(readFileSync(process.env.SCN, 'utf8'));
    const sent = []; const out = process.env.SCN.replace('scenario.json','sent.json');
    globalThis.setTimeout = (fn) => { fn(); return 0; };
    globalThis.fetch = async (url, opts = {}) => {
      url = String(url);
      if (url.includes('api.telegram.org')) {
        const body = JSON.parse(opts.body || '{}');
        if (url.endsWith('/getUpdates')) return new Response(JSON.stringify({ ok: true, result: s.updates.filter(u => u.update_id >= body.offset) }));
        sent.push(body); writeFileSync(out, JSON.stringify(sent));
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response(s.page, { status: 200 });
    };
    writeFileSync(out, '[]');`);
  const msg = (id, chat, text) => ({ update_id: id, message: { chat: { id: chat, type: 'private' }, text } });
  const URL1 = 'https://www.dyson.com.sg/hushjet-purifier-compact-black-teal';

  // Run 1: owner adds link, stranger says /start, evil link rejected; page sold out.
  let r = run(dir, { page: ld('OutOfStock'), updates: [msg(1, 42, URL1 + ' HushJet Teal'), msg(2, 99, '/start'), msg(3, 42, 'https://evil.com/x'), msg(4, 99, URL1)] });
  assert.equal(r.state.items.length, 1);
  assert.equal(r.state.items[0].name, 'HushJet Teal');
  assert.equal(r.state.items[0].status, 'out_of_stock');
  assert.equal(r.state.offset, 5);
  assert.ok(r.sent.some(m => m.chat_id === '99' && m.text.includes('<code>99</code>')), 'stranger told their id');
  assert.ok(r.sent.some(m => m.chat_id === '42' && m.text.includes('not allowed')), 'evil host rejected');
  assert.ok(!r.sent.some(m => m.text.includes('Back in stock')));

  // Run 2: restock → exactly one alert.
  r = run(dir, { page: ld('InStock'), updates: [] });
  assert.equal(r.sent.filter(m => m.text.includes('Back in stock')).length, 1);
  // Run 3: still in stock → no repeat alert.
  r = run(dir, { page: ld('InStock'), updates: [] });
  assert.equal(r.sent.filter(m => m.text.includes('Back in stock')).length, 0);
  // Run 4: /list and /remove
  r = run(dir, { page: ld('InStock'), updates: [msg(5, 42, '/list'), msg(6, 42, '/remove 1')] });
  assert.ok(r.sent.some(m => m.text.includes('In stock')));
  assert.equal(r.state.items.length, 0);
});
