const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const appId = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';

function loadRoute({ authenticated = true, detail, record, deliveryConfigured = false, dispatch, deliver, outboxStatus } = {}) {
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
      getApplicationReviewDetail: detail || (async () => ({
        id: appId, sourceEventId: 'application:qa:current', reviewState: 'unreviewed', reviewRevision: 0, hasOpportunity: true,
        identitySnapshot: {
          vendorName: 'QA Vendor', businessName: 'QA Booth', email: 'nate@autocraftstudios.com', applicantType: 'Vendor',
          dates: ['2027-05-29'], fullSeason: false, requiresFinalDateConfirmation: false, category: 'Produce', details: null,
        },
      })),
      getApplicationReviewOutboxStatus: outboxStatus || (async () => deliveryConfigured ? 'delivered' : 'pending'),
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
  assert.deepEqual(await response.json(), { application: { id: appId, reviewState: 'approved' }, reviewEventId: 'event', duplicate: false, delivery: 'queued', vendorNotification: 'not_sent' });
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
      ? {
        id: appId, sourceEventId: 'application:qa:current', reviewState: 'unreviewed', reviewRevision: 0, hasOpportunity: true,
        identitySnapshot: {
          vendorName: 'QA Vendor', businessName: 'QA Booth', email: 'nate@autocraftstudios.com', applicantType: 'Vendor',
          dates: ['2027-05-29'], fullSeason: false, requiresFinalDateConfirmation: false, category: 'Produce', details: null,
        },
      }
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

test('application review route keeps incomplete identity snapshot failures non-mutating', async () => {
  const route = loadRoute({ record: async () => ({ kind: 'missing_identity_snapshot' }) });
  const response = await route.PATCH(
    request({ action: 'approve', sourceEventId: 'application:qa:current' }, { 'Idempotency-Key': key }),
    { params: Promise.resolve({ id: appId }) },
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'The latest application snapshot is incomplete. Reload after a complete vendor submission is captured.',
  });
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
  assert.deepEqual(await response.json(), { application: { id: appId, reviewState: 'approved' }, reviewEventId: 'event', duplicate: true, delivery: 'delivered', vendorNotification: 'not_sent' });
});


test('correction API distinguishes unsent vendor notice from delivered, queued or failed CRM reconciliation', async () => {
  for (const [kind, delivered, failed] of [['applied', 1, 0], ['applied', 0, 0], ['applied', 0, 1], ['duplicate', 1, 0]]) {
    let saved;
    const route = loadRoute({ deliveryConfigured: true,
      record: async input => { saved = input; return { kind, applicationId: appId, reviewState: 'changes_requested', reviewEventId: 'review-correction', outboxId: 'correction-outbox' }; },
      dispatch: async id => { assert.equal(id, 'correction-outbox'); return { delivered, failed, deferred: 0, stale: 0 }; },
      outboxStatus: async () => delivered ? 'delivered' : failed ? 'failed' : 'pending',
    });
    const response = await route.PATCH(request({ action: 'request_changes', sourceEventId: 'application:qa:current',
      reason: '  Please correct the business name.  ' }, { 'Idempotency-Key': key }), { params: Promise.resolve({ id: appId }) });
    assert.equal(response.status, 200); assert.equal(saved.reason, 'Please correct the business name.');
    assert.deepEqual(await response.json(), { application: { id: appId, reviewState: 'changes_requested' },
      reviewEventId: 'review-correction', duplicate: kind === 'duplicate', delivery: delivered ? 'delivered' : failed ? 'failed' : 'queued', vendorNotification: 'not_sent' });
  }
});

test('correction API reports not_sent when CRM is not configured and does not attempt a notification', async () => {
  let dispatched = 0;
  const route = loadRoute({ record: async () => ({ kind: 'applied', applicationId: appId, reviewState: 'changes_requested', reviewEventId: 'correction', outboxId: 'outbox' }),
    dispatch: async () => { dispatched++; throw new Error('not configured'); } });
  const response = await route.PATCH(request({ action: 'request_changes', sourceEventId: 'application:qa:current', reason: 'Correct this name.' },
    { 'Idempotency-Key': key }), { params: Promise.resolve({ id: appId }) });
  const body = await response.json(); assert.equal(body.vendorNotification, 'not_sent'); assert.equal(body.delivery, 'queued');
  assert.equal(dispatched, 0);
});


test('duplicate review with no claimed work preserves authoritative delivered or failed status in its exact scope', async () => {
  for (const status of ['failed', 'delivered', 'pending', 'processing']) {
    for (const deliveryConfigured of [true, false]) {
      const events = [];
      const route = loadRoute({ deliveryConfigured,
        record: async () => ({ kind: 'duplicate', applicationId: appId, reviewState: 'changes_requested', reviewEventId: 'original-review', outboxId: 'original-outbox' }),
        dispatch: async id => { events.push(['dispatch', id]); return { delivered: 0, failed: 0, deferred: 0, stale: 0 }; },
        outboxStatus: async scope => { events.push(['status', scope]); return status; },
      });
      const response = await route.PATCH(request({ action: 'request_changes', sourceEventId: 'application:qa:current', reason: 'Correct the business name.',
        marketId: 'foreign-market', applicationId: 'foreign-application', outboxId: 'foreign-job' }, { 'Idempotency-Key': key }), { params: Promise.resolve({ id: appId }) });
      assert.equal(response.status, 200);
      assert.deepEqual(events, [ ...(deliveryConfigured ? [['dispatch', 'original-outbox']] : []), ['status', {
        outboxId: 'original-outbox', reviewEventId: 'original-review', applicationId: appId, marketId: 'qa-market',
      }] ]);
      const body = await response.json(); assert.equal(body.delivery, ['pending', 'processing'].includes(status) ? 'queued' : status);
      assert.equal(body.vendorNotification, 'not_sent'); assert.equal(body.duplicate, true);
    }
  }
});

test('missing, foreign or unavailable stored review status stays unknown rather than falsely queued or delivered', async () => {
  for (const outboxStatus of [async () => null, async () => { throw new Error('private-vendor-and-token'); }]) {
    const route = loadRoute({ deliveryConfigured: true, outboxStatus,
      // Even a successful dispatch count is not a replacement for the exact stored result.
      dispatch: async () => ({ delivered: 1, failed: 0, deferred: 0, stale: 0 }),
      record: async () => ({ kind: 'duplicate', applicationId: appId, reviewState: 'changes_requested', reviewEventId: 'review', outboxId: 'outbox' }),
    });
    const response = await route.PATCH(request({ action: 'request_changes', sourceEventId: 'application:qa:current', reason: 'Correct the business name.' },
      { 'Idempotency-Key': key }), { params: Promise.resolve({ id: appId }) });
    assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.delivery, 'unknown'); assert.equal(body.vendorNotification, 'not_sent'); assert.doesNotMatch(JSON.stringify(body), /private-vendor-and-token/);
  }
});
