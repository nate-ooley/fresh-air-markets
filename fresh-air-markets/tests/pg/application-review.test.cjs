const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const postgres = require('postgres');
const {
  claimApplicationReviewOutbox,
  dispatchApplicationReviewOutboxById,
  dispatchApplicationReviewOutbox,
  markApplicationReviewOutboxDelivered,
  recordApplicationReview,
  retryApplicationReviewOutbox,
} = require('../../.test-build/application-review-pg.js');

// This suite creates and drops only a private schema inside the disposable CI DB.
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = 'qa_application_review';
const admin = postgres(url.toString(), { max: 1, prepare: false });
const connect = () => postgres(url.toString(), {
  max: 10,
  prepare: false,
  connection: { search_path: schema, statement_timeout: 15000 },
});
const first = connect();
const second = connect();
const market = 'qa-review-market';
const otherMarket = 'qa-review-other-market';
const location = 'qa-review-location';

before(async () => {
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await first`CREATE TABLE accounts (id TEXT PRIMARY KEY)`;
  await first`INSERT INTO accounts (id) VALUES (${market}), (${otherMarket})`;
  const migration = postgres(url.toString(), { max: 1, prepare: false, connection: { search_path: schema } });
  try {
    await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations/001-application-handoff.sql'), 'utf8'));
    await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations/004-application-review-outbox.sql'), 'utf8'));
  } finally {
    await migration.end();
  }
});

beforeEach(async () => {
  await first`TRUNCATE fame_application_review_events, fame_application_outbox, fame_application_events, fame_applications`;
});

after(async () => {
  await first.end();
  await second.end();
  await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

async function seedApplication(patch = {}) {
  const applicationId = patch.applicationId || randomUUID();
  const eventId = patch.eventId || `application:qa:${applicationId}`;
  const marketId = patch.marketId || market;
  const contactId = patch.contactId || `contact:${applicationId}`;
  const seasonId = patch.seasonId || '2026-2027';
  const opportunityId = patch.opportunityId === undefined ? `opportunity:${applicationId}` : patch.opportunityId;
  await first`
    INSERT INTO fame_applications (id, market_id, location_id, contact_id, season_id, opportunity_id)
    VALUES (${applicationId}, ${marketId}, ${location}, ${contactId}, ${seasonId}, ${opportunityId})`;
  await first`
    INSERT INTO fame_application_events
      (location_id, event_id, market_id, application_id, payload_hash, snapshot)
    VALUES (${location}, ${eventId}, ${marketId}, ${applicationId}, ${`hash:${eventId}`}, ${first.json({ source: 'qa' })})`;
  return { applicationId, eventId, marketId, contactId, seasonId, opportunityId };
}

function decision(application, patch = {}) {
  return {
    applicationId: application.applicationId,
    marketId: application.marketId,
    actorAccountId: application.marketId,
    sourceEventId: application.eventId,
    idempotencyKey: patch.idempotencyKey || randomUUID(),
    action: patch.action || 'approve',
    reason: patch.reason || '',
  };
}

test('100 concurrent exact approvals create one audit decision and one durable application outbox job', async () => {
  const application = await seedApplication();
  const input = decision(application, { idempotencyKey: '11111111-1111-4111-8111-111111111111' });
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) =>
    recordApplicationReview(input, i % 2 ? first : second)));
  assert.equal(results.filter(result => result.kind === 'applied').length, 1);
  assert.equal(results.filter(result => result.kind === 'duplicate').length, 99);
  const [stored] = await first`SELECT review_state, review_revision, reviewed_by_account_id FROM fame_applications`;
  assert.deepEqual(stored, { review_state: 'approved', review_revision: 1, reviewed_by_account_id: market });
  const audits = await first`SELECT * FROM fame_application_review_events`;
  const outbox = await first`SELECT * FROM fame_application_outbox`;
  assert.equal(audits.length, 1);
  assert.equal(outbox.length, 1);
  assert.equal(audits[0].outbox_id, outbox[0].id);
  assert.equal(outbox[0].payload.applicationId, application.applicationId);
  assert.equal(outbox[0].payload.opportunityId, application.opportunityId);
  assert.equal(outbox[0].payload.sourceEventId, application.eventId);
});

test('reusing a review key with changed content conflicts before a later terminal decision can be overwritten', async () => {
  const application = await seedApplication();
  const key = '22222222-2222-4222-8222-222222222222';
  assert.equal((await recordApplicationReview(decision(application, { idempotencyKey: key }), first)).kind, 'applied');
  assert.equal((await recordApplicationReview(decision(application, {
    idempotencyKey: key, action: 'decline', reason: 'Changed request',
  }), second)).kind, 'conflict');
  assert.equal((await recordApplicationReview(decision(application, {
    idempotencyKey: '33333333-3333-4333-8333-333333333333', action: 'decline', reason: 'Later click',
  }), first)).kind, 'terminal');
  assert.equal((await first`SELECT * FROM fame_application_review_events`).length, 1);
  assert.equal((await first`SELECT * FROM fame_application_outbox`).length, 1);
});

test('wrong market, missing CRM opportunity and a stale source event all stop before a review audit or outbound work', async () => {
  const application = await seedApplication();
  const newer = 'application:qa:newer';
  await first`
    INSERT INTO fame_application_events
      (location_id, event_id, market_id, application_id, payload_hash, snapshot)
    VALUES (${location}, ${newer}, ${market}, ${application.applicationId}, 'newer-hash', ${first.json({ source: 'newer' })})`;
  assert.deepEqual(
    await recordApplicationReview(decision(application, { idempotencyKey: '44444444-4444-4444-8444-444444444444' }), first),
    { kind: 'stale_source', sourceEventId: newer },
  );
  const missing = await seedApplication({ opportunityId: null });
  assert.equal((await recordApplicationReview(decision(missing, { idempotencyKey: '55555555-5555-4555-8555-555555555555' }), second)).kind, 'missing_opportunity');
  assert.equal((await recordApplicationReview({
    ...decision(application, { idempotencyKey: '66666666-6666-4666-8666-666666666666' }), marketId: otherMarket, actorAccountId: otherMarket, sourceEventId: newer,
  }, first)).kind, 'not_found');
  assert.equal((await first`SELECT * FROM fame_application_review_events`).length, 0);
  assert.equal((await first`SELECT * FROM fame_application_outbox`).length, 0);
});

test('a correction requires a newer captured source event before a later approval, while a different application remains untouched', async () => {
  const application = await seedApplication();
  const sibling = await seedApplication({ contactId: application.contactId, seasonId: '2027-2028' });
  assert.equal((await recordApplicationReview(decision(application, {
    idempotencyKey: '77777777-7777-4777-8777-777777777777', action: 'request_changes', reason: 'Upload the current certificate.',
  }), first)).kind, 'applied');
  assert.equal((await recordApplicationReview(decision(application, {
    idempotencyKey: '88888888-8888-4888-8888-888888888888', action: 'approve',
  }), second)).kind, 'awaiting_resubmission');
  const newEvent = 'application:qa:resubmitted';
  await first`
    INSERT INTO fame_application_events
      (location_id, event_id, market_id, application_id, payload_hash, snapshot)
    VALUES (${location}, ${newEvent}, ${market}, ${application.applicationId}, 'resubmitted-hash', ${first.json({ source: 'resubmitted' })})`;
  assert.equal((await recordApplicationReview({
    ...decision(application, { idempotencyKey: '99999999-9999-4999-8999-999999999999', action: 'approve' }), sourceEventId: newEvent,
  }, first)).kind, 'applied');
  const rows = await first`SELECT id, review_state FROM fame_applications ORDER BY season_id`;
  assert.deepEqual(rows.map(row => row.review_state), ['approved', 'unreviewed']);
  assert.equal(rows.find(row => row.id === sibling.applicationId).review_state, 'unreviewed');
});

test('outbox leases prevent duplicate delivery and recover safely after worker failure or an expired lease', async () => {
  const application = await seedApplication();
  assert.equal((await recordApplicationReview(decision(application), first)).kind, 'applied');
  const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => claimApplicationReviewOutbox(1, 30, i % 2 ? first : second)));
  const jobs = claims.flat();
  assert.equal(jobs.length, 1);
  const original = jobs[0];
  await first`UPDATE fame_application_outbox SET locked_until = statement_timestamp() - interval '1 second' WHERE id = ${original.id}`;
  const [replacement] = await claimApplicationReviewOutbox(1, 30, second);
  assert.ok(replacement);
  assert.notEqual(replacement.leaseToken, original.leaseToken);
  assert.equal(await markApplicationReviewOutboxDelivered(original.id, original.leaseToken, first), false);
  assert.equal(await retryApplicationReviewOutbox(replacement.id, replacement.leaseToken, 'delivery_failed', 1, second), true);
  await first`UPDATE fame_application_outbox SET next_attempt_at = statement_timestamp() - interval '1 second' WHERE id = ${replacement.id}`;
  const received = [];
  const failed = await dispatchApplicationReviewOutbox(async () => { throw new Error('private upstream diagnostic'); }, { sql: first });
  assert.deepEqual(failed, { delivered: 0, deferred: 1, stale: 0 });
  const [afterFailure] = await first`SELECT attempts, last_error_code, next_attempt_at FROM fame_application_outbox WHERE id = ${replacement.id}`;
  assert.equal(afterFailure.last_error_code, 'delivery_failed');
  await first`UPDATE fame_application_outbox SET next_attempt_at = statement_timestamp() - interval '1 second' WHERE id = ${replacement.id}`;
  const success = await dispatchApplicationReviewOutbox(async job => { received.push(job); }, { sql: second });
  assert.deepEqual(success, { delivered: 1, deferred: 0, stale: 0 });
  assert.equal(received.length, 1);
  assert.equal(received[0].payload.applicationId, application.applicationId);
  assert.equal(received[0].payload.opportunityId, application.opportunityId);
  assert.deepEqual(await dispatchApplicationReviewOutbox(async () => { throw new Error('must not run'); }, { sql: first }), { delivered: 0, deferred: 0, stale: 0 });
  const [stored] = await first`SELECT status, attempts, delivered_at FROM fame_application_outbox WHERE id = ${replacement.id}`;
  assert.equal(stored.status, 'delivered');
  assert.ok(stored.attempts >= 4);
  assert.ok(stored.delivered_at);
});

test('an immediate exact-job delivery and a concurrent scheduler sweep claim one job and make one provider call', async () => {
  const application = await seedApplication();
  const result = await recordApplicationReview(decision(application), first);
  assert.equal(result.kind, 'applied');
  const delivered = [];
  const [immediate, scheduled] = await Promise.all([
    dispatchApplicationReviewOutboxById(result.outboxId, async job => { delivered.push(`immediate:${job.id}`); }, { sql: first }),
    dispatchApplicationReviewOutbox(async job => { delivered.push(`scheduled:${job.id}`); }, { sql: second }),
  ]);
  assert.equal(immediate.delivered + scheduled.delivered, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].endsWith(result.outboxId), true);
  const [stored] = await first`SELECT status FROM fame_application_outbox WHERE id = ${result.outboxId}`;
  assert.equal(stored.status, 'delivered');
});
