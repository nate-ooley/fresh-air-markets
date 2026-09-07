const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const postgres = require('postgres');
const { persistSquarePaymentWebhook } = require('../../.test-build/square-webhook-pg.js');

// This suite creates and drops only a private schema inside the disposable CI DB.
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = 'qa_square_webhook';
const admin = postgres(url.toString(), { max: 1, prepare: false });
const connect = () => postgres(url.toString(), {
  max: 10,
  prepare: false,
  connection: { search_path: schema, statement_timeout: 15000 },
});
const first = connect();
const second = connect();
const market = 'qa-square-webhook-market';
const now = new Date('2026-10-01T12:00:00.000Z');
const dueAt = new Date('2026-10-03T12:00:00.000Z');

before(async () => {
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await first`CREATE TABLE accounts (id TEXT PRIMARY KEY)`;
  await first`INSERT INTO accounts (id) VALUES (${market})`;
  const migration = postgres(url.toString(), { max: 1, prepare: false, connection: { search_path: schema } });
  try {
    for (const file of ['001-application-handoff.sql', '006-application-document-ledger.sql', '011-square-payment-checkout-ledger.sql', '012-square-webhook-events.sql']) {
      await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations', file), 'utf8'));
    }
  } finally {
    await migration.end();
  }
});

beforeEach(async () => {
  await first`TRUNCATE fame_square_webhook_events, fame_payment_orders, fame_reservations, fame_application_events, fame_applications CASCADE`;
});

after(async () => {
  await first.end();
  await second.end();
  await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

async function seedOrder(patch = {}) {
  const reservationId = patch.reservationId || `reservation-${randomUUID()}`;
  const paymentOrderId = patch.paymentOrderId || `payment-order-${randomUUID()}`;
  const squareOrderId = patch.squareOrderId || `square-order-${randomUUID()}`;
  const merchantId = patch.merchantId || 'sandbox-merchant';
  const locationId = patch.locationId || 'sandbox-location';
  const totalCents = patch.totalCents ?? 28000;
  const state = patch.reservationState || 'payment_pending';
  const status = patch.orderStatus || 'checkout_created';
  const deadline = patch.dueAt || dueAt;
  await first`
    INSERT INTO fame_reservations
      (id, market_id, revision, state, payment_required, currency, total_cents,
       checkout_description, quote_version, final_booth_quantity, final_dates,
       payment_request_sent_at, payment_due_at, updated_at)
    VALUES
      (${reservationId}, ${market}, 1, ${state}, true, 'USD', ${totalCents},
       'QA market reservation', 'qa-quote-v1', 1, ${first.json(['2026-10-03'])},
       ${now}, ${deadline}, ${now})`;
  await first`
    INSERT INTO fame_payment_orders
      (id, market_id, reservation_id, reservation_revision, square_environment,
       square_merchant_id, square_location_id, expected_currency,
       expected_total_cents, idempotency_key, status, square_payment_link_id,
       square_order_id, checkout_url, payment_request_sent_at, payment_due_at,
       updated_at)
    VALUES
      (${paymentOrderId}, ${market}, ${reservationId}, 1, 'sandbox', ${merchantId},
       ${locationId}, 'USD', ${totalCents}, ${`idempotency:${reservationId}`}, ${status},
       ${`link:${reservationId}`}, ${squareOrderId}, 'https://square.link/qa',
       ${now}, ${deadline}, ${now})`;
  return { reservationId, paymentOrderId, squareOrderId, merchantId, locationId, totalCents, deadline };
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function paymentEvent(order, patch = {}) {
  const { payment: paymentPatch = {}, rawBodySha256: suppliedHash, ...eventPatch } = patch;
  const eventId = eventPatch.eventId || `event-${randomUUID()}`;
  const payment = {
    id: `payment-${randomUUID()}`,
    status: 'COMPLETED',
    locationId: order.locationId,
    orderId: order.squareOrderId,
    amountCents: order.totalCents,
    currency: 'USD',
    createdAt: '2026-10-01T12:01:00.000Z',
    updatedAt: '2026-10-01T12:02:00.000Z',
    ...paymentPatch,
  };
  const event = {
    eventId,
    eventType: 'payment.updated',
    merchantId: order.merchantId,
    occurredAt: '2026-10-01T12:02:00.000Z',
    ...eventPatch,
    payment,
  };
  return {
    ...event,
    rawBodySha256: suppliedHash || hash(JSON.stringify(event)),
  };
}

function persist(event, sql = first, config = {}) {
  return persistSquarePaymentWebhook(event, { environment: 'sandbox', now, ...config }, sql);
}

test('100 concurrent exact Square event deliveries create one receipt and one paid reservation', async () => {
  const order = await seedOrder();
  const event = paymentEvent(order, { eventId: 'square-event-race' });
  const results = await Promise.all(Array.from({ length: 100 }, (_, index) => persist(event, index % 2 ? first : second)));
  assert.equal(results.filter(result => result.kind === 'paid').length, 1);
  assert.equal(results.filter(result => result.kind === 'duplicate').length, 99);
  const [payment] = await first`SELECT status, payment_id, payment_status FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`;
  const [reservation] = await first`SELECT state FROM fame_reservations WHERE id = ${order.reservationId}`;
  const receipts = await first`SELECT disposition, raw_body_sha256 FROM fame_square_webhook_events`;
  assert.deepEqual(payment, { status: 'paid', payment_id: event.payment.id, payment_status: 'COMPLETED' });
  assert.equal(reservation.state, 'paid');
  assert.deepEqual(receipts, [{ disposition: 'paid', raw_body_sha256: event.rawBodySha256 }]);
});

test('out-of-order payment updates never regress the newest provider state or make an old completion paid', async () => {
  const order = await seedOrder();
  const paymentId = 'payment-out-of-order';
  const approved = paymentEvent(order, {
    eventId: 'square-event-approved-new',
    payment: { id: paymentId, status: 'APPROVED', updatedAt: '2026-10-01T12:03:00.000Z' },
  });
  assert.deepEqual(await persist(approved), { kind: 'ignored' });
  const oldComplete = paymentEvent(order, {
    eventId: 'square-event-completed-old',
    payment: { id: paymentId, status: 'COMPLETED', updatedAt: '2026-10-01T12:02:00.000Z' },
  });
  assert.deepEqual(await persist(oldComplete, second), { kind: 'ignored' });
  let [stored] = await first`SELECT status, payment_status, payment_provider_updated_at FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`;
  assert.equal(stored.status, 'checkout_created');
  assert.equal(stored.payment_status, 'APPROVED');
  assert.equal(new Date(stored.payment_provider_updated_at).toISOString(), '2026-10-01T12:03:00.000Z');

  const currentComplete = paymentEvent(order, {
    eventId: 'square-event-completed-current',
    payment: { id: paymentId, status: 'COMPLETED', updatedAt: '2026-10-01T12:04:00.000Z' },
  });
  assert.deepEqual(await persist(currentComplete), { kind: 'paid' });
  [stored] = await first`SELECT status, payment_status FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`;
  assert.deepEqual(stored, { status: 'paid', payment_status: 'COMPLETED' });
});

test('a later successful retry may use a different payment ID after a failed attempt on the same Square order', async () => {
  const order = await seedOrder();
  const failed = paymentEvent(order, {
    eventId: 'square-event-failed-attempt',
    payment: { id: 'payment-declined', status: 'FAILED', updatedAt: '2026-10-01T12:03:00.000Z' },
  });
  assert.deepEqual(await persist(failed), { kind: 'ignored' });
  let [stored] = await first`SELECT payment_id, payment_status FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`;
  assert.deepEqual(stored, { payment_id: null, payment_status: 'FAILED' });

  const completedRetry = paymentEvent(order, {
    eventId: 'square-event-successful-retry',
    payment: { id: 'payment-successful-retry', status: 'COMPLETED', updatedAt: '2026-10-01T12:04:00.000Z' },
  });
  assert.deepEqual(await persist(completedRetry, second), { kind: 'paid' });
  [stored] = await first`SELECT status, payment_id, payment_status FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`;
  assert.deepEqual(stored, { status: 'paid', payment_id: 'payment-successful-retry', payment_status: 'COMPLETED' });
});

test('amount, merchant, and late-payment mismatches are durably held for review without claiming capacity', async () => {
  const amountOrder = await seedOrder();
  const wrongAmount = paymentEvent(amountOrder, { payment: { amountCents: amountOrder.totalCents - 1 } });
  assert.deepEqual(await persist(wrongAmount), { kind: 'manual_review' });
  let [stored] = await first`SELECT status FROM fame_payment_orders WHERE id = ${amountOrder.paymentOrderId}`;
  let [reservation] = await first`SELECT state FROM fame_reservations WHERE id = ${amountOrder.reservationId}`;
  assert.equal(stored.status, 'manual_review');
  assert.equal(reservation.state, 'manual_review');

  const merchantOrder = await seedOrder();
  const wrongMerchant = paymentEvent(merchantOrder, { eventId: 'square-event-wrong-merchant', merchantId: 'other-merchant' });
  assert.deepEqual(await persist(wrongMerchant, second), { kind: 'manual_review' });
  [stored] = await first`SELECT status FROM fame_payment_orders WHERE id = ${merchantOrder.paymentOrderId}`;
  [reservation] = await first`SELECT state FROM fame_reservations WHERE id = ${merchantOrder.reservationId}`;
  assert.equal(stored.status, 'checkout_created');
  assert.equal(reservation.state, 'payment_pending');

  const lateOrder = await seedOrder();
  const late = paymentEvent(lateOrder, { eventId: 'square-event-late', payment: { updatedAt: '2026-10-03T12:00:00.001Z' } });
  assert.deepEqual(await persist(late), { kind: 'manual_review' });
  const reviews = await first`SELECT payment_order_id, disposition, manual_review_reason FROM fame_square_webhook_events WHERE disposition = 'manual_review' ORDER BY event_id`;
  assert.equal(reviews.length, 3);
  assert.ok(reviews.some(row => row.payment_order_id === null && row.manual_review_reason === 'payment_order_identity_mismatch'));
  assert.ok(reviews.some(row => row.payment_order_id === amountOrder.paymentOrderId && row.manual_review_reason === 'payment_amount_or_currency_mismatch'));
  assert.ok(reviews.some(row => row.payment_order_id === lateOrder.paymentOrderId && row.manual_review_reason === 'payment_completed_after_deadline'));
});

test('an exact replay is duplicate and altered reuse of its event ID is a conflict without a second mutation', async () => {
  const order = await seedOrder();
  const event = paymentEvent(order, {
    eventId: 'square-event-reused',
    payment: { status: 'APPROVED', updatedAt: '2026-10-01T12:03:00.000Z' },
  });
  assert.deepEqual(await persist(event), { kind: 'ignored' });
  assert.deepEqual(await persist(event, second), { kind: 'duplicate' });
  const altered = { ...event, rawBodySha256: hash('altered-signed-raw-body') };
  assert.deepEqual(await persist(altered), { kind: 'conflict' });
  const receipts = await first`SELECT event_id, raw_body_sha256, disposition, manual_review_reason FROM fame_square_webhook_events`;
  assert.deepEqual(receipts, [{
    event_id: event.eventId,
    raw_body_sha256: event.rawBodySha256,
    disposition: 'manual_review',
    manual_review_reason: 'event_id_reused_with_different_payload',
  }]);
  const [stored] = await first`SELECT status, payment_status FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`;
  assert.deepEqual(stored, { status: 'checkout_created', payment_status: 'APPROVED' });
});

test('a completed payment ID already bound to another order is held for review instead of surfacing a retryable unique-index failure', async () => {
  const paidOrder = await seedOrder();
  const activeOrder = await seedOrder();
  await first`
    UPDATE fame_payment_orders
    SET status = 'paid', payment_id = 'payment-already-bound', payment_status = 'COMPLETED'
    WHERE id = ${paidOrder.paymentOrderId}`;
  await first`UPDATE fame_reservations SET state = 'paid' WHERE id = ${paidOrder.reservationId}`;
  const reusedPayment = paymentEvent(activeOrder, {
    eventId: 'square-event-payment-id-reused', payment: { id: 'payment-already-bound' },
  });
  assert.deepEqual(await persist(reusedPayment), { kind: 'manual_review' });
  const [active] = await first`SELECT status FROM fame_payment_orders WHERE id = ${activeOrder.paymentOrderId}`;
  const [receipt] = await first`SELECT disposition, manual_review_reason FROM fame_square_webhook_events WHERE event_id = ${reusedPayment.eventId}`;
  assert.equal(active.status, 'manual_review');
  assert.deepEqual(receipt, { disposition: 'manual_review', manual_review_reason: 'payment_id_bound_to_other_order' });
});

test('the scoped QA rollback fault rolls back receipt and paid state so the exact event can safely retry', async () => {
  const order = await seedOrder();
  const event = paymentEvent(order, { eventId: 'square-event-rollback' });
  await assert.rejects(
    persist(event, first, { qaRollbackEventId: event.eventId }),
    /QA Square webhook transaction rollback/,
  );
  assert.equal((await first`SELECT * FROM fame_square_webhook_events`).length, 0);
  let [stored] = await first`SELECT status FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`;
  let [reservation] = await first`SELECT state FROM fame_reservations WHERE id = ${order.reservationId}`;
  assert.equal(stored.status, 'checkout_created');
  assert.equal(reservation.state, 'payment_pending');
  assert.deepEqual(await persist(event, second), { kind: 'paid' });
  [stored] = await first`SELECT status FROM fame_payment_orders WHERE id = ${order.paymentOrderId}`;
  [reservation] = await first`SELECT state FROM fame_reservations WHERE id = ${order.reservationId}`;
  assert.equal(stored.status, 'paid');
  assert.equal(reservation.state, 'paid');
});
