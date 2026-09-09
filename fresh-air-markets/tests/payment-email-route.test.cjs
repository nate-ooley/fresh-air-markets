const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const access = require('../.test-build/vendor-payment-access.js');
const delivery = require('../.test-build/ghl-payment-email-delivery.js');
const origin = 'https://qa-market.vercel.app';
const marketId = 'private-market';
const reservationId = 'reservation-1';
const context = { params: Promise.resolve({ id: reservationId }) };
const managerPath = `/api/admin/reservations/${reservationId}/payment-email`;
const cronPath = '/api/internal/cron/payment-email';
const notice = { id: 'email-job-1', status: 'pending', createdAt: '2026-10-01T12:00:00.000Z' };
const report = { processed: 1, accepted: 1, delivered: 0, failed: 0, uncertain: 0, cancelled: 0, pending: 0 };
const secret = 'route-test-authentication-secret-distinct-characters-12345';

function loadRoute(name, options = {}) {
  const filename = path.resolve(__dirname, `../src/app/api/${name}/route.ts`);
  const mod = new Module(filename, module);
  const calls = options.calls || [];
  mod.filename = filename; mod.paths = module.paths;
  mod.require = id => {
    if (id === '@/lib/auth') return { getSessionAccountId: async () => options.actor === undefined ? marketId : options.actor };
    if (id === '@/lib/auth-secret') return { signingSecret: () => secret };
    if (id === '@/lib/vendor-payment-access') return access;
    if (id === '@/lib/ghl-payment-email-delivery') return delivery;
    if (id === '@/lib/square-payment') return require('../.test-build/square-payment.js');
    if (id === '@/lib/cron-auth') return require('../.test-build/cron-auth.js');
    if (id === '@/lib/payment-email-pg') return {
      queuePaymentEmail: async value => { calls.push({ action: 'queue', value }); return options.queue ? options.queue(value) : { kind: 'queued', notification: notice }; },
      dispatchPaymentEmails: async value => { calls.push({ action: 'dispatch', value }); return options.dispatch ? options.dispatch(value) : report; },
      getPaymentEmailStatus: async value => { calls.push({ action: 'status', value }); return options.status ? options.status(value) : notice; },
    };
    return require(id);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return mod.exports;
}
const manager = options => loadRoute('admin/reservations/[id]/payment-email', options);
const cron = options => loadRoute('internal/cron/payment-email', options);
function request(pathname = managerPath, body = {}, opts = {}) {
  const method = opts.method || 'POST';
  return new NextRequest(origin + pathname, {
    method, headers: { origin, 'content-type': 'application/json', ...opts.headers },
    ...(method === 'GET' ? {} : { body: opts.raw === undefined ? JSON.stringify(body) : opts.raw }),
  });
}
function scheduler(authorized = true, suffix = '') {
  return request(cronPath + suffix, {}, { method: 'GET', headers: authorized ? { authorization: `Bearer ${secret}` } : {} });
}
async function configured(fn, overrides = {}) {
  const vars = { VERCEL: '1', VERCEL_ENV: 'preview', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ALLOW_LIVE_PAYMENTS: 'false',
    FAME_MARKET_ACCOUNT_ID: marketId, FAME_VENDOR_PORTAL_ORIGIN: origin, DATABASE_URL: 'postgres://unused-route-test-only',
    GHL_PAYMENT_EMAIL_ENABLED: 'true', GHL_PAYMENT_DELIVERY_MODE: 'qa', GHL_API_TOKEN: 'test-only-no-network-provider-token',
    GHL_LOCATION_ID: 'aooAnUXF0COePorBo7wL', GHL_QA_APPLICATION_PIPELINE_ID: 'qa-pipeline', GHL_APPLICATION_PIPELINE_ID: 'live-pipeline',
    GHL_PAYMENT_PENDING_STAGE_ID: 'qa-pending-stage', GHL_PAYMENT_EMAIL_FROM: 'nate@autocraftstudios.com',
    GHL_PAYMENT_QA_ROUTING_VERIFIED: 'true', CRON_SECRET: secret, ...overrides };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) value === undefined ? delete process.env[key] : process.env[key] = value;
  try { await fn(); } finally { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; }
}

test('payment email manager endpoints reject anonymous, public demo and another tenant before touching the ledger', () => configured(async () => {
  for (const [actor, expected] of [[null, 401], ['demo-market', 403], ['another-market', 403]]) {
    const calls = []; const route = manager({ actor, calls });
    assert.equal((await route.POST(request(), context)).status, expected);
    assert.equal((await route.GET(request(managerPath, {}, { method: 'GET' }), context)).status, expected);
    assert.equal(calls.length, 0);
  }
}));

test('payment email POST requires the configured same origin and rejects malformed reservation IDs', () => configured(async () => {
  const calls = []; const route = manager({ calls });
  for (const badOrigin of ['https://evil.invalid', 'null', 'http://qa-market.vercel.app']) {
    assert.equal((await route.POST(request(managerPath, {}, { headers: { origin: badOrigin } }), context)).status, 403);
  }
  const invalid = { params: Promise.resolve({ id: '../other-reservation' }) };
  assert.equal((await route.POST(request(), invalid)).status, 400);
  assert.equal((await route.GET(request(managerPath, {}, { method: 'GET' }), invalid)).status, 400);
  assert.equal(calls.length, 0);
}));

test('payment email callers cannot override recipient, identity, amount, URL, or retry semantics', () => configured(async () => {
  const calls = []; const route = manager({ calls });
  const forbidden = [{ recipientEmail: 'someone@example.com' }, { contactId: 'other' }, { marketId: 'other' }, { totalCents: 1 },
    { invitationUrl: 'https://evil.invalid' }, { reservationId: 'other' }, { retryPreflight: false }, { retryPreflight: 'true' },
    { retryPreflight: true, email: 'someone@example.com' }, [], null, 'string'];
  for (const body of forbidden) assert.equal((await route.POST(request(managerPath, body), context)).status, 400);
  assert.equal((await route.POST(request(managerPath, {}, { raw: '{invalid-json' }), context)).status, 400);
  assert.equal((await route.POST(request(managerPath, {}, { headers: { 'content-type': 'text/plain' } }), context)).status, 400);
  assert.equal(calls.length, 0);
}));

test('an intentional send commits the selected reservation queue before dispatching that exact one job', () => configured(async () => {
  const calls = []; const route = manager({ calls });
  const response = await route.POST(request(), context);
  assert.equal(response.status, 202);
  assert.deepEqual(calls.map(call => call.action), ['queue', 'dispatch', 'status']);
  assert.equal(calls[0].value.marketId, marketId); assert.equal(calls[0].value.actorAccountId, marketId);
  assert.equal(calls[0].value.reservationId, reservationId); assert.equal(calls[0].value.retryPreflight, false);
  assert.equal(calls[1].value.notificationId, notice.id); assert.equal(calls[1].value.limit, 1);
  assert.equal(calls[1].value.marketId, marketId);
  assert.deepEqual(calls[2].value, { marketId, reservationId, actorAccountId: marketId });
  assert.deepEqual(await response.json(), { notification: notice });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
}));

test('explicit preflight retry is a server-led queue request and still dispatches only the returned notification', () => configured(async () => {
  const calls = [];
  const route = manager({ calls, queue: async () => ({ kind: 'existing', notification: { ...notice, id: 'persisted-email-job' } }) });
  assert.equal((await route.POST(request(managerPath, { retryPreflight: true }), context)).status, 202);
  assert.equal(calls[0].value.retryPreflight, true);
  assert.equal(calls[1].value.notificationId, 'persisted-email-job');
  assert.equal(calls[1].value.limit, 1);
  assert.equal(calls.filter(c => c.action === 'queue').length, 1);
}));

test('nonexistent, ineligible and rejected-source reservations never dispatch an email', () => configured(async () => {
  for (const [kind, expected] of [['forbidden', 403], ['not_found', 404], ['not_eligible', 409], ['invalid_source', 409]]) {
    const calls = []; const response = await manager({ calls, queue: async () => ({ kind }) }).POST(request(), context);
    assert.equal(response.status, expected); assert.deepEqual(calls.map(c => c.action), ['queue']);
  }
}));

test('GET reads only current manager-scoped delivery status and cannot queue or resend', () => configured(async () => {
  const calls = []; const route = manager({ calls });
  const response = await route.GET(request(managerPath + '?marketId=other&recipientEmail=other@example.com', {}, { method: 'GET' }), context);
  assert.equal(response.status, 200); assert.deepEqual(calls, [{ action: 'status', value: { marketId, reservationId, actorAccountId: marketId } }]);
  assert.deepEqual(await response.json(), { notification: notice });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const missing = await manager({ status: async () => null }).GET(request(managerPath, {}, { method: 'GET' }), context);
  assert.deepEqual(await missing.json(), { notification: null });
}));

test('manager provider/storage failures expose no private diagnostics and do not fall back to unscoped delivery', () => configured(async () => {
  const privateDetail = 'secret-provider-token user-private@example.com postgres://private';
  for (const phase of ['queue', 'dispatch', 'status']) {
    const calls = []; const options = { calls, [phase]: async () => { throw new Error(privateDetail); } };
    const response = await manager(options).POST(request(), context);
    assert.equal(response.status, 503); assert.ok(!(await response.text()).includes(privateDetail));
    assert.equal(calls.filter(c => c.action === 'dispatch').length, phase === 'queue' ? 0 : 1);
  }
  const failedRead = await manager({ status: async () => { throw new Error(privateDetail); } }).GET(request(managerPath, {}, { method: 'GET' }), context);
  assert.equal(failedRead.status, 503); assert.ok(!(await failedRead.text()).includes(privateDetail));
}));

test('disabled payment-email configuration blocks manager queueing and cron storage access', () => configured(async () => {
  const calls = [];
  assert.equal((await manager({ calls }).POST(request(), context)).status, 503);
  assert.equal((await cron({ calls }).GET(scheduler())).status, 503);
  assert.equal(calls.length, 0);
}, { GHL_PAYMENT_EMAIL_ENABLED: 'false' }));

test('payment-email cron requires a valid scheduler credential before any configuration or ledger work', () => configured(async () => {
  const calls = [];
  assert.equal((await cron({ calls }).GET(scheduler(false))).status, 401);
  assert.equal((await cron({ calls }).GET(request(cronPath, {}, { method: 'GET', headers: { authorization: 'Bearer wrong' } }))).status, 401);
  assert.equal(calls.length, 0);
}));

test('payment-email cron refuses an unconfigured secret or unverified QA routing without storage', async () => {
  for (const overrides of [{ CRON_SECRET: undefined }, { CRON_SECRET: 'short' }, { GHL_PAYMENT_QA_ROUTING_VERIFIED: undefined }, { DATABASE_URL: undefined }]) {
    await configured(async () => {
      const calls = []; assert.equal((await cron({ calls }).GET(scheduler())).status, 503); assert.equal(calls.length, 0);
    }, overrides);
  }
});

test('authorized payment-email cron processes one configured-market job and returns only counts', () => configured(async () => {
  const calls = []; const response = await cron({ calls }).GET(scheduler(true, '?marketId=other&notificationId=other-job&limit=100'));
  assert.equal(response.status, 200); assert.equal(calls.length, 1); assert.equal(calls[0].action, 'dispatch');
  assert.equal(calls[0].value.marketId, marketId); assert.equal(calls[0].value.limit, 1); assert.equal(calls[0].value.notificationId, undefined);
  assert.deepEqual(await response.json(), report); assert.equal(response.headers.get('cache-control'), 'no-store');
}));

test('payment-email cron hides provider and database errors instead of reporting false delivery', () => configured(async () => {
  const response = await cron({ dispatch: async () => { throw new Error('private-database-user-email'); } }).GET(scheduler());
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'Payment email recovery is unavailable.' });
}));
