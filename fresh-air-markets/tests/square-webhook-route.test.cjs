const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const NEW = 'https://freshairmarketsandevents.com/api/payments/square/webhook';
const production = {
  VERCEL: '1', VERCEL_ENV: 'production', FAME_MARKET_ACCOUNT_ID: 'fame-market', FAME_VENDOR_PORTAL_ORIGIN: 'https://freshairmarketsandevents.com',
  SQUARE_ENVIRONMENT: 'production', SQUARE_ALLOW_LIVE_PAYMENTS: 'true', SQUARE_ACCESS_TOKEN: 'tok', SQUARE_LOCATION_ID: 'L1', SQUARE_MERCHANT_ID: 'M1',
  SQUARE_WEBHOOK_SIGNATURE_KEY: 'sig', SQUARE_WEBHOOK_URL: NEW,
};

function loadRoute({ session = 'fame-market', sync } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/square/webhook/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/auth') return { getSessionAccountId: async () => session };
    if (id === '@/lib/seed') return { DEMO_MARKET_ID: 'demo-market' };
    if (id === '@/lib/square-webhook-subscription') return { syncSquareWebhookSubscription: sync };
    if (id.startsWith('@/lib/')) return require('../.test-build/' + id.slice(6) + '.js');
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}

function withEnv(patch, run) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith('SQUARE_') || key.startsWith('FAME_') || key.startsWith('VERCEL')) delete process.env[key];
  Object.assign(process.env, patch);
  return run().finally(() => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); });
}

const request = (method, headers = {}) => new NextRequest('https://freshairmarketsandevents.com/api/admin/square/webhook', { method, headers });

test('webhook status and sync require the production manager session and a same-origin browser request', () => withEnv(production, async () => {
  let calls = [];
  const sync = async (config, expected, options) => { calls.push([config.accessToken, expected, options.apply]); return { expectedUrl: expected, subscription: null, inSync: false, updated: false, candidates: 0 }; };
  assert.equal((await loadRoute({ session: null, sync }).GET(request('GET'))).status, 401);
  assert.equal((await loadRoute({ session: 'demo-market', sync }).GET(request('GET'))).status, 403);
  assert.equal((await loadRoute({ session: 'other-market', sync }).GET(request('GET'))).status, 403);
  assert.equal((await loadRoute({ sync }).POST(request('POST', { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await loadRoute({ sync }).POST(request('POST', { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal(calls.length, 0);
  const status = await loadRoute({ sync }).GET(request('GET'));
  assert.equal(status.status, 200);
  const apply = await loadRoute({ sync }).POST(request('POST', { origin: 'https://freshairmarketsandevents.com' }));
  assert.equal(apply.status, 200);
  assert.deepEqual(calls, [['tok', NEW, false], ['tok', NEW, true]]);
}));

test('webhook sync refuses outside production and answers 503 when Square is unreachable', async () => {
  const sync = async () => { throw new Error('boom'); };
  await withEnv({ ...production, VERCEL_ENV: 'preview' }, async () => {
    assert.equal((await loadRoute({ sync }).POST(request('POST'))).status, 403);
  });
  await withEnv(production, async () => {
    assert.equal((await loadRoute({ sync }).POST(request('POST'))).status, 503);
  });
  await withEnv({ ...production, SQUARE_WEBHOOK_URL: undefined }, async () => {
    assert.equal((await loadRoute({ sync: async () => ({}) }).GET(request('GET'))).status, 503);
  });
});
