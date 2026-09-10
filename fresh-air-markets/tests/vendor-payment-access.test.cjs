const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createVendorAccessToken, validVendorAccessToken, hashVendorAccessToken,
  vendorPaymentAccessConfig, vendorInvitationUrl, issueVendorPaymentInvitation,
  exchangeVendorPaymentInvitation, readVendorAccessBody, sameOriginVendorPost,
  vendorCookieOptions, VENDOR_PAYMENT_COOKIE,
} = require('../.test-build/vendor-payment-access.js');
const env = { VERCEL: '1', VERCEL_ENV: 'preview', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ALLOW_LIVE_PAYMENTS: 'false', FAME_MARKET_ACCOUNT_ID: 'private-market', FAME_VENDOR_PORTAL_ORIGIN: 'https://qa-market.vercel.app' };
const config = vendorPaymentAccessConfig(env);

test('vendor invitation and session tokens are independent 256-bit values, hash-only in the store and fragment-only in the URL', async () => {
  let issued;
  const result = await issueVendorPaymentInvitation({ config, reservationId: 'reservation', actorAccountId: config.marketId,
    store: { issue: async input => { issued = input; return { kind: 'issued', expiresAt: '2026-10-03T12:00:00.000Z' }; } } });
  assert.equal(result.kind, 'issued');
  assert.equal(validVendorAccessToken(result.invitationToken), true);
  assert.equal(Buffer.from(result.invitationToken, 'base64url').length, 32);
  assert.equal(issued.tokenHash, hashVendorAccessToken(result.invitationToken));
  assert.equal(JSON.stringify(issued).includes(result.invitationToken), false);
  const url = new URL(result.invitationUrl);
  assert.equal(url.origin, config.portalOrigin);
  assert.equal(url.pathname, '/vendor/payment');
  assert.equal(url.search, '');
  assert.equal(url.hash, `#token=${result.invitationToken}`);
  let swapped;
  const exchange = await exchangeVendorPaymentInvitation({ token: result.invitationToken, config,
    store: { exchange: async input => { swapped = input; return { kind: 'exchanged', expiresAt: '2026-10-08T12:00:00.000Z' }; } } });
  assert.notEqual(exchange.sessionToken, result.invitationToken);
  assert.equal(swapped.invitationHash, issued.tokenHash);
  assert.equal(swapped.sessionHash, hashVendorAccessToken(exchange.sessionToken));
  assert.equal(JSON.stringify(swapped).includes(exchange.sessionToken), false);
  assert.deepEqual(vendorCookieOptions(), { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/vendor' });
  assert.notEqual(VENDOR_PAYMENT_COOKIE, 'bhq_session');
});

test('token parsing rejects malformed encodings and failed exchanges never expose a session', async () => {
  let calls = 0;
  for (const token of [null, {}, '', 'a', 'a'.repeat(42), 'a'.repeat(44), '!'.repeat(43), 'A'.repeat(42) + 'B', ' '.repeat(43)]) {
    assert.equal(validVendorAccessToken(token), false);
    assert.equal((await exchangeVendorPaymentInvitation({ token, config, store: { exchange: async () => { calls++; } } })).kind, 'invalid');
  }
  assert.equal(calls, 0);
  const token = createVendorAccessToken();
  const rejected = await exchangeVendorPaymentInvitation({ token, config, store: { exchange: async () => ({ kind: 'invalid' }) } });
  assert.deepEqual(rejected, { kind: 'invalid' });
  assert.throws(() => vendorInvitationUrl(config.portalOrigin, '../token'));
});

test('configuration rejects demo market, wrong environment and untrusted payment origins', () => {
  for (const patch of [
    { FAME_MARKET_ACCOUNT_ID: 'demo-market' }, { FAME_MARKET_ACCOUNT_ID: '' },
    { VERCEL: undefined }, { VERCEL_ENV: 'development' },
    { SQUARE_ENVIRONMENT: 'production' }, { SQUARE_ENVIRONMENT: 'invalid' },
    { FAME_VENDOR_PORTAL_ORIGIN: 'https://evil.invalid' },
    { FAME_VENDOR_PORTAL_ORIGIN: 'https://qa-market.vercel.app.evil.invalid' },
    { FAME_VENDOR_PORTAL_ORIGIN: 'https://evil@qa-market.vercel.app' },
    { FAME_VENDOR_PORTAL_ORIGIN: 'https://qa-market.vercel.app/path' },
    { FAME_VENDOR_PORTAL_ORIGIN: 'https://qa-market.vercel.app?token=1' },
    { FAME_VENDOR_PORTAL_ORIGIN: 'http://qa-market.vercel.app' },
    { VERCEL_ENV: 'production', SQUARE_ENVIRONMENT: 'production', FAME_VENDOR_PORTAL_ORIGIN: 'https://evil.invalid' },
    { VERCEL_ENV: 'production', SQUARE_ENVIRONMENT: 'production', FAME_VENDOR_PORTAL_ORIGIN: 'https://freshairmarketsandevents.com.evil.invalid' },
  ]) assert.throws(() => vendorPaymentAccessConfig({ ...env, ...patch }));
  // Production accepts the market domain, its subdomains, and the Vercel deployment host.
  for (const origin of ['https://freshairmarketsandevents.com', 'https://portal.freshairmarketsandevents.com', 'https://qa-market.vercel.app']) {
    assert.equal(vendorPaymentAccessConfig({ ...env, VERCEL_ENV: 'production', SQUARE_ENVIRONMENT: 'production', FAME_VENDOR_PORTAL_ORIGIN: origin }).portalOrigin, origin);
  }
  const prod = { ...env, VERCEL_ENV: 'production', SQUARE_ENVIRONMENT: 'production', FAME_VENDOR_PORTAL_ORIGIN: 'https://freshairmarketsandevents.com' };
  assert.equal(vendorPaymentAccessConfig(prod).allowCheckout, false);
  assert.equal(vendorPaymentAccessConfig({ ...prod, SQUARE_ALLOW_LIVE_PAYMENTS: 'true' }).allowCheckout, true);
  assert.throws(() => vendorPaymentAccessConfig({ ...prod, SQUARE_QA_FAULT: 'timeout' }));
});

test('manager issuance never trusts a supplied foreign tenant or public demo identity', async () => {
  let calls = 0;
  for (const actorAccountId of ['other-market', 'demo-market']) {
    assert.deepEqual(await issueVendorPaymentInvitation({ config, actorAccountId, reservationId: 'reservation', store: { issue: async () => { calls++; } } }), { kind: 'forbidden' });
  }
  assert.equal(calls, 0);
});

test('explicit exchange requires same-origin JSON, refuses oversized/scalar payloads and cross-site requests', async () => {
  const request = body => new Request(config.portalOrigin + '/api/vendor/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const token = createVendorAccessToken();
  assert.deepEqual(await readVendorAccessBody(request(JSON.stringify({ token }))), { token });
  for (const body of ['null', '[]', '1', '"token"', '{', JSON.stringify({ token: 'a'.repeat(1024) })]) {
    assert.equal(await readVendorAccessBody(request(body)), null);
  }
  assert.equal(await readVendorAccessBody(new Request(config.portalOrigin, { method: 'POST', body: '{}' })), null);
  for (const origin of ['https://evil.invalid', 'null', '']) {
    assert.equal(sameOriginVendorPost({ url: config.portalOrigin, headers: new Headers({ origin }) }, config.portalOrigin), false);
  }
  assert.equal(sameOriginVendorPost({ url: config.portalOrigin, headers: new Headers({ origin: config.portalOrigin, 'sec-fetch-site': 'cross-site' }) }, config.portalOrigin), false);
  assert.equal(sameOriginVendorPost({ url: config.portalOrigin, headers: new Headers({ origin: config.portalOrigin, 'sec-fetch-site': 'same-origin' }) }, config.portalOrigin), true);
});
