// ─────────────────────────────────────────────────────────────
// safeFetch.js — the ONLY way this app talks to the internet.
//
// Three layers of protection:
//  1. Host allowlist  – only shops you listed in ALLOWED_HOSTS.
//  2. IP check at connect time – even if DNS is tricked into pointing
//     an allowed name at 127.0.0.1 / 10.x / 169.254.x (cloud metadata),
//     the connection is refused. Checking at *connect* time (not before)
//     closes the "DNS rebinding" loophole.
//  3. Limits – HTTPS only, 15s timeout, 3MB max page, max 3 redirects,
//     and every redirect is re-checked against the allowlist.
// ─────────────────────────────────────────────────────────────
const dns = require('dns');
const net = require('net');
const { Agent, fetch } = require('undici');
const config = require('./config');

// Private / reserved ranges we must never connect to.
const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([ip, p]) => blocked.addSubnet(ip, p, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['::ffff:0:0', 96],
].forEach(([ip, p]) => blocked.addSubnet(ip, p, 'ipv6'));

function isBlockedIp(address) {
  const family = net.isIPv6(address) ? 'ipv6' : 'ipv4';
  return blocked.check(address, family);
}

// Custom DNS lookup used by the HTTP client for every connection.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const bad = addresses.find(a => isBlockedIp(a.address));
    if (bad) return callback(new Error(`Blocked private address for ${hostname}`));
    if (options && options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

const agent = new Agent({ connect: { lookup: safeLookup, timeout: 10_000 } });

/** Throws unless the URL is https:// on an allowlisted host. */
function assertAllowedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Not a valid URL'); }
  if (u.protocol !== 'https:') throw new Error('Only https:// links are allowed');
  if (u.username || u.password) throw new Error('URLs with logins are not allowed');
  if (u.port && u.port !== '443') throw new Error('Custom ports are not allowed');
  if (!config.allowedHosts.includes(u.hostname.toLowerCase())) {
    throw new Error(`Shop not on the allowlist: ${u.hostname}`);
  }
  return u;
}

const MAX_BYTES = 3 * 1024 * 1024;

// A normal desktop browser identity. We are NOT trying to disguise
// heavy traffic — checks are slow and spaced out (see scheduler).
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml',
  'accept-language': 'en-SG,en;q=0.9',
};

/** Fetch a page's HTML safely. Returns { status, html }. */
async function safeFetchHtml(rawUrl) {
  let url = assertAllowedUrl(rawUrl);

  for (let hop = 0; hop <= 3; hop++) {
    const res = await fetch(url, {
      dispatcher: agent,
      headers: HEADERS,
      redirect: 'manual',              // we follow redirects ourselves…
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      // …so every hop is re-checked against the allowlist.
      url = assertAllowedUrl(new URL(res.headers.get('location'), url).toString());
      continue;
    }

    // Read the body with a hard size cap.
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Page too large'); }
      chunks.push(value);
    }
    return { status: res.status, html: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('Too many redirects');
}

module.exports = { safeFetchHtml, assertAllowedUrl, isBlockedIp };
