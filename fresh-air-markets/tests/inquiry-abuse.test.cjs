const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryInquiryLimiter, inquiryClient, inquiryBucket } = require('../.test-build/inquiry-rate-limit.js');
const { readInquiryBody, MAX_INQUIRY_BYTES } = require('../.test-build/inquiry-body.js');

test('inquiry limits permit the boundary, reject concurrent excess and reset at expiration', async () => {
  let now = 100000;
  const limiter = new MemoryInquiryLimiter(() => now);
  const policy = { limit: 5, seconds: 60 };
  const results = await Promise.all(Array.from({ length: 100 }, () => limiter.consume('one', policy)));
  assert.equal(results.filter(x => x.allowed).length, 5);
  now += 59999;
  assert.deepEqual(await limiter.consume('one', policy), { allowed: false, retryAfterSeconds: 1 });
  now += 1;
  assert.equal((await limiter.consume('one', policy)).allowed, true);
});

test('bounded development limiter cannot be bypassed by evicting active identities', async () => {
  let now = 0;
  const limiter = new MemoryInquiryLimiter(() => now, 1);
  const policy = { limit: 1, seconds: 10 };
  assert.equal((await limiter.consume('one', policy)).allowed, true);
  assert.equal((await limiter.consume('two', policy)).allowed, false);
  assert.equal((await limiter.consume('one', policy)).allowed, false);
  now = 10000;
  assert.equal((await limiter.consume('two', policy)).allowed, true);
});

test('client identity ignores spoofable headers outside Vercel and rejects ambiguous chains', () => {
  const headers = new Headers({ 'x-forwarded-for': '203.0.113.8', 'x-real-ip': '198.51.100.1' });
  assert.equal(inquiryClient(headers, {}), 'unknown');
  assert.equal(inquiryClient(headers, { VERCEL: '1' }), '203.0.113.8');
  for (const value of ['fake', '203.0.113.8, 198.51.100.1', '']) {
    assert.equal(inquiryClient(new Headers({ 'x-forwarded-for': value }), { VERCEL: '1' }), 'unknown');
  }
  assert.equal(inquiryClient(new Headers({ 'x-forwarded-for': '2001:0DB8:0:0:0:0:0:1' }), { VERCEL: '1' }), '[2001:db8::1]');
});

test('stored rate keys conceal identities and separate scope, kind and signing secret', () => {
  const env = { NODE_ENV: 'production', AUTH_SECRET: 'a'.repeat(32) };
  const key = inquiryBucket('email', JSON.stringify(['market-a', 'qa@example.invalid']), env);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.notEqual(key, inquiryBucket('email', JSON.stringify(['market-b', 'qa@example.invalid']), env));
  assert.notEqual(key, inquiryBucket('ip', JSON.stringify(['market-a', 'qa@example.invalid']), env));
  assert.notEqual(key, inquiryBucket('email', JSON.stringify(['market-a', 'qa@example.invalid']), { ...env, AUTH_SECRET: 'b'.repeat(32) }));
  assert.throws(() => inquiryBucket('ip', 'qa', { NODE_ENV: 'production' }));
});

test('bounded body reader counts UTF-8 bytes, cancels oversized streams and preserves valid chunks', async () => {
  const value = JSON.stringify({ message: 'é' });
  const bytes = new TextEncoder().encode(value);
  const valid = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  assert.deepEqual(await readInquiryBody(new Request('https://unit-test.invalid', { method: 'POST', body: valid, duplex: 'half' })), { body: { message: 'é' } });
  let cancelled = false;
  const oversized = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_INQUIRY_BYTES + 1)); }, cancel() { cancelled = true; } });
  assert.equal((await readInquiryBody(new Request('https://unit-test.invalid', { method: 'POST', body: oversized, duplex: 'half' }))).status, 413);
  assert.equal(cancelled, true);
  const exact = '{"x":"' + 'a'.repeat(MAX_INQUIRY_BYTES - 8) + '"}';
  assert.equal(new TextEncoder().encode(exact).length, MAX_INQUIRY_BYTES);
  assert.ok('body' in await readInquiryBody(new Request('https://unit-test.invalid', { method: 'POST', body: exact })));
});
