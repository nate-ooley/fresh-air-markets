const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
function load({ calls, configured = true }) {
  const filename = path.resolve(__dirname, '../src/app/api/internal/cron/application-review-outbox/route.ts');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = module.paths;
  mod.require = id => {
    if (id === '@/lib/cron-auth') return require('../.test-build/cron-auth.js');
    if (id === '@/lib/application-review-pg') return {
      dispatchApplicationReviewOutbox: async (deliver, options) => {
        calls.push(options);
        await deliver({ id: 'exact-job' });
        return { delivered: 1, deferred: 0, failed: 0, stale: 0 };
      },
    };
    if (id === '@/lib/ghl-application-review-delivery') return {
      applicationReviewDeliveryConfigured: () => configured,
      readApplicationReviewDeliveryConfig: () => ({ pipelineId: 'qa-pipeline' }),
      deliverApplicationReviewToGhl: async (message, config) => {
        assert.equal(message.id, 'exact-job');
        assert.equal(config.pipelineId, 'qa-pipeline');
      },
    };
    return require(id);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}
const secret = 'q'.repeat(32);
const request = authorized => new Request('https://qa.example/api/internal/cron/application-review-outbox', {
  headers: authorized ? { authorization: `Bearer ${secret}` } : {},
});
async function withEnv(fn) {
  const before = { CRON_SECRET: process.env.CRON_SECRET, DATABASE_URL: process.env.DATABASE_URL };
  Object.assign(process.env, { CRON_SECRET: secret, DATABASE_URL: 'qa-storage-not-a-credential' });
  try { await fn(); } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
test('review cron claims one job so five slow QA provider calls cannot age a later job lease', () => withEnv(async () => {
  const calls = []; const route = load({ calls });
  const response = await route.GET(request(true));
  assert.equal(route.maxDuration, 60);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ limit: 1, leaseSeconds: 60 }]);
  assert.deepEqual(await response.json(), { delivered: 1, deferred: 0, failed: 0, stale: 0 });
}));
test('review cron does not claim work without authentication and verified delivery configuration', () => withEnv(async () => {
  for (const [authorized, configured, status] of [[false, true, 401], [true, false, 503]]) {
    const calls = [];
    const response = await load({ calls, configured }).GET(request(authorized));
    assert.equal(response.status, status);
    assert.equal(calls.length, 0);
  }
}));
