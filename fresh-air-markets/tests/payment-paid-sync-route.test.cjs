const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
function load({ dispatch = async () => ({ queued: 0, delivered: 0, deferred: 0, manual_review: 0, stale: 0 }), configured = true, calls } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/internal/cron/payment-paid-sync/route.ts');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = module.paths;
  mod.require = id => {
    if (id === '@/lib/cron-auth') return require('../.test-build/cron-auth.js');
    if (id === '@/lib/payment-paid-sync-pg') return { dispatchPaymentPaidSync: async (...args) => { if (calls) calls.push(args); return dispatch(...args); } };
    if (id === '@/lib/ghl-payment-paid-delivery') return {
      readPaymentPaidDeliveryConfig: () => { if (!configured) throw new Error('private-config'); return { marketId: 'qa-market' }; },
      deliverPaymentPaidToGhl: async () => {},
    };
    return require(id);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return mod.exports;
}
const request = authorized => new Request('https://qa.example/api/internal/cron/payment-paid-sync', { headers: authorized ? { authorization: `Bearer ${'q'.repeat(32)}` } : {} });
async function withEnv(overrides, fn) {
  const keys = ['CRON_SECRET', 'DATABASE_URL', 'GHL_PAYMENT_SYNC_ENABLED']; const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { CRON_SECRET: 'q'.repeat(32), DATABASE_URL: 'qa-storage-not-a-credential', GHL_PAYMENT_SYNC_ENABLED: 'true' }, overrides);
  try { await fn(); } finally { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } }
}
test('paid sync cron rejects unauthenticated requests before queue access', () => withEnv({}, async () => {
  const calls = []; const response = await load({ calls }).GET(request(false)); assert.equal(response.status, 401); assert.equal(calls.length, 0);
}));
test('paid sync cron is explicitly disabled and does not touch storage', () => withEnv({ GHL_PAYMENT_SYNC_ENABLED: 'false' }, async () => {
  const calls = []; const response = await load({ calls }).GET(request(true)); assert.deepEqual(await response.json(), { enabled: false }); assert.equal(calls.length, 0);
}));
test('paid sync cron stops at invalid configuration and hides private errors', () => withEnv({}, async () => {
  const calls = []; const response = await load({ calls, configured: false }).GET(request(true)); assert.equal(response.status, 503); assert.equal(calls.length, 0); assert.ok(!(await response.text()).includes('private-config'));
}));
test('paid sync cron runs only one job within the route time budget and returns counts with no-store', () => withEnv({}, async () => {
  const calls = []; const route = load({ calls }); const response = await route.GET(request(true)); assert.equal(response.status, 200); assert.equal(calls[0][2].limit, 1); assert.equal(route.maxDuration, 60); assert.equal(response.headers.get('cache-control'), 'private, no-store');
}));
test('paid sync cron exposes no database or provider diagnostics on failure', () => withEnv({}, async () => {
  const response = await load({ dispatch: async () => { throw new Error('private-database-url'); } }).GET(request(true)); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('private-database-url'));
}));
