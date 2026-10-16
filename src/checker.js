// ─────────────────────────────────────────────────────────────
// checker.js — decides whether a product page says "in stock".
//
// Strategy, most reliable first:
//  1. Structured data (JSON-LD). Most big shops, incl. Dyson,
//     embed schema.org "Product" data for Google Shopping, with
//     offers.availability = InStock / OutOfStock. Machine-readable,
//     so it rarely breaks when the shop redesigns.
//  2. Your own phrase. If you tell us "the page says 'Notify me'
//     when sold out", we look for that text.
//  3. Common phrases ("out of stock", "add to cart", …).
// Returns 'in_stock' | 'out_of_stock' | 'unknown'.
// ─────────────────────────────────────────────────────────────
const cheerio = require('cheerio');

const OUT_PHRASES = [
  'out of stock', 'sold out', 'currently unavailable', 'notify me when available',
  'notify me', 'temporarily unavailable', 'coming soon', 'no longer available',
];
const IN_PHRASES = ['add to cart', 'add to bag', 'add to basket', 'buy now'];

// Walk any JSON value and collect every "availability" field we find.
function collectAvailability(node, found = []) {
  if (Array.isArray(node)) node.forEach(n => collectAvailability(n, found));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k.toLowerCase() === 'availability' && typeof v === 'string') found.push(v);
      else collectAvailability(v, found);
    }
  }
  return found;
}

function fromJsonLd($) {
  const values = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { collectAvailability(JSON.parse($(el).contents().text()), values); }
    catch { /* broken JSON on the shop's side — ignore that block */ }
  });
  if (!values.length) return 'unknown';
  // If ANY variant is in stock, treat the product as in stock.
  if (values.some(v => /instock|limitedavailability|onlineonly|instoreonly/i.test(v))) return 'in_stock';
  if (values.some(v => /outofstock|soldout|discontinued|preorder|backorder/i.test(v))) return 'out_of_stock';
  return 'unknown';
}

/**
 * @param {string} html        raw page HTML
 * @param {string} [outPhrase] optional text that ONLY shows when sold out
 */
function detectStock(html, outPhrase) {
  const $ = cheerio.load(html);

  const structured = fromJsonLd($);
  if (structured !== 'unknown') return { status: structured, via: 'structured data' };

  // Visible text only (scripts/styles removed), lower-cased.
  $('script, style, noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ').toLowerCase();

  if (outPhrase) {
    return text.includes(outPhrase.toLowerCase())
      ? { status: 'out_of_stock', via: `found "${outPhrase}"` }
      : { status: 'in_stock', via: `"${outPhrase}" gone` };
  }

  // Disabled buy buttons are a strong sold-out hint.
  const buyBtnDisabled = $('button[disabled], button[aria-disabled="true"]')
    .filter((_, b) => /add to (cart|bag|basket)|buy now/i.test($(b).text())).length > 0;
  if (buyBtnDisabled) return { status: 'out_of_stock', via: 'buy button disabled' };

  if (OUT_PHRASES.some(p => text.includes(p))) return { status: 'out_of_stock', via: 'page text' };
  if (IN_PHRASES.some(p => text.includes(p))) return { status: 'in_stock', via: 'page text' };
  return { status: 'unknown', via: 'no signal found' };
}

module.exports = { detectStock };
