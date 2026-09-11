const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');
const { submitPortalApplication, validatePortalApplication, validateContactMessage, saveContactMessage, saveSubscriber, listContactMessages, listSubscribers, portalContactId, VENDOR_AGREEMENT_VERSION } = require('../../.test-build/portal-intake.js');
const { getApplicationReviewDetail, recordApplicationReview } = require('../../.test-build/application-review-pg.js');

const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = `qa_portal_intake_${process.pid}`;
const admin = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
const sql = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
const config = { marketId: 'fame-qa-market', locationId: 'aooAnUXF0COePorBo7wL', seasonId: '2026-2027' };
const body = (patch = {}) => ({
  registrationType: 'Vendor', firstName: 'Rosa', lastName: 'Alvarez', email: 'Rosa@SunriseFarms.example', phone: '555-0100',
  businessName: 'Sunrise Farms', vendorCategory: 'Produce', otherCategory: '', fullSeason: false, dates: ['2026-10-10', '2026-10-03'],
  booths: 2, message: 'Organic produce.', agreementAccepted: true, signatureName: 'Rosa Alvarez', ...patch,
});

before(async () => {
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  // Minimal portal base tables; the migration chain references accounts(id) and bookings(id).
  await sql`CREATE TABLE accounts (id TEXT PRIMARY KEY)`;
  await sql`CREATE TABLE booths (id TEXT PRIMARY KEY)`;
  await sql`CREATE TABLE bookings (id TEXT PRIMARY KEY)`;
  await sql`CREATE TABLE booking_dates (booking_id TEXT REFERENCES bookings(id))`;
  await sql`INSERT INTO accounts (id) VALUES (${config.marketId})`;
  const migration = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
  try {
    for (const file of fs.readdirSync(path.join(__dirname, '../../docs/migrations')).filter(f => /^\d{3}-.*\.sql$/.test(f)).sort()) {
      await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations', file), 'utf8'));
    }
  } finally { await migration.end(); }
});
beforeEach(async () => {
  // CASCADE clears every table that references fame_applications (events, reviews, documents, agreements).
  await sql`TRUNCATE fame_applications, fame_contact_messages, fame_newsletter_subscribers CASCADE`;
});
after(async () => { await sql.end(); await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });

test('validation normalizes the form and reports every missing field', () => {
  const ok = validatePortalApplication(body());
  assert.equal(ok.ok, true);
  assert.equal(ok.input.email, 'rosa@sunrisefarms.example');
  assert.deepEqual(ok.input.dates, ['2026-10-03', '2026-10-10']);
  const bad = validatePortalApplication(body({ registrationType: 'Sponsor', firstName: '', email: 'nope', dates: ['2026-10-04'], agreementAccepted: false, signatureName: 'R' }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 5);
  const nonprofit = validatePortalApplication(body({ registrationType: 'Non-Profit Organization', vendorCategory: '', dates: [], message: '' }));
  assert.equal(nonprofit.ok, false);
  assert.ok(nonprofit.errors.some(e => /mission/.test(e)));
  assert.equal(validatePortalApplication(body({ registrationType: 'Non-Profit Organization', vendorCategory: '', dates: [], message: 'Food access.' })).ok, true);
  assert.equal(validatePortalApplication(body({ fullSeason: true, dates: [] })).ok, true);
  assert.equal(validatePortalApplication(body({ booths: 9 })).ok, false);
  assert.equal(validatePortalApplication(body({ booths: undefined })).input.booths, 1);
  assert.equal(validatePortalApplication(body({ registrationType: 'Non-Profit Organization', vendorCategory: '', dates: [], message: 'x', booths: 3 })).input.booths, 1);
  assert.equal(validateContactMessage({ topic: 'vendor', firstName: 'A', email: 'a@example.com', message: 'hi' }).ok, true);
  assert.equal(validateContactMessage({ topic: 'x', firstName: '', email: 'a', message: '' }).ok, false);
});

test('a submission becomes a reviewable application with an opportunity, a signed agreement, and no CRM rows', async () => {
  const valid = validatePortalApplication(body());
  const result = await submitPortalApplication(valid.input, config, { clientIp: '203.0.113.5', userAgent: 'test' }, sql);
  assert.equal(result.status, 'captured');
  assert.equal(result.agreementSigned, true);
  const detail = await getApplicationReviewDetail(result.applicationId, config.marketId, sql);
  assert.equal(detail.hasOpportunity, true);
  assert.equal(detail.identitySnapshot.businessName, 'Sunrise Farms');
  assert.equal(detail.identitySnapshot.email, 'rosa@sunrisefarms.example');
  assert.deepEqual(detail.identitySnapshot.dates, ['2026-10-03', '2026-10-10']);
  assert.equal(detail.identitySnapshot.category, 'Produce');
  assert.equal(detail.identitySnapshot.boothsRequested, 2);
  const [application] = await sql`SELECT contact_id, opportunity_id FROM fame_applications`;
  assert.equal(application.contact_id, portalContactId('rosa@sunrisefarms.example'));
  assert.match(application.opportunity_id, /^portal-opportunity:/);
  const [completion] = await sql`SELECT template_id, document_id, contact_id FROM fame_agreement_completions`;
  assert.equal(completion.template_id, VENDOR_AGREEMENT_VERSION);
  const [signature] = await sql`SELECT id, signer_name, client_ip FROM fame_agreement_signatures`;
  assert.equal(completion.document_id, signature.id);
  assert.equal(signature.signer_name, 'Rosa Alvarez');
  assert.equal(signature.client_ip, '203.0.113.5');
  assert.equal((await sql`SELECT count(*)::int AS count FROM fame_agreement_notification_outbox`)[0].count, 0);
  assert.equal((await sql`SELECT count(*)::int AS count FROM fame_agreement_stage_outbox`)[0].count, 0);

  // The manager can approve it with the existing review path.
  const review = await recordApplicationReview({ applicationId: result.applicationId, marketId: config.marketId, actorAccountId: config.marketId,
    action: 'approve', reason: '', idempotencyKey: '44444444-4444-4444-8444-444444444444', expectedRevision: 0, sourceEventId: detail.sourceEventId }, sql);
  assert.ok(['applied', 'duplicate'].includes(review.kind), JSON.stringify(review));
});

test('identical resubmission is a duplicate; a changed resubmission updates the same application and keeps one agreement', async () => {
  const first = await submitPortalApplication(validatePortalApplication(body()).input, config, {}, sql);
  const again = await submitPortalApplication(validatePortalApplication(body()).input, config, {}, sql);
  assert.equal(again.applicationId, first.applicationId);
  const changed = await submitPortalApplication(validatePortalApplication(body({ vendorCategory: 'Baked Goods' })).input, config, {}, sql);
  assert.equal(changed.status, 'captured');
  assert.equal(changed.applicationId, first.applicationId);
  assert.equal((await sql`SELECT count(*)::int AS count FROM fame_applications`)[0].count, 1);
  assert.equal((await sql`SELECT count(*)::int AS count FROM fame_application_events`)[0].count, 2);
  assert.equal((await sql`SELECT count(*)::int AS count FROM fame_agreement_completions`)[0].count, 1);
  const detail = await getApplicationReviewDetail(first.applicationId, config.marketId, sql);
  assert.equal(detail.identitySnapshot.category, 'Baked Goods');
  const other = await submitPortalApplication(validatePortalApplication(body({ email: 'other@example.com' })).input, config, {}, sql);
  assert.notEqual(other.applicationId, first.applicationId);
});

test('contact messages and newsletter signups are stored per market and listed newest first', async () => {
  const message = validateContactMessage({ topic: 'nonprofit', firstName: 'Pat', lastName: 'Lee', email: 'PAT@example.org', phone: '555', message: 'Can we join?' });
  await saveContactMessage(message.input, config.marketId, '203.0.113.9', sql);
  const listed = await listContactMessages(config.marketId, sql);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].email, 'pat@example.org');
  assert.equal(listed[0].topic, 'nonprofit');
  assert.equal(await saveSubscriber('Fan@Example.com', config.marketId, sql), 'added');
  assert.equal(await saveSubscriber('fan@example.com', config.marketId, sql), 'exists');
  await assert.rejects(saveSubscriber('not-an-email', config.marketId, sql), /invalid_email/);
  assert.deepEqual((await listSubscribers(config.marketId, sql)).map(s => s.email), ['fan@example.com']);
});
