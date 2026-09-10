const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

function loadRoute({ authenticated = true, configured = true, verifiedIdentity, dispatch, qaSupport, qaTransport, setup, identityCheck, portalOrigin } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/reservations/[id]/checkout/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/seed') return require('../.test-build/seed.js');
    if (id === '@/lib/auth') return { getSessionAccountId: async () => authenticated ? 'qa-market' : null };
    if (id === '@/lib/square') return {
      squarePaymentRuntimeConfig: () => {
        if (!configured) throw new Error('not configured');
        return setup || { environment: 'sandbox', accessToken: 'private-token', locationId: 'configured-location' };
      },
      squarePortalOrigin: portalOrigin || (() => "https://freshairmarketsandevents.com"),
      verifySquareIdentity: identityCheck || (async () => verifiedIdentity || { merchantId: 'verified-merchant', locationId: 'verified-location' }),
    };
    if (id === '@/lib/square-payment') return {
      validSquareReservationId: value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,192}$/.test(value),
      dispatchSquareCheckout: dispatch || (async () => ({ kind: 'not_found' })),
    };
    if (id === '@/lib/square-payment-pg') return { postgresSquarePaymentCheckoutStore: { qa: true } };
    if (id === '@/lib/square-qa-faults') return {
      squareQaSupportConfig: qaSupport || (() => null),
      squareQaCheckoutTransport: qaTransport || (() => undefined),
    };
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}

function request(body = { totalCents: 1, vendorId: 'attacker', checkoutUrl: 'https://attacker.invalid' }) {
  return new NextRequest('https://unit-test.invalid/', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function withDatabase(fn) {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://qa/unused';
  try { await fn(); }
  finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
}

test('checkout route requires a manager session before configuration or provider work', async () => {
  let calls = 0;
  const route = loadRoute({ authenticated: false, dispatch: async () => { calls++; throw new Error('must not run'); } });
  const response = await route.POST(request(), { params: Promise.resolve({ id: 'reservation-1' }) });
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('checkout route fails closed for missing durable storage, bad reservation IDs, and a missing Preview Sandbox gate', async () => {
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.equal((await loadRoute().POST(request(), { params: Promise.resolve({ id: 'reservation-1' }) })).status, 503);
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
  await withDatabase(async () => {
    assert.equal((await loadRoute().POST(request(), { params: Promise.resolve({ id: '../bad' }) })).status, 400);
    let configuredDispatches = 0;
    const previewGateFailure = loadRoute({
      configured: false,
      dispatch: async () => { configuredDispatches++; return { kind: 'not_found' }; },
    });
    assert.equal((await previewGateFailure.POST(request(), { params: Promise.resolve({ id: 'reservation-1' }) })).status, 503);
    assert.equal(configuredDispatches, 0);
    let dispatched = 0;
    const unsafeQaControl = loadRoute({
      qaSupport: () => { throw new Error('QA controls are not permitted here'); },
      dispatch: async () => { dispatched++; return { kind: 'not_found' }; },
    });
    assert.equal((await unsafeQaControl.POST(request(), { params: Promise.resolve({ id: 'reservation-1' }) })).status, 503);
    assert.equal(dispatched, 0);
  });
});

test('checkout route binds the session market/path reservation and ignores price, vendor, and URL fields in the body', async () => {
  await withDatabase(async () => {
    let input;
    const route = loadRoute({ dispatch: async value => {
      input = value;
      return { kind: 'created', order: {
        id: 'payment-order', status: 'checkout_created', checkoutUrl: 'https://sandbox.square.link/qa', paymentDueAt: '2026-10-03T12:00:00.000Z',
      } };
    } });
    const response = await route.POST(request({ totalCents: 1, vendorId: 'attacker', reservationId: 'other', checkoutUrl: 'https://attacker.invalid' }), {
      params: Promise.resolve({ id: 'reservation-1' }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(input, {
      marketId: 'qa-market', reservationId: 'reservation-1',
      square: { environment: 'sandbox', accessToken: 'private-token', locationId: 'verified-location', merchantId: 'verified-merchant' },
      store: { qa: true },
    });
    assert.deepEqual(await response.json(), { paymentOrder: {
      id: 'payment-order', status: 'checkout_created', checkoutUrl: 'https://sandbox.square.link/qa', paymentDueAt: '2026-10-03T12:00:00.000Z',
    } });
  });
});

test('checkout route maps safe retry, terminal, and nonprofit outcomes without claiming payment success', async () => {
  await withDatabase(async () => {
    const cases = [
      [{ kind: 'existing', order: { id: 'order', status: 'checkout_created', checkoutUrl: 'https://sandbox.square.link/qa', paymentDueAt: null } }, 200],
      [{ kind: 'in_progress', paymentOrderId: 'order' }, 202],
      [{ kind: 'retry_scheduled', paymentOrderId: 'order' }, 503],
      [{ kind: 'failed', paymentOrderId: 'order' }, 409],
      [{ kind: 'not_payable', reason: 'nonprofit' }, 409],
      [{ kind: 'not_payable', reason: 'expired' }, 409],
    ];
    for (const [result, status] of cases) {
      const route = loadRoute({ dispatch: async () => result });
      const response = await route.POST(request(), { params: Promise.resolve({ id: 'reservation-1' }) });
      assert.equal(response.status, status);
      const payload = await response.json();
      assert.equal(payload.status === 'paid', false);
    }
  });
});

test('a scoped Preview QA checkout fault passes only its in-process transport and blocks other reservations', async () => {
  await withDatabase(async () => {
    const transport = async () => new Response(null, { status: 429 });
    let input;
    const qaSupport = () => ({ fault: { kind: 'checkout', mode: 'checkout_429', reservationId: 'reservation-1' } });
    const route = loadRoute({
      qaSupport,
      qaTransport: () => transport,
      dispatch: async value => { input = value; return { kind: 'retry_scheduled', paymentOrderId: 'order' }; },
    });
    assert.equal((await route.POST(request(), { params: Promise.resolve({ id: 'reservation-1' }) })).status, 503);
    assert.equal(input.transport, transport);

    input = undefined;
    assert.equal((await route.POST(request(), { params: Promise.resolve({ id: 'different-reservation' }) })).status, 503);
    assert.equal(input, undefined);
  });
});


test('production checkout refuses another private market and uses only the configured website return URL', async () => {
  await withDatabase(async () => {
    const old = process.env.FAME_MARKET_ACCOUNT_ID;
    try {
      let written;
      const setup = { environment: 'production', accessToken: 'private-token', locationId: 'configured-location', merchantId: 'configured-merchant', checkoutRedirectUrl: 'https://freshairmarketsandevents.com/vendor/payment?returned=1' };
      const route = loadRoute({ setup, dispatch: async input => { written = input; return { kind: 'not_found' }; } });
      process.env.FAME_MARKET_ACCOUNT_ID = 'another-market';
      assert.equal((await route.POST(request(), { params: Promise.resolve({ id: 'reservation-1' }) })).status, 403);
      assert.equal(written, undefined);
      process.env.FAME_MARKET_ACCOUNT_ID = 'qa-market';
      assert.equal((await route.POST(request({ redirect_url: 'https://attacker.invalid/' }), { params: Promise.resolve({ id: 'reservation-1' }) })).status, 404);
      assert.equal(written.square.environment, 'production');
      assert.equal(written.square.checkoutRedirectUrl, setup.checkoutRedirectUrl);
      assert.equal(written.square.merchantId, 'verified-merchant');
    } finally { if (old === undefined) delete process.env.FAME_MARKET_ACCOUNT_ID; else process.env.FAME_MARKET_ACCOUNT_ID = old; }
  });
});


test('browser checkout rejects foreign origins and cross-site metadata before identity or payment writes', async () => {
  await withDatabase(async () => {
    let providerCalls = 0;
    let writes = 0;
    const route = loadRoute({ identityCheck: async () => { providerCalls++; return { merchantId: 'merchant', locationId: 'location' }; }, dispatch: async () => { writes++; return { kind: 'not_found' }; } });
    for (const headers of [
      { origin: 'https://attacker.invalid' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'https://freshairmarketsandevents.com', 'sec-fetch-site': 'cross-site' },
      { origin: 'https://freshairmarketsandevents.com.attacker.invalid', 'sec-fetch-site': 'same-site' },
    ]) {
      const response = await route.POST(new NextRequest('https://freshairmarketsandevents.com/api/admin/reservations/reservation-1/checkout', { method: 'POST', headers }), { params: Promise.resolve({ id: 'reservation-1' }) });
      assert.equal(response.status, 403);
    }
    assert.equal(providerCalls, 0);
    assert.equal(writes, 0);
    const good = await route.POST(new NextRequest('https://freshairmarketsandevents.com/api/admin/reservations/reservation-1/checkout', { method: 'POST', headers: { origin: 'https://freshairmarketsandevents.com', 'sec-fetch-site': 'same-origin' } }), { params: Promise.resolve({ id: 'reservation-1' }) });
    assert.equal(good.status, 404);
    assert.equal(providerCalls, 1);
    assert.equal(writes, 1);
  });
});

test('browser checkout fails closed when the configured public origin cannot be validated', async () => {
  await withDatabase(async () => {
    let providerCalls = 0;
    const route = loadRoute({ portalOrigin: () => { throw new Error('invalid config'); }, identityCheck: async () => { providerCalls++; throw new Error('must not run'); } });
    const response = await route.POST(new NextRequest('https://unit-test.invalid/', { method: 'POST', headers: { origin: 'https://freshairmarketsandevents.com' } }), { params: Promise.resolve({ id: 'reservation-1' }) });
    assert.equal(response.status, 503);
    assert.equal(providerCalls, 0);
  });
});
