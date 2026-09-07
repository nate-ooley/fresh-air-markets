const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');
const {
  dispatchApplicationDocumentOutbox,
  claimApplicationDocumentOutbox,
  markApplicationDocumentOutboxDelivered,
  persistApplicationDocumentSource,
  recordApplicationDocumentReview,
  recordApplicationDocumentScan,
  retryApplicationDocumentOutbox,
} = require('../../.test-build/application-document-pg.js');

// Destructive fixtures are limited to the disposable local CI database.
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = 'qa_application_document';
const admin = postgres(url.toString(), { max: 1, prepare: false });
const connect = () => postgres(url.toString(), {
  max: 12,
  prepare: false,
  connection: { search_path: schema, statement_timeout: 15000 },
});
const first = connect();
const second = connect();

const applicationId = '11111111-1111-4111-8111-111111111111';
const marketId = 'qa-market-a';
const locationId = 'qa-location';
const actorAccountId = 'qa-admin';

const source = (patch = {}) => ({
  eventId: 'qa-document-event-1',
  applicationId,
  marketId,
  locationId,
  kind: 'insurance',
  submittedAt: '2026-09-07T19:00:00.000Z',
  file: {
    storageKey: 'documents/qa/insurance-v1.pdf',
    sourceFileId: 'qa-file-1',
    filename: 'insurance.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
  },
  ...patch,
});

async function insertApplication(sql = first, opportunityId = 'qa-opportunity') {
  await sql`
    INSERT INTO fame_applications (id, market_id, location_id, contact_id, season_id, opportunity_id)
    VALUES (${applicationId}, ${marketId}, ${locationId}, 'qa-contact', '2026-2027', ${opportunityId})`;
}

before(async () => {
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await first`CREATE TABLE accounts (id TEXT PRIMARY KEY)`;
  await first`INSERT INTO accounts (id) VALUES (${marketId}), ('qa-market-b'), (${actorAccountId}) ON CONFLICT DO NOTHING`;
  const migration = postgres(url.toString(), { max: 1, prepare: false, connection: { search_path: schema } });
  try {
    for (const file of ['001-application-handoff.sql', '006-application-document-ledger.sql', '008-application-opportunity-identity.sql']) {
      await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations', file), 'utf8'));
    }
  } finally {
    await migration.end();
  }
});

beforeEach(async () => {
  await first`TRUNCATE fame_document_review_events, fame_document_validation_events,
    fame_document_source_events, fame_document_outbox, fame_application_documents,
    fame_application_events, fame_applications`;
  await insertApplication();
});

after(async () => {
  await first.end();
  await second.end();
  await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

test('100 concurrent exact upload deliveries create one pending version and one durable submission job', async () => {
  const results = await Promise.all(Array.from({ length: 100 }, (_, index) => persistApplicationDocumentSource(source(), index % 2 ? first : second)));
  assert.equal(results.filter(result => result.kind === 'captured').length, 1);
  assert.equal(results.filter(result => result.kind === 'duplicate').length, 99);
  const documents = await first`SELECT * FROM fame_application_documents`;
  const events = await first`SELECT * FROM fame_document_source_events`;
  const outbox = await first`SELECT * FROM fame_document_outbox`;
  assert.equal(documents.length, 1);
  assert.equal(events.length, 1);
  assert.equal(outbox.length, 1);
  assert.equal(documents[0].version, 1);
  assert.equal(documents[0].is_current, true);
  assert.equal(documents[0].validation_state, 'pending_scan');
  assert.equal(documents[0].review_state, 'submitted');
  assert.equal(outbox[0].topic, 'document-submitted');
});

test('reusing a source event with changed file metadata conflicts without replacing the saved version', async () => {
  const firstWrite = await persistApplicationDocumentSource(source(), first);
  assert.equal(firstWrite.kind, 'captured');
  const changed = await persistApplicationDocumentSource(source({
    file: { ...source().file, sha256: 'b'.repeat(64), storageKey: 'documents/qa/insurance-replaced.pdf' },
  }), second);
  assert.deepEqual(changed, { kind: 'conflict' });
  const [document] = await first`SELECT source_file_id, storage_key, content_sha256 FROM fame_application_documents`;
  assert.deepEqual(document, {
    source_file_id: 'qa-file-1',
    storage_key: 'documents/qa/insurance-v1.pdf',
    content_sha256: 'a'.repeat(64),
  });
});

test('a separate event for the same verified source file keeps the approved version and creates no duplicate submission job', async () => {
  const firstVersion = await persistApplicationDocumentSource(source(), first);
  assert.equal(firstVersion.kind, 'captured');
  if (firstVersion.kind !== 'captured') return;
  await recordApplicationDocumentScan({
    documentId: firstVersion.document.id, marketId, expectedVersion: 1,
    sourceEventId: 'qa-same-source-scan', outcome: 'clean', reason: '',
  }, first);
  await recordApplicationDocumentReview({
    documentId: firstVersion.document.id, marketId, actorAccountId, expectedVersion: 1,
    idempotencyKey: '12345678-1234-4234-8234-123456789012', action: 'approve', reason: '',
  }, first);

  const duplicate = await persistApplicationDocumentSource(source({
    eventId: 'qa-document-event-same-file',
    submittedAt: '2026-09-07T20:00:00.000Z',
    file: {
      ...source().file,
      sourceFileId: 'qa-file-retransferred-v1',
      storageKey: 'documents/qa/retransferred-insurance-v1.pdf',
    },
  }), second);
  assert.equal(duplicate.kind, 'duplicate');
  if (duplicate.kind !== 'duplicate') return;
  assert.equal(duplicate.document.id, firstVersion.document.id);
  assert.equal(duplicate.document.version, 1);
  assert.equal(duplicate.document.isCurrent, true);
  assert.equal(duplicate.document.reviewState, 'approved');

  const documents = await first`SELECT version, is_current, review_state FROM fame_application_documents`;
  assert.deepEqual(Array.from(documents), [{ version: 1, is_current: true, review_state: 'approved' }]);
  const events = await first`SELECT event_id, document_id FROM fame_document_source_events ORDER BY event_id`;
  assert.deepEqual(Array.from(events), [
    { event_id: 'qa-document-event-1', document_id: firstVersion.document.id },
    { event_id: 'qa-document-event-same-file', document_id: firstVersion.document.id },
  ]);
  const outbox = await first`SELECT topic FROM fame_document_outbox ORDER BY topic`;
  assert.deepEqual(outbox.map(row => row.topic), [
    'document-ready-for-review', 'document-review', 'document-submitted',
  ]);
});

test('a delayed duplicate of an older source file cannot replace a later current document', async () => {
  const firstVersion = await persistApplicationDocumentSource(source(), first);
  assert.equal(firstVersion.kind, 'captured');
  if (firstVersion.kind !== 'captured') return;
  const secondVersion = await persistApplicationDocumentSource(source({
    eventId: 'qa-document-event-2',
    file: { ...source().file, sourceFileId: 'qa-file-2', storageKey: 'documents/qa/insurance-v2.pdf', sha256: 'b'.repeat(64) },
  }), second);
  assert.equal(secondVersion.kind, 'captured');
  if (secondVersion.kind !== 'captured') return;

  const delayedDuplicate = await persistApplicationDocumentSource(source({
    eventId: 'qa-document-event-v1-delayed',
    submittedAt: '2026-09-07T21:00:00.000Z',
    file: { ...source().file, storageKey: 'documents/qa/retransferred-insurance-v1.pdf' },
  }), first);
  assert.equal(delayedDuplicate.kind, 'duplicate');
  if (delayedDuplicate.kind !== 'duplicate') return;
  assert.equal(delayedDuplicate.document.id, firstVersion.document.id);
  assert.equal(delayedDuplicate.document.isCurrent, false);

  const documents = await first`SELECT version, source_file_id, is_current FROM fame_application_documents ORDER BY version`;
  assert.deepEqual(Array.from(documents), [
    { version: 1, source_file_id: 'qa-file-1', is_current: false },
    { version: 2, source_file_id: 'qa-file-2', is_current: true },
  ]);
  const outbox = await first`SELECT topic, payload->>'sourceEventId' AS source_event_id FROM fame_document_outbox WHERE topic = 'document-submitted' ORDER BY source_event_id`;
  assert.deepEqual(Array.from(outbox), [
    { topic: 'document-submitted', source_event_id: 'qa-document-event-1' },
    { topic: 'document-submitted', source_event_id: 'qa-document-event-2' },
  ]);
});

test('simultaneous new upload events get a complete immutable version history with one current document', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => persistApplicationDocumentSource(source({
    eventId: `qa-document-event-${index + 1}`,
    file: {
      ...source().file,
      sourceFileId: `qa-file-${index + 1}`,
      storageKey: `documents/qa/insurance-v${index + 1}.pdf`,
      sha256: `${String(index).padStart(2, '0')}${'a'.repeat(62)}`,
    },
  }), index % 2 ? first : second)));
  assert.equal(results.filter(result => result.kind === 'captured').length, 20);
  const documents = await first`SELECT version, is_current, storage_key, source_event_id FROM fame_application_documents ORDER BY version`;
  assert.deepEqual(documents.map(row => Number(row.version)), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(documents.filter(row => row.is_current).length, 1);
  const current = documents.find(row => row.is_current);
  assert.ok(current);
  const submittedIndex = current.source_event_id.replace('qa-document-event-', '');
  assert.equal(current.storage_key, `documents/qa/insurance-v${submittedIndex}.pdf`);
});

test('review cannot bypass scanning; exact scanner/reviewer retries enqueue only one result each', async () => {
  const captured = await persistApplicationDocumentSource(source(), first);
  assert.equal(captured.kind, 'captured');
  if (captured.kind !== 'captured') return;
  const documentId = captured.document.id;
  const waiting = await recordApplicationDocumentReview({
    documentId, marketId, actorAccountId, expectedVersion: 1,
    idempotencyKey: '22222222-2222-4222-8222-222222222222', action: 'approve', reason: '',
  }, first);
  assert.deepEqual(waiting, { kind: 'awaiting_validation', validationState: 'pending_scan' });
  const scan = await recordApplicationDocumentScan({
    documentId, marketId, expectedVersion: 1, sourceEventId: 'qa-scan-event-1', outcome: 'clean', reason: '',
  }, first);
  assert.equal(scan.kind, 'applied');
  const scanReplay = await recordApplicationDocumentScan({
    documentId, marketId, expectedVersion: 1, sourceEventId: 'qa-scan-event-1', outcome: 'clean', reason: '',
  }, second);
  assert.equal(scanReplay.kind, 'duplicate');
  const review = await recordApplicationDocumentReview({
    documentId, marketId, actorAccountId, expectedVersion: 1,
    idempotencyKey: '22222222-2222-4222-8222-222222222222', action: 'approve', reason: '',
  }, first);
  assert.equal(review.kind, 'applied');
  const replay = await recordApplicationDocumentReview({
    documentId, marketId, actorAccountId, expectedVersion: 1,
    idempotencyKey: '22222222-2222-4222-8222-222222222222', action: 'approve', reason: '',
  }, second);
  assert.equal(replay.kind, 'duplicate');
  const conflict = await recordApplicationDocumentReview({
    documentId, marketId, actorAccountId, expectedVersion: 1,
    idempotencyKey: '22222222-2222-4222-8222-222222222222', action: 'request_changes', reason: 'changed',
  }, second);
  assert.deepEqual(conflict, { kind: 'conflict' });
  const [document] = await first`SELECT validation_state, review_state, review_revision, reviewed_by_account_id FROM fame_application_documents`;
  assert.deepEqual(document, { validation_state: 'ready_for_review', review_state: 'approved', review_revision: 1, reviewed_by_account_id: actorAccountId });
  const outbox = await first`SELECT topic FROM fame_document_outbox ORDER BY created_at, id`;
  assert.deepEqual(outbox.map(row => row.topic).sort(), ['document-ready-for-review', 'document-review', 'document-submitted']);
});

test('a corrected resubmission blocks stale prior-version scan and approval, including a scanner rejection', async () => {
  const firstVersion = await persistApplicationDocumentSource(source(), first);
  assert.equal(firstVersion.kind, 'captured');
  if (firstVersion.kind !== 'captured') return;
  await recordApplicationDocumentScan({
    documentId: firstVersion.document.id, marketId, expectedVersion: 1, sourceEventId: 'qa-scan-v1', outcome: 'clean', reason: '',
  }, first);
  const secondVersion = await persistApplicationDocumentSource(source({
    eventId: 'qa-document-event-2',
    file: { ...source().file, sourceFileId: 'qa-file-2', storageKey: 'documents/qa/insurance-v2.pdf', sha256: 'c'.repeat(64) },
  }), second);
  assert.equal(secondVersion.kind, 'captured');
  if (secondVersion.kind !== 'captured') return;
  const staleScan = await recordApplicationDocumentScan({
    documentId: firstVersion.document.id, marketId, expectedVersion: 1, sourceEventId: 'qa-stale-scan', outcome: 'clean', reason: '',
  }, first);
  const staleReview = await recordApplicationDocumentReview({
    documentId: firstVersion.document.id, marketId, actorAccountId, expectedVersion: 1,
    idempotencyKey: '33333333-3333-4333-8333-333333333333', action: 'approve', reason: '',
  }, first);
  assert.deepEqual(staleScan, { kind: 'stale', currentVersion: 1, isCurrent: false });
  assert.deepEqual(staleReview, { kind: 'stale', currentVersion: 1, isCurrent: false });
  const rejected = await recordApplicationDocumentScan({
    documentId: secondVersion.document.id, marketId, expectedVersion: 2, sourceEventId: 'qa-scan-v2', outcome: 'rejected', reason: 'parser_invalid',
  }, second);
  assert.equal(rejected.kind, 'applied');
  const blocked = await recordApplicationDocumentReview({
    documentId: secondVersion.document.id, marketId, actorAccountId, expectedVersion: 2,
    idempotencyKey: '44444444-4444-4444-8444-444444444444', action: 'approve', reason: '',
  }, first);
  assert.deepEqual(blocked, { kind: 'awaiting_validation', validationState: 'rejected' });
  const documents = await first`SELECT version, is_current, validation_state, review_state FROM fame_application_documents ORDER BY version`;
  assert.deepEqual(Array.from(documents), [
    { version: 1, is_current: false, validation_state: 'ready_for_review', review_state: 'submitted' },
    { version: 2, is_current: true, validation_state: 'rejected', review_state: 'submitted' },
  ]);
});

test('only the current clean validation phase delivers before manager review', async () => {
  const captured = await persistApplicationDocumentSource(source(), first);
  assert.equal(captured.kind, 'captured');
  if (captured.kind !== 'captured') return;
  await recordApplicationDocumentScan({
    documentId: captured.document.id, marketId, expectedVersion: 1,
    sourceEventId: 'qa-clean-dispatch-scan', outcome: 'clean', reason: '',
  }, first);

  const delivered = [];
  const result = await dispatchApplicationDocumentOutbox(async envelope => { delivered.push(envelope); }, { limit: 10, sql: first });
  assert.deepEqual(result, { delivered: 1, deferred: 0, superseded: 1, stale: 0 });
  assert.deepEqual(delivered.map(envelope => envelope.event.topic), ['document-ready-for-review']);
  const retired = await first`SELECT topic, last_error_code FROM fame_document_outbox WHERE last_error_code = 'superseded'`;
  assert.deepEqual(Array.from(retired), [{ topic: 'document-submitted', last_error_code: 'superseded' }]);
});

test('only the current rejected validation phase delivers while the document is still submitted', async () => {
  const captured = await persistApplicationDocumentSource(source(), first);
  assert.equal(captured.kind, 'captured');
  if (captured.kind !== 'captured') return;
  await recordApplicationDocumentScan({
    documentId: captured.document.id, marketId, expectedVersion: 1,
    sourceEventId: 'qa-rejected-dispatch-scan', outcome: 'rejected', reason: 'scanner_rejected',
  }, first);

  const delivered = [];
  const result = await dispatchApplicationDocumentOutbox(async envelope => { delivered.push(envelope); }, { limit: 10, sql: first });
  assert.deepEqual(result, { delivered: 1, deferred: 0, superseded: 1, stale: 0 });
  assert.deepEqual(delivered.map(envelope => envelope.event.topic), ['document-validation-rejected']);
  const retired = await first`SELECT topic, last_error_code FROM fame_document_outbox WHERE last_error_code = 'superseded'`;
  assert.deepEqual(Array.from(retired), [{ topic: 'document-submitted', last_error_code: 'superseded' }]);
});

test('submission and validation jobs are retired after review, leaving only the exact review decision to deliver', async () => {
  const captured = await persistApplicationDocumentSource(source(), first);
  assert.equal(captured.kind, 'captured');
  if (captured.kind !== 'captured') return;
  await recordApplicationDocumentScan({
    documentId: captured.document.id, marketId, expectedVersion: 1,
    sourceEventId: 'qa-reviewed-dispatch-scan', outcome: 'clean', reason: '',
  }, first);
  await recordApplicationDocumentReview({
    documentId: captured.document.id, marketId, actorAccountId, expectedVersion: 1,
    idempotencyKey: 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0', action: 'approve', reason: '',
  }, first);

  const delivered = [];
  const result = await dispatchApplicationDocumentOutbox(async envelope => { delivered.push(envelope); }, { limit: 10, sql: first });
  assert.deepEqual(result, { delivered: 1, deferred: 0, superseded: 2, stale: 0 });
  assert.deepEqual(delivered.map(envelope => [envelope.event.topic, envelope.event.reviewState]), [
    ['document-review', 'approved'],
  ]);
  const retired = await first`SELECT topic, last_error_code FROM fame_document_outbox WHERE last_error_code = 'superseded' ORDER BY topic`;
  assert.deepEqual(Array.from(retired), [
    { topic: 'document-ready-for-review', last_error_code: 'superseded' },
    { topic: 'document-submitted', last_error_code: 'superseded' },
  ]);
});

test('outbox delivery uses leases and retry does not create extra application document versions', async () => {
  const captured = await persistApplicationDocumentSource(source(), first);
  assert.equal(captured.kind, 'captured');
  const [job] = await claimApplicationDocumentOutbox(5, 30, first);
  assert.ok(job);
  assert.equal(job.payload.topic, 'document-submitted');
  assert.equal(await markApplicationDocumentOutboxDelivered(job.id, 'wrong-lease', second), false);
  assert.equal(await retryApplicationDocumentOutbox(job.id, job.leaseToken, 'provider_timeout', 1, first), true);
  await first`UPDATE fame_document_outbox SET next_attempt_at = statement_timestamp() WHERE id = ${job.id}`;
  const [retry] = await claimApplicationDocumentOutbox(5, 30, second);
  assert.ok(retry);
  assert.equal(retry.id, job.id);
  assert.equal(retry.attempt, 2);
  assert.equal(await markApplicationDocumentOutboxDelivered(retry.id, retry.leaseToken, second), true);
  assert.equal((await first`SELECT * FROM fame_application_documents`).length, 1);
  assert.equal((await first`SELECT * FROM fame_document_source_events`).length, 1);
});

test('a queued v1 approval is fenced and retired when a newer current upload arrives before delivery', async () => {
  const firstVersion = await persistApplicationDocumentSource(source(), first);
  assert.equal(firstVersion.kind, 'captured');
  if (firstVersion.kind !== 'captured') return;
  await recordApplicationDocumentScan({
    documentId: firstVersion.document.id, marketId, expectedVersion: 1, sourceEventId: 'qa-fence-scan', outcome: 'clean', reason: '',
  }, first);
  await recordApplicationDocumentReview({
    documentId: firstVersion.document.id, marketId, actorAccountId, expectedVersion: 1,
    idempotencyKey: '55555555-5555-4555-8555-555555555555', action: 'approve', reason: '',
  }, first);
  const secondVersion = await persistApplicationDocumentSource(source({
    eventId: 'qa-document-event-2',
    file: { ...source().file, sourceFileId: 'qa-file-2', storageKey: 'documents/qa/insurance-v2.pdf', sha256: 'd'.repeat(64) },
  }), second);
  assert.equal(secondVersion.kind, 'captured');
  const delivered = [];
  const result = await dispatchApplicationDocumentOutbox(async envelope => { delivered.push(envelope); }, { limit: 10, sql: first });
  assert.deepEqual(result, { delivered: 1, deferred: 0, superseded: 3, stale: 0 });
  assert.deepEqual(delivered.map(envelope => [envelope.event.topic, envelope.document.version]), [['document-submitted', 2]]);
  assert.deepEqual(delivered[0].application, {
    id: applicationId,
    marketId,
    locationId,
    contactId: 'qa-contact',
    opportunityId: 'qa-opportunity',
    seasonId: '2026-2027',
  });
  assert.equal(JSON.stringify(delivered[0]).includes('storageKey'), false);
  const retired = await first`SELECT topic, last_error_code FROM fame_document_outbox WHERE last_error_code = 'superseded' ORDER BY topic`;
  assert.deepEqual(Array.from(retired), [
    { topic: 'document-ready-for-review', last_error_code: 'superseded' },
    { topic: 'document-review', last_error_code: 'superseded' },
    { topic: 'document-submitted', last_error_code: 'superseded' },
  ]);
});

test('outbox defers when its exact application has no stored opportunity and never calls a delivery adapter', async () => {
  await first`DELETE FROM fame_applications WHERE id = ${applicationId}`;
  await insertApplication(first, null);
  const captured = await persistApplicationDocumentSource(source(), first);
  assert.equal(captured.kind, 'captured');
  let calls = 0;
  const result = await dispatchApplicationDocumentOutbox(async () => { calls++; }, { limit: 10, sql: first });
  assert.deepEqual(result, { delivered: 0, deferred: 1, superseded: 0, stale: 0 });
  assert.equal(calls, 0);
  const [stored] = await first`SELECT status, last_error_code FROM fame_document_outbox`;
  assert.deepEqual(stored, { status: 'pending', last_error_code: 'document_identity_missing' });
});

test('an application can receive its first opportunity ID but cannot be reassigned to a newer opportunity', async () => {
  await assert.rejects(
    first`UPDATE fame_applications SET opportunity_id = 'qa-opportunity-new' WHERE id = ${applicationId}`,
    /cannot be reassigned/,
  );
  const secondApplicationId = '22222222-2222-4222-8222-222222222222';
  await first`
    INSERT INTO fame_applications (id, market_id, location_id, contact_id, season_id, opportunity_id)
    VALUES (${secondApplicationId}, ${marketId}, ${locationId}, 'qa-contact-without-opportunity', '2026-2027', NULL)`;
  await first`UPDATE fame_applications SET opportunity_id = 'qa-opportunity-first' WHERE id = ${secondApplicationId}`;
  const [stored] = await first`SELECT opportunity_id FROM fame_applications WHERE id = ${secondApplicationId}`;
  assert.deepEqual(stored, { opportunity_id: 'qa-opportunity-first' });
});

test('a failed submission outbox write rolls back the event and document, then an exact retry succeeds', async () => {
  await first`ALTER TABLE fame_document_outbox ADD CONSTRAINT qa_document_outbox_failure CHECK (topic <> 'document-submitted')`;
  try {
    await assert.rejects(persistApplicationDocumentSource(source(), first), error => error.code === '23514');
    assert.equal((await first`SELECT * FROM fame_application_documents`).length, 0);
    assert.equal((await first`SELECT * FROM fame_document_source_events`).length, 0);
  } finally {
    await first`ALTER TABLE fame_document_outbox DROP CONSTRAINT qa_document_outbox_failure`;
  }
  const retry = await persistApplicationDocumentSource(source(), second);
  assert.equal(retry.kind, 'captured');
  assert.equal((await first`SELECT * FROM fame_application_documents`).length, 1);
  assert.equal((await first`SELECT * FROM fame_document_source_events`).length, 1);
});
