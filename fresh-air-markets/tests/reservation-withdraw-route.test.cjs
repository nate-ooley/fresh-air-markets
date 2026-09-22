const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const reservationId = '44444444-4444-4444-8444-444444444444';
const applicationId = '33333333-3333-4333-8333-333333333333';
const env = { DATABASE_URL: 'postgres://unit-test.invalid/db', FAME_MARKET_ACCOUNT_ID: 'fame-market', FAME_SEASON_ID: '2026-2027', FAME_BOOTH_CAPACITY: '55', FAME_VENDOR_PORTAL_ORIGIN: 'https://freshairmarketsandevents.com', VERCEL: '1', VERCEL_ENV: 'production', SQUARE_ENVIRONMENT: 'production', SQUARE_ALLOW_LIVE_PAYMENTS: 'true', SQUARE_ACCESS_TOKEN: 'EAAA-unit', SQUARE_LOCATION_ID: 'L1', SQUARE_MERCHANT_ID: 'M1', SQUARE_WEBHOOK_SIGNATURE_KEY: 'sig', SQUARE_WEBHOOK_URL: 'https://freshairmarketsandevents.com/api/payments/square/webhook' };

function loadRoute(file, { session = 'fame-market', withdraw = {}, notifications = {}, square = {} } = {}) {
  const filename = path.resolve(__dirname, `../src/app/api/admin/${file}/withdraw/route.ts`);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/auth') return { getSessionAccountId: async () => session };
    if (id === '@/lib/reservation-withdraw-pg') return withdraw;
    if (id === '@/lib/notifications') return { notifyBookingWithdrawn: async () => 'sent', notifyApplicationWithdrawn: async () => 'sent', ...notifications };
    if (id === '@/lib/square') return { ...require('../.test-build/square.js'), ...square };
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
const post = (url, body, headers = {}) => new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://freshairmarketsandevents.com', ...headers }, body: JSON.stringify(body) });
const params = id => ({ params: Promise.resolve({ id }) });
const reservationUrl = `https://freshairmarketsandevents.com/api/admin/reservations/${reservationId}/withdraw`;
const applicationUrl = `https://freshairmarketsandevents.com/api/admin/applications/${applicationId}/withdraw`;

test('booking withdraw needs a manager, same origin and a note; cancels the Square link through the store', () => withEnv(env, async () => {
  const calls = [];
  const deletes = [];
  const route = loadRoute('reservations/[id]', {
    withdraw: { withdrawReservation: async input => { calls.push(input); await input.deleteLink('PL1'); return { kind: 'withdrawn', reservationId, linksCancelled: 1 }; } },
    square: { deleteSquarePaymentLink: async (config, id) => { deletes.push([config.environment, id]); return { kind: 'deleted', paymentLinkId: id, cancelledOrderId: 'O1' }; } },
  });
  assert.equal((await loadRoute('reservations/[id]', { session: null }).POST(post(reservationUrl, { note: 'x' }), params(reservationId))).status, 401);
  assert.equal((await route.POST(post(reservationUrl, { note: 'x' }, { origin: 'https://evil.example' }), params(reservationId))).status, 403);
  assert.equal((await route.POST(post(reservationUrl, { note: 'x' }, { 'sec-fetch-site': 'cross-site' }), params(reservationId))).status, 403);
  assert.equal((await route.POST(post(reservationUrl, { note: 'x' }), params('bad id'))).status, 400);
  const noNote = await route.POST(post(reservationUrl, { note: '   ' }), params(reservationId));
  assert.equal(noNote.status, 400);
  assert.match((await noNote.json()).error, /short note/);
  assert.equal(calls.length, 0);
  const ok = await route.POST(post(reservationUrl, { note: 'Vendor asked for spring only.' }), params(reservationId));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { reservation: { id: reservationId, state: 'cancelled' }, linksCancelled: 1, vendorNotification: 'sent' });
  assert.equal(calls[0].marketId, 'fame-market');
  assert.equal(calls[0].reservationId, reservationId);
  assert.equal(calls[0].note, 'Vendor asked for spring only.');
  assert.deepEqual(deletes, [['production', 'PL1']]);
}));

test('booking withdraw maps every store outcome to a manager-readable answer', () => withEnv(env, async () => {
  const run = async result => {
    const route = loadRoute('reservations/[id]', { withdraw: { withdrawReservation: async () => result } });
    const response = await route.POST(post(reservationUrl, { note: 'Vendor asked.' }), params(reservationId));
    return [response.status, (await response.json()).error];
  };
  assert.deepEqual((await run({ kind: 'not_found' }))[0], 404);
  const paid = await run({ kind: 'not_withdrawable', state: 'paid' });
  assert.equal(paid[0], 409); assert.match(paid[1], /Refund it in Square/);
  const cancelled = await run({ kind: 'not_withdrawable', state: 'cancelled' });
  assert.equal(cancelled[0], 409); assert.match(cancelled[1], /already cancelled/);
  const closing = await run({ kind: 'link_closing' });
  assert.equal(closing[0], 409); assert.match(closing[1], /few minutes/);
  const square = await run({ kind: 'square_unavailable' });
  assert.equal(square[0], 503); assert.match(square[1], /Nothing was changed/);
  const broken = loadRoute('reservations/[id]', { withdraw: { withdrawReservation: async () => { throw new Error('db'); } } });
  assert.equal((await broken.POST(post(reservationUrl, { note: 'x' }), params(reservationId))).status, 503);
  await withEnv({ FAME_MARKET_ACCOUNT_ID: 'other-market' }, async () => {
    assert.equal((await broken.POST(post(reservationUrl, { note: 'x' }), params(reservationId))).status, 503);
  });
}));

test('application withdraw releases every unpaid booking first and refuses while a paid booking exists', () => withEnv(env, async () => {
  const withdrawn = [];
  let recorded = null;
  const route = loadRoute('applications/[id]', { withdraw: {
    applicationBookingSummary: async () => ({ paidOrConfirmed: 0, unpaid: ['r1', 'r2'] }),
    withdrawReservation: async input => { withdrawn.push(input.reservationId); return { kind: 'withdrawn', reservationId: input.reservationId, linksCancelled: 0 }; },
    withdrawApplication: async input => { recorded = input; return { kind: 'withdrawn', applicationId, fromState: 'approved' }; },
  } });
  assert.equal((await loadRoute('applications/[id]', { session: null }).POST(post(applicationUrl, { note: 'x' }), params(applicationId))).status, 401);
  assert.equal((await route.POST(post(applicationUrl, { note: 'x' }), params('nope'))).status, 400);
  assert.equal((await route.POST(post(applicationUrl, { note: '' }), params(applicationId))).status, 400);
  const ok = await route.POST(post(applicationUrl, { note: 'Out for the season.' }), params(applicationId));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { application: { id: applicationId, reviewState: 'withdrawn' }, bookingsWithdrawn: 2, vendorNotification: 'sent' });
  assert.deepEqual(withdrawn, ['r1', 'r2']);
  assert.equal(recorded.actorAccountId, 'fame-market');
  assert.equal(recorded.note, 'Out for the season.');

  const paid = loadRoute('applications/[id]', { withdraw: {
    applicationBookingSummary: async () => ({ paidOrConfirmed: 1, unpaid: [] }),
    withdrawReservation: async () => { throw new Error('must not run'); },
    withdrawApplication: async () => { throw new Error('must not run'); },
  } });
  const blocked = await paid.POST(post(applicationUrl, { note: 'x' }), params(applicationId));
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /paid booking/);

  const already = loadRoute('applications/[id]', { withdraw: {
    applicationBookingSummary: async () => ({ paidOrConfirmed: 0, unpaid: [] }),
    withdrawApplication: async () => ({ kind: 'already_withdrawn' }),
  } });
  assert.equal((await already.POST(post(applicationUrl, { note: 'x' }), params(applicationId))).status, 409);

  const squareDown = loadRoute('applications/[id]', { withdraw: {
    applicationBookingSummary: async () => ({ paidOrConfirmed: 0, unpaid: ['r1'] }),
    withdrawReservation: async () => ({ kind: 'square_unavailable' }),
    withdrawApplication: async () => { throw new Error('must not run'); },
  } });
  assert.equal((await squareDown.POST(post(applicationUrl, { note: 'x' }), params(applicationId))).status, 503);
}));
