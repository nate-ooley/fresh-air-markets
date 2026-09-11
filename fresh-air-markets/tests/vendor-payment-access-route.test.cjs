const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const access = require('../.test-build/vendor-payment-access.js');
const origin = 'https://qa-market.vercel.app';

function loadRoute(name, store = {}, actor = 'private-market') {
  const filename = path.resolve(__dirname, `../src/app/api/${name}/route.ts`);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = id => {
    if (id === '@/lib/auth') return { getSessionAccountId: async () => actor };
    if (id === '@/lib/vendor-payment-access') return access;
    if (id === '@/lib/vendor-payment-access-pg') return { postgresVendorPaymentAccessStore: store };
    if (id === '@/lib/square-payment') return require('../.test-build/square-payment.js');
    if (id === '@/lib/notifications') return { notifyPaymentRequest: async () => 'not_sent' };
    return require(id);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return mod.exports;
}

function request(pathname, body = {}, opts = {}) {
  return new NextRequest(origin + pathname, {
    method: opts.method || 'POST',
    headers: { origin, 'content-type': 'application/json', ...opts.headers },
    ...(opts.method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}
async function configured(fn) {
  const vars = { VERCEL: '1', VERCEL_ENV: 'preview', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ALLOW_LIVE_PAYMENTS: 'false', FAME_MARKET_ACCOUNT_ID: 'private-market', FAME_VENDOR_PORTAL_ORIGIN: origin, DATABASE_URL: 'postgres://unused-test-only' };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try { await fn(); } finally { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; }
}
const context = { params: Promise.resolve({ id: 'reservation-1' }) };

test('issuer requires private manager, same origin and exact empty JSON, never a caller-selected tenant', () => configured(async () => {
  let calls = 0;
  const store = { issue: async () => { calls++; return { kind: 'not_found' }; } };
  const route = actor => loadRoute('admin/reservations/[id]/access', store, actor);
  assert.equal((await route(null).POST(request('/api/admin/reservations/reservation-1/access'), context)).status, 401);
  assert.equal((await route('demo-market').POST(request('/api/admin/reservations/reservation-1/access'), context)).status, 403);
  assert.equal((await route('other-market').POST(request('/api/admin/reservations/reservation-1/access'), context)).status, 403);
  assert.equal((await route('private-market').POST(request('/api/admin/reservations/reservation-1/access', {}, { headers: { origin: 'https://evil.invalid' } }), context)).status, 403);
  assert.equal((await route('private-market').POST(request('/api/admin/reservations/reservation-1/access', { marketId: 'other', totalCents: 1 }), context)).status, 400);
  assert.equal(calls, 0);
}));

test('issuer returns one server-built fragment invitation, no-store, and accurate not-ready/errors without private details', () => configured(async () => {
  let input;
  const route = loadRoute('admin/reservations/[id]/access', { issue: async value => { input = value; return { kind: 'issued', expiresAt: '2026-10-03T12:00:00.000Z' }; } });
  const response = await route.POST(request('/api/admin/reservations/reservation-1/access'), context);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const body = await response.json();
  assert.equal(input.config.marketId, 'private-market');
  assert.equal(input.reservationId, 'reservation-1');
  assert.equal(body.invitationUrl, `${origin}/vendor/payment#token=${body.invitationToken}`);
  for (const [result, status] of [[{ kind: 'not_found' }, 404], [{ kind: 'not_eligible' }, 409]]) {
    assert.equal((await loadRoute('admin/reservations/[id]/access', { issue: async () => result }).POST(request('/api/admin/reservations/reservation-1/access'), context)).status, status);
  }
  const failed = await loadRoute('admin/reservations/[id]/access', { issue: async () => { throw new Error('secret connection password'); } }).POST(request('/api/admin/reservations/reservation-1/access'), context);
  assert.equal(failed.status, 503);
  assert.equal((await failed.text()).includes('password'), false);
}));

test('explicit invitation exchange sets a dedicated private cookie but never exposes session bearer in JSON', () => configured(async () => {
  let received;
  const route = loadRoute('vendor/access', { exchange: async input => { received = input; return { kind: 'exchanged', expiresAt: '2026-10-08T12:00:00.000Z' }; } });
  assert.equal(route.GET, undefined);
  const token = access.createVendorAccessToken();
  const response = await route.POST(request('/api/vendor/access', { token }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, expiresAt: '2026-10-08T12:00:00.000Z' });
  const cookie = response.cookies.get(access.VENDOR_PAYMENT_COOKIE);
  assert.equal(access.hashVendorAccessToken(cookie.value), received.sessionHash);
  assert.notEqual(cookie.value, token);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(response.headers.get('set-cookie'), /Secure/i);
  assert.match(response.headers.get('set-cookie'), /SameSite=lax/i);
  assert.match(response.headers.get('set-cookie'), /Path=\/api\/vendor/i);
  assert.equal((await route.POST(request('/api/vendor/access', { token }, { headers: { origin: 'https://evil.invalid' } }))).status, 403);
  assert.equal((await route.POST(request('/api/vendor/access', { token, reservationId: 'other' }))).status, 400);
  assert.equal((await loadRoute('vendor/access', { exchange: async () => ({ kind: 'invalid' }) }).POST(request('/api/vendor/access', { token }))).status, 401);
}));

test('vendor payment reads only vendor-cookie session and rejects manager cookie or selected reservation query', () => configured(async () => {
  let input;
  const reservation = { dates: ['2026-10-03'], boothsPerMarket: 1, rateCents: 4000, totalCents: 4000, currency: 'USD', quoteTier: 'standard', paymentRequired: true, paymentDueAt: '2026-10-03T12:00:00.000Z', status: 'pending', checkoutUrl: 'https://sandbox.square.link/u/qa', environment: 'sandbox' };
  const route = loadRoute('vendor/payment', { read: async value => { input = value; return reservation; } });
  assert.equal((await route.GET(request('/api/vendor/payment', {}, { method: 'GET', headers: { cookie: 'bhq_session=manager-cookie' } }))).status, 401);
  const token = access.createVendorAccessToken();
  const response = await route.GET(request('/api/vendor/payment?reservationId=attacker&marketId=other', {}, { method: 'GET', headers: { cookie: `${access.VENDOR_PAYMENT_COOKIE}=${token}` } }));
  assert.deepEqual(await response.json(), { reservation });
  assert.equal(input.sessionHash, access.hashVendorAccessToken(token));
  assert.equal(input.config.marketId, 'private-market');
  assert.equal(input.reservationId, undefined);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await loadRoute('vendor/payment', { read: async () => null }).GET(request('/api/vendor/payment', {}, { method: 'GET', headers: { cookie: `${access.VENDOR_PAYMENT_COOKIE}=${token}` } }))).status, 401);
}));

test('logout revokes stored vendor session and only then expires the same secure cookie', () => configured(async () => {
  const token = access.createVendorAccessToken();
  let revoked;
  const route = loadRoute('vendor/logout', { revoke: async input => { revoked = input; } });
  const req = () => request('/api/vendor/logout', {}, { headers: { cookie: `${access.VENDOR_PAYMENT_COOKIE}=${token}` } });
  const response = await route.POST(req());
  assert.equal(response.status, 200);
  assert.equal(revoked.sessionHash, access.hashVendorAccessToken(token));
  assert.equal(response.cookies.get(access.VENDOR_PAYMENT_COOKIE).value, '');
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  const failed = await loadRoute('vendor/logout', { revoke: async () => { throw new Error('private failure'); } }).POST(req());
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('set-cookie'), null);
}));
