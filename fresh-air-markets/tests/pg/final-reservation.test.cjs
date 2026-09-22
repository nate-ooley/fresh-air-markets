const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const postgres = require('postgres');
const { reserveFinalApplication, getFinalApplicationReservation, reopenExpiredReservation } = require('../../.test-build/final-reservation-pg.js');
const { claimSquarePaymentCheckout } = require('../../.test-build/square-payment-pg.js');
const { withdrawReservation, withdrawApplication, applicationBookingSummary } = require('../../.test-build/reservation-withdraw-pg.js');

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

// postgres returns a Result array subclass. Convert only query results used in
// structural assertions so the test checks rows rather than a driver prototype.
const rows = result => Array.from(result, row => ({ ...row }));

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
      '014-square-payment-expiry.sql',
      '017-vendor-payment-access.sql',
      '018-payment-paid-sync-outbox.sql',
      '019-payment-email-outbox.sql',
      '027-payment-order-reissue.sql',
      '028-payment-order-reissue-after-failure.sql',
      '029-vendor-bookings.sql',
      '030-vendor-booking-requests.sql',
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

function reserve(applicationId, reservationSelection, sql = first, boothCapacity = 2, at = now) {
  return reserveFinalApplication({
    marketId,
    applicationId,
    actorAccountId: marketId,
    selection: reservationSelection,
    config: config(boothCapacity),
    now: at,
  }, sql);
}
const later = minutes => new Date(now.valueOf() + minutes * 60_000);

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
  assert.deepEqual({ ...reservation, total_cents: Number(reservation.total_cents) }, {
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
  assert.deepEqual(rows(allocations), calendarDates.map(market_date => ({ market_date, booth_quantity: 1 })));
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


test('manager reload returns only committed same-market reservation and no raw evidence', async () => {
  const app = await seedEligibleApplication();
  const applicationId = app.applicationId;
  assert.deepEqual(await getFinalApplicationReservation(marketId, applicationId, first), { reservation: null, reservations: [], insuranceExpiresOn: null });
  const result = await reserveFinalApplication({ marketId, applicationId, actorAccountId: marketId, selection: selection(), config: config(), now }, first);
  assert.equal(result.kind, 'created');
  const reloaded = await getFinalApplicationReservation(marketId, applicationId, first);
  assert.equal(reloaded.reservations.length, 1);
  assert.deepEqual(reloaded.reservation, reloaded.reservations[0]);
  assert.deepEqual({ ...reloaded.reservation, createdAt: undefined, withdrawnAt: undefined, withdrawalNote: undefined }, { ...result.reservation, createdAt: undefined, withdrawnAt: undefined, withdrawalNote: undefined });
  assert.equal(reloaded.reservation.withdrawnAt, null);
  assert.equal(await getFinalApplicationReservation('foreign-market', applicationId, first), null);
  assert.equal(await getFinalApplicationReservation(marketId, randomUUID(), first), null);
});

test('an expired hold can be reopened, keeps its dates, price and revision, respects capacity taken meanwhile, and gets a fresh payment order', async () => {
  const { applicationId } = await seedEligibleApplication();
  const made = await reserve(applicationId, selection({ selectedDates: ['2026-10-03'] }), first, 1);
  assert.equal(made.kind, 'created');
  const id = made.reservation.id;
  const square = { environment: 'sandbox', merchantId: 'qa-merchant', locationId: 'qa-location' };
  const firstClaim = await claimSquarePaymentCheckout({ marketId, reservationId: id, square, now, leaseSeconds: 60 }, first);
  assert.equal(firstClaim.kind, 'checkout_required');
  assert.equal((await reopenExpiredReservation({ marketId, reservationId: id, config: config(1), now }, first)).kind, 'not_expired');
  // The scheduler retired the link: order expired, reservation expired.
  await first`UPDATE fame_payment_orders SET status = 'expired', lease_token = NULL, locked_until = NULL WHERE id = ${firstClaim.order.id}`;
  await first`UPDATE fame_reservations SET state = 'expired', payment_due_at = ${now} WHERE id = ${id}`;
  // Someone else takes the only booth while the hold is expired.
  const other = await seedEligibleApplication();
  assert.equal((await reserve(other.applicationId, selection({ selectedDates: ['2026-10-03'] }), first, 1)).kind, 'created');
  const blocked = await reopenExpiredReservation({ marketId, reservationId: id, config: config(1), now }, first);
  assert.deepEqual(blocked, { kind: 'unavailable', unavailableDates: ['2026-10-03'] });
  assert.equal((await first`SELECT state FROM fame_reservations WHERE id = ${id}`)[0].state, 'expired');
  // The vendor was booked again for the same Saturday while this hold lapsed: reopening would double-book them.
  const again = await reserve(applicationId, selection({ selectedDates: ['2026-10-03'] }), first, 3, new Date(now.valueOf() + 60_000));
  assert.equal(again.kind, 'created');
  assert.deepEqual(await reopenExpiredReservation({ marketId, reservationId: id, config: config(3), now }, first), { kind: 'overlap', dates: ['2026-10-03'] });
  await first`UPDATE fame_reservations SET state = 'cancelled' WHERE id = ${again.reservation.id}`;
  // A certificate that no longer covers the Saturday blocks the reopen too.
  await first`UPDATE fame_application_documents SET expires_on = '2026-10-01' WHERE application_id = ${applicationId} AND kind = 'insurance'`;
  assert.deepEqual(await reopenExpiredReservation({ marketId, reservationId: id, config: config(2), now }, first), { kind: 'insurance_expires', expiresOn: '2026-10-01', dates: ['2026-10-03'] });
  await first`UPDATE fame_application_documents SET expires_on = NULL WHERE application_id = ${applicationId} AND kind = 'insurance'`;
  // With room, the hold reopens with no deadline and the same revision.
  const reopened = await reopenExpiredReservation({ marketId, reservationId: id, config: config(2), now }, first);
  assert.deepEqual(reopened, { kind: 'reopened', reservation: { id, state: 'held', finalDates: ['2026-10-03'], finalBoothQuantity: 1, totalCents: 4000 } });
  const [row] = await first`SELECT state, revision, payment_due_at FROM fame_reservations WHERE id = ${id}`;
  assert.deepEqual([row.state, row.revision, row.payment_due_at], ['held', 1, null]);
  assert.equal((await reopenExpiredReservation({ marketId, reservationId: id, config: config(2), now }, first)).kind, 'not_expired');
  assert.equal((await reopenExpiredReservation({ marketId: 'other-market', reservationId: id, config: config(2), now }, first)).kind, 'not_found');
  // A second payment request is a new order with its own idempotency key; the expired one stays for audit.
  const secondClaim = await claimSquarePaymentCheckout({ marketId, reservationId: id, square, now: new Date(now.valueOf() + 60_000), leaseSeconds: 60 }, first);
  assert.equal(secondClaim.kind, 'checkout_required');
  assert.notEqual(secondClaim.order.id, firstClaim.order.id);
  assert.notEqual(secondClaim.order.idempotencyKey, firstClaim.order.idempotencyKey);
  const orders = rows(await first`SELECT status FROM fame_payment_orders WHERE reservation_id = ${id} ORDER BY created_at`);
  assert.deepEqual(orders.map(o => o.status), ['expired', 'processing_checkout']);
  // A live attempt blocks reopening even from manual review; a failed attempt does not.
  await first`UPDATE fame_reservations SET state = 'manual_review' WHERE id = ${id}`;
  assert.equal((await reopenExpiredReservation({ marketId, reservationId: id, config: config(2), now }, first)).kind, 'not_expired');
  await first`UPDATE fame_payment_orders SET status = 'failed', lease_token = NULL, locked_until = NULL WHERE id = ${secondClaim.order.id}`;
  assert.equal((await reopenExpiredReservation({ marketId, reservationId: id, config: config(2), now }, first)).kind, 'reopened');
  const thirdClaim = await claimSquarePaymentCheckout({ marketId, reservationId: id, square, now: new Date(now.valueOf() + 120_000), leaseSeconds: 60 }, first);
  assert.equal(thirdClaim.kind, 'checkout_required');
  assert.equal(thirdClaim.approved.attempt, 3);
  assert.equal(new Set([firstClaim.order.idempotencyKey, secondClaim.order.idempotencyKey, thirdClaim.order.idempotencyKey]).size, 3);
});

test('a vendor can hold several bookings, priced on their own dates, but never the same Saturday twice while a booking is live', async () => {
  const { applicationId } = await seedEligibleApplication();
  const fall = await reserve(applicationId, selection({ selectedDates: ['2026-10-03'] }));
  assert.equal(fall.kind, 'created');
  // Same date again while the first booking is live: refused, nothing written.
  const clash = await reserve(applicationId, selection({ selectedDates: ['2026-10-03', '2026-10-10'] }));
  assert.deepEqual(clash, { kind: 'overlap', dates: ['2026-10-03'] });
  // A different Saturday becomes a second booking with its own total.
  const spring = await reserve(applicationId, selection({ selectedDates: ['2026-10-10'] }), first, 2, later(1));
  assert.equal(spring.kind, 'created');
  assert.notEqual(spring.reservation.id, fall.reservation.id);
  assert.equal(spring.reservation.totalCents, 4000);
  // A replay of either booking answers with that booking, not a third one.
  const replay = await reserve(applicationId, { ...selection({ selectedDates: ['2026-10-10'] }), idempotencyKey: (await first`SELECT idempotency_key FROM fame_reservation_finalizations WHERE reservation_id = ${spring.reservation.id}`)[0].idempotency_key });
  assert.equal(replay.kind, 'duplicate');
  assert.equal(replay.reservation.id, spring.reservation.id);
  const reloaded = await getFinalApplicationReservation(marketId, applicationId, first);
  assert.deepEqual(reloaded.reservations.map(r => [r.id, r.finalDates]), [[fall.reservation.id, ['2026-10-03']], [spring.reservation.id, ['2026-10-10']]]);
  assert.equal(reloaded.reservation.id, spring.reservation.id);
  assert.equal(rows(await first`SELECT 1 FROM fame_reservation_allocations WHERE reservation_id IN (${fall.reservation.id}, ${spring.reservation.id})`).length, 2);
  // Once the first booking is withdrawn, its Saturday is free for the vendor again.
  await first`UPDATE fame_reservations SET state = 'cancelled' WHERE id = ${fall.reservation.id}`;
  const again = await reserve(applicationId, selection({ selectedDates: ['2026-10-03'] }), first, 2, later(2));
  assert.equal(again.kind, 'created');
  assert.equal((await getFinalApplicationReservation(marketId, applicationId, first)).reservations.length, 3);
});

test('withdrawing a booking cancels its Square link first, releases the dates and revokes vendor links; paid bookings refuse', async () => {
  const { applicationId } = await seedEligibleApplication();
  const made = await reserve(applicationId, selection({ selectedDates: ['2026-10-03'] }), first, 1);
  const id = made.reservation.id;
  const square = { environment: 'sandbox', merchantId: 'qa-merchant', locationId: 'qa-location' };
  const claim = await claimSquarePaymentCheckout({ marketId, reservationId: id, square, now, leaseSeconds: 60 }, first);
  assert.equal(claim.kind, 'checkout_required');
  await first`UPDATE fame_payment_orders SET status = 'checkout_created', square_payment_link_id = 'PL-qa', square_order_id = 'ORD-qa',
    checkout_url = 'https://sandbox.square.link/u/qa', lease_token = NULL, locked_until = NULL, payment_due_at = ${now} WHERE id = ${claim.order.id}`;
  await first`UPDATE fame_reservations SET state = 'payment_pending', payment_due_at = ${now} WHERE id = ${id}`;
  await first`INSERT INTO fame_vendor_payment_invitations (token_hash, market_id, reservation_id, reservation_revision, expires_at, created_at)
    VALUES (${'d'.repeat(64)}, ${marketId}, ${id}, 1, ${new Date(now.valueOf() + 3600_000)}, ${now})`;
  await first`INSERT INTO fame_vendor_payment_sessions (token_hash, invitation_hash, market_id, reservation_id, reservation_revision, created_at, expires_at)
    VALUES (${'e'.repeat(64)}, ${'d'.repeat(64)}, ${marketId}, ${id}, 1, ${now}, ${new Date(now.valueOf() + 3600_000)})`;
  // A queued (not yet sent) payment email must be cancelled by the withdrawal; the outbox guard needs exact payment evidence.
  const sentAt = new Date(now.valueOf() - 60_000);
  const dueAt = new Date(sentAt.valueOf() + 48 * 3600_000);
  await first`UPDATE fame_payment_orders SET payment_request_sent_at = ${sentAt}, payment_due_at = ${dueAt}, expected_total_cents = 4000 WHERE id = ${claim.order.id}`;
  await first`UPDATE fame_reservations SET payment_request_sent_at = ${sentAt}, payment_due_at = ${dueAt} WHERE id = ${id}`;
  await first`UPDATE fame_application_events SET snapshot = ${first.json({ source: 'qa', email: 'vendor@example.org', snapshot: { email: 'vendor@example.org' } })} WHERE application_id = ${applicationId}`;
  const [source] = await first`SELECT f.application_source_location_id AS location_id, f.application_source_event_id AS event_id, g.contact_id, g.opportunity_id
    FROM fame_reservation_finalizations f JOIN fame_agreement_completions g ON g.id = f.agreement_completion_id WHERE f.reservation_id = ${id}`;
  await first`INSERT INTO fame_payment_email_outbox (id, market_id, application_id, reservation_id, reservation_revision, source_location_id, source_event_id, contact_id, opportunity_id,
      recipient_email, total_cents, payment_due_at, invitation_hash, invitation_ciphertext, state, next_attempt_at, created_at, updated_at)
    VALUES (${randomUUID()}, ${marketId}, ${applicationId}, ${id}, 1, ${source.location_id}, ${source.event_id}, ${source.contact_id}, ${source.opportunity_id},
      'vendor@example.org', 4000, ${dueAt}, ${'d'.repeat(64)}, 'ciphertext', 'pending', ${now}, ${now}, ${now})`;
  // Square refuses: nothing changes.
  const failed = await withdrawReservation({ marketId, reservationId: id, note: 'Vendor asked.', now, cancelLink: async () => { throw new Error('square down'); } }, first);
  assert.deepEqual(failed, { kind: 'square_unavailable' });
  assert.equal((await first`SELECT state FROM fame_reservations WHERE id = ${id}`)[0].state, 'payment_pending');
  // No Square adapter while a link is live: also refused.
  assert.deepEqual(await withdrawReservation({ marketId, reservationId: id, note: 'x', now }, first), { kind: 'square_unavailable' });
  // Square could not prove the order was cancelled (it may be paid): refused, dates stay held.
  assert.deepEqual(await withdrawReservation({ marketId, reservationId: id, note: 'x', now, cancelLink: async () => 'unproven' }, first), { kind: 'cancellation_unproven', squareOrderId: 'ORD-qa' });
  assert.equal((await first`SELECT state FROM fame_reservations WHERE id = ${id}`)[0].state, 'payment_pending');
  // Square proves the link is cancelled: booking cancelled, order cancelled, invitation + session revoked, queued email cancelled, capacity free.
  const deleted = [];
  const done = await withdrawReservation({ marketId, reservationId: id, note: 'Vendor emailed 9/20: spring only.', now, cancelLink: async link => { deleted.push([link.paymentLinkId, link.squareOrderId]); return 'cancelled'; } }, first);
  assert.deepEqual(done, { kind: 'withdrawn', reservationId: id, linksCancelled: 1 });
  assert.deepEqual(deleted, [['PL-qa', 'ORD-qa']]);
  assert.equal((await first`SELECT revoked_at FROM fame_vendor_payment_sessions WHERE reservation_id = ${id}`)[0].revoked_at.toISOString(), now.toISOString());
  assert.deepEqual(rows(await first`SELECT state, safe_error, invitation_ciphertext FROM fame_payment_email_outbox WHERE reservation_id = ${id}`), [{ state: 'cancelled', safe_error: 'payment_email_reservation_withdrawn', invitation_ciphertext: null }]);
  const [reservation] = await first`SELECT state, withdrawn_at, withdrawal_note, payment_due_at FROM fame_reservations WHERE id = ${id}`;
  assert.deepEqual([reservation.state, reservation.withdrawn_at.toISOString(), reservation.withdrawal_note, reservation.payment_due_at], ['cancelled', now.toISOString(), 'Vendor emailed 9/20: spring only.', null]);
  assert.deepEqual(rows(await first`SELECT status, last_error_code FROM fame_payment_orders WHERE reservation_id = ${id}`), [{ status: 'cancelled', last_error_code: 'withdrawn_by_manager' }]);
  assert.equal((await first`SELECT revoked_at FROM fame_vendor_payment_invitations WHERE reservation_id = ${id}`)[0].revoked_at.toISOString(), now.toISOString());
  assert.equal(rows(await first`SELECT 1 FROM fame_reservation_allocations WHERE reservation_id = ${id}`).length, 1, 'allocation rows stay as audit evidence');
  const other = await seedEligibleApplication();
  assert.equal((await reserve(other.applicationId, selection({ selectedDates: ['2026-10-03'] }), first, 1)).kind, 'created', 'the withdrawn booth is free again');
  // Already withdrawn, paid, in manager review (a payment may be parked there), or unknown.
  assert.deepEqual(await withdrawReservation({ marketId, reservationId: id, note: 'x', now }, first), { kind: 'not_withdrawable', state: 'cancelled' });
  await first`UPDATE fame_reservations SET state = 'paid' WHERE id = ${id}`;
  assert.deepEqual(await withdrawReservation({ marketId, reservationId: id, note: 'x', now }, first), { kind: 'not_withdrawable', state: 'paid' });
  await first`UPDATE fame_reservations SET state = 'manual_review' WHERE id = ${id}`;
  assert.deepEqual(await withdrawReservation({ marketId, reservationId: id, note: 'x', now }, first), { kind: 'not_withdrawable', state: 'manual_review' });
  assert.deepEqual(await applicationBookingSummary(marketId, applicationId, first), { blocking: 1, unpaid: [] });
  assert.deepEqual(await withdrawReservation({ marketId, reservationId: randomUUID(), note: 'x', now }, first), { kind: 'not_found' });
  assert.deepEqual(await withdrawReservation({ marketId: 'other-market', reservationId: id, note: 'x', now }, first), { kind: 'not_found' });
  // A hold whose checkout is being created right now is left alone; one with no link needs no Square call at all.
  const plain = await reserve(other.applicationId, selection({ selectedDates: ['2026-10-10'] }), first, 1);
  const inflight = await claimSquarePaymentCheckout({ marketId, reservationId: plain.reservation.id, square, now, leaseSeconds: 60 }, first);
  assert.equal(inflight.kind, 'checkout_required');
  assert.deepEqual(await withdrawReservation({ marketId, reservationId: plain.reservation.id, note: 'x', now }, first), { kind: 'checkout_in_progress' });
  await first`UPDATE fame_payment_orders SET status = 'failed', lease_token = NULL, locked_until = NULL WHERE id = ${inflight.order.id}`;
  assert.deepEqual(await withdrawReservation({ marketId, reservationId: plain.reservation.id, note: 'Changed mind.', now }, first), { kind: 'withdrawn', reservationId: plain.reservation.id, linksCancelled: 0 });
  // An expired hold withdraws without any Square call (its link is already retired).
  const third = await seedEligibleApplication();
  const lapsed = await reserve(third.applicationId, selection({ selectedDates: ['2026-10-03'] }), first, 3);
  assert.equal(lapsed.kind, 'created');
  await first`UPDATE fame_reservations SET state = 'expired' WHERE id = ${lapsed.reservation.id}`;
  assert.deepEqual(await withdrawReservation({ marketId, reservationId: lapsed.reservation.id, note: 'Gave up.', now }, first), { kind: 'withdrawn', reservationId: lapsed.reservation.id, linksCancelled: 0 });
});

test('withdrawing an application records a terminal review event and blocks on live bookings (re-application is covered in application-handoff)', async () => {
  const { applicationId } = await seedEligibleApplication();
  const made = await reserve(applicationId, selection({ selectedDates: ['2026-10-03'] }));
  assert.deepEqual(await applicationBookingSummary(marketId, applicationId, first), { blocking: 0, unpaid: [made.reservation.id] });
  assert.deepEqual(await withdrawApplication({ marketId, applicationId, actorAccountId: marketId, note: 'Out this season.', now }, first), { kind: 'has_live_booking', states: ['held'] });
  await first`UPDATE fame_reservations SET state = 'paid' WHERE id = ${made.reservation.id}`;
  assert.deepEqual(await applicationBookingSummary(marketId, applicationId, first), { blocking: 1, unpaid: [] });
  await first`UPDATE fame_reservations SET state = 'cancelled' WHERE id = ${made.reservation.id}`;
  const done = await withdrawApplication({ marketId, applicationId, actorAccountId: marketId, note: 'Out this season.', now }, first);
  assert.deepEqual(done, { kind: 'withdrawn', applicationId, fromState: 'approved' });
  const [application] = await first`SELECT review_state, review_revision FROM fame_applications WHERE id = ${applicationId}`;
  assert.deepEqual([application.review_state, application.review_revision], ['withdrawn', 2]);
  const events = rows(await first`SELECT from_state, to_state, reason, outbox_id FROM fame_application_review_events WHERE application_id = ${applicationId} AND to_state = 'withdrawn'`);
  assert.deepEqual(events[0], { from_state: 'approved', to_state: 'withdrawn', reason: 'Out this season.', outbox_id: null });
  assert.deepEqual(await withdrawApplication({ marketId, applicationId, actorAccountId: marketId, note: 'x', now }, first), { kind: 'already_withdrawn' });
  assert.deepEqual(await withdrawApplication({ marketId, applicationId: randomUUID(), actorAccountId: marketId, note: 'x', now }, first), { kind: 'not_found' });
  // A withdrawn vendor cannot get a new booking until they re-apply (the evidence guard needs the approved state).
  assert.equal((await reserve(applicationId, selection({ selectedDates: ['2026-10-10'] }))).kind, 'not_eligible');
});

const { vendorBookingOverview, createBookingRequest, settleBookingRequest, listPendingBookingRequests, getBookingRequest } = require('../../.test-build/vendor-booking-pg.js');

test('a vendor can ask for open Saturdays; the request is validated against their bookings, insurance expiry and room', async () => {
  const { applicationId } = await seedEligibleApplication();
  await first`UPDATE fame_application_events SET snapshot = ${first.json({ source: 'qa', snapshot: { firstName: 'Val', lastName: 'Vendor', businessName: 'Val Crafts', email: 'val@example.org', applicantType: 'Vendor', vendorCategory: 'Arts & Crafts', selectedDates: ['2026-10-03'], boothsPerMarket: 1 } })} WHERE application_id = ${applicationId}`;
  const today = '2026-09-22';
  const before = await vendorBookingOverview({ marketId, applicationId, config: config(1), today }, first);
  assert.equal(before.eligible, true);
  assert.equal(before.profile.fromBooking, false);
  // A Saturday that already happened is flagged and refused.
  const later = await vendorBookingOverview({ marketId, applicationId, config: config(1), today: '2026-10-05' }, first);
  assert.deepEqual(later.days.map(d => [d.date, d.past]), [['2026-10-03', true], ['2026-10-10', false]]);
  const gone = await createBookingRequest({ marketId, applicationId, dates: ['2026-10-03'], booths: 1, note: '', config: config(1), today: '2026-10-05' }, first);
  assert.equal(gone.kind, 'invalid');
  assert.match(gone.problems[0], /already happened/);
  assert.deepEqual(before.days.map(d => [d.date, d.available, d.booked, d.uninsured]), [['2026-10-03', true, false, false], ['2026-10-10', true, false, false]]);
  // First booking by staff fixes the profile and takes a Saturday.
  const made = await reserve(applicationId, selection({ selectedDates: ['2026-10-03'] }), first, 1);
  assert.equal(made.kind, 'created');
  const after = await vendorBookingOverview({ marketId, applicationId, config: config(1), today }, first);
  assert.deepEqual([after.profile.fromBooking, after.profile.vendorCategory, after.bookings.length], [true, 'Arts & Crafts', 1]);
  assert.deepEqual(after.days.map(d => [d.date, d.booked]), [['2026-10-03', true], ['2026-10-10', false]]);
  // Bad requests are refused with reasons; nothing is written.
  const bad = await createBookingRequest({ marketId, applicationId, dates: ['2026-10-03', '2026-10-10', '2026-12-25'], booths: 9, note: 'x', config: config(1), today }, first);
  assert.equal(bad.kind, 'invalid');
  assert.ok(bad.problems.some(p => /already in one of your bookings/.test(p)) && bad.problems.some(p => /not a market Saturday/.test(p)) && bad.problems.some(p => /Booths per Saturday/.test(p)));
  assert.equal(rows(await first`SELECT 1 FROM fame_booking_requests`).length, 0);
  // Insurance that expires before the date blocks it.
  await first`UPDATE fame_application_documents SET expires_on = '2026-10-05' WHERE application_id = ${applicationId} AND kind = 'insurance'`;
  const uninsured = await createBookingRequest({ marketId, applicationId, dates: ['2026-10-10'], booths: 1, note: '', config: config(1), today }, first);
  assert.equal(uninsured.kind, 'invalid');
  assert.match(uninsured.problems[0], /insurance certificate expires \(2026-10-05\)/);
  assert.equal((await vendorBookingOverview({ marketId, applicationId, config: config(1), today }, first)).days[1].uninsured, true);
  await first`UPDATE fame_application_documents SET expires_on = '2027-06-01' WHERE application_id = ${applicationId} AND kind = 'insurance'`;
  // Another vendor fills the only booth on Oct 10: no room.
  const other = await seedEligibleApplication();
  assert.equal((await reserve(other.applicationId, selection({ selectedDates: ['2026-10-10'] }), first, 1)).kind, 'created');
  const full = await createBookingRequest({ marketId, applicationId, dates: ['2026-10-10'], booths: 1, note: '', config: config(1), today }, first);
  assert.equal(full.kind, 'invalid');
  assert.match(full.problems[0], /no longer has room/);
  // With two booths of capacity the request goes through, once.
  const ok = await createBookingRequest({ marketId, applicationId, dates: ['2026-10-10'], booths: 1, note: 'Please and thanks', config: config(2), today }, first);
  assert.equal(ok.kind, 'created');
  assert.deepEqual([ok.request.dates, ok.request.booths, ok.request.status, ok.request.vendorNote], [['2026-10-10'], 1, 'pending', 'Please and thanks']);
  const again = await createBookingRequest({ marketId, applicationId, dates: ['2026-10-10'], booths: 1, note: '', config: config(2), today }, first);
  assert.equal(again.kind, 'already_pending');
  assert.equal(again.request.id, ok.request.id);
  const pending = await listPendingBookingRequests(marketId, first);
  assert.deepEqual([pending.length, pending[0].businessName, pending[0].id], [1, 'Val Crafts', ok.request.id]);
  assert.equal((await vendorBookingOverview({ marketId, applicationId, config: config(2), today }, first)).pendingRequest.id, ok.request.id);
  // Staff settle it; a settled request cannot be settled twice.
  const declined = await settleBookingRequest({ marketId, requestId: ok.request.id, status: 'declined', staffNote: 'Full that week', actorAccountId: marketId, now }, first);
  assert.deepEqual([declined.kind, declined.request.status, declined.request.staffNote], ['settled', 'declined', 'Full that week']);
  assert.deepEqual(await settleBookingRequest({ marketId, requestId: ok.request.id, status: 'declined', staffNote: 'x', actorAccountId: marketId, now }, first), { kind: 'not_pending', status: 'declined' });
  assert.equal((await getBookingRequest(marketId, ok.request.id, first)).status, 'declined');
  assert.equal(await getBookingRequest('other-market', ok.request.id, first), null);
  // Confirmed requests must point at the booking they became.
  const second = await createBookingRequest({ marketId, applicationId, dates: ['2026-10-10'], booths: 1, note: '', config: config(2), today }, first);
  assert.equal(second.kind, 'created');
  await assert.rejects(settleBookingRequest({ marketId, requestId: second.request.id, status: 'confirmed', actorAccountId: marketId, now }, first));
  const booked = await reserve(applicationId, selection({ selectedDates: ['2026-10-10'] }), first, 2);
  assert.equal(booked.kind, 'created');
  const confirmed = await settleBookingRequest({ marketId, requestId: second.request.id, status: 'confirmed', reservationId: booked.reservation.id, actorAccountId: marketId, now }, first);
  assert.deepEqual([confirmed.kind, confirmed.request.status, confirmed.request.reservationId], ['settled', 'confirmed', booked.reservation.id]);
  // Not eligible once withdrawn.
  await first`UPDATE fame_applications SET review_state = 'withdrawn' WHERE id = ${applicationId}`;
  assert.equal((await createBookingRequest({ marketId, applicationId, dates: ['2026-10-03'], booths: 1, note: '', config: config(2), today }, first)).kind, 'not_eligible');
});

test('a booking refuses Saturdays after the insurance certificate expires and reports the expiry to staff', async () => {
  const { applicationId } = await seedEligibleApplication();
  await first`UPDATE fame_application_documents SET expires_on = '2026-10-05' WHERE application_id = ${applicationId} AND kind = 'insurance'`;
  assert.equal((await getFinalApplicationReservation(marketId, applicationId, first)).insuranceExpiresOn, '2026-10-05');
  const blocked = await reserve(applicationId, selection({ selectedDates: ['2026-10-03', '2026-10-10'] }));
  assert.deepEqual(blocked, { kind: 'insurance_expires', expiresOn: '2026-10-05', dates: ['2026-10-10'] });
  assert.equal(rows(await first`SELECT 1 FROM fame_reservations WHERE application_id = ${applicationId}`).length, 0);
  assert.equal((await reserve(applicationId, selection({ selectedDates: ['2026-10-03'] }))).kind, 'created');
});
