const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const { createApplicationLinkToken, verifyApplicationLinkToken } = require('../.test-build/application-upload-token.js');

const applicationId = '33333333-3333-4333-8333-333333333333';
const requestId = '55555555-5555-4555-8555-555555555555';
const reservationId = '44444444-4444-4444-8444-444444444444';
const origin = 'https://freshairmarketsandevents.com';
const env = { DATABASE_URL: 'postgres://unit-test.invalid/db', FAME_MARKET_ACCOUNT_ID: 'fame-market', FAME_SEASON_ID: '2026-2027', FAME_BOOTH_CAPACITY: '55', FAME_VENDOR_PORTAL_ORIGIN: origin, VERCEL: '1', VERCEL_ENV: 'production', SQUARE_ENVIRONMENT: 'production', SQUARE_ALLOW_LIVE_PAYMENTS: 'true', SQUARE_ACCESS_TOKEN: 'EAAA-unit', SQUARE_LOCATION_ID: 'L1', SQUARE_MERCHANT_ID: 'M1', SQUARE_WEBHOOK_SIGNATURE_KEY: 'sig', SQUARE_WEBHOOK_URL: `${origin}/api/payments/square/webhook` };

function load(file, mocks = {}) {
  const filename = path.resolve(__dirname, `../src/app/api/${file}/route.ts`);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  mod.require = (id) => {
    if (id in mocks) return mocks[id];
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
const json = (url, body, headers = {}) => new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body) });
const params = id => ({ params: Promise.resolve({ id }) });
const limiter = { '@/lib/inquiry-rate-limit': { consumeInquiryLimit: async () => ({ allowed: true }), inquiryClient: () => 'unit' } };

test('booking link tokens are purpose-bound: an upload link cannot act as a booking link and vice versa', () => {
  const booking = createApplicationLinkToken('booking', applicationId, 'fame-market', {}, 1_000, 60_000);
  const upload = createApplicationLinkToken('upload', applicationId, 'fame-market', {}, 1_000, 60_000);
  assert.deepEqual(verifyApplicationLinkToken('booking', booking, {}, 2_000), { applicationId, marketId: 'fame-market' });
  assert.equal(verifyApplicationLinkToken('booking', upload, {}, 2_000), null);
  assert.equal(verifyApplicationLinkToken('upload', booking, {}, 2_000), null);
  assert.equal(verifyApplicationLinkToken('booking', booking, {}, 70_000), null);
});

test('vendor booking page reads only with a valid booking token and never returns the application id or email', () => withEnv(env, async () => {
  const token = createApplicationLinkToken('booking', applicationId, 'fame-market');
  const overview = { applicationId, businessName: 'Val Crafts', vendorName: 'Val', email: 'val@example.org', eligible: true, reasons: [], profile: { applicantType: 'Vendor', vendorCategory: 'Arts & Crafts', foodLicenseRequired: false, boothsPerMarket: 1, fromBooking: true }, insuranceExpiresOn: null, bookings: [], pendingRequest: null, days: [] };
  const calls = [];
  const route = load('vendor/booking', { ...limiter, '@/lib/vendor-booking-pg': { vendorBookingOverview: async input => { calls.push(input); return overview; }, createBookingRequest: async () => { throw new Error('no'); }, marketToday: () => '2026-09-22' }, '@/lib/notifications': {} });
  const bad = await route.GET(new NextRequest(`${origin}/api/vendor/booking?token=nope`));
  assert.equal(bad.status, 401);
  const foreign = createApplicationLinkToken('booking', applicationId, 'other-market');
  assert.equal((await route.GET(new NextRequest(`${origin}/api/vendor/booking?token=${foreign}`))).status, 401);
  const ok = await route.GET(new NextRequest(`${origin}/api/vendor/booking?token=${token}`));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.businessName, 'Val Crafts');
  assert.equal(body.applicationId, undefined);
  assert.equal(body.email, undefined);
  assert.equal(calls[0].applicationId, applicationId);
  assert.equal(calls[0].today, '2026-09-22');
}));

test('vendor booking request maps store outcomes and emails vendor and staff on success', () => withEnv(env, async () => {
  const token = createApplicationLinkToken('booking', applicationId, 'fame-market');
  const notified = [];
  const make = result => load('vendor/booking', { ...limiter,
    '@/lib/vendor-booking-pg': { vendorBookingOverview: async () => null, createBookingRequest: async input => { notified.push(['create', input.dates, input.booths, input.note]); return result; }, marketToday: () => '2026-09-22' },
    '@/lib/notifications': { notifyBookingRequest: async input => { notified.push(['email', input.requestId, input.dates]); return 'sent'; } },
  });
  const request = { id: requestId, applicationId, dates: ['2026-11-07'], booths: 1, vendorNote: 'hi', status: 'pending', reservationId: null, staffNote: null, createdAt: '2026-09-22T12:00:00.000Z', decidedAt: null };
  assert.equal((await make({ kind: 'created', request }).POST(json(`${origin}/api/vendor/booking`, { token: 'bad', dates: ['2026-11-07'], booths: 1 }))).status, 401);
  assert.equal((await make({ kind: 'created', request }).POST(json(`${origin}/api/vendor/booking`, { token, dates: ['2026-11-07'], booths: 1 }, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal(notified.length, 0);
  const created = await make({ kind: 'created', request }).POST(json(`${origin}/api/vendor/booking`, { token, dates: ['2026-11-07'], booths: 1, note: 'hi' }));
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { request, vendorNotification: 'sent' });
  assert.deepEqual(notified, [['create', ['2026-11-07'], 1, 'hi'], ['email', requestId, ['2026-11-07']]]);
  const invalid = await make({ kind: 'invalid', problems: ['2026-11-07 is already in one of your bookings.'] }).POST(json(`${origin}/api/vendor/booking`, { token, dates: ['2026-11-07'], booths: 1 }));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /already in one of your bookings/);
  assert.equal((await make({ kind: 'already_pending', request }).POST(json(`${origin}/api/vendor/booking`, { token, dates: ['2026-11-07'], booths: 1 }))).status, 409);
  assert.equal((await make({ kind: 'not_eligible', reasons: ['insurance_not_approved'] }).POST(json(`${origin}/api/vendor/booking`, { token, dates: ['2026-11-07'], booths: 1 }))).status, 409);
  assert.equal((await make({ kind: 'not_found' }).POST(json(`${origin}/api/vendor/booking`, { token, dates: ['2026-11-07'], booths: 1 }))).status, 401);
}));

test('staff decline needs a manager, same origin and a note, and emails the vendor', () => withEnv(env, async () => {
  const emails = [];
  const request = { id: requestId, applicationId, dates: ['2026-11-07'], booths: 1, vendorNote: '', status: 'declined', reservationId: null, staffNote: 'Full', createdAt: '2026-09-22T12:00:00.000Z', decidedAt: '2026-09-22T13:00:00.000Z' };
  const make = ({ session = 'fame-market', settle } = {}) => load('admin/booking-requests/[id]/decline', {
    '@/lib/auth': { getSessionAccountId: async () => session },
    '@/lib/vendor-booking-pg': { settleBookingRequest: settle ?? (async input => { emails.push(['settle', input.status, input.staffNote]); return { kind: 'settled', request }; }), getBookingRequest: async () => request },
    '@/lib/notifications': { notifyBookingRequestDeclined: async input => { emails.push(['email', input.note, input.dates]); return 'sent'; } },
  });
  const url = `${origin}/api/admin/booking-requests/${requestId}/decline`;
  assert.equal((await make({ session: null }).POST(json(url, { note: 'Full' }), params(requestId))).status, 401);
  assert.equal((await make().POST(json(url, { note: 'Full' }, { origin: 'https://evil.example' }), params(requestId))).status, 403);
  assert.equal((await make().POST(json(url, { note: '' }), params(requestId))).status, 400);
  assert.equal((await make().POST(json(url, { note: 'Full' }), params('nope'))).status, 400);
  assert.equal(emails.length, 0);
  const ok = await make().POST(json(url, { note: 'Full' }), params(requestId));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { request, vendorNotification: 'sent' });
  assert.deepEqual(emails, [['settle', 'declined', 'Full'], ['email', 'Full', ['2026-11-07']]]);
  assert.equal((await make({ settle: async () => ({ kind: 'not_found' }) }).POST(json(url, { note: 'Full' }), params(requestId))).status, 404);
  assert.equal((await make({ settle: async () => ({ kind: 'not_pending', status: 'confirmed' }) }).POST(json(url, { note: 'Full' }), params(requestId))).status, 409);
}));

test('staff confirm reserves the requested dates with the vendor profile, creates checkout, emails the link, and reports partial progress', () => withEnv(env, async () => {
  const request = { id: requestId, applicationId, dates: ['2026-11-07', '2026-11-21'], booths: 2, vendorNote: '', status: 'pending', reservationId: null, staffNote: null, createdAt: '2026-09-22T12:00:00.000Z', decidedAt: null };
  const profile = { applicantType: 'Vendor', vendorCategory: 'Arts & Crafts', foodLicenseRequired: false, boothsPerMarket: 1, fromBooking: true };
  const reservation = { id: reservationId, state: 'held', paymentRequired: true, totalCents: 16000, finalDates: request.dates, finalBoothQuantity: 2, quoteVersion: 'v1' };
  const order = { id: 'order-1', checkoutUrl: 'https://square.link/u/abc', paymentDueAt: '2026-09-24T12:00:00.000Z', status: 'checkout_created' };
  const log = [];
  const make = (overrides = {}) => load('admin/booking-requests/[id]/confirm', {
    '@/lib/auth': { getSessionAccountId: async () => 'fame-market' },
    '@/lib/vendor-booking-pg': {
      getBookingRequest: async () => overrides.request ?? request,
      vendorBookingOverview: async () => ({ applicationId, profile, eligible: true, reasons: [], insuranceExpiresOn: null, bookings: [], pendingRequest: request, days: [] }),
      settleBookingRequest: async input => { log.push(['settle', input.status, input.reservationId]); return { kind: 'settled', request: { ...request, status: 'confirmed' } }; },
      marketToday: () => '2026-09-22',
    },
    '@/lib/final-reservation-pg': { ...require('../.test-build/final-reservation-pg.js'), reserveFinalApplication: async input => { log.push(['reserve', input.selection.selectedDates, input.selection.boothsPerMarket, input.selection.vendorCategory, input.selection.applicantType, input.selection.foodLicenseRequired]); return overrides.reserve ?? { kind: 'created', reservation }; } },
    '@/lib/square': { ...require('../.test-build/square.js'), verifySquareIdentity: async () => ({ environment: 'production', merchantId: 'M1', locationId: 'L1' }) },
    '@/lib/square-payment': { dispatchSquareCheckout: async input => { log.push(['checkout', input.reservationId]); return overrides.checkout ?? { kind: 'created', order }; } },
    '@/lib/square-payment-pg': { postgresSquarePaymentCheckoutStore: {} },
    '@/lib/vendor-payment-access': { ...require('../.test-build/vendor-payment-access.js'), issueVendorPaymentInvitation: async input => { log.push(['access', input.reservationId]); return overrides.access ?? { kind: 'issued', invitationToken: 't', invitationUrl: `${origin}/vendor/payment#token=t`, expiresAt: '2026-09-24T12:00:00.000Z' }; } },
    '@/lib/vendor-payment-access-pg': { postgresVendorPaymentAccessStore: {} },
    '@/lib/notifications': { notifyPaymentRequest: async input => { log.push(['email', input.reservationId]); return 'sent'; } },
  });
  const url = `${origin}/api/admin/booking-requests/${requestId}/confirm`;
  const ok = await make().POST(json(url, {}), params(requestId));
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.deepEqual(body.reservation, { ...reservation, state: 'payment_pending' });
  assert.deepEqual(body.paymentOrder, order);
  assert.equal(body.vendorNotification, 'sent');
  assert.deepEqual(log, [
    ['reserve', ['2026-11-07', '2026-11-21'], 2, 'Arts & Crafts', 'Vendor', false],
    ['settle', 'confirmed', reservationId],
    ['checkout', reservationId], ['access', reservationId], ['email', reservationId],
  ]);
  log.length = 0;
  // Staff may override type/category for a first booking.
  await make().POST(json(url, { vendorCategory: 'Baked Goods', foodLicenseRequired: true }), params(requestId));
  assert.deepEqual(log[0], ['reserve', ['2026-11-07', '2026-11-21'], 2, 'Baked Goods', 'Vendor', true]);
  log.length = 0;
  // Already settled, missing, or refused by the writer: nothing later runs.
  assert.equal((await make({ request: { ...request, status: 'declined' } }).POST(json(url, {}), params(requestId))).status, 409);
  const overlap = await make({ reserve: { kind: 'overlap', dates: ['2026-11-07'] } }).POST(json(url, {}), params(requestId));
  assert.equal(overlap.status, 409);
  assert.match((await overlap.json()).error, /already holds 2026-11-07/);
  const expiry = await make({ reserve: { kind: 'insurance_expires', expiresOn: '2026-11-10', dates: ['2026-11-21'] } }).POST(json(url, {}), params(requestId));
  assert.equal(expiry.status, 409);
  assert.match((await expiry.json()).error, /expires on 2026-11-10/);
  assert.ok(!log.some(entry => entry[0] === 'settle' || entry[0] === 'checkout'));
  log.length = 0;
  // Reserved but Square failed: the booking stands, the request is settled, and the response points at the next button.
  const partial = await make({ checkout: { kind: 'retry_scheduled' } }).POST(json(url, {}), params(requestId));
  assert.equal(partial.status, 503);
  const partialBody = await partial.json();
  assert.deepEqual(partialBody.reservation, reservation);
  assert.equal(partialBody.step, 'Create payment request');
  assert.deepEqual(log.map(e => e[0]), ['reserve', 'settle', 'checkout']);
}));
