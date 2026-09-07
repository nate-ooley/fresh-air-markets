const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const postgres = require('postgres');
const { reserveFinalApplication } = require('../../.test-build/final-reservation-pg.js');

// This suite creates and drops only a private schema inside the disposable CI DB.
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = 'qa_final_reservation';
const admin = postgres(url.toString(), { max: 1, prepare: false });
const connect = () => postgres(url.toString(), {
  max: 12,
  prepare: false,
  connection: { search_path: schema, statement_timeout: 15000 },
});
const first = connect();
const second = connect();
const marketId = 'qa-final-reservation-market';
const locationId = 'qa-final-reservation-location';
const now = new Date('2026-10-01T12:00:00.000Z');
const calendarDates = ['2026-10-03', '2026-10-10'];

const config = (boothCapacity = 2) => ({
  marketId,
  seasonId: '2026-2027',
  boothCapacity,
  calendarDates,
  quoteVersion: 'qa-final-v1',
});

function selection(patch = {}) {
  return {
    applicantType: 'Vendor',
    vendorCategory: 'Arts & Crafts',
    selectedDates: [...calendarDates],
    fullSeason: false,
    boothsPerMarket: 1,
    foodLicenseRequired: false,
    idempotencyKey: randomUUID(),
    ...patch,
  };
}

before(async () => {
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await first`CREATE TABLE accounts (id TEXT PRIMARY KEY)`;
  await first`INSERT INTO accounts (id) VALUES (${marketId})`;
  const migration = postgres(url.toString(), { max: 1, prepare: false, connection: { search_path: schema } });
  try {
    for (const file of [
      '001-application-handoff.sql',
      '004-application-review-outbox.sql',
      '005-agreement-completion-outbox.sql',
      '006-application-document-ledger.sql',
      '011-square-payment-checkout-ledger.sql',
      '012-square-webhook-events.sql',
      '013-final-reservation-writer.sql',
    ]) await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations', file), 'utf8'));
  } finally {
    await migration.end();
  }
});

beforeEach(async () => {
  await first`TRUNCATE fame_applications CASCADE`;
});

after(async () => {
  await first.end();
  await second.end();
  await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

async function seedEligibleApplication(sql = first, patch = {}) {
  const applicationId = patch.applicationId || randomUUID();
  const contactId = patch.contactId || `contact-${applicationId}`;
  const opportunityId = patch.opportunityId || `opportunity-${applicationId}`;
  const sourceEventId = patch.sourceEventId || `application:${applicationId}`;
  const reviewEventId = patch.reviewEventId || randomUUID();
  const agreementId = patch.agreementId || randomUUID();
  const insuranceId = patch.insuranceId || randomUUID();
  await sql`
    INSERT INTO fame_applications
      (id, market_id, location_id, contact_id, season_id, opportunity_id,
       review_state, review_revision, reviewed_at, reviewed_by_account_id)
    VALUES
      (${applicationId}, ${marketId}, ${locationId}, ${contactId}, '2026-2027', ${opportunityId},
       'approved', 1, ${now}, ${marketId})`;
  await sql`
    INSERT INTO fame_application_events
      (location_id, event_id, market_id, application_id, payload_hash, snapshot, created_at)
    VALUES
      (${locationId}, ${sourceEventId}, ${marketId}, ${applicationId}, ${'a'.repeat(64)},
       ${sql.json({ source: 'qa' })}, ${now})`;
  await sql`
    INSERT INTO fame_application_review_events
      (id, application_id, market_id, source_event_id, actor_account_id,
       idempotency_key, payload_hash, from_state, to_state, reason, created_at)
    VALUES
      (${reviewEventId}, ${applicationId}, ${marketId}, ${sourceEventId}, ${marketId},
       ${randomUUID()}, ${'b'.repeat(64)}, 'unreviewed', 'approved', '', ${now})`;
  await sql`
    INSERT INTO fame_agreement_completions
      (id, application_id, market_id, location_id, contact_id, opportunity_id,
       season_id, document_id, template_id, completion_event_id, completed_at)
    VALUES
      (${agreementId}, ${applicationId}, ${marketId}, ${locationId}, ${contactId}, ${opportunityId},
       '2026-2027', ${`agreement-document-${applicationId}`}, 'qa-template',
       ${`agreement-event-${applicationId}`}, ${now})`;
  await sql`
    INSERT INTO fame_application_documents
      (id, application_id, market_id, kind, version, source_event_id, source_file_id,
       storage_key, filename, content_type, size_bytes, content_sha256, submitted_at,
       validation_state, validation_reason, validated_at, review_state,
       review_revision, reviewed_at, reviewed_by_account_id, review_reason, is_current)
    VALUES
      (${insuranceId}, ${applicationId}, ${marketId}, 'insurance', 1,
       ${`insurance-source-${applicationId}`}, ${`insurance-file-${applicationId}`},
       ${`private/${applicationId}/insurance.pdf`}, 'insurance.pdf', 'application/pdf', 1024,
       ${'c'.repeat(64)}, ${now}, 'ready_for_review', '', ${now}, 'approved',
       1, ${now}, ${marketId}, '', TRUE)`;
  return { applicationId, sourceEventId, reviewEventId, agreementId, insuranceId };
}

function reserve(applicationId, reservationSelection, sql = first, boothCapacity = 2) {
  return reserveFinalApplication({
    marketId,
    applicationId,
    actorAccountId: marketId,
    selection: reservationSelection,
    config: config(boothCapacity),
    now,
  }, sql);
}

test('100 concurrent exact reserves create one immutable hold, exact provenance, and one allocation per date', async () => {
  const application = await seedEligibleApplication();
  const requested = selection({ idempotencyKey: '11111111-1111-4111-8111-111111111111' });
  const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    reserve(application.applicationId, requested, index % 2 ? first : second)));
  assert.equal(results.filter(result => result.kind === 'created').length, 1);
  assert.equal(results.filter(result => result.kind === 'duplicate').length, 99);
  const [reservation] = await first`
    SELECT state, payment_required, total_cents, final_booth_quantity, final_dates
    FROM fame_reservations`;
  assert.deepEqual(reservation, {
    state: 'held', payment_required: true, total_cents: 8000,
    final_booth_quantity: 1, final_dates: calendarDates,
  });
  const [finalization] = await first`
    SELECT application_source_location_id, application_source_event_id,
           application_review_event_id, agreement_completion_id,
           insurance_document_id, full_season, food_license_required
    FROM fame_reservation_finalizations`;
  assert.deepEqual(finalization, {
    application_source_location_id: locationId,
    application_source_event_id: application.sourceEventId,
    application_review_event_id: application.reviewEventId,
    agreement_completion_id: application.agreementId,
    insurance_document_id: application.insuranceId,
    full_season: false,
    food_license_required: false,
  });
  const allocations = await first`SELECT market_date::text, booth_quantity FROM fame_reservation_allocations ORDER BY market_date`;
  assert.deepEqual(allocations, calendarDates.map(market_date => ({ market_date, booth_quantity: 1 })));
  await assert.rejects(
    first`UPDATE fame_reservation_finalizations SET full_season = TRUE`,
    error => error.code === '55000',
  );
  await assert.rejects(
    first`UPDATE fame_reservations SET total_cents = 1`,
    error => error.code === '55000',
  );
  await first`UPDATE fame_reservations SET state = 'payment_pending'`;
  assert.equal((await first`SELECT state FROM fame_reservations`)[0].state, 'payment_pending');
});

test('sorted date locks let exactly one competing application consume a one-booth date without a partial hold', async () => {
  const [one, two] = await Promise.all([seedEligibleApplication(first), seedEligibleApplication(second)]);
  const results = await Promise.all([
    reserve(one.applicationId, selection({ idempotencyKey: '22222222-2222-4222-8222-222222222222' }), first, 1),
    reserve(two.applicationId, selection({ idempotencyKey: '33333333-3333-4333-8333-333333333333' }), second, 1),
  ]);
  assert.equal(results.filter(result => result.kind === 'created').length, 1);
  assert.equal(results.filter(result => result.kind === 'unavailable').length, 1);
  assert.equal((await first`SELECT * FROM fame_reservations`).length, 1);
  assert.equal((await first`SELECT * FROM fame_reservation_finalizations`).length, 1);
  assert.equal((await first`SELECT * FROM fame_reservation_allocations`).length, calendarDates.length);
});

test('a provenance-ledger failure rolls back reservation and allocations before the caller can retry', async () => {
  const application = await seedEligibleApplication();
  await first`ALTER TABLE fame_reservation_finalizations
    ADD CONSTRAINT qa_finalization_failure CHECK (quote_tier <> 'standard')`;
  try {
    await assert.rejects(
      reserve(application.applicationId, selection({
        selectedDates: [calendarDates[0]],
        idempotencyKey: '44444444-4444-4444-8444-444444444444',
      })),
      error => error.code === '23514',
    );
    assert.equal((await first`SELECT * FROM fame_reservations`).length, 0);
    assert.equal((await first`SELECT * FROM fame_reservation_finalizations`).length, 0);
    assert.equal((await first`SELECT * FROM fame_reservation_allocations`).length, 0);
  } finally {
    await first`ALTER TABLE fame_reservation_finalizations DROP CONSTRAINT qa_finalization_failure`;
  }
  assert.equal((await reserve(application.applicationId, selection({
    selectedDates: [calendarDates[0]],
    idempotencyKey: '55555555-5555-4555-8555-555555555555',
  }), second)).kind, 'created');
});
