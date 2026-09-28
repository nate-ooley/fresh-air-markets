const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const origin = 'https://freshairmarketsandevents.com';
const env = { DATABASE_URL: 'postgres://unit-test.invalid/db', FAME_MARKET_ACCOUNT_ID: 'fame-market', FAME_SEASON_ID: '2026-2027', FAME_BOOTH_CAPACITY: '55', FAME_VENDOR_PORTAL_ORIGIN: origin, VERCEL: '1', VERCEL_ENV: 'production', SQUARE_ENVIRONMENT: 'production', SQUARE_ALLOW_LIVE_PAYMENTS: 'true', SQUARE_ACCESS_TOKEN: 'EAAA-unit', SQUARE_LOCATION_ID: 'L1', SQUARE_MERCHANT_ID: 'M1', SQUARE_WEBHOOK_SIGNATURE_KEY: 'sig', SQUARE_WEBHOOK_URL: `${origin}/api/payments/square/webhook` };
const rows = [
  { id: 'r-pending', state: 'payment_pending', total_cents: 4000, business: 'KC Candles', email: 'kc@vendor.org' },
  { id: 'r-held', state: 'held', total_cents: 105000, business: 'Blue Akoya', email: 'blue@vendor.org' },
  { id: 'r-expired', state: 'expired', total_cents: 105000, business: 'Holy Coney', email: 'holy@vendor.org' },
  { id: 'r-full', state: 'expired', total_cents: 8000, business: 'No Room', email: 'full@vendor.org' },
  { id: 'r-test', state: 'expired', total_cents: 8000, business: 'Site Test Bakery', email: 'site-test@example.com' },
];

function load({ session = 'fame-market', log = [] } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/payments/reminders/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  const sql = () => Promise.resolve(rows);
  mod.require = (id) => {
    if (id === 'postgres') return { __esModule: true, default: () => sql };
    if (id === '@/lib/auth') return { getSessionAccountId: async () => session };
    if (id === '@/lib/final-reservation-pg') return { ...require('../.test-build/final-reservation-pg.js'), reopenExpiredReservation: async input => { log.push(['reopen', input.reservationId]); return input.reservationId === 'r-full' ? { kind: 'unavailable', unavailableDates: ['2026-10-03'] } : { kind: 'reopened', reservation: {} }; } };
    if (id === '@/lib/square') return { ...require('../.test-build/square.js'), verifySquareIdentity: async () => ({ merchantId: 'M1', locationId: 'L1' }) };
    if (id === '@/lib/square-payment') return { dispatchSquareCheckout: async input => { log.push(['checkout', input.reservationId]); return { kind: input.reservationId === 'r-pending' ? 'existing' : 'created', order: { id: 'o', status: 'checkout_created' } }; } };
    if (id === '@/lib/square-payment-pg') return { postgresSquarePaymentCheckoutStore: {} };
    if (id === '@/lib/vendor-payment-access') return { ...require('../.test-build/vendor-payment-access.js'), issueVendorPaymentInvitation: async input => { log.push(['link', input.reservationId]); return { kind: 'issued', invitationToken: 't', invitationUrl: `${origin}/vendor/payment#token=t`, expiresAt: '2027-09-28T00:00:00.000Z' }; } };
    if (id === '@/lib/vendor-payment-access-pg') return { postgresVendorPaymentAccessStore: {} };
    if (id === '@/lib/notifications') return { notifyPaymentRequest: async input => { log.push(['email', input.reservationId, input.reminder]); return 'sent'; } };
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
const request = (method, headers = {}) => new NextRequest(`${origin}/api/admin/payments/reminders`, { method, headers: { origin, ...headers } });

test('payment reminders need a manager and same origin, skip test addresses, and send one reminder per unpaid booking', () => withEnv(env, async () => {
  assert.equal((await load({ session: null }).GET(request('GET'))).status, 401);
  assert.equal((await load().POST(request('POST', { origin: 'https://evil.example' }))).status, 403);
  const listed = await (await load().GET(request('GET'))).json();
  assert.deepEqual(listed.unpaid.map(row => row.reservationId), ['r-pending', 'r-held', 'r-expired', 'r-full']);
  const log = [];
  const response = await load({ log }).POST(request('POST'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sent, 3);
  assert.deepEqual(body.results.map(row => [row.reservationId, row.outcome]), [['r-pending', 'sent'], ['r-held', 'sent'], ['r-expired', 'sent'], ['r-full', 'skipped']]);
  assert.match(body.results[3].detail, /No room left on 2026-10-03/);
  assert.deepEqual(log, [
    ['checkout', 'r-pending'], ['link', 'r-pending'], ['email', 'r-pending', true],
    ['checkout', 'r-held'], ['link', 'r-held'], ['email', 'r-held', true],
    ['reopen', 'r-expired'], ['checkout', 'r-expired'], ['link', 'r-expired'], ['email', 'r-expired', true],
    ['reopen', 'r-full'],
  ]);
}));
