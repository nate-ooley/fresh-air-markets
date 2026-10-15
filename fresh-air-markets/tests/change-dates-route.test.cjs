const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const origin = 'https://freshairmarketsandevents.com';
const env = { DATABASE_URL: 'postgres://unit-test.invalid/db', FAME_MARKET_ACCOUNT_ID: 'fame-market', FAME_SEASON_ID: '2026-2027', FAME_BOOTH_CAPACITY: '55', FAME_VENDOR_PORTAL_ORIGIN: origin, VERCEL: '1', VERCEL_ENV: 'production', SQUARE_ENVIRONMENT: 'production', SQUARE_ALLOW_LIVE_PAYMENTS: 'true', SQUARE_ACCESS_TOKEN: 'EAAA-unit', SQUARE_LOCATION_ID: 'L1', SQUARE_MERCHANT_ID: 'M1', SQUARE_WEBHOOK_SIGNATURE_KEY: 'sig', SQUARE_WEBHOOK_URL: `${origin}/api/payments/square/webhook` };
const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';
const okPlan = { kind: 'ok', applicationId: 'app-1', profile: { applicantType: 'Vendor', vendorCategory: 'Arts & Crafts', foodLicenseRequired: false },
  current: { dates: ['2026-11-07'], booths: 1, fullSeason: false }, quote: { dates: ['2026-10-24', '2026-10-31'], booths: 1, totalCents: 8000, rateCents: 4000, fullSeason: false } };
const created = { kind: 'created', reservation: { id: NEW, state: 'held', paymentRequired: true, totalCents: 8000, finalDates: ['2026-10-24', '2026-10-31'], finalBoothQuantity: 1, quoteVersion: 'v1' } };

function load({ session = 'fame-market', log = [], plan = okPlan, withdrawn = { kind: 'withdrawn', reservationId: OLD, linksCancelled: 1 }, reserved = [created] } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/reservations/[id]/change-dates/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  const reservations = [...reserved];
  mod.require = (id) => {
    if (id === '@/lib/auth') return { getSessionAccountId: async () => session };
    if (id === '@/lib/final-reservation-pg') return {
      ...require('../.test-build/final-reservation-pg.js'),
      planDateChange: async input => { log.push(['plan', input.reservationId, input.dates, input.booths]); return plan; },
      reserveFinalApplication: async input => { log.push(['reserve', input.selection.selectedDates, input.selection.fullSeason]); return reservations.shift() ?? { kind: 'unavailable', availability: [] }; },
    };
    if (id === '@/lib/reservation-withdraw-pg') return { withdrawReservation: async input => { log.push(['withdraw', input.reservationId, input.note]); return withdrawn; } };
    if (id === '@/lib/square-link-cancel') return { squareLinkCanceller: () => async () => 'cancelled' };
    if (id === '@/lib/square') return { ...require('../.test-build/square.js'), verifySquareIdentity: async () => ({ merchantId: 'M1', locationId: 'L1' }) };
    if (id === '@/lib/square-payment') return { ...require('../.test-build/square-payment.js'), dispatchSquareCheckout: async input => { log.push(['checkout', input.reservationId]); return { kind: 'created', order: { id: 'o', status: 'checkout_created', checkoutUrl: 'https://square.link/u/x', paymentDueAt: null } }; } };
    if (id === '@/lib/square-payment-pg') return { postgresSquarePaymentCheckoutStore: {} };
    if (id === '@/lib/vendor-booking-pg') return { marketToday: () => '2026-10-15' };
    if (id === '@/lib/vendor-payment-access') return { ...require('../.test-build/vendor-payment-access.js'), issueVendorPaymentInvitation: async input => { log.push(['link', input.reservationId]); return { kind: 'issued', invitationToken: 't', invitationUrl: `${origin}/vendor/payment#token=t`, expiresAt: '2027-10-15T00:00:00.000Z' }; } };
    if (id === '@/lib/vendor-payment-access-pg') return { postgresVendorPaymentAccessStore: {} };
    if (id === '@/lib/notifications') return { notifyBookingDatesChanged: async input => { log.push(['email', input.oldReservationId, input.newReservationId, input.note]); return 'sent'; } };
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
const call = (route, body, headers = {}, id = OLD) => route.POST(
  new NextRequest(`${origin}/api/admin/reservations/${id}/change-dates`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) });
const body = { dates: ['2026-10-31', '2026-10-24'], booths: 1, note: 'As we discussed.' };

test('change dates: check first, then withdraw, reserve, payment request, link and ONE email', () => withEnv(env, async () => {
  const log = [];
  const response = await call(load({ log }), body);
  assert.equal(response.status, 201);
  const json = await response.json();
  assert.equal(json.reservation.id, NEW);
  assert.equal(json.vendorNotification, 'sent');
  assert.deepEqual(log.map(entry => entry[0]), ['plan', 'withdraw', 'reserve', 'checkout', 'link', 'email']);
  assert.deepEqual(log[0], ['plan', OLD, ['2026-10-24', '2026-10-31'], 1]);
  assert.match(log[1][2], /^Dates changed to Oct 24, Oct 31\. As we discussed\.$/);
  assert.deepEqual(log[2], ['reserve', ['2026-10-24', '2026-10-31'], false]);
  assert.deepEqual(log[5], ['email', OLD, NEW, 'As we discussed.']);
}));

test('when the check fails nothing is withdrawn or reserved', () => withEnv(env, async () => {
  const cases = [
    [{ kind: 'unavailable', dates: ['2026-10-24'] }, 409, /No room left on Oct 24/],
    [{ kind: 'not_changeable', state: 'paid' }, 409, /paid/],
    [{ kind: 'same_dates' }, 409, /already the booking's dates/],
    [{ kind: 'past_dates', dates: ['2026-10-03'] }, 409, /already happened/],
    [{ kind: 'overlap', dates: ['2026-10-24'] }, 409, /another booking/],
    [{ kind: 'insurance_expires', expiresOn: '2026-10-20', dates: ['2026-10-24'] }, 409, /insurance/],
    [{ kind: 'not_found' }, 404, /not found/],
  ];
  for (const [plan, status, message] of cases) {
    const log = [];
    const response = await call(load({ log, plan }), body);
    assert.equal(response.status, status, plan.kind);
    assert.match((await response.json()).error, message);
    assert.deepEqual(log.map(entry => entry[0]), ['plan'], plan.kind);
  }
}));

test('if Square cannot prove the old link is dead, nothing new is booked', () => withEnv(env, async () => {
  const log = [];
  const response = await call(load({ log, withdrawn: { kind: 'cancellation_unproven', squareOrderId: 'SQ-1' } }), body);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /SQ-1/);
  assert.deepEqual(log.map(entry => entry[0]), ['plan', 'withdraw']);
}));

test('if a date is taken between the check and the write, the original dates are put back', () => withEnv(env, async () => {
  const log = [];
  const response = await call(load({ log, reserved: [{ kind: 'unavailable', availability: [] }, { kind: 'created', reservation: { id: 'restored' } }] }), body);
  assert.equal(response.status, 409);
  const json = await response.json();
  assert.equal(json.restored, true);
  assert.match(json.error, /original dates were put back/);
  assert.deepEqual(log.filter(entry => entry[0] === 'reserve').map(entry => entry[1]), [['2026-10-24', '2026-10-31'], ['2026-11-07']]);
  assert.equal(log.some(entry => entry[0] === 'email'), false);
}));

test('a retry after a half-finished change skips the withdraw and finishes the booking', () => withEnv(env, async () => {
  const log = [];
  const response = await call(load({ log, plan: { ...okPlan, resuming: true }, reserved: [{ ...created, kind: 'duplicate' }] }), body);
  assert.equal(response.status, 201);
  assert.deepEqual(log.map(entry => entry[0]), ['plan', 'reserve', 'checkout', 'link', 'email']);
}));

test('change dates needs a signed-in manager, same origin and a sensible body', () => withEnv(env, async () => {
  assert.equal((await call(load({ session: null }), body)).status, 401);
  assert.equal((await call(load(), body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(load(), body, {}, 'bad%20id')).status, 400);
  for (const bad of [{ booths: 1 }, { dates: [], booths: 1 }, { dates: ['2026-10-24'], booths: 0 }, { dates: ['2026-10-24'], booths: 11 }, { dates: [3], booths: 1 }, { dates: ['2026-10-24'], booths: 1, note: 'x'.repeat(501) }]) {
    const log = [];
    assert.equal((await call(load({ log }), bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    assert.deepEqual(log, []);
  }
}));
