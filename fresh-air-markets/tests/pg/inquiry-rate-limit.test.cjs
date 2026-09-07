const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');
const { consumePgInquiryLimit } = require('../../.test-build/inquiry-rate-limit-pg.js');

// Deliberately refuse production URLs. This suite only touches a local CI database.
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const first = postgres(url.toString(), { max: 10, prepare: false });
const second = postgres(url.toString(), { max: 10, prepare: false });
before(async () => {
  await first.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations/002-inquiry-rate-limit.sql'), 'utf8'));
  await first`TRUNCATE fame_inquiry_limits`;
});
after(async () => { await first.end(); await second.end(); });

test('100 concurrent requests over separate pools admit exactly the configured limit', async () => {
  const result = await Promise.all(Array.from({ length: 100 }, (_, i) => consumePgInquiryLimit('concurrent', { limit: 20, seconds: 600 }, i % 2 ? first : second)));
  assert.equal(result.filter(x => x.allowed).length, 20);
  assert.ok(result.every(x => x.retryAfterSeconds > 0 && x.retryAfterSeconds <= 600));
});

test('independent identities have independent quotas', async () => {
  for (const key of ['market-a:email-a', 'market-b:email-a', 'market-a:email-b']) {
    assert.equal((await consumePgInquiryLimit(key, { limit: 1, seconds: 60 }, first)).allowed, true);
    assert.equal((await consumePgInquiryLimit(key, { limit: 1, seconds: 60 }, second)).allowed, false);
  }
});

test('expired bucket admits a fresh window without waiting on wall clock', async () => {
  const policy = { limit: 1, seconds: 60 };
  await consumePgInquiryLimit('expiry', policy, first);
  assert.equal((await consumePgInquiryLimit('expiry', policy, second)).allowed, false);
  await first`UPDATE fame_inquiry_limits SET resets_at = now() - interval '1 second' WHERE bucket_key = 'expiry'`;
  assert.equal((await consumePgInquiryLimit('expiry', policy, second)).allowed, true);
  assert.equal((await consumePgInquiryLimit('expiry', policy, first)).allowed, false);
});

test('blocked retries cap the counter without extending its deadline', async () => {
  const policy = { limit: 1, seconds: 60 };
  await consumePgInquiryLimit('deadline', policy, first);
  const [before] = await first`SELECT resets_at FROM fame_inquiry_limits WHERE bucket_key = 'deadline'`;
  for (let i = 0; i < 10; i++) assert.equal((await consumePgInquiryLimit('deadline', policy, second)).allowed, false);
  const [after] = await first`SELECT hits, resets_at FROM fame_inquiry_limits WHERE bucket_key = 'deadline'`;
  assert.equal(after.hits, 2);
  assert.equal(after.resets_at.toISOString(), before.resets_at.toISOString());
});

test('new client connections retain the previous rate limit', async () => {
  const policy = { limit: 1, seconds: 60 };
  const transient = postgres(url.toString(), { max: 1 });
  assert.equal((await consumePgInquiryLimit('restart', policy, transient)).allowed, true);
  await transient.end();
  assert.equal((await consumePgInquiryLimit('restart', policy, first)).allowed, false);
});
