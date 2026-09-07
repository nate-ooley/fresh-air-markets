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
const first = postgres(url.toString(), { max: 12, prepare: false });
const second = postgres(url.toString(), { max: 12, prepare: false });

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

async function insertApplication(sql = first) {
  await sql`
    INSERT INTO fame_applications (id, market_id, location_id, contact_id, season_id, opportunity_id)
    VALUES (${applicationId}, ${marketId}, ${locationId}, 'qa-contact', '2026-2027', 'qa-opportunity')`;
}

before(async () => {
  await first`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY)`;
  await first`INSERT INTO accounts (id) VALUES (${marketId}), ('qa-market-b'), (${actorAccountId}) ON CONFLICT DO NOTHING`;
  const migration = postgres(url.toString(), { max: 1, prepare: false });
  try {
    for (const file of ['001-application-handoff.sql', '006-application-document-ledger.sql']) {
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

after(async () => { await first.end(); await second.end(); });

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
  const documents = await first`SELECT version, is_current, storage_key FROM fame_application_documents ORDER BY version`;
  assert.deepEqual(documents.map(row => Number(row.version)), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(documents.filter(row => row.is_current).length, 1);
  assert.equal(documents.find(row => row.is_current).storage_key, 'documents/qa/insurance-v20.pdf');
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
  assert.deepEqual(documents, [
    { version: 1, is_current: false, validation_state: 'ready_for_review', review_state: 'submitted' },
    { version: 2, is_current: true, validation_state: 'rejected', review_state: 'submitted' },
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
  const result = await dispatchApplicationDocumentOutbox(async job => { delivered.push(job.payload); }, { limit: 10, sql: first });
  assert.deepEqual(result, { delivered: 1, deferred: 0, superseded: 3, stale: 0 });
  assert.deepEqual(delivered.map(payload => [payload.topic, payload.version]), [['document-submitted', 2]]);
  const retired = await first`SELECT topic, last_error_code FROM fame_document_outbox WHERE last_error_code = 'superseded' ORDER BY topic`;
  assert.deepEqual(retired, [
    { topic: 'document-ready-for-review', last_error_code: 'superseded' },
    { topic: 'document-review', last_error_code: 'superseded' },
    { topic: 'document-submitted', last_error_code: 'superseded' },
  ]);
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
