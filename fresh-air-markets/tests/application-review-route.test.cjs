const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const appId = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';

function loadRoute({ authenticated = true, detail, record, deliveryConfigured = false, dispatch, deliver } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/applications/[id]/review/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/auth') return { getSessionAccountId: async () => authenticated ? 'qa-market' : null };
    if (id === '@/lib/application-review-pg') return {
      getApplicationReviewDetail: detail || (async () => ({ id: appId, sourceEventId: 'application:qa:current', reviewState: 'unreviewed', reviewRevision: 0, hasOpportunity: true })),
      recordApplicationReview: record || (async () => ({ kind: 'applied', applicationId: appId, reviewState: 'approved', reviewEventId: 'event', outboxId: 'outbox' })),
      dispatchApplicationReviewOutboxById: dispatch || (async () => ({ delivered: 1, deferred: 0, failed: 0, stale: 0 })),
    };
    if (id === '@/lib/ghl-application-review-delivery') return {
      applicationReviewDeliveryConfigured: () => deliveryConfigured,
      readApplicationReviewDeliveryConfig: () => ({ qa: true }),
      deliverApplicationReviewToGhl: deliver || (async () => {}),
    };
    if (id.startsWith('@/lib/')) return require('../.test-build/' + id.slice(6) + '.js');
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}

function request(body, headers = {}) {
  return new NextRequest('https://unit-test.invalid/', {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

test('application review route requires a signed-in market session before parsing or persisting', async () => {
  let calls = 0;
  const route = loadRoute({ authenticated: false, record: async () => { calls++; throw new Error('must not run'); } });
  const response = await route.PATCH(request(null), { params: Promise.resolve({ id: appId }) });
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('application review route binds the path ID and market session, ignoring client identity fields', async () => {
  let input;
  const route = loadRoute({ record: async value => {
    input = value;
    return { kind: 'applied', applicationId: appId, reviewState: 'approved', reviewEventId: 'event', outboxId: 'outbox' };
  } });
  const response = await route.PATCH(request({
    action: 'approve', sourceEventId: 'application:qa:current',
    contactId: 'attacker-contact', opportunityId: 'attacker-opportunity', marketId: 'attacker-market', email: 'attacker@example.com',
  }, { 'Idempotency-Key': key }), { params: Promise.resolve({ id: appId }) });
  assert.equal(response.status, 200);
  assert.deepEqual(input, {
    applicationId: appId, marketId: 'qa-market', actorAccountId: 'qa-market',
    action: 'approve', sourceEventId: 'application:qa:current', reason: '', idempotencyKey: key,
  });
  assert.deepEqual(await response.json(), { application: { id: appId, reviewState: 'approved' }, reviewEventId: 'event', duplicate: false, delivery: 'queued' });
});

test('application review route rejects malformed identities/replay keys before persistence', async () => {
  let calls = 0;
  const route = loadRoute({ record: async () => { calls++; throw new Error('must not run'); } });
  for (const [id, body, header] of [
    ['not-an-application', { action: 'approve', sourceEventId: 'application:qa:current' }, key],
    [appId, { action: 'approve', sourceEventId: 'application:qa:current' }, 'bad'],
    [appId, { action: 'request_changes', sourceEventId: 'application:qa:current', reason: '  ' }, key],
  ]) {
    const response = await route.PATCH(request(body, { 'Idempotency-Key': header }), { params: Promise.resolve({ id }) });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('application review route exposes only scoped detail and maps non-mutating replay failures safely', async () => {
  const route = loadRoute({
    detail: async (id, market) => id === appId && market === 'qa-market'
      ? { id: appId, sourceEventId: 'application:qa:current', reviewState: 'unreviewed', reviewRevision: 0, hasOpportunity: true }
      : null,
    record: async () => ({ kind: 'stale_source', sourceEventId: 'application:qa:new' }),
  });
  const get = await route.GET(new NextRequest('https://unit-test.invalid/'), { params: Promise.resolve({ id: appId }) });
  assert.equal(get.status, 200);
  assert.equal((await get.json()).application.sourceEventId, 'application:qa:current');
  const patch = await route.PATCH(request({ action: 'approve', sourceEventId: 'application:qa:current' }, { 'Idempotency-Key': key }), { params: Promise.resolve({ id: appId }) });
  assert.equal(patch.status, 409);
  assert.deepEqual(await patch.json(), { error: 'Application changed; reload before reviewing.' });
});

test('an idempotent replay immediately retries only its original exact outbox job when delivery becomes available', async () => {
  let dispatched;
  let delivered = 0;
  const route = loadRoute({
    deliveryConfigured: true,
    record: async () => ({ kind: 'duplicate', applicationId: appId, reviewState: 'approved', reviewEventId: 'event', outboxId: 'outbox' }),
    dispatch: async (id, callback, options) => {
      dispatched = { id, options };
      await callback({ id: 'outbox' });
      return { delivered: 1, deferred: 0, failed: 0, stale: 0 };
    },
    deliver: async () => { delivered++; },
  });
  const response = await route.PATCH(request({ action: 'approve', sourceEventId: 'application:qa:current' }, { 'Idempotency-Key': key }), { params: Promise.resolve({ id: appId }) });
  assert.equal(response.status, 200);
  assert.deepEqual(dispatched, { id: 'outbox', options: undefined });
  assert.equal(delivered, 1);
  assert.deepEqual(await response.json(), { application: { id: appId, reviewState: 'approved' }, reviewEventId: 'event', duplicate: true, delivery: 'delivered' });
});
