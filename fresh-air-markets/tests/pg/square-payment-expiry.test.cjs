const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const postgres = require('postgres');
const { reserveFinalApplication } = require('../../.test-build/final-reservation-pg.js');
const {
  claimSquarePaymentCheckout,
  completeSquarePaymentCheckout,
  expireDueSquarePaymentHolds,
  claimSquarePaymentLinkRetirement,
  completeSquarePaymentLinkRetirement,
  failSquarePaymentLinkRetirement,
} = require('../../.test-build/square-payment-pg.js');
const { persistSquarePaymentWebhook } = require('../../.test-build/square-webhook-pg.js');

// This suite creates and drops only a private schema inside the disposable CI DB.
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = 'qa_square_payment_expiry';
const admin = postgres(url.toString(), { max: 1, prepare: false });
const connect = () => postgres(url.toString(), {
  max: 12,
  prepare: false,
  connection: { search_path: schema, statement_timeout: 15000 },
});
const first = connect();
const second = connect();
const marketId = 'qa-square-expiry-market';
const locationId = 'qa-square-expiry-location';
const merchantId = 'qa-square-expiry-merchant';
const squareLocationId = 'qa-square-expiry-square-location';
const createdAt = new Date('2026-10-01T12:00:00.000Z');
const dueAt = new Date('2026-10-03T12:00:00.000Z');
const calendarDates = ['2026-10-03'];

// postgres returns a Result array subclass. Convert only query results used in
// structural assertions so the test checks rows rather than a driver prototype.
const rows = result => Array.from(result, row => ({ ...row }));

const config = (boothCapacity = 1) => ({
  marketId,
  seasonId: '2026-2027',
  boothCapacity,
  calendarDates,
  quoteVersion: 'qa-expiry-v1',
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
      '015-square-payment-expiry-retry-schedule.sql',
      '016-square-production-environment-fences.sql',
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
       'approved', 1, ${createdAt}, ${marketId})`;
  await sql`
    INSERT INTO fame_application_events
      (location_id, event_id, market_id, application_id, payload_hash, snapshot, created_at)
    VALUES
      (${locationId}, ${sourceEventId}, ${marketId}, ${applicationId}, ${'a'.repeat(64)},
       ${sql.json({ source: 'qa' })}, ${createdAt})`;
  await sql`
    INSERT INTO fame_application_review_events
      (id, application_id, market_id, source_event_id, actor_account_id,
       idempotency_key, payload_hash, from_state, to_state, reason, created_at)
    VALUES
      (${reviewEventId}, ${applicationId}, ${marketId}, ${sourceEventId}, ${marketId},
       ${randomUUID()}, ${'b'.repeat(64)}, 'unreviewed', 'approved', '', ${createdAt})`;
  await sql`
    INSERT INTO fame_agreement_completions
      (id, application_id, market_id, location_id, contact_id, opportunity_id,
       season_id, document_id, template_id, completion_event_id, completed_at)
    VALUES
      (${agreementId}, ${applicationId}, ${marketId}, ${locationId}, ${contactId}, ${opportunityId},
       '2026-2027', ${`agreement-document-${applicationId}`}, 'qa-template',
       ${`agreement-event-${applicationId}`}, ${createdAt})`;
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
       ${'c'.repeat(64)}, ${createdAt}, 'ready_for_review', '', ${createdAt}, 'approved',
       1, ${createdAt}, ${marketId}, '', TRUE)`;
  return { applicationId };
}

async function checkoutForApplication(sql = first, environment = 'sandbox', boothCapacity = 1) {
  const application = await seedEligibleApplication(sql);
  const final = await reserveFinalApplication({
    marketId,
    applicationId: application.applicationId,
    actorAccountId: marketId,
    selection: selection(),
    config: config(boothCapacity),
    now: createdAt,
  }, sql);
  assert.equal(final.kind, 'created');
  const claim = await claimSquarePaymentCheckout({
    marketId,
    reservationId: final.reservation.id,
    square: { environment, merchantId, locationId: squareLocationId },
    now: createdAt,
    leaseSeconds: 60,
  }, sql);
  assert.equal(claim.kind, 'checkout_required');
  const completed = await completeSquarePaymentCheckout({
    paymentOrderId: claim.order.id,
    leaseToken: claim.leaseToken,
    checkout: {
      paymentLinkId: `link-${claim.order.id}`,
      orderId: `square-order-${claim.order.id}`,
      checkoutUrl: environment === 'production' ? 'https://square.link/u/qa-expiry' : 'https://sandbox.square.link/u/qa-expiry',
      createdAt: createdAt.toISOString(),
      idempotencyKey: claim.order.idempotencyKey,
    },
    sentAt: createdAt,
  }, sql);
  assert.equal(completed.kind, 'completed');
  return { reservationId: final.reservation.id, paymentOrderId: claim.order.id, squareOrderId: `square-order-${claim.order.id}` };
}

function paymentEvent(order, patch = {}) {
  const { payment: paymentPatch = {}, ...eventPatch } = patch;
  const payment = {
    id: `payment-${randomUUID()}`,
    status: 'COMPLETED',
    locationId: squareLocationId,
    orderId: order.squareOrderId,
    amountCents: 4000,
    currency: 'USD',
    createdAt: createdAt.toISOString(),
    updatedAt: dueAt.toISOString(),
    ...paymentPatch,
  };
  const event = {
    eventId: `event-${randomUUID()}`,
    eventType: 'payment.updated',
    merchantId,
    occurredAt: dueAt.toISOString(),
    ...eventPatch,
    payment,
  };
  return { ...event, rawBodySha256: createHash('sha256').update(JSON.stringify(event)).digest('hex') };
}

function expire(sql = first, now = dueAt, limit = 25, paymentOrderId) {
  return expireDueSquarePaymentHolds({ marketId, now, limit, paymentOrderId }, sql);
}

test('exactly one concurrent expiry claims the 48-hour hold, then provider retirement releases capacity once', async () => {
  const order = await checkoutForApplication();
  assert.deepEqual(await expire(first, new Date(dueAt.valueOf() - 1)), { expiryPending: 0, manualReview: 0 });

  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => expire(index % 2 ? first : second, dueAt, 1)));
  assert.equal(results.reduce((total, result) => total + result.expiryPending, 0), 1);
  assert.equal(results.reduce((total, result) => total + result.manualReview, 0), 0);
  assert.deepEqual(await expire(first, dueAt), { expiryPending: 0, manualReview: 0 });

  const [payment] = await first`SELECT status, last_error_code FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`;
  const [reservation] = await first`SELECT state FROM fame_reservations WHERE id = ${order.reservationId}`;
  const [retirement] = await first`
    SELECT status, attempt_count, square_payment_link_id
    FROM fame_square_payment_link_retirements
    WHERE payment_order_id = ${order.paymentOrderId}`;
  assert.deepEqual(payment, { status: 'expiry_pending', last_error_code: 'payment_expiry_pending' });
  assert.deepEqual(reservation, { state: 'payment_pending' });
  assert.deepEqual(retirement, { status: 'pending', attempt_count: 0, square_payment_link_id: `link-${order.paymentOrderId}` });

  // The still-live link means capacity remains held until Square retirement
  // confirms. Then the same immutable allocation becomes audit history only.
  assert.equal((await first`SELECT * FROM fame_reservation_allocations WHERE reservation_id = ${order.reservationId}`).length, 1);
  const square = { environment: 'sandbox', merchantId, locationId: squareLocationId };
  const claim = await claimSquarePaymentLinkRetirement({ marketId, square, now: dueAt, leaseSeconds: 60 }, first);
  assert.equal(claim.kind, 'retirement_required');
  assert.deepEqual(await completeSquarePaymentLinkRetirement({
    paymentOrderId: order.paymentOrderId, leaseToken: claim.leaseToken,
    cancelledOrderId: order.squareOrderId, retiredAt: dueAt,
  }, first), { kind: 'retired' });
  assert.deepEqual(rows(await first`SELECT state FROM fame_reservations WHERE id = ${order.reservationId}`), [{ state: 'expired' }]);
  const nextApplication = await seedEligibleApplication(second);
  const next = await reserveFinalApplication({
    marketId,
    applicationId: nextApplication.applicationId,
    actorAccountId: marketId,
    selection: selection(),
    config: config(1),
    now: dueAt,
  }, second);
  assert.equal(next.kind, 'created');
});

test('a payment-order fence leaves every other QA hold untouched until the exact target is selected', async () => {
  const order = await checkoutForApplication();
  assert.deepEqual(await expire(first, dueAt, 25, 'qa-not-this-payment-order'), { expiryPending: 0, manualReview: 0 });
  assert.deepEqual(rows(await first`
    SELECT status FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`), [{ status: 'checkout_created' }]);
  assert.deepEqual(await expire(first, dueAt, 25, order.paymentOrderId), { expiryPending: 1, manualReview: 0 });
  const square = { environment: 'sandbox', merchantId, locationId: squareLocationId };
  assert.deepEqual(await claimSquarePaymentLinkRetirement({
    marketId, paymentOrderId: 'qa-not-this-payment-order', square, now: dueAt, leaseSeconds: 60,
  }, first), { kind: 'no_work' });
  assert.equal((await claimSquarePaymentLinkRetirement({
    marketId, paymentOrderId: order.paymentOrderId, square, now: dueAt, leaseSeconds: 60,
  }, first)).kind, 'retirement_required');
});

test('retirement leases back off after provider failure while the claimed hold keeps capacity', async () => {
  const order = await checkoutForApplication();
  assert.deepEqual(await expire(), { expiryPending: 1, manualReview: 0 });
  const square = { environment: 'sandbox', merchantId, locationId: squareLocationId };
  const firstClaim = await claimSquarePaymentLinkRetirement({ marketId, square, now: dueAt, leaseSeconds: 60 }, first);
  assert.equal(firstClaim.kind, 'retirement_required');
  await failSquarePaymentLinkRetirement({
    paymentOrderId: order.paymentOrderId,
    leaseToken: firstClaim.leaseToken,
    code: 'square_http_503',
    retryable: true,
    attemptedAt: dueAt,
  }, first);
  const [pending] = await first`
    SELECT status, attempt_count, locked_until, lease_token, next_attempt_at, last_error_code
    FROM fame_square_payment_link_retirements
    WHERE payment_order_id = ${order.paymentOrderId}`;
  assert.equal(pending.status, 'pending');
  assert.equal(pending.attempt_count, 1);
  assert.equal(pending.locked_until, null);
  assert.equal(pending.lease_token, null);
  assert.equal(pending.last_error_code, 'square_http_503');
  const retryAt = new Date(dueAt.valueOf() + 15_000);
  assert.equal(new Date(pending.next_attempt_at).toISOString(), retryAt.toISOString());
  assert.deepEqual(rows(await first`SELECT state FROM fame_reservations WHERE id = ${order.reservationId}`), [{ state: 'payment_pending' }]);
  assert.deepEqual(rows(await first`SELECT status FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`), [{ status: 'expiry_pending' }]);
  // The route can loop over other due rows, but this failed row is not eligible
  // again in the same invocation/time slice.
  assert.deepEqual(await claimSquarePaymentLinkRetirement({ marketId, square, now: dueAt, leaseSeconds: 60 }, second), { kind: 'no_work' });
  const retry = await claimSquarePaymentLinkRetirement({ marketId, square, now: retryAt, leaseSeconds: 60 }, second);
  assert.equal(retry.kind, 'retirement_required');
  assert.equal(retry.retirement.attempt, 2);
  assert.deepEqual(await completeSquarePaymentLinkRetirement({
    paymentOrderId: order.paymentOrderId,
    leaseToken: retry.leaseToken,
    cancelledOrderId: order.squareOrderId,
    retiredAt: retryAt,
  }, second), { kind: 'retired' });
  const [retired] = await first`
    SELECT status, attempt_count, retired_at, retired_square_order_id, locked_until, lease_token
    FROM fame_square_payment_link_retirements
    WHERE payment_order_id = ${order.paymentOrderId}`;
  assert.equal(retired.status, 'retired');
  assert.equal(retired.attempt_count, 2);
  assert.equal(new Date(retired.retired_at).toISOString(), retryAt.toISOString());
  assert.equal(retired.retired_square_order_id, order.squareOrderId);
  assert.equal(retired.locked_until, null);
  assert.equal(retired.lease_token, null);
  assert.deepEqual(rows(await first`SELECT state FROM fame_reservations WHERE id = ${order.reservationId}`), [{ state: 'expired' }]);
});

test('payment completion and expiry serialize; a signed event fences expiry-pending capacity for review', async () => {
  const paidFirst = await checkoutForApplication();
  const onTime = paymentEvent(paidFirst);
  assert.deepEqual(await persistSquarePaymentWebhook(onTime, { environment: 'sandbox', now: dueAt }, second), { kind: 'paid' });
  assert.deepEqual(await expire(first, dueAt), { expiryPending: 0, manualReview: 0 });
  assert.deepEqual(rows(await first`SELECT state FROM fame_reservations WHERE id = ${paidFirst.reservationId}`), [{ state: 'paid' }]);

  // A distinct record exercises the opposite ordering. The provider timestamp
  // is before the deadline, but expiry claimed its link first. The signed
  // delivery becomes review evidence, cancels automatic retirement, and keeps
  // capacity held for an operator instead of silently expiring a possible pay.
  await first`TRUNCATE fame_applications CASCADE`;
  const expiredFirst = await checkoutForApplication(first);
  assert.deepEqual(await expire(first, dueAt), { expiryPending: 1, manualReview: 0 });
  const delayedOnTime = paymentEvent(expiredFirst, {
    payment: { updatedAt: new Date(dueAt.valueOf() - 1).toISOString() },
  });
  assert.deepEqual(await persistSquarePaymentWebhook(delayedOnTime, { environment: 'sandbox', now: dueAt }, second), { kind: 'manual_review' });
  assert.deepEqual(rows(await first`SELECT state FROM fame_reservations WHERE id = ${expiredFirst.reservationId}`), [{ state: 'manual_review' }]);
  assert.deepEqual(rows(await first`SELECT status FROM fame_payment_orders WHERE id = ${expiredFirst.paymentOrderId}`), [{ status: 'manual_review' }]);
  assert.deepEqual(rows(await first`
    SELECT status, last_error_code
    FROM fame_square_payment_link_retirements
    WHERE payment_order_id = ${expiredFirst.paymentOrderId}`),
  [{ status: 'manual_review', last_error_code: 'payment_order_or_reservation_not_payable' }]);
  const retirement = await claimSquarePaymentLinkRetirement({
    marketId, square: { environment: 'sandbox', merchantId, locationId: squareLocationId }, now: dueAt, leaseSeconds: 60,
  }, first);
  assert.equal(retirement.kind, 'no_work');
  const nextApplication = await seedEligibleApplication(first);
  const blocked = await reserveFinalApplication({
    marketId,
    applicationId: nextApplication.applicationId,
    actorAccountId: marketId,
    selection: selection(),
    config: config(1),
    now: dueAt,
  }, first);
  assert.equal(blocked.kind, 'unavailable');
});

test('a corrupted deadline goes to manual review and keeps capacity held instead of releasing an unknown payment', async () => {
  const order = await checkoutForApplication();
  await first`
    UPDATE fame_reservations
    SET payment_due_at = ${new Date(dueAt.valueOf() + 1000)}
    WHERE id = ${order.reservationId}`;
  assert.deepEqual(await expire(first, dueAt), { expiryPending: 0, manualReview: 1 });
  assert.deepEqual(rows(await first`SELECT state FROM fame_reservations WHERE id = ${order.reservationId}`), [{ state: 'manual_review' }]);
  assert.deepEqual(rows(await first`SELECT status, last_error_code FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`),
    [{ status: 'manual_review', last_error_code: 'payment_deadline_missing_or_mismatched' }]);
  assert.equal((await first`SELECT * FROM fame_square_payment_link_retirements WHERE payment_order_id = ${order.paymentOrderId}`).length, 0);
});

test('missing or future-mismatched deadline copies are fenced before either deadline is due', async () => {
  const beforeDue = new Date(dueAt.valueOf() - 60 * 60 * 1000);
  const missing = await checkoutForApplication();
  await first`
    UPDATE fame_payment_orders
    SET payment_due_at = NULL
    WHERE id = ${missing.paymentOrderId}`;
  assert.deepEqual(await expire(first, beforeDue), { expiryPending: 0, manualReview: 1 });
  assert.deepEqual(rows(await first`SELECT state FROM fame_reservations WHERE id = ${missing.reservationId}`), [{ state: 'manual_review' }]);
  assert.deepEqual(rows(await first`SELECT status, last_error_code FROM fame_payment_orders WHERE id = ${missing.paymentOrderId}`),
    [{ status: 'manual_review', last_error_code: 'payment_deadline_missing_or_mismatched' }]);
  assert.equal((await first`SELECT * FROM fame_reservation_allocations WHERE reservation_id = ${missing.reservationId}`).length, 1);

  await first`TRUNCATE fame_applications CASCADE`;
  const mismatched = await checkoutForApplication();
  await first`
    UPDATE fame_reservations
    SET payment_due_at = ${new Date(dueAt.valueOf() + 60_000)}
    WHERE id = ${mismatched.reservationId}`;
  assert.deepEqual(await expire(first, beforeDue), { expiryPending: 0, manualReview: 1 });
  assert.deepEqual(rows(await first`SELECT state FROM fame_reservations WHERE id = ${mismatched.reservationId}`), [{ state: 'manual_review' }]);
  assert.deepEqual(rows(await first`SELECT status, last_error_code FROM fame_payment_orders WHERE id = ${mismatched.paymentOrderId}`),
    [{ status: 'manual_review', last_error_code: 'payment_deadline_missing_or_mismatched' }]);
  assert.equal((await first`SELECT * FROM fame_reservation_allocations WHERE reservation_id = ${mismatched.reservationId}`).length, 1);
});

test('a retirement row that no longer maps to its parent is fenced before any provider call or capacity release', async () => {
  const order = await checkoutForApplication();
  assert.deepEqual(await expire(), { expiryPending: 1, manualReview: 0 });
  await first`
    UPDATE fame_square_payment_link_retirements
    SET square_payment_link_id = 'wrong-link'
    WHERE payment_order_id = ${order.paymentOrderId}`;
  const claim = await claimSquarePaymentLinkRetirement({
    marketId, square: { environment: 'sandbox', merchantId, locationId: squareLocationId }, now: dueAt, leaseSeconds: 60,
  }, first);
  assert.deepEqual(claim, { kind: 'manual_review', paymentOrderId: order.paymentOrderId });
  assert.deepEqual(rows(await first`SELECT status FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`),
    [{ status: 'manual_review' }]);
  assert.deepEqual(rows(await first`SELECT state FROM fame_reservations WHERE id = ${order.reservationId}`),
    [{ state: 'manual_review' }]);
  assert.deepEqual(rows(await first`
    SELECT status, last_error_code
    FROM fame_square_payment_link_retirements
    WHERE payment_order_id = ${order.paymentOrderId}`),
  [{ status: 'manual_review', last_error_code: 'square_retirement_parent_mapping_mismatch' }]);
});

test('a configured Square identity mismatch fences the order, reservation, and retirement together', async () => {
  const order = await checkoutForApplication();
  assert.deepEqual(await expire(), { expiryPending: 1, manualReview: 0 });
  const claim = await claimSquarePaymentLinkRetirement({
    marketId, square: { environment: 'sandbox', merchantId: 'wrong-merchant', locationId: squareLocationId }, now: dueAt, leaseSeconds: 60,
  }, first);
  assert.deepEqual(claim, { kind: 'manual_review', paymentOrderId: order.paymentOrderId });
  assert.deepEqual(rows(await first`SELECT status FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`),
    [{ status: 'manual_review' }]);
  assert.deepEqual(rows(await first`SELECT state FROM fame_reservations WHERE id = ${order.reservationId}`),
    [{ state: 'manual_review' }]);
  assert.deepEqual(rows(await first`
    SELECT status, last_error_code
    FROM fame_square_payment_link_retirements
    WHERE payment_order_id = ${order.paymentOrderId}`),
  [{ status: 'manual_review', last_error_code: 'square_retirement_identity_mismatch' }]);
});

test('the 014-to-015 upgrade chain quarantines proofless legacy retirements before the proof constraint is installed', async () => {
  const legacySchema = 'qa_square_payment_expiry_legacy';
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`);
  await admin.unsafe(`CREATE SCHEMA ${legacySchema}`);
  const legacy = postgres(url.toString(), {
    max: 1,
    prepare: false,
    connection: { search_path: legacySchema },
  });
  try {
    await legacy.unsafe(`
      CREATE TABLE fame_reservations (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TIMESTAMPTZ
      );
      CREATE TABLE fame_payment_orders (
        id TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        status TEXT NOT NULL,
        square_order_id TEXT,
        locked_until TIMESTAMPTZ,
        lease_token TEXT,
        last_error_code TEXT,
        updated_at TIMESTAMPTZ
      );
      CREATE TABLE fame_square_payment_link_retirements (
        payment_order_id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        square_environment TEXT NOT NULL,
        square_merchant_id TEXT NOT NULL,
        square_location_id TEXT NOT NULL,
        square_payment_link_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        square_order_id TEXT,
        retired_square_order_id TEXT,
        retired_at TIMESTAMPTZ,
        locked_until TIMESTAMPTZ,
        lease_token TEXT,
        last_error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ
      );
      INSERT INTO fame_reservations (id, market_id, state) VALUES
        ('legacy-reservation-missing', 'legacy-market', 'payment_pending'),
        ('legacy-reservation-mismatch', 'legacy-market', 'payment_pending'),
        ('legacy-reservation-no-time', 'legacy-market', 'payment_pending'),
        ('legacy-reservation-stale-proof', 'legacy-market', 'payment_pending');
      INSERT INTO fame_payment_orders (id, reservation_id, market_id, status, square_order_id) VALUES
        ('legacy-order-missing', 'legacy-reservation-missing', 'legacy-market', 'checkout_created', 'square-order-missing'),
        ('legacy-order-mismatch', 'legacy-reservation-mismatch', 'legacy-market', 'checkout_created', 'square-order-mismatch'),
        ('legacy-order-no-time', 'legacy-reservation-no-time', 'legacy-market', 'checkout_created', 'square-order-no-time'),
        ('legacy-order-stale-proof', 'legacy-reservation-stale-proof', 'legacy-market', 'checkout_created', 'square-order-stale-proof');
      INSERT INTO fame_square_payment_link_retirements
        (payment_order_id, market_id, square_environment, square_merchant_id, square_location_id,
         square_payment_link_id, status, square_order_id, retired_square_order_id, retired_at)
      VALUES
        ('legacy-order-missing', 'legacy-market', 'sandbox', 'legacy-merchant', 'legacy-location',
         'legacy-link-missing', 'retired', 'square-order-missing', NULL, '2026-10-03T12:00:00.000Z'),
        ('legacy-order-mismatch', 'legacy-market', 'sandbox', 'legacy-merchant', 'legacy-location',
         'legacy-link-mismatch', 'retired', 'square-order-mismatch', 'other-square-order', '2026-10-03T12:00:00.000Z'),
        ('legacy-order-no-time', 'legacy-market', 'sandbox', 'legacy-merchant', 'legacy-location',
         'legacy-link-no-time', 'retired', 'square-order-no-time', 'square-order-no-time', NULL),
        ('legacy-order-stale-proof', 'legacy-market', 'sandbox', 'legacy-merchant', 'legacy-location',
         'legacy-link-stale-proof', 'pending', 'square-order-stale-proof', 'stale-proof', '2026-10-03T12:00:00.000Z');
    `);
    await legacy.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations/014-square-payment-expiry.sql'), 'utf8'));
    await legacy.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations/015-square-payment-expiry-retry-schedule.sql'), 'utf8'));
    assert.deepEqual(rows(await legacy`
      SELECT id, status, last_error_code
      FROM fame_payment_orders
      ORDER BY id`), [
      { id: 'legacy-order-mismatch', status: 'manual_review', last_error_code: 'legacy_retired_without_cancellation_proof' },
      { id: 'legacy-order-missing', status: 'manual_review', last_error_code: 'legacy_retired_without_cancellation_proof' },
      { id: 'legacy-order-no-time', status: 'manual_review', last_error_code: 'legacy_retired_without_cancellation_proof' },
      { id: 'legacy-order-stale-proof', status: 'checkout_created', last_error_code: null },
    ]);
    assert.deepEqual(rows(await legacy`
      SELECT state
      FROM fame_reservations
      ORDER BY id`), [
      { state: 'manual_review' },
      { state: 'manual_review' },
      { state: 'manual_review' },
      { state: 'payment_pending' },
    ]);
    const retirements = rows(await legacy`
      SELECT status, retired_at, retired_square_order_id, next_attempt_at, last_error_code
      FROM fame_square_payment_link_retirements
      ORDER BY payment_order_id`);
    assert.deepEqual(retirements.slice(0, 3), [
      { status: 'manual_review', retired_at: null, retired_square_order_id: null, next_attempt_at: null, last_error_code: 'legacy_retired_without_cancellation_proof' },
      { status: 'manual_review', retired_at: null, retired_square_order_id: null, next_attempt_at: null, last_error_code: 'legacy_retired_without_cancellation_proof' },
      { status: 'manual_review', retired_at: null, retired_square_order_id: null, next_attempt_at: null, last_error_code: 'legacy_retired_without_cancellation_proof' },
    ]);
    assert.deepEqual({
      ...retirements[3],
      next_attempt_at: retirements[3].next_attempt_at ? 'set' : null,
    }, {
      status: 'pending', retired_at: null, retired_square_order_id: null,
      next_attempt_at: 'set', last_error_code: 'legacy_retirement_proof_cleared',
    });
  } finally {
    await legacy.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`);
  }
});


test('production checkout persists its environment, retries the same order, and refuses a Sandbox replay of the reservation', async () => {
  const order = await checkoutForApplication(first, 'production');
  const claim = async environment => claimSquarePaymentCheckout({
    marketId, reservationId: order.reservationId, square: { environment, merchantId, locationId: squareLocationId },
    now: createdAt, leaseSeconds: 60,
  }, first);
  const replay = await claim('production');
  assert.equal(replay.kind, 'checkout_created');
  assert.equal(replay.order.id, order.paymentOrderId);
  assert.equal(replay.order.environment, 'production');
  assert.deepEqual(await claim('sandbox'), { kind: 'not_payable', reason: 'invalid_reservation' });
  assert.equal((await first`SELECT id FROM fame_payment_orders`).length, 1);
});

test('identical provider event/order/payment IDs in separate environments reconcile only their own durable reservation', async () => {
  const production = await checkoutForApplication(first, 'production', 2);
  const sandbox = await checkoutForApplication(first, 'sandbox', 2);
  await first`UPDATE fame_payment_orders SET square_order_id = 'same-provider-order'`;
  const event = paymentEvent({ squareOrderId: 'same-provider-order' }, { eventId: 'same-event', payment: { id: 'same-payment' } });
  const config = { environment: 'production', merchantId, locationId: squareLocationId, now: dueAt };
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => persistSquarePaymentWebhook(event, config, i % 2 ? first : second)));
  assert.equal(results.filter(value => value.kind === 'paid').length, 1);
  assert.equal(results.filter(value => value.kind === 'duplicate').length, 29);
  assert.equal((await first`SELECT state FROM fame_reservations WHERE id = ${production.reservationId}`)[0].state, 'paid');
  assert.equal((await first`SELECT state FROM fame_reservations WHERE id = ${sandbox.reservationId}`)[0].state, 'payment_pending');
  assert.deepEqual(await persistSquarePaymentWebhook(event, { environment: 'sandbox', now: dueAt }, first), { kind: 'paid' });
  assert.deepEqual(rows(await first`SELECT square_environment, disposition FROM fame_square_webhook_events ORDER BY square_environment`),
    [{ square_environment: 'production', disposition: 'paid' }, { square_environment: 'sandbox', disposition: 'paid' }]);
});

test('production scheduler cannot claim, quarantine or retire a Sandbox hold in the same market', async () => {
  const production = await checkoutForApplication(first, 'production', 2);
  const sandbox = await checkoutForApplication(first, 'sandbox', 2);
  assert.deepEqual(await expireDueSquarePaymentHolds({ marketId, environment: 'production', now: dueAt, limit: 25 }, first), { expiryPending: 1, manualReview: 0 });
  assert.equal((await first`SELECT status FROM fame_payment_orders WHERE id = ${sandbox.paymentOrderId}`)[0].status, 'checkout_created');
  assert.equal((await first`SELECT state FROM fame_reservations WHERE id = ${sandbox.reservationId}`)[0].state, 'payment_pending');
  const sandboxClaim = await claimSquarePaymentLinkRetirement({ marketId, square: { environment: 'sandbox', merchantId, locationId: squareLocationId }, now: dueAt, leaseSeconds: 60 }, first);
  assert.deepEqual(sandboxClaim, { kind: 'no_work' });
  const liveClaim = await claimSquarePaymentLinkRetirement({ marketId, square: { environment: 'production', merchantId, locationId: squareLocationId }, now: dueAt, leaseSeconds: 60 }, first);
  assert.equal(liveClaim.kind, 'retirement_required');
  assert.equal(liveClaim.retirement.paymentOrderId, production.paymentOrderId);
  assert.deepEqual(await completeSquarePaymentLinkRetirement({ paymentOrderId: production.paymentOrderId, leaseToken: liveClaim.leaseToken, cancelledOrderId: production.squareOrderId, retiredAt: dueAt }, first), { kind: 'retired' });
  assert.equal((await first`SELECT state FROM fame_reservations WHERE id = ${production.reservationId}`)[0].state, 'expired');
  assert.equal((await first`SELECT state FROM fame_reservations WHERE id = ${sandbox.reservationId}`)[0].state, 'payment_pending');
});

test('database freezes Square environment/identity/amount and forbids cross-environment receipt/retirement links', async () => {
  const order = await checkoutForApplication(first, 'production');
  for (const change of [
    first`UPDATE fame_payment_orders SET square_environment = 'sandbox' WHERE id = ${order.paymentOrderId}`,
    first`UPDATE fame_payment_orders SET square_merchant_id = 'other' WHERE id = ${order.paymentOrderId}`,
    first`UPDATE fame_payment_orders SET expected_total_cents = 1 WHERE id = ${order.paymentOrderId}`,
  ]) await assert.rejects(change, /immutable/);
  await expireDueSquarePaymentHolds({ marketId, environment: 'production', now: dueAt, limit: 25 }, first);
  await assert.rejects(first`UPDATE fame_square_payment_link_retirements SET square_environment = 'sandbox' WHERE payment_order_id = ${order.paymentOrderId}`, error => error.code === '23503');
  const event = paymentEvent(order);
  assert.deepEqual(await persistSquarePaymentWebhook(event, { environment: 'production', merchantId, locationId: squareLocationId, now: dueAt }, first), { kind: 'manual_review' });
  await assert.rejects(first`UPDATE fame_square_webhook_events SET square_environment = 'sandbox' WHERE event_id = ${event.eventId}`, error => error.code === '23503');
});

test('production receipts reject QA rollback and missing merchant; wrong configured identity records review without changing payment', async () => {
  const order = await checkoutForApplication(first, 'production');
  const event = paymentEvent(order);
  await assert.rejects(persistSquarePaymentWebhook(event, { environment: 'production', locationId: squareLocationId, now: dueAt }, first), /pinned identity/);
  await assert.rejects(persistSquarePaymentWebhook(event, { environment: 'production', merchantId, locationId: squareLocationId, qaRollbackEventId: event.eventId, now: dueAt }, first), /QA rollback/);
  assert.equal((await first`SELECT event_id FROM fame_square_webhook_events`).length, 0);
  assert.deepEqual(await persistSquarePaymentWebhook(event, { environment: 'production', merchantId: 'wrong', locationId: squareLocationId, now: dueAt }, first), { kind: 'manual_review' });
  assert.equal((await first`SELECT status FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`)[0].status, 'checkout_created');
  assert.equal((await first`SELECT state FROM fame_reservations WHERE id = ${order.reservationId}`)[0].state, 'payment_pending');
  assert.equal((await first`SELECT manual_review_reason FROM fame_square_webhook_events WHERE event_id = ${event.eventId}`)[0].manual_review_reason, 'configured_square_identity_mismatch');
});
