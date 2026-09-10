const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const script = import(pathToFileURL(path.resolve(__dirname, '../scripts/run-payment-scheduler.mjs')).href);
const secret = 'scheduler-unit-test-not-a-real-secret-1234567890';
const env = { FAME_PAYMENT_SCHEDULER_ENABLED: 'true', CRON_SECRET: secret };
const fixtures = {
  '/api/internal/cron/application-review-outbox': { delivered: 0, deferred: 1, failed: 0, stale: 0 },
  '/api/internal/cron/agreement-completion-stage-outbox': { delivered: 0, deferred: 0, failed: 0, stale: 0 },
  '/api/internal/cron/payment-pending-sync': { queued: 0, delivered: 1, deferred: 0, cancelled: 0, manual_review: 0, stale: 0 },
  '/api/internal/cron/payment-email': { processed: 1, accepted: 1, delivered: 0, failed: 0, uncertain: 0, cancelled: 0, pending: 0 },
  '/api/internal/cron/payment-paid-sync': { queued: 0, delivered: 1, deferred: 0, manual_review: 0, stale: 0 },
  '/api/internal/cron/square-payment-expiry': { expiryPending: 1, expired: 1, deferred: 0, manualReview: 0 },
};
const fixture = url => fixtures[new URL(url).pathname];

test('scheduler stays inert unless explicitly enabled, including manual invocation', async () => {
  const { runPaymentScheduler, main } = await script;
  let calls = 0;
  const transport = async () => { calls++; throw new Error('must never be reached'); };
  for (const flag of [undefined, '', 'false', 'TRUE', '1']) {
    const result = await runPaymentScheduler({ ...env, FAME_PAYMENT_SCHEDULER_ENABLED: flag }, transport);
    assert.deepEqual(result, { enabled: false, ok: true, processed: 0, failures: 0, workers: [] });
  }
  const lines = []; assert.equal(await main({}, transport, line => lines.push(line)), 0);
  assert.equal(calls, 0); assert.equal(lines.length, 1);
});

test('scheduler refuses missing, short, oversized and header-injection secrets before any request', async () => {
  const { runPaymentScheduler } = await script; let calls = 0;
  for (const value of [undefined, '', 'short', 'x'.repeat(4097), secret + '\r\nInjected: value', secret + '\0']) {
    const result = await runPaymentScheduler({ ...env, CRON_SECRET: value }, async () => { calls++; });
    assert.equal(result.ok, false); assert.equal(result.error, 'scheduler_secret_invalid'); assert.equal(result.processed, 0);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  assert.equal(calls, 0);
});

test('scheduler invokes all six fixed-domain workers in application-to-payment order sequentially with bearer authentication and no redirects', async () => {
  const { runPaymentScheduler } = await script;
  const calls = []; let active = 0; let maxActive = 0;
  const result = await runPaymentScheduler({ ...env, FAME_VENDOR_PORTAL_ORIGIN: 'https://attacker.invalid', ORIGIN: 'https://other.invalid' }, async (url, init) => {
    active++; maxActive = Math.max(active, maxActive); calls.push(url);
    assert.equal(new URL(url).origin, 'https://freshairmarketsandevents.com');
    assert.ok(Object.hasOwn(fixtures, new URL(url).pathname));
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, `Bearer ${secret}`); assert.equal(init.headers.Accept, 'application/json');
    assert.ok(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted, false);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return Response.json(fixture(url));
  });
  assert.equal(maxActive, 1); assert.equal(result.ok, true); assert.equal(result.processed, 6); assert.equal(result.failures, 0);
  assert.deepEqual(calls.map(url => new URL(url).pathname), Object.keys(fixtures));
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('failed HTTP calls do not skip later workers or disclose private response bodies', async () => {
  const { runPaymentScheduler, main } = await script; let calls = 0;
  const privateBody = 'private-person@example.com secret-provider-token';
  const transport = async url => {
    calls++;
    if (new URL(url).pathname.endsWith('payment-email')) return new Response(privateBody, { status: 503 });
    return Response.json(fixture(url));
  };
  const result = await runPaymentScheduler(env, transport);
  assert.equal(calls, 6); assert.equal(result.ok, false); assert.equal(result.failures, 1);
  assert.deepEqual(result.workers.find(w => w.worker === 'payment_email'), { worker: 'payment_email', ok: false, error: 'http_failure', status: 503 });
  const lines = []; assert.equal(await main(env, transport, line => lines.push(line)), 1);
  assert.ok(!lines[0].includes(privateBody)); assert.ok(!lines[0].includes(secret));
});

test('timeout and redirect failures are sanitized and attempted only once per worker', async () => {
  const { runPaymentScheduler } = await script; const counts = new Map();
  const result = await runPaymentScheduler(env, async url => {
    counts.set(url, (counts.get(url) || 0) + 1);
    if (new URL(url).pathname.endsWith('payment-paid-sync')) throw new DOMException('private-token https://attacker.invalid', 'TimeoutError');
    return Response.json(fixture(url));
  });
  assert.equal(result.failures, 1); assert.equal(counts.size, 6); assert.ok([...counts.values()].every(n => n === 1));
  assert.deepEqual(result.workers.find(w => w.worker === 'payment_paid_sync'), { worker: 'payment_paid_sync', ok: false, error: 'request_unavailable' });
  assert.ok(!JSON.stringify(result).includes('attacker')); assert.ok(!JSON.stringify(result).includes('private-token'));
});

test('marketing HTML, redirects, disabled workers, PII fields and malformed counts fail closed', async () => {
  const { runPaymentScheduler } = await script;
  const invalid = [
    () => new Response('<html>Marketing site</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('', { status: 307, headers: { location: 'https://attacker.invalid' } }),
    () => Response.json({ enabled: false }),
    () => Response.json({ ...fixtures['/api/internal/cron/payment-email'], vendorEmail: 'private@example.com' }),
    () => Response.json({ ...fixtures['/api/internal/cron/payment-email'], accepted: '1' }),
    () => Response.json({ ...fixtures['/api/internal/cron/payment-email'], accepted: -1 }),
    () => new Response('private'.repeat(1000), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{malformed', { headers: { 'content-type': 'application/json' } }),
  ];
  for (const response of invalid) {
    const result = await runPaymentScheduler(env, async url => new URL(url).pathname.endsWith('payment-email') ? response() : Response.json(fixture(url)));
    assert.equal(result.failures, 1); assert.equal(result.processed, 6); assert.ok(!JSON.stringify(result).includes('private@example.com'));
  }
});

test('permanent worker failures or manual-review counts fail the run while bounded scheduled retries remain visible', async () => {
  const { runPaymentScheduler } = await script;
  const result = await runPaymentScheduler(env, async url => {
    const data = { ...fixture(url) };
    if (new URL(url).pathname.endsWith('payment-email')) data.uncertain = 1;
    if (new URL(url).pathname.endsWith('payment-paid-sync')) data.manual_review = 1;
    return Response.json(data);
  });
  assert.equal(result.failures, 2); assert.equal(result.ok, false);
  assert.equal(result.workers.find(w => w.worker === 'payment_email').error, 'worker_needs_attention');
  assert.equal(result.workers.find(w => w.worker === 'payment_paid_sync').error, 'worker_needs_attention');
  assert.equal(result.workers.find(w => w.worker === 'application_review').counts.deferred, 1);
  assert.equal(result.workers.find(w => w.worker === 'application_review').ok, true);
});


test('pending sync cancellation is counted while manual review fails the scheduler without skipping later workers', async () => {
  const { runPaymentScheduler } = await script;
  for (const manualReview of [0, 1]) {
    const calls = [];
    const result = await runPaymentScheduler(env, async url => {
      calls.push(new URL(url).pathname);
      const data = { ...fixture(url) };
      if (new URL(url).pathname.endsWith('payment-pending-sync')) { data.cancelled = 1; data.manual_review = manualReview; }
      return Response.json(data);
    });
    const pending = result.workers.find(w => w.worker === 'payment_pending_sync');
    assert.equal(pending.counts.cancelled, 1); assert.equal(pending.ok, manualReview === 0);
    assert.equal(result.failures, manualReview); assert.deepEqual(calls, Object.keys(fixtures));
  }
});
