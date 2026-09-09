const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const { DEMO_MARKET_ID } = require('../.test-build/seed.js');

// Invoke real handlers with observable storage/provider boundaries. These
// checks must never reach HighLevel, Square, or a deployed database.
function loadRoute(relative, { marketId = 'fresh-air-qa', overrides = {} } = {}) {
  const calls = { stores: 0, lookups: 0, approvals: 0, writes: 0, crm: 0, square: 0 };
  const booking = { id: 'legacy-booking', boothId: 'qa-booth', status: 'approved' };
  const store = {
    getAccountBySlug: async () => { calls.lookups++; return { id: marketId }; },
    approveBooking: async () => { calls.approvals++; return { ok: true, booking }; },
    getBooth: async () => ({ id: 'qa-booth', label: 'QA', pricePerDay: 40 }),
    getInquiryReplay: async () => null,
    boothsWithAvailability: async () => [{ id: 'qa-booth', bookedDates: [] }],
    createInquiry: async (_market, input, totalPrice) => { calls.writes++; return { ...booking, ...input, totalPrice, replayed: false }; },
    setBookingStatus: async () => { calls.writes++; return booking; },
    ...overrides,
  };
  const filename = path.resolve(__dirname, '../src/app/api', relative, 'route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/store') return { getStore: async () => { calls.stores++; return store; } };
    if (id === '@/lib/auth') return { getSessionAccountId: async () => marketId };
    if (id === '@/lib/ghl') return { syncBookingToGhl: async () => { calls.crm++; return false; } };
    if (id === '@/lib/inquiry-rate-limit') return { consumeInquiryLimit: async () => ({ allowed: true }), inquiryClient: () => 'qa-client' };
    if (id === '@/lib/market-calendar') return { marketBookableDates: () => new Set(['2026-10-03']) };
    if (id === '@/lib/square') return {
      squarePreviewSandboxRuntimeConfig: () => { calls.square++; throw new Error('No provider access expected'); },
    };
    if (id === '@/lib/square-payment') return {};
    if (id === '@/lib/square-payment-pg') return {};
    if (id === '@/lib/square-qa-faults') return { squareQaSupportConfig: () => { calls.square++; return null; } };
    if (id.startsWith('@/lib/')) return require('../.test-build/' + id.slice(6) + '.js');
    return require(id);
  };
  mod._compile(compiled, filename);
  return { route: mod.exports, calls };
}

async function configuredMarket(value, run) {
  const original = process.env.FAME_MARKET_ACCOUNT_ID;
  if (value === undefined) delete process.env.FAME_MARKET_ACCOUNT_ID;
  else process.env.FAME_MARKET_ACCOUNT_ID = value;
  try { await run(); }
  finally {
    if (original === undefined) delete process.env.FAME_MARKET_ACCOUNT_ID;
    else process.env.FAME_MARKET_ACCOUNT_ID = original;
  }
}

const params = { params: Promise.resolve({ id: 'legacy-booking', slug: 'qa-market' }) };
function request(method, body) {
  return new NextRequest('https://unit-test.invalid/', {
    method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': '11111111-1111-4111-8111-111111111111' },
    body: JSON.stringify(body),
  });
}
const inquiry = {
  name: 'QA', businessName: 'QA booth', email: 'nate@autocraftstudios.com',
  category: 'Crafts & Artisan', boothId: 'qa-booth', dates: ['2026-10-03'],
};

test('configured Fresh Air market cannot approve legacy bookings or trigger CRM, including injected identities', async () => {
  await configuredMarket(' fresh-air-qa ', async () => {
    const { route, calls } = loadRoute('admin/bookings/[id]');
    for (const body of [{ action: 'approve' }, { action: 'approve', marketId: 'other-market', accountId: DEMO_MARKET_ID }]) {
      const response = await route.PATCH(request('PATCH', body), params);
      assert.equal(response.status, 409);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).code, 'APPLICATION_REVIEW_REQUIRED');
    }
    assert.equal(calls.stores + calls.approvals + calls.writes + calls.crm, 0);
  });
});

test('five concurrent legacy approvals all stop before storage or CRM', async () => {
  await configuredMarket('fresh-air-qa', async () => {
    const { route, calls } = loadRoute('admin/bookings/[id]');
    const results = await Promise.all(Array.from({ length: 5 }, () => route.PATCH(request('PATCH', { action: 'approve' }), params)));
    assert.deepEqual(results.map(r => r.status), Array(5).fill(409));
    assert.equal(calls.stores + calls.approvals + calls.crm, 0);
  });
});

test('configured Fresh Air intake redirects to the existing application without a booking or CRM event', async () => {
  await configuredMarket(' fresh-air-qa ', async () => {
    const { route, calls } = loadRoute('m/[slug]/inquiries');
    const response = await route.POST(request('POST', { ...inquiry, marketId: 'other-market' }), params);
    assert.equal(response.status, 410);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).applicationUrl, 'https://freshairmarketsandevents.com/vendors');
    assert.equal(calls.lookups, 1);
    assert.equal(calls.writes + calls.crm, 0);
  });
});

test('demo market remains isolated unless deliberately misconfigured as Fresh Air', async () => {
  for (const configured of [undefined, 'different-fresh-air-market']) {
    await configuredMarket(configured, async () => {
      const approved = loadRoute('admin/bookings/[id]', { marketId: DEMO_MARKET_ID });
      assert.equal((await approved.route.PATCH(request('PATCH', { action: 'approve' }), params)).status, 200);
      assert.equal(approved.calls.approvals, 1);
      assert.equal(approved.calls.crm, 1);
      const intake = loadRoute('m/[slug]/inquiries', { marketId: DEMO_MARKET_ID });
      assert.equal((await intake.route.POST(request('POST', inquiry), params)).status, 201);
      assert.equal(intake.calls.writes, 1);
      assert.equal(intake.calls.crm, 1);
    });
  }
  await configuredMarket(DEMO_MARKET_ID, async () => {
    const approved = loadRoute('admin/bookings/[id]', { marketId: DEMO_MARKET_ID });
    const intake = loadRoute('m/[slug]/inquiries', { marketId: DEMO_MARKET_ID });
    assert.equal((await approved.route.PATCH(request('PATCH', { action: 'approve' }), params)).status, 409);
    assert.equal((await intake.route.POST(request('POST', inquiry), params)).status, 410);
    assert.equal(approved.calls.approvals + approved.calls.crm + intake.calls.writes + intake.calls.crm, 0);
  });
});

test('legacy approval guard preserves authentication and cancellation without introducing an approval bypass', async () => {
  await configuredMarket('fresh-air-qa', async () => {
    const anonymous = loadRoute('admin/bookings/[id]', { marketId: null });
    assert.equal((await anonymous.route.PATCH(request('PATCH', { action: 'approve' }), params)).status, 401);
    assert.equal(anonymous.calls.stores, 0);
    const cancelled = loadRoute('admin/bookings/[id]');
    assert.equal((await cancelled.route.PATCH(request('PATCH', { action: 'cancel' }), params)).status, 200);
    assert.equal(cancelled.calls.writes, 1);
    assert.equal(cancelled.calls.approvals + cancelled.calls.crm, 0);
  });
});

test('public demo manager cannot run Square checkout, even for previously stored final reservations', async () => {
  const { route, calls } = loadRoute('admin/reservations/[id]/checkout', { marketId: DEMO_MARKET_ID });
  const response = await route.POST(request('POST', { marketId: 'private-market' }), params);
  assert.equal(response.status, 403);
  assert.equal(calls.square + calls.stores + calls.crm, 0);
});

test('Fresh Air final reservation config rejects the public demo account and accepts a private QA account', () => {
  const { freshAirFinalReservationConfig } = require('../.test-build/final-reservation-pg.js');
  const env = { FAME_SEASON_ID: '2026-2027', FAME_BOOTH_CAPACITY: '20' };
  for (const marketId of [DEMO_MARKET_ID, ` ${DEMO_MARKET_ID} `]) {
    assert.throws(() => freshAirFinalReservationConfig({ ...env, FAME_MARKET_ACCOUNT_ID: marketId }), /private market account/);
  }
  assert.equal(freshAirFinalReservationConfig({ ...env, FAME_MARKET_ACCOUNT_ID: 'private-qa-market' }).marketId, 'private-qa-market');
});
