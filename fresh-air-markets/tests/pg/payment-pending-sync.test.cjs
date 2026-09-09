const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');
const { seedPaymentSync } = require('./helpers/payment-sync-fixture.cjs');
const { persistSquarePaymentWebhook } = require('../../.test-build/square-webhook-pg.js');
const { dispatchPaymentPendingSync, enqueueMissingPaymentPendingSync } = require('../../.test-build/payment-pending-sync-pg.js');
const { dispatchPaymentPaidSync } = require('../../.test-build/payment-paid-sync-pg.js');
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Local disposable fresh_air_test database required');
const schema = 'qa_payment_pending_sync';
const admin = postgres(url.toString(), { max: 1, prepare: false });
const connect = () => postgres(url.toString(), { max: 8, prepare: false, connection: { search_path: schema, statement_timeout: 15000 } });
const first = connect(); const second = connect();
const scope = { marketId: 'qa-payment-pending-market', seasonId: '2026-2027', locationId: 'aooAnUXF0COePorBo7wL', squareEnvironment: 'sandbox' };
const now = new Date();
before(async () => {
  await admin.unsafe(`CREATE SCHEMA ${schema}`); await first`CREATE TABLE accounts (id TEXT PRIMARY KEY)`;
  await first`INSERT INTO accounts (id) VALUES (${scope.marketId})`;
  const migration = postgres(url.toString(), { max: 1, prepare: false, connection: { search_path: schema } });
  try { for (const file of ['001-application-handoff.sql', '004-application-review-outbox.sql', '005-agreement-completion-outbox.sql',
    '006-application-document-ledger.sql', '007-agreement-completion-stage-outbox.sql', '009-agreement-stage-terminal-state.sql',
    '011-square-payment-checkout-ledger.sql', '012-square-webhook-events.sql', '013-final-reservation-writer.sql',
    '018-payment-paid-sync-outbox.sql', '020-payment-pending-sync-outbox.sql']) await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations', file), 'utf8')); }
  finally { await migration.end(); }
});
beforeEach(async () => { await first`TRUNCATE fame_applications CASCADE`; });
after(async () => { await first.end(); await second.end(); await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
const seed = (options = {}) => seedPaymentSync(first, scope, now, options);
const persist = f => persistSquarePaymentWebhook(f.event, { environment: 'sandbox', now }, second);
const pendingRow = async () => (await first`SELECT * FROM fame_payment_pending_sync_outbox`)[0];
const retryPending = () => first`UPDATE fame_payment_pending_sync_outbox SET next_attempt_at = statement_timestamp() - interval '1 second'`;
const retryPaid = () => first`UPDATE fame_payment_paid_sync_outbox SET next_attempt_at = statement_timestamp() - interval '1 second'`;

test('committed checkout queues once; concurrent repairs and workers deliver one exact pending stage action', async () => {
  const f = await seed(); assert.equal((await pendingRow()).payment_order_id, f.order);
  await Promise.all(Array.from({ length: 20 }, (_, i) => enqueueMissingPaymentPendingSync(scope, 5, i % 2 ? first : second)));
  assert.equal((await first`SELECT * FROM fame_payment_pending_sync_outbox`).length, 1);
  let calls = 0; const deliver = async job => { calls++; assert.equal(job.opportunityId, `opportunity-${f.app}`); };
  const results = await Promise.all([dispatchPaymentPendingSync(deliver, scope, { sql: first }), dispatchPaymentPendingSync(deliver, scope, { sql: second })]);
  assert.equal(calls, 1); assert.equal(results.reduce((sum, r) => sum + r.delivered, 0), 1);
  await dispatchPaymentPendingSync(deliver, scope, { sql: first }); assert.equal(calls, 1);
  await assert.rejects(first`UPDATE fame_payment_pending_sync_outbox SET contact_id = 'foreign'`, /cannot be reassigned/);
});
test('checkout preparation and rolled-back creation queue nothing; repair recovers a missed exact committed checkout', async () => {
  const f = await seed({ checkoutStatus: 'checkout_pending' }); assert.equal(await pendingRow(), undefined);
  await assert.rejects(first.begin(async tx => { await tx`UPDATE fame_payment_orders SET status = 'checkout_created' WHERE id = ${f.order}`; throw new Error('rollback'); }), /rollback/);
  assert.equal(await pendingRow(), undefined);
  await first`UPDATE fame_payment_orders SET status = 'checkout_created' WHERE id = ${f.order}`;
  assert.ok(await pendingRow());
  await first`DELETE FROM fame_payment_pending_sync_outbox`;
  assert.equal(await enqueueMissingPaymentPendingSync(scope, 5, first), 1);
});
test('expired, paid or changed identity cancels stale pending job without touching CRM', async () => {
  for (const reason of ['expired', 'paid', 'identity']) {
    const f = await seed();
    if (reason === 'paid') await persist(f);
    else if (reason === 'expired') await first`UPDATE fame_reservations SET state = 'expired' WHERE id = ${f.reservation}`;
    else await first`UPDATE fame_applications SET contact_id = 'foreign' WHERE id = ${f.app}`;
    let calls = 0; const result = await dispatchPaymentPendingSync(async () => { calls++; }, scope, { sql: first });
    assert.equal(result.cancelled, 1); assert.equal(calls, 0);
  }
});
test('queued agreement prerequisite defers both stages without failure-budget exhaustion; exact delivered receipt unblocks', async () => {
  const f = await seed({ agreementStage: 'pending' }); let calls = 0;
  for (let i = 0; i < 9; i++) {
    assert.equal((await dispatchPaymentPendingSync(async () => { calls++; }, scope, { sql: first })).deferred, 1);
    await retryPending();
  }
  assert.equal((await pendingRow()).attempts, 0); assert.equal(calls, 0);
  await persist(f);
  for (let i = 0; i < 9; i++) {
    assert.equal((await dispatchPaymentPaidSync(async () => { calls++; }, scope, { sql: second })).deferred, 1);
    await retryPaid();
  }
  assert.equal((await first`SELECT attempts FROM fame_payment_paid_sync_outbox`)[0].attempts, 0);
  await first`UPDATE fame_agreement_stage_outbox SET status = 'delivered', delivered_at = statement_timestamp() WHERE id = ${f.stageJob}`;
  assert.equal((await dispatchPaymentPaidSync(async () => { calls++; }, scope, { sql: second })).delivered, 1);
  assert.equal(calls, 1);
});
test('missing or failed agreement stage proof requires review and never guesses a stage transition', async () => {
  for (const agreementStage of ['missing', 'failed']) {
    const f = await seed({ agreementStage }); let calls = 0;
    assert.equal((await dispatchPaymentPendingSync(async () => { calls++; }, scope, { sql: first })).manual_review, 1);
    await persist(f);
    assert.equal((await dispatchPaymentPaidSync(async () => { calls++; }, scope, { sql: second })).manual_review, 1);
    assert.equal(calls, 0);
  }
});
test('webhook commits while pending provider operation holds advisory lock; paid defers then advances without regression', async () => {
  const f = await seed(); let stage = 'signed'; const writes = [];
  const pending = await dispatchPaymentPendingSync(async () => {
    assert.equal((await persist(f)).kind, 'paid', 'webhook must not block on reservation row locks');
    const paid = await dispatchPaymentPaidSync(async () => { writes.push('confirmed'); stage = 'confirmed'; }, scope, { sql: second });
    assert.equal(paid.deferred, 1); assert.equal(writes.length, 0);
    writes.push('pending'); stage = 'pending';
  }, scope, { sql: first });
  assert.equal(pending.cancelled, 1, 'paid evidence supersedes pending receipt');
  await retryPaid();
  assert.equal((await dispatchPaymentPaidSync(async () => { writes.push('confirmed'); stage = 'confirmed'; }, scope, { sql: second })).delivered, 1);
  await dispatchPaymentPendingSync(async () => { writes.push('regression'); }, scope, { sql: first });
  assert.deepEqual(writes, ['pending', 'confirmed']); assert.equal(stage, 'confirmed');
});
test('fast paid stage wins shared lock first; old pending job cannot regress Confirmed', async () => {
  const f = await seed(); await persist(f); const writes = [];
  await dispatchPaymentPaidSync(async () => {
    const blocked = await dispatchPaymentPendingSync(async () => { writes.push('pending'); }, scope, { sql: second });
    assert.equal(blocked.deferred, 1);
    writes.push('confirmed');
  }, scope, { sql: first });
  await retryPending();
  const stale = await dispatchPaymentPendingSync(async () => { writes.push('regression'); }, scope, { sql: second });
  assert.equal(stale.cancelled, 1); assert.deepEqual(writes, ['confirmed']);
});
