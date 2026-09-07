const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const postgres = require('postgres');
const {
  claimAgreementNotificationOutbox,
  dispatchAgreementNotificationOutbox,
  markAgreementNotificationDelivered,
  persistAgreementCompletion,
  persistAgreementIssuance,
  retryAgreementNotificationOutbox,
} = require('../../.test-build/agreement-completion-pg.js');

// This suite creates and drops only a private schema inside the disposable CI DB.
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = 'qa_agreement_completion';
const admin = postgres(url.toString(), { max: 1, prepare: false });
const connect = () => postgres(url.toString(), {
  max: 10,
  prepare: false,
  connection: { search_path: schema, statement_timeout: 15000 },
});
const first = connect();
const second = connect();
const market = 'qa-agreement-market';
const otherMarket = 'qa-agreement-other-market';
const location = 'qa-agreement-location';
const template = 'qa-agreement-template';

before(async () => {
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await first`CREATE TABLE accounts (id TEXT PRIMARY KEY)`;
  await first`INSERT INTO accounts (id) VALUES (${market}), (${otherMarket})`;
  const migration = postgres(url.toString(), { max: 1, prepare: false, connection: { search_path: schema } });
  try {
    await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations/001-application-handoff.sql'), 'utf8'));
    await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations/005-agreement-completion-outbox.sql'), 'utf8'));
  } finally {
    await migration.end();
  }
});

beforeEach(async () => {
  await first`TRUNCATE fame_agreement_notification_outbox, fame_agreement_completions,
    fame_agreement_issuances, fame_agreement_events, fame_application_events,
    fame_applications`;
});

after(async () => {
  await first.end();
  await second.end();
  await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

async function seedApplication(patch = {}) {
  const applicationId = patch.applicationId || randomUUID();
  const marketId = patch.marketId || market;
  const contactId = patch.contactId || `contact:${applicationId}`;
  const seasonId = patch.seasonId || '2026-2027';
  const opportunityId = patch.opportunityId === undefined ? `opportunity:${applicationId}` : patch.opportunityId;
  await first`
    INSERT INTO fame_applications (id, market_id, location_id, contact_id, season_id, opportunity_id)
    VALUES (${applicationId}, ${marketId}, ${location}, ${contactId}, ${seasonId}, ${opportunityId})`;
  return { applicationId, marketId, contactId, seasonId, opportunityId };
}

function issued(application, patch = {}) {
  const eventId = patch.eventId || `issue:${randomUUID()}`;
  const documentId = patch.documentId || `document:${randomUUID()}`;
  return {
    eventId,
    documentId,
    templateId: patch.templateId || template,
    contactId: patch.contactId || application.contactId,
    opportunityId: patch.opportunityId || application.opportunityId,
    locationId: patch.locationId || location,
    marketId: patch.marketId || application.marketId,
    seasonId: patch.seasonId || application.seasonId,
    notificationEmail: patch.notificationEmail || 'nate@autocraftstudios.com',
    payloadHash: patch.payloadHash || `hash:${eventId}`,
  };
}

function completed(issue, patch = {}) {
  const eventId = patch.eventId || `complete:${randomUUID()}`;
  return {
    ...issue,
    ...patch,
    eventId,
    payloadHash: patch.payloadHash || `hash:${eventId}`,
    status: 'completed',
  };
}

test('100 concurrent source retries bind one exact document, then create one completion and one QA-notice job', async () => {
  const application = await seedApplication();
  const issue = issued(application, { eventId: 'issue:race', documentId: 'document:race', payloadHash: 'issue-hash' });
  const issuedResults = await Promise.all(Array.from({ length: 100 }, (_, i) => persistAgreementIssuance(issue, i % 2 ? first : second)));
  assert.equal(issuedResults.filter(result => result === 'captured').length, 1);
  assert.equal(issuedResults.filter(result => result === 'duplicate').length, 99);

  const completion = completed(issue, { eventId: 'complete:race', payloadHash: 'complete-hash' });
  const completeResults = await Promise.all(Array.from({ length: 100 }, (_, i) => persistAgreementCompletion(completion, i % 2 ? first : second)));
  assert.equal(completeResults.filter(result => result === 'captured').length, 1);
  assert.equal(completeResults.filter(result => result === 'duplicate').length, 99);
  const [stored] = await first`SELECT * FROM fame_agreement_completions`;
  const [outbox] = await first`SELECT * FROM fame_agreement_notification_outbox`;
  assert.equal(stored.application_id, application.applicationId);
  assert.equal(stored.document_id, issue.documentId);
  assert.equal(stored.contact_id, application.contactId);
  assert.equal(stored.opportunity_id, application.opportunityId);
  assert.equal(outbox.recipient_email, 'nate@autocraftstudios.com');
  assert.equal(outbox.payload.applicationId, application.applicationId);
  assert.equal((await first`SELECT * FROM fame_agreement_events`).length, 2);
});

test('wrong contact, opportunity, template, location or document cannot change a bound application or enqueue a notice', async () => {
  const application = await seedApplication();
  const issue = issued(application, { eventId: 'issue:mismatch', documentId: 'document:mismatch' });
  assert.equal(await persistAgreementIssuance(issue, first), 'captured');
  const invalid = [
    completed(issue, { eventId: 'complete:wrong-contact', contactId: 'other-contact' }),
    completed(issue, { eventId: 'complete:wrong-opportunity', opportunityId: 'other-opportunity' }),
    completed(issue, { eventId: 'complete:wrong-template', templateId: 'other-template' }),
    completed(issue, { eventId: 'complete:wrong-location', locationId: 'other-location' }),
    completed(issue, { eventId: 'complete:wrong-season', seasonId: '2027-2028' }),
    completed(issue, { eventId: 'complete:wrong-market', marketId: otherMarket }),
    completed(issue, { eventId: 'complete:unknown-document', documentId: 'unknown-document' }),
  ];
  for (const event of invalid) await assert.rejects(persistAgreementCompletion(event, second), /Agreement does not match/);
  assert.equal((await first`SELECT * FROM fame_agreement_completions`).length, 0);
  assert.equal((await first`SELECT * FROM fame_agreement_notification_outbox`).length, 0);
  assert.equal((await first`SELECT * FROM fame_agreement_events`).length, 1);
  assert.equal((await first`SELECT * FROM fame_agreement_issuances WHERE document_id = ${issue.documentId}`).length, 1);
});

test('a newer unsigned issuance supersedes the old document and an old completion cannot sign the current application', async () => {
  const application = await seedApplication();
  const oldIssue = issued(application, { eventId: 'issue:old', documentId: 'document:old' });
  const currentIssue = issued(application, { eventId: 'issue:current', documentId: 'document:current' });
  assert.equal(await persistAgreementIssuance(oldIssue, first), 'captured');
  assert.equal(await persistAgreementIssuance(currentIssue, second), 'captured');
  await assert.rejects(persistAgreementCompletion(completed(oldIssue, { eventId: 'complete:old' }), first), /Agreement does not match/);
  assert.equal(await persistAgreementCompletion(completed(currentIssue, { eventId: 'complete:current' }), second), 'captured');
  const rows = await first`SELECT document_id, superseded_at FROM fame_agreement_issuances ORDER BY document_id`;
  assert.equal(rows[0].document_id, 'document:current');
  assert.equal(rows[0].superseded_at, null);
  assert.equal(rows[1].document_id, 'document:old');
  assert.ok(rows[1].superseded_at);
  const [completion] = await first`SELECT document_id FROM fame_agreement_completions`;
  assert.equal(completion.document_id, 'document:current');
});

test('a completed application rejects a second document and preserves the original completion and notification', async () => {
  const application = await seedApplication();
  const initial = issued(application, { eventId: 'issue:initial', documentId: 'document:initial' });
  assert.equal(await persistAgreementIssuance(initial, first), 'captured');
  assert.equal(await persistAgreementCompletion(completed(initial, { eventId: 'complete:initial' }), second), 'captured');
  await assert.rejects(persistAgreementIssuance(issued(application, { eventId: 'issue:replacement', documentId: 'document:replacement' }), first), /already been completed/);
  assert.equal((await first`SELECT * FROM fame_agreement_completions`).length, 1);
  assert.equal((await first`SELECT * FROM fame_agreement_notification_outbox`).length, 1);
  assert.equal((await first`SELECT * FROM fame_agreement_issuances`).length, 1);
});

test('outbox leases fence stale workers and safely replay failed notification delivery without sending a real email', async () => {
  const application = await seedApplication();
  const issue = issued(application, { eventId: 'issue:lease', documentId: 'document:lease' });
  await persistAgreementIssuance(issue, first);
  await persistAgreementCompletion(completed(issue, { eventId: 'complete:lease' }), second);
  const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => claimAgreementNotificationOutbox(1, 30, i % 2 ? first : second)));
  const jobs = claims.flat();
  assert.equal(jobs.length, 1);
  const original = jobs[0];
  await first`UPDATE fame_agreement_notification_outbox SET locked_until = statement_timestamp() - interval '1 second' WHERE id = ${original.id}`;
  assert.equal(await markAgreementNotificationDelivered(original.id, original.leaseToken, first), false);
  const [replacement] = await claimAgreementNotificationOutbox(1, 30, second);
  assert.ok(replacement);
  assert.notEqual(replacement.leaseToken, original.leaseToken);
  assert.equal(await markAgreementNotificationDelivered(original.id, original.leaseToken, first), false);
  assert.equal(await retryAgreementNotificationOutbox(replacement.id, replacement.leaseToken, 'delivery_failed', 1, second), true);
  await first`UPDATE fame_agreement_notification_outbox SET next_attempt_at = statement_timestamp() - interval '1 second' WHERE id = ${replacement.id}`;
  const failed = await dispatchAgreementNotificationOutbox(async () => { throw new Error('private provider diagnostic'); }, { sql: first });
  assert.deepEqual(failed, { delivered: 0, deferred: 1, stale: 0 });
  await first`UPDATE fame_agreement_notification_outbox SET next_attempt_at = statement_timestamp() - interval '1 second' WHERE id = ${replacement.id}`;
  const deliveredTo = [];
  const success = await dispatchAgreementNotificationOutbox(async job => { deliveredTo.push(job.recipientEmail); }, { sql: second });
  assert.deepEqual(success, { delivered: 1, deferred: 0, stale: 0 });
  assert.deepEqual(deliveredTo, ['nate@autocraftstudios.com']);
  assert.deepEqual(await dispatchAgreementNotificationOutbox(async () => { throw new Error('must not run'); }, { sql: first }), { delivered: 0, deferred: 0, stale: 0 });
  const [stored] = await first`SELECT status, attempts, last_error_code, delivered_at FROM fame_agreement_notification_outbox`;
  assert.equal(stored.status, 'delivered');
  assert.equal(stored.last_error_code, null);
  assert.ok(stored.attempts >= 4);
  assert.ok(stored.delivered_at);
});

test('a failed notification-row write rolls back the completion event and admits an exact retry after repair', async () => {
  const application = await seedApplication();
  const issue = issued(application, { eventId: 'issue:rollback', documentId: 'document:rollback' });
  const completion = completed(issue, { eventId: 'complete:rollback' });
  await persistAgreementIssuance(issue, first);
  await first.unsafe(`CREATE FUNCTION qa_agreement_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected agreement outbox failure'; END $$`);
  await first.unsafe('CREATE TRIGGER qa_agreement_fail_outbox BEFORE INSERT ON fame_agreement_notification_outbox FOR EACH ROW EXECUTE FUNCTION qa_agreement_fail_outbox()');
  try {
    await assert.rejects(persistAgreementCompletion(completion, first), /injected agreement outbox failure/);
    assert.equal((await first`SELECT * FROM fame_agreement_completions`).length, 0);
    assert.equal((await first`SELECT * FROM fame_agreement_notification_outbox`).length, 0);
    assert.equal((await first`SELECT * FROM fame_agreement_events`).length, 1);
  } finally {
    await first.unsafe('DROP TRIGGER qa_agreement_fail_outbox ON fame_agreement_notification_outbox');
    await first.unsafe('DROP FUNCTION qa_agreement_fail_outbox()');
  }
  assert.equal(await persistAgreementCompletion(completion, second), 'captured');
  assert.equal((await first`SELECT * FROM fame_agreement_completions`).length, 1);
  assert.equal((await first`SELECT * FROM fame_agreement_notification_outbox`).length, 1);
  assert.equal((await first`SELECT * FROM fame_agreement_events`).length, 2);
});
