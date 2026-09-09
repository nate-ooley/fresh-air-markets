const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const postgres = require('postgres');
const { seedPaymentSync } = require('./helpers/payment-sync-fixture.cjs');
const { persistSquarePaymentWebhook } = require('../../.test-build/square-webhook-pg.js');
const { dispatchPaymentPaidSync, claimPaymentPaidSync, markPaymentPaidSyncDelivered, enqueueMissingPaymentPaidSync } = require('../../.test-build/payment-paid-sync-pg.js');
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Local disposable fresh_air_test database required');
const schema = 'qa_payment_paid_sync';
const admin = postgres(url.toString(), { max: 1, prepare: false });
const connect = () => postgres(url.toString(), { max: 8, prepare: false, connection: { search_path: schema, statement_timeout: 15000 } });
const first = connect(); const second = connect();
const scope = { marketId: 'qa-payment-sync-market', seasonId: '2026-2027', locationId: 'aooAnUXF0COePorBo7wL', squareEnvironment: 'sandbox' };
const now = new Date('2026-10-01T12:00:00Z');
before(async () => {
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await first`CREATE TABLE accounts (id TEXT PRIMARY KEY)`;
  await first`INSERT INTO accounts (id) VALUES (${scope.marketId})`;
  const migration = postgres(url.toString(), { max: 1, prepare: false, connection: { search_path: schema } });
  try { for (const file of ['001-application-handoff.sql', '004-application-review-outbox.sql', '005-agreement-completion-outbox.sql', '006-application-document-ledger.sql', '007-agreement-completion-stage-outbox.sql', '009-agreement-stage-terminal-state.sql', '011-square-payment-checkout-ledger.sql', '012-square-webhook-events.sql', '013-final-reservation-writer.sql', '018-payment-paid-sync-outbox.sql']) {
    await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations', file), 'utf8'));
  } } finally { await migration.end(); }
});
beforeEach(async () => { await first`TRUNCATE fame_payment_paid_sync_outbox, fame_square_webhook_events, fame_payment_orders, fame_reservations, fame_applications CASCADE`; });
after(async () => { await first.end(); await second.end(); await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function seed(options = {}) { return seedPaymentSync(first, scope, now, options); }

const persist = (f, sql = first, extra = {}) => persistSquarePaymentWebhook(f.event, { environment: 'sandbox', now, ...extra }, sql);
test('100 concurrent signed payment replays create one immutable paid-sync job with exact identities', async () => {
  const f = await seed();
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => persist(f, i % 2 ? first : second)));
  assert.equal(results.filter(r => r.kind === 'paid').length, 1);
  const rows = await first`SELECT * FROM fame_payment_paid_sync_outbox`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].application_id, f.app); assert.equal(rows[0].payment_order_id, f.order);
  assert.equal(rows[0].reservation_id, f.reservation); assert.equal(rows[0].event_id, f.event.eventId);
  assert.equal(rows[0].contact_id, `contact-${f.app}`); assert.equal(rows[0].opportunity_id, `opportunity-${f.app}`);
  await assert.rejects(first`UPDATE fame_payment_paid_sync_outbox SET contact_id = 'other' WHERE payment_order_id = ${f.order}`, /identity cannot be reassigned/);
});
test('webhook rollback removes paid order, reservation and sync job together; exact retry queues once', async () => {
  const f = await seed();
  await assert.rejects(persist(f, first, { qaRollbackEventId: f.event.eventId }), /rollback/);
  assert.equal((await first`SELECT * FROM fame_payment_paid_sync_outbox`).length, 0);
  assert.equal((await first`SELECT state FROM fame_reservations`)[0].state, 'payment_pending');
  await persist(f); assert.equal((await first`SELECT * FROM fame_payment_paid_sync_outbox`).length, 1);
});
test('neither a browser-like paid flag nor incomplete or mismatched provider evidence can queue sync', async () => {
  const f = await seed();
  await first`UPDATE fame_payment_orders SET status = 'paid', payment_id = ${f.event.payment.id}, payment_status = 'COMPLETED', payment_received_at = ${now} WHERE id = ${f.order}`;
  await first`UPDATE fame_reservations SET state = 'paid' WHERE id = ${f.reservation}`;
  assert.equal(await enqueueMissingPaymentPaidSync(scope, 5, first), 0);
  assert.equal((await first`SELECT * FROM fame_payment_paid_sync_outbox`).length, 0);
});
test('concurrent workers claim a job once and a replay after delivery performs no provider work', async () => {
  const f = await seed(); await persist(f);
  let calls = 0;
  const delivery = async job => { calls++; assert.equal(job.paymentOrderId, f.order); await new Promise(r => setTimeout(r, 20)); };
  const results = await Promise.all([dispatchPaymentPaidSync(delivery, scope, { sql: first }), dispatchPaymentPaidSync(delivery, scope, { sql: second })]);
  assert.equal(calls, 1); assert.equal(results.reduce((n, r) => n + r.delivered, 0), 1);
  await dispatchPaymentPaidSync(delivery, scope, { sql: first }); assert.equal(calls, 1);
});
test('provider failure preserves paid facts and schedules sanitized retry; a later verified delivery writes receipt', async () => {
  const f = await seed(); await persist(f);
  const failure = await dispatchPaymentPaidSync(async () => { throw { code: 'ghl_rate_limited', retryAfterSeconds: 42, message: 'private-provider-data' }; }, scope, { sql: first });
  assert.equal(failure.deferred, 1);
  const [row] = await first`SELECT status, last_error_code, delivered_at FROM fame_payment_paid_sync_outbox`;
  assert.deepEqual(row, { status: 'pending', last_error_code: 'ghl_rate_limited', delivered_at: null });
  assert.equal((await first`SELECT state FROM fame_reservations`)[0].state, 'paid');
  await first`UPDATE fame_payment_paid_sync_outbox SET next_attempt_at = statement_timestamp() - interval '1 second'`;
  assert.equal((await dispatchPaymentPaidSync(async () => {}, scope, { sql: second })).delivered, 1);
});
test('changed application identity or a different market scope cannot update any CRM record', async () => {
  const f = await seed(); await persist(f); let calls = 0;
  await dispatchPaymentPaidSync(async () => { calls++; }, { ...scope, marketId: 'another-market' }, { sql: first });
  assert.equal(calls, 0);
  await first`UPDATE fame_applications SET contact_id = 'reassigned-contact' WHERE id = ${f.app}`;
  const result = await dispatchPaymentPaidSync(async () => { calls++; }, scope, { sql: first });
  assert.equal(result.manual_review, 1); assert.equal(calls, 0);
});
test('expired lease cannot mark a newer worker delivery successful', async () => {
  const f = await seed(); await persist(f);
  const [old] = await claimPaymentPaidSync(scope, 1, 60, first);
  await first`UPDATE fame_payment_paid_sync_outbox SET locked_until = statement_timestamp() - interval '1 second'`;
  const [fresh] = await claimPaymentPaidSync(scope, 1, 60, second);
  assert.notEqual(old.leaseToken, fresh.leaseToken);
  assert.equal(await markPaymentPaidSyncDelivered(old, first), false);
  assert.equal(await markPaymentPaidSyncDelivered(fresh, second), true);
});
