// Run with: npm test
process.env.ADMIN_PASSWORD = 'test-password-123';
const test = require('node:test');
const assert = require('node:assert');
const { detectStock } = require('../src/checker');
const { assertAllowedUrl, isBlockedIp } = require('../src/safeFetch');

const ld = availability => `<html><head><script type="application/ld+json">
{"@type":"Product","name":"HushJet","offers":{"@type":"Offer","availability":"https://schema.org/${availability}"}}
</script></head><body>Some page</body></html>`;

test('structured data: in stock', () => assert.equal(detectStock(ld('InStock')).status, 'in_stock'));
test('structured data: out of stock', () => assert.equal(detectStock(ld('OutOfStock')).status, 'out_of_stock'));
test('custom phrase wins when no structured data', () => {
  assert.equal(detectStock('<body>Notify me when back</body>', 'notify me').status, 'out_of_stock');
  assert.equal(detectStock('<body>Add to cart</body>', 'notify me').status, 'in_stock');
});
test('disabled buy button = sold out', () =>
  assert.equal(detectStock('<body><button disabled>Add to cart</button></body>').status, 'out_of_stock'));
test('plain text fallback', () => assert.equal(detectStock('<body><b>Add to bag</b></body>').status, 'in_stock'));
test('nothing recognisable = unknown', () => assert.equal(detectStock('<body>hello</body>').status, 'unknown'));

test('URL allowlist', () => {
  assert.ok(assertAllowedUrl('https://www.dyson.com.sg/hushjet-purifier-compact-black-teal'));
  assert.throws(() => assertAllowedUrl('http://www.dyson.com.sg/x'));            // not https
  assert.throws(() => assertAllowedUrl('https://evil.com/x'));                    // not allowed
  assert.throws(() => assertAllowedUrl('https://www.dyson.com.sg:8080/x'));       // odd port
  assert.throws(() => assertAllowedUrl('https://user:pw@www.dyson.com.sg/x'));    // creds in URL
});

test('private IPs blocked (SSRF guard)', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1'])
    assert.ok(isBlockedIp(ip), ip);
  assert.ok(!isBlockedIp('23.45.67.89'));
});
