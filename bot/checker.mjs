// ─────────────────────────────────────────────────────────────
// bot/checker.mjs — "is this page saying in stock?"
// Same logic as src/checker.js, but with no npm packages.
//
// Order of trust:
//  1. Structured data (JSON-LD schema.org offers.availability) —
//     machine-readable, survives shop redesigns.
//  2. Your custom sold-out phrase (set with /phrase).
//  3. Disabled buy button, then common phrases.
// ─────────────────────────────────────────────────────────────

const OUT_PHRASES = ['out of stock', 'sold out', 'currently unavailable', 'notify me when available',
  'temporarily unavailable', 'no longer available'];
const IN_PHRASES = ['add to cart', 'add to bag', 'add to basket', 'buy now'];

function collectAvailability(node, found) {
  if (Array.isArray(node)) node.forEach(n => collectAvailability(n, found));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k.toLowerCase() === 'availability' && typeof v === 'string') found.push(v);
      else collectAvailability(v, found);
    }
  }
  return found;
}

function fromJsonLd(html) {
  const values = [];
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try { collectAvailability(JSON.parse(m[1]), values); } catch { /* shop's broken JSON — skip */ }
  }
  if (!values.length) return 'unknown';
  if (values.some(v => /instock|limitedavailability|onlineonly|instoreonly/i.test(v))) return 'in_stock';
  if (values.some(v => /outofstock|soldout|discontinued|preorder|backorder/i.test(v))) return 'out_of_stock';
  return 'unknown';
}

// Visible text only: drop scripts/styles/tags, decode a few entities.
function visibleText(html) {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function detectStock(html, outPhrase = '') {
  const structured = fromJsonLd(html);
  if (structured !== 'unknown') return { status: structured, via: 'structured data' };

  const text = visibleText(html);
  if (outPhrase) {
    return text.includes(outPhrase.toLowerCase())
      ? { status: 'out_of_stock', via: 'your phrase found' }
      : { status: 'in_stock', via: 'your phrase gone' };
  }

  // <button ... disabled ...>Add to cart</button>
  const disabledBuy = /<button\b[^>]*\b(disabled|aria-disabled\s*=\s*["']true["'])[^>]*>[\s\S]{0,200}?(add to (cart|bag|basket)|buy now)/i.test(html);
  if (disabledBuy) return { status: 'out_of_stock', via: 'buy button disabled' };

  if (OUT_PHRASES.some(p => text.includes(p))) return { status: 'out_of_stock', via: 'page text' };
  if (IN_PHRASES.some(p => text.includes(p))) return { status: 'in_stock', via: 'page text' };
  return { status: 'unknown', via: 'no signal' };
}
