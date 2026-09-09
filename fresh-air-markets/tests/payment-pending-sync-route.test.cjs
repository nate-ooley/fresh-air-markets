const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const counts = { queued: 1, delivered: 1, deferred: 0, cancelled: 0, manual_review: 0, stale: 0 };
const config = { marketId: 'qa-market', pipelineId: 'qa-pipeline' };

function load({ dispatch = async () => counts, configured = true, calls = [], deliveries = [] } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/internal/cron/payment-pending-sync/route.ts');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = module.paths;
  mod.require = id => {
    if (id === '@/lib/cron-auth') return require('../.test-build/cron-auth.js');
    if (id === '@/lib/payment-pending-sync-pg') return { dispatchPaymentPendingSync: async (...args) => { calls.push(args); return dispatch(...args); } };
    if (id === '@/lib/ghl-payment-pending-delivery') return {
      readPaymentPendingDeliveryConfig: () => { if (!configured) throw new Error('private-config'); return config; },
      deliverPaymentPendingToGhl: async (...args) => { deliveries.push(args); },
    };
    return require(id);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return mod.exports;
}
const request = (authorized = true) => new Request('https://qa.example/api/internal/cron/payment-pending-sync', { headers: authorized ? { authorization: `Bearer ${'q'.repeat(32)}` } : {} });
async function withEnv(overrides, fn) {
  const keys = ['CRON_SECRET', 'DATABASE_URL', 'GHL_PAYMENT_SYNC_ENABLED'];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { CRON_SECRET: 'q'.repeat(32), DATABASE_URL: 'qa-storage-not-a-credential', GHL_PAYMENT_SYNC_ENABLED: 'true' }, overrides);
  try { await fn(); } finally { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } }
}
test('pending sync rejects unauthenticated requests before queue access', () => withEnv({}, async () => {
  const calls = []; const response = await load({ calls }).GET(request(false));
  assert.equal(response.status, 401); assert.equal(calls.length, 0);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
}));
test('pending sync refuses an unconfigured scheduler before queue access', () => withEnv({ CRON_SECRET: '' }, async () => {
  const calls = []; const response = await load({ calls }).GET(request());
  assert.equal(response.status, 503); assert.equal(calls.length, 0);
}));
test('pending sync remains inert unless explicitly enabled', async () => {
  for (const flag of ['', 'false', 'TRUE', '1']) await withEnv({ GHL_PAYMENT_SYNC_ENABLED: flag }, async () => {
    const calls = []; const response = await load({ calls, configured: false }).GET(request());
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { enabled: false }); assert.equal(calls.length, 0);
  });
});
test('pending sync stops at invalid provider configuration without exposing its details', () => withEnv({}, async () => {
  const calls = []; const response = await load({ calls, configured: false }).GET(request());
  assert.equal(response.status, 503); assert.equal(calls.length, 0); assert.ok(!(await response.text()).includes('private-config'));
}));
test('pending sync requires storage before accessing the queue', () => withEnv({ DATABASE_URL: '' }, async () => {
  const calls = []; const response = await load({ calls }).GET(request());
  assert.equal(response.status, 503); assert.equal(calls.length, 0);
}));
test('pending sync passes the same configured scope to one bounded dispatch and provider callback', () => withEnv({}, async () => {
  const calls = [], deliveries = []; const job = { id: 'qa-pending-job', marketId: 'qa-market' };
  const route = load({ calls, deliveries, dispatch: async deliver => { await deliver(job); return counts; } });
  const response = await route.GET(request());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), counts);
  assert.equal(calls.length, 1); assert.equal(calls[0][1], config); assert.deepEqual(calls[0][2], { limit: 1 });
  assert.deepEqual(deliveries, [[job, config]]); assert.equal(route.maxDuration, 60);
  assert.equal(route.runtime, 'nodejs'); assert.equal(route.dynamic, 'force-dynamic');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
}));
test('pending sync sanitizes database/provider failures without a second dispatch', () => withEnv({}, async () => {
  const calls = []; const response = await load({ calls, dispatch: async () => { throw new Error('private-database-url'); } }).GET(request());
  assert.equal(response.status, 503); assert.equal(calls.length, 1);
  assert.deepEqual(await response.json(), { error: 'Payment pending sync is unavailable.' });
}));
