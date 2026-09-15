const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const reservationId = '44444444-4444-4444-8444-444444444444';
const env = { DATABASE_URL: 'postgres://unit-test.invalid/db', FAME_MARKET_ACCOUNT_ID: 'fame-market', FAME_SEASON_ID: '2026-2027', FAME_BOOTH_CAPACITY: '55', FAME_VENDOR_PORTAL_ORIGIN: 'https://freshairmarketsandevents.com', VERCEL: '1', VERCEL_ENV: 'production', SQUARE_ENVIRONMENT: 'production', SQUARE_ALLOW_LIVE_PAYMENTS: 'true' };

function loadRoute({ session = 'fame-market', reopen } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/reservations/[id]/reopen/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/auth') return { getSessionAccountId: async () => session };
    if (id === '@/lib/final-reservation-pg') return { ...require('../.test-build/final-reservation-pg.js'), reopenExpiredReservation: reopen };
    if (id.startsWith('@/lib/')) return require('../.test-build/' + id.slice(6) + '.js');
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}
function withEnv(patch, run) {
  const saved = { ...process.env };
  Object.assign(process.env, patch);
  return run().finally(() => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); });
}
const post = (headers = {}) => new NextRequest(`https://freshairmarketsandevents.com/api/admin/reservations/${reservationId}/reopen`, { method: 'POST', headers });
const params = (id = reservationId) => ({ params: Promise.resolve({ id }) });

test('reopen needs a manager session and a same-origin request, and maps every outcome', () => withEnv(env, async () => {
  const calls = [];
  const reopened = { id: reservationId, state: 'held', finalDates: ['2026-10-03'], finalBoothQuantity: 1, totalCents: 4000 };
  const route = loadRoute({ reopen: async input => { calls.push(input); return { kind: 'reopened', reservation: reopened }; } });
  assert.equal((await loadRoute({ session: null, reopen: async () => { throw new Error('no'); } }).POST(post(), params())).status, 401);
  assert.equal((await route.POST(post({ origin: 'https://evil.example' }), params())).status, 403);
  assert.equal((await route.POST(post({ 'sec-fetch-site': 'cross-site' }), params())).status, 403);
  assert.equal((await route.POST(post(), params('bad id'))).status, 400);
  assert.equal(calls.length, 0);
  const ok = await route.POST(post({ origin: 'https://freshairmarketsandevents.com' }), params());
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).reservation, reopened);
  assert.equal(calls[0].marketId, 'fame-market');
  assert.equal(calls[0].reservationId, reservationId);
  assert.equal(calls[0].config.boothCapacity, 55);
  assert.equal((await loadRoute({ reopen: async () => ({ kind: 'not_found' }) }).POST(post(), params())).status, 404);
  const busy = await loadRoute({ reopen: async () => ({ kind: 'not_expired', state: 'payment_pending' }) }).POST(post(), params());
  assert.equal(busy.status, 409);
  assert.match((await busy.json()).error, /payment pending/);
  const full = await loadRoute({ reopen: async () => ({ kind: 'unavailable', unavailableDates: ['2026-10-03'] }) }).POST(post(), params());
  assert.equal(full.status, 409);
  assert.deepEqual((await full.json()).unavailableDates, ['2026-10-03']);
  assert.equal((await loadRoute({ reopen: async () => { throw new Error('db'); } }).POST(post(), params())).status, 503);
  await withEnv({ FAME_MARKET_ACCOUNT_ID: 'other-market' }, async () => {
    assert.equal((await route.POST(post(), params())).status, 503);
  });
}));
