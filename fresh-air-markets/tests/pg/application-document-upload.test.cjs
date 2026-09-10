const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');
const { uploadApplicationDocumentAsManager, listApplicationDocuments, readApplicationDocumentFile, MANAGER_UPLOAD_SCAN_REASON } = require('../../.test-build/application-document-upload.js');
const { postgresPrivateDocumentStore } = require('../../.test-build/private-document-store-pg.js');
const { recordApplicationDocumentReview } = require('../../.test-build/application-document-pg.js');

const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = `qa_document_upload_${process.pid}`;
const admin = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
const sql = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
const store = postgresPrivateDocumentStore(sql);

const applicationId = '22222222-2222-4222-8222-222222222222';
const marketId = 'fame-qa-market';
const locationId = 'qa-location';
const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
const body = bytes => (async function* () { yield new Uint8Array(bytes); })();
const upload = (patch = {}) => uploadApplicationDocumentAsManager({
  applicationId, marketId, locationId, kind: 'insurance', filename: 'coi.pdf', declaredContentType: 'application/pdf', body: body(pdf), ...patch,
}, { sql, store });
const objectCount = async () => (await sql`SELECT count(*)::int AS count FROM fame_private_document_objects`)[0].count;

before(async () => {
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await sql`CREATE TABLE accounts (id TEXT PRIMARY KEY)`;
  await sql`INSERT INTO accounts (id) VALUES (${marketId}), ('other-market')`;
  // Migration files carry their own BEGIN/COMMIT, which postgres.js only allows on a single-connection client.
  const migration = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
  try {
    for (const file of ['001-application-handoff.sql', '006-application-document-ledger.sql', '008-application-opportunity-identity.sql', '022-private-document-objects.sql']) {
      await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations', file), 'utf8'));
    }
  } finally { await migration.end(); }
});
beforeEach(async () => {
  await sql`TRUNCATE fame_document_review_events, fame_document_validation_events, fame_document_source_events,
    fame_document_outbox, fame_application_documents, fame_application_events, fame_applications, fame_private_document_objects`;
  await sql`INSERT INTO fame_applications (id, market_id, location_id, contact_id, season_id, opportunity_id)
    VALUES (${applicationId}, ${marketId}, ${locationId}, 'qa-contact', '2026-2027', 'qa-opportunity')`;
});
after(async () => { await sql.end(); await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });

test('a staff upload stores the bytes privately, binds one reviewable version, and can be approved', async () => {
  const result = await upload();
  assert.equal(result.kind, 'captured');
  assert.equal(result.document.validationState, 'ready_for_review');
  assert.equal(result.document.reviewState, 'submitted');
  assert.equal(result.document.version, 1);
  assert.equal(result.document.file.sha256, createHash('sha256').update(pdf).digest('hex'));
  assert.equal(await objectCount(), 1);
  const [row] = await sql`SELECT validation_reason, storage_key FROM fame_application_documents`;
  assert.equal(row.validation_reason, MANAGER_UPLOAD_SCAN_REASON);
  assert.match(row.storage_key, /^documents\/fame-qa-market\/22222222-2222-4222-8222-222222222222\/[0-9a-f-]{36}$/);

  const listed = await listApplicationDocuments(applicationId, marketId, sql);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].filename, 'coi.pdf');
  assert.equal('storageKey' in listed[0], false);
  const file = await readApplicationDocumentFile(result.document.id, marketId, { sql, store });
  assert.equal(file.contentType, 'application/pdf');
  assert.equal(Buffer.compare(file.body, pdf), 0);
  assert.equal(await readApplicationDocumentFile(result.document.id, 'other-market', { sql, store }), null);

  const review = await recordApplicationDocumentReview({
    documentId: result.document.id, marketId, actorAccountId: marketId, expectedVersion: 1,
    idempotencyKey: '33333333-3333-4333-8333-333333333333', action: 'approve', reason: '',
  }, sql);
  assert.equal(review.kind, 'applied');
  assert.equal(review.reviewState, 'approved');
  assert.equal((await listApplicationDocuments(applicationId, marketId, sql))[0].reviewState, 'approved');
});

test('re-uploading identical bytes is a duplicate that leaves one object; a changed file becomes the next version', async () => {
  const first = await upload();
  const again = await upload({ filename: 'coi-copy.pdf' });
  assert.equal(again.kind, 'duplicate');
  assert.equal(again.document.id, first.document.id);
  assert.equal(await objectCount(), 1);
  const revised = Buffer.concat([pdf, Buffer.from('% revised\n%%EOF\n', 'latin1')]);
  const second = await upload({ body: body(revised) });
  assert.equal(second.kind, 'captured');
  assert.equal(second.document.version, 2);
  assert.equal(second.document.isCurrent, true);
  const listed = await listApplicationDocuments(applicationId, marketId, sql);
  assert.deepEqual(listed.map(d => [d.version, d.isCurrent]), [[2, true], [1, false]]);
  assert.equal(await objectCount(), 2);
});

test('rejected, oversized, foreign-market and unknown-kind uploads leave no private object behind', async () => {
  const text = await upload({ filename: 'notes.txt', declaredContentType: 'text/plain', body: body(Buffer.from('hello')) });
  assert.equal(text.kind, 'rejected');
  assert.equal(text.code, 'unsupported_type');
  const spoofed = await upload({ filename: 'coi.pdf', declaredContentType: 'application/pdf', body: body(Buffer.from('not really a pdf')) });
  assert.equal(spoofed.kind, 'rejected');
  assert.equal(spoofed.code, 'signature_mismatch');
  const huge = await upload({ body: (async function* () { for (let i = 0; i < 11; i++) yield new Uint8Array(1024 * 1024); })() });
  assert.equal(huge.kind, 'rejected');
  assert.equal(huge.code, 'file_too_large');
  assert.equal((await upload({ marketId: 'other-market' })).kind, 'not_found');
  assert.equal((await upload({ kind: 'passport' })).kind, 'rejected');
  assert.equal((await upload({ applicationId: 'not-a-uuid' })).kind, 'rejected');
  assert.equal(await objectCount(), 0);
  assert.equal((await sql`SELECT count(*)::int AS count FROM fame_application_documents`)[0].count, 0);
});
