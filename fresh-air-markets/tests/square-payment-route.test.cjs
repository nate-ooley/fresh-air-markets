const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

function loadRoute({ authenticated = true, configured = true, verifiedIdentity, dispatch, qaSupport, qaTransport } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/reservations/[id]/checkout/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/auth') return { getSessionAccountId: async () => authenticated ? 'qa-market' : null };
    if (id === '@/lib/square') return {
      squareSandboxSetupConfig: () => {
        if (!configured) throw new Error('not configured');
        return { environment: 'sandbox', accessToken: 'private-token', locationId: 'configured-location' };
      },
      verifySquareSandboxSetup: async () => verifiedIdentity || { merchantId: 'verified-merchant', locationId: 'verified-location' },
    };
    if (id === '@/lib/square-payment') return {
      validSquareReservationId: value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,192}$/.test(value),
      dispatchSquareSandboxCheckout: dispatch || (async () => ({ kind: 'not_found' })),
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

test('checkout route fails closed for missing durable storage, bad reservation IDs, and missing Sandbox setup', async () => {
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
    assert.equal((await loadRoute({ configured: false }).POST(request(), { params: Promise.resolve({ id: 'reservation-1' }) })).status, 503);
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
        id: 'payment-order', status: 'checkout_created', checkoutUrl: 'https://square.link/qa', paymentDueAt: '2026-10-03T12:00:00.000Z',
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
      id: 'payment-order', status: 'checkout_created', checkoutUrl: 'https://square.link/qa', paymentDueAt: '2026-10-03T12:00:00.000Z',
    } });
  });
});

test('checkout route maps safe retry, terminal, and nonprofit outcomes without claiming payment success', async () => {
  await withDatabase(async () => {
    const cases = [
      [{ kind: 'existing', order: { id: 'order', status: 'checkout_created', checkoutUrl: 'https://square.link/qa', paymentDueAt: null } }, 200],
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
