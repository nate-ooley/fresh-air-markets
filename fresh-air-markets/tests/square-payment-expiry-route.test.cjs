const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadRoute({ authorized = true, expiry, configured = true, verified = true, dispatch, qaSupport, expiryTransport } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/internal/cron/square-payment-expiry/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/cron-auth') return {
      cronSecretConfigured: value => typeof value === 'string' && value.length >= 32,
      cronAuthorized: () => authorized,
    };
    if (id === '@/lib/square-payment-pg') return {
      expireDueSquarePaymentHolds: expiry || (async () => ({ expiryPending: 0, manualReview: 0 })),
      postgresSquarePaymentLinkRetirementStore: { qa: true },
    };
    if (id === '@/lib/square') return {
      squarePreviewSandboxRuntimeConfig: () => {
        if (!configured) throw new Error('not configured');
        return { environment: 'sandbox', accessToken: 'private-token', locationId: 'sandbox-location' };
      },
      verifySquareSandboxSetup: async () => {
        if (!verified) throw new Error('unverified');
        return { merchantId: 'sandbox-merchant', locationId: 'sandbox-location' };
      },
    };
    if (id === '@/lib/square-payment') return {
      dispatchSquarePaymentLinkRetirement: dispatch || (async () => ({ kind: 'no_work' })),
    };
    if (id === '@/lib/square-qa-faults') return {
      squareQaSupportConfig: qaSupport || (() => null),
      squareQaExpiryTransport: expiryTransport || (() => undefined),
    };
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}

async function withSchedulerEnv(fn, { database = true, secret = true, market = true } = {}) {
  const previousDatabase = process.env.DATABASE_URL;
  const previousSecret = process.env.CRON_SECRET;
  const previousMarket = process.env.FAME_MARKET_ACCOUNT_ID;
  if (database) process.env.DATABASE_URL = 'postgres://qa/unused';
  else delete process.env.DATABASE_URL;
  if (secret) process.env.CRON_SECRET = 'qa-cron-secret-with-at-least-thirty-two-characters';
  else delete process.env.CRON_SECRET;
  if (market) process.env.FAME_MARKET_ACCOUNT_ID = 'qa-market';
  else delete process.env.FAME_MARKET_ACCOUNT_ID;
  try { await fn(); }
  finally {
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousMarket === undefined) delete process.env.FAME_MARKET_ACCOUNT_ID;
    else process.env.FAME_MARKET_ACCOUNT_ID = previousMarket;
  }
}

test('payment expiry scheduler requires its trusted cron credential and durable database before any work', async () => {
  await withSchedulerEnv(async () => {
    let expiryCalls = 0;
    let dispatchCalls = 0;
    const route = loadRoute({
      authorized: false,
      expiry: async () => { expiryCalls++; return { expiryPending: 0, manualReview: 0 }; },
      dispatch: async () => { dispatchCalls++; return { kind: 'no_work' }; },
    });
    assert.equal((await route.GET(new Request('https://unit-test.invalid'))).status, 401);
    assert.equal(expiryCalls, 0);
    assert.equal(dispatchCalls, 0);
  });
  await withSchedulerEnv(async () => {
    let expiryCalls = 0;
    const route = loadRoute({ expiry: async () => { expiryCalls++; return { expiryPending: 0, manualReview: 0 }; } });
    assert.equal((await route.GET(new Request('https://unit-test.invalid'))).status, 503);
    assert.equal(expiryCalls, 0);
  }, { database: false });
  await withSchedulerEnv(async () => {
    let expiryCalls = 0;
    const route = loadRoute({ expiry: async () => { expiryCalls++; return { expiryPending: 0, manualReview: 0 }; } });
    assert.equal((await route.GET(new Request('https://unit-test.invalid'))).status, 503);
    assert.equal(expiryCalls, 0);
  }, { market: false });
});

test('payment expiry claims durable holds before it calls only the verified Sandbox retirement dispatcher', async () => {
  await withSchedulerEnv(async () => {
    const calls = [];
    const route = loadRoute({
      expiry: async input => { calls.push(['expiry', input]); return { expiryPending: 3, manualReview: 1 }; },
      dispatch: async input => {
        calls.push(['dispatch', input]);
        return calls.filter(([kind]) => kind === 'dispatch').length === 1
          ? { kind: 'retired', paymentOrderId: 'payment-order-1' }
          : { kind: 'no_work' };
      },
    });
    const response = await route.GET(new Request('https://unit-test.invalid'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { expiryPending: 3, expired: 1, deferred: 0, manualReview: 1 });
    assert.equal(calls[0][0], 'expiry');
    assert.equal(calls[1][0], 'dispatch');
    assert.deepEqual(calls[1][1], {
      marketId: 'qa-market',
      square: {
        environment: 'sandbox', accessToken: 'private-token',
        merchantId: 'sandbox-merchant', locationId: 'sandbox-location',
      },
      store: { qa: true },
    });
  });
});

test('provider identity failure leaves the claimed hold queued and never invokes retirement', async () => {
  await withSchedulerEnv(async () => {
    let dispatched = 0;
    let claimed = 0;
    const route = loadRoute({
      expiry: async () => { claimed++; return { expiryPending: 1, manualReview: 0 }; },
      configured: false,
      dispatch: async () => { dispatched++; return { kind: 'no_work' }; },
    });
    const response = await route.GET(new Request('https://unit-test.invalid'));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Square payment expiry is unavailable.' });
    assert.equal(claimed, 0);
    assert.equal(dispatched, 0);
  });
});

test('a Preview-only expiry fault is fenced to one payment order and supplies only its synthetic transport', async () => {
  await withSchedulerEnv(async () => {
    let expiryInput;
    let dispatchInput;
    let transportTarget;
    const route = loadRoute({
      qaSupport: () => ({
        fault: { kind: 'expiry', mode: 'expiry_429', paymentOrderId: 'qa-payment-order-1' },
        signerSecret: null,
      }),
      expiry: async input => {
        expiryInput = input;
        return { expiryPending: 1, manualReview: 0 };
      },
      expiryTransport: (fault, paymentOrderId, locationId) => {
        transportTarget = { fault, paymentOrderId, locationId };
        return async () => new Response(null, { status: 429 });
      },
      dispatch: async input => {
        dispatchInput = input;
        const transport = input.transportForRetirement({ paymentOrderId: 'qa-payment-order-1' });
        assert.equal((await transport('https://should-not-be-called.invalid')).status, 429);
        return { kind: 'no_work' };
      },
    });
    const response = await route.GET(new Request('https://unit-test.invalid'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { expiryPending: 1, expired: 0, deferred: 0, manualReview: 0 });
    assert.equal(expiryInput.paymentOrderId, 'qa-payment-order-1');
    assert.equal(dispatchInput.paymentOrderId, 'qa-payment-order-1');
    assert.deepEqual(transportTarget, {
      fault: { kind: 'expiry', mode: 'expiry_429', paymentOrderId: 'qa-payment-order-1' },
      paymentOrderId: 'qa-payment-order-1',
      locationId: 'sandbox-location',
    });
  });
});

test('an unrelated QA fault fails closed before the scheduler can claim or retire a hold', async () => {
  await withSchedulerEnv(async () => {
    let expiryCalls = 0;
    let dispatchCalls = 0;
    const route = loadRoute({
      qaSupport: () => ({
        fault: { kind: 'checkout', mode: 'checkout_429', reservationId: 'qa-reservation-1' },
        signerSecret: null,
      }),
      expiry: async () => { expiryCalls++; return { expiryPending: 0, manualReview: 0 }; },
      dispatch: async () => { dispatchCalls++; return { kind: 'no_work' }; },
    });
    const response = await route.GET(new Request('https://unit-test.invalid'));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Square payment expiry QA configuration is not applicable.' });
    assert.equal(expiryCalls, 0);
    assert.equal(dispatchCalls, 0);
  });
});
