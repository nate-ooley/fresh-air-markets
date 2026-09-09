const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const postgres = require('postgres');
const { reserveFinalApplication } = require('../../.test-build/final-reservation-pg.js');
const { createVendorAccessToken, hashVendorAccessToken } = require('../../.test-build/vendor-payment-access.js');
const { issueVendorPaymentAccess } = require('../../.test-build/vendor-payment-access-pg.js');
const { queuePaymentEmail, getPaymentEmailStatus, dispatchPaymentEmails } = require('../../.test-build/payment-email-pg.js');
const { decryptPaymentEmailInvitation } = require('../../.test-build/payment-email.js');
const { persistSquarePaymentWebhook } = require('../../.test-build/square-webhook-pg.js');
const { withPaymentStageLock } = require('../../.test-build/payment-stage-lock.js');
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = 'qa_payment_email';
const admin = postgres(url.toString(), { max: 1, prepare: false });
const connect = () => postgres(url.toString(), { max: 12, prepare: false, connection: { search_path: schema, statement_timeout: 15000 } });
const first = connect();
const second = connect();
const marketId = 'qa-private-vendor-market';
const locationId = 'aooAnUXF0COePorBo7wL';
const now = new Date();
const due = new Date(now.valueOf() + 48 * 3600_000);
const config = { marketId, environment: 'sandbox', portalOrigin: 'https://qa-market.vercel.app', allowCheckout: true };
const hash = () => hashVendorAccessToken(createVendorAccessToken());

before(async () => {
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await first`CREATE TABLE accounts (id TEXT PRIMARY KEY)`;
  await first`INSERT INTO accounts (id) VALUES (${marketId}), ('another-market')`;
  const migration = postgres(url.toString(), { max: 1, prepare: false, connection: { search_path: schema } });
  try {
    for (const file of [
      '001-application-handoff.sql', '004-application-review-outbox.sql',
      '005-agreement-completion-outbox.sql', '006-application-document-ledger.sql',
      '007-agreement-completion-stage-outbox.sql', '009-agreement-stage-terminal-state.sql',
      '011-square-payment-checkout-ledger.sql', '012-square-webhook-events.sql',
      '013-final-reservation-writer.sql', '014-square-payment-expiry.sql',
      '017-vendor-payment-access.sql', '018-payment-paid-sync-outbox.sql', '019-payment-email-outbox.sql', '020-payment-pending-sync-outbox.sql', '021-opportunity-field-delivery-receipts.sql',
    ]) await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations', file), 'utf8'));
  } finally { await migration.end(); }
});
beforeEach(async () => { await first`TRUNCATE fame_applications CASCADE`; });
after(async () => {
  await first.end(); await second.end();
  await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
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
       ${sql.json({ source: 'qa', email: patch.email || 'lnooley@gmail.com' })}, ${now})`;
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

function pendingFieldProof(applicationId) { return { deliveryContract: 'ghl_opportunity_fields_v1', locationId, contactId: `contact-${applicationId}`,
  opportunityId: `opportunity-${applicationId}`, pipelineId: 'qa-payment-pipeline', fields: [{ fieldId: 'qa-agreement-status', fieldValue: 'Signed' },
    { fieldId: 'qa-payment-status', fieldValue: 'Ready for Payment' }] }; }

async function finalReservation({ nonprofit = false, checkout = true, email, pendingStage = 'delivered' } = {}) {
  const application = await seedEligibleApplication(first, { email });
  const result = await reserveFinalApplication({
    marketId, applicationId: application.applicationId, actorAccountId: marketId, now,
    config: { marketId, seasonId: '2026-2027', boothCapacity: 100, calendarDates: ['2026-10-03', '2026-10-10'], quoteVersion: 'fresh-air-2026-2027-v1' },
    selection: { applicantType: nonprofit ? 'Non-Profit Organization' : 'Vendor', vendorCategory: nonprofit ? 'Community' : 'Arts & Crafts', selectedDates: ['2026-10-03'], fullSeason: false, boothsPerMarket: 1, foodLicenseRequired: false, idempotencyKey: randomUUID() },
  }, first);
  assert.equal(result.kind, 'created');
  const id = result.reservation.id;
  if (!nonprofit && checkout) {
    await first`UPDATE fame_reservations SET state = 'payment_pending', payment_request_sent_at = ${now}, payment_due_at = ${due} WHERE id = ${id}`;
    await first`INSERT INTO fame_payment_orders
      (id, market_id, reservation_id, reservation_revision, square_environment, square_merchant_id, square_location_id,
       expected_currency, expected_total_cents, idempotency_key, status, square_payment_link_id, square_order_id,
       checkout_url, payment_request_sent_at, payment_due_at)
      VALUES (${randomUUID()}, ${marketId}, ${id}, 1, 'sandbox', 'verified-merchant', 'verified-location',
        'USD', 4000, ${randomUUID()}, 'checkout_created', ${randomUUID()}, ${randomUUID()},
        'https://sandbox.square.link/u/qa-private', ${now}, ${due})`;
    if (pendingStage !== 'pending') await first`UPDATE fame_payment_pending_sync_outbox SET status = ${pendingStage},
      delivered_at = ${pendingStage === 'delivered' ? now : null}, delivery_receipt = ${pendingStage === 'delivered' ? first.json(pendingFieldProof(application.applicationId)) : null} WHERE reservation_id = ${id}`;
  }
  return id;
}

const secret = 'local-disposable-email-test-secret-0123456789-ABCD';
const deliveryConfig = {
  apiToken: 'isolated-no-network-token', locationId, marketId,
  pipelineId: 'qa-payment-pipeline', approvedStageId: 'qa-approved', agreementStatusFieldId: 'qa-agreement-status', paymentStatusFieldId: 'qa-payment-status',
  fromEmail: 'nate@autocraftstudios.com', portalOrigin: config.portalOrigin, mode: 'qa',
};
const shared = { marketId, accessConfig: config, deliveryConfig, secret, now };
const queue = (id, patch = {}, sql = first) => queuePaymentEmail({ ...shared, reservationId: id, actorAccountId: marketId, ...patch }, sql);
const dispatch = (transport, patch = {}, sql = first) => dispatchPaymentEmails({ ...shared, transport, ...patch }, sql);
const state = async id => (await first`SELECT * FROM fame_payment_email_outbox WHERE reservation_id = ${id}`)[0];
const publicStatus = id => getPaymentEmailStatus({ marketId, actorAccountId: marketId, reservationId: id }, first);
const future = offset => new Date(now.valueOf() + offset);

async function provider(id, overrides = {}) {
  const row = await state(id);
  const calls = [];
  let posted;
  let paymentStatus = 'Ready for Payment';
  const transport = async (url, init) => {
    calls.push({ url, method: init.method });
    if (overrides.request) {
      const response = await overrides.request(url, init, row, calls);
      if (response) return response;
    }
    if (url.includes('/contacts/')) return Response.json({ contact: {
      id: row.contact_id, locationId, email: row.recipient_email, ...overrides.contact,
    } });
    if (url.includes('/customFields/')) {
      const agreement = url.endsWith('/qa-agreement-status');
      return Response.json({ customField: { id: agreement ? 'qa-agreement-status' : 'qa-payment-status', locationId,
        model: 'opportunity', name: agreement ? 'Vendor Agreement Status' : 'Vendor Payment Status', dataType: 'SINGLE_OPTIONS',
        fieldKey: agreement ? 'opportunity.vendor_agreement_status' : 'opportunity.vendor_payment_status',
        picklistOptions: agreement ? ['Not Sent', 'Sent', 'Signed'] : ['Not Ready', 'Ready for Payment', 'Payment Sent', 'Paid', 'Payment Issue'] } });
    }
    if (init.method === 'PUT') {
      if (overrides.put) { const response = await overrides.put(url, init, row); if (response) return response; }
      paymentStatus = JSON.parse(init.body).customFields[0].fieldValue;
      return Response.json({});
    }
    if (url.includes('/opportunities/')) return Response.json({ opportunity: {
      id: row.opportunity_id, contactId: row.contact_id, locationId,
      pipelineId: deliveryConfig.pipelineId, pipelineStageId: deliveryConfig.approvedStageId, status: 'open',
      customFields: [{ id: 'qa-agreement-status', fieldValue: 'Signed' }, { id: 'qa-payment-status', fieldValue: paymentStatus }], ...overrides.opportunity,
    } });
    if (init.method === 'POST') {
      posted = JSON.parse(init.body);
      if (overrides.post) return overrides.post(url, init, row);
      return Response.json({ messageId: 'qa-message', conversationId: 'qa-conversation', emailMessageId: 'qa-email' });
    }
    if (url.includes('/conversations/messages/email/')) return Response.json({
      id: 'qa-email', threadId: 'qa-message', conversationId: 'qa-conversation', locationId,
      contactId: row.contact_id, direction: 'outbound', to: [row.recipient_email],
      subject: `[TEST] Fresh Air Markets payment request — ${row.id}`,
      body: `Reference: ${row.id}`, status: 'delivered', ...overrides.receipt,
    });
    throw new Error('Unexpected isolated fixture request');
  };
  return { transport, calls, get posted() { return posted; }, posts: () => calls.filter(call => call.method === 'POST').length };
}

test('20 concurrent queue requests commit one encrypted invitation and notification without token exposure or rotation', async () => {
  const id = await finalReservation();
  const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => queue(id, {}, i % 2 ? first : second)));
  assert.equal(replies.filter(reply => reply.kind === 'queued').length, 1);
  assert.equal(replies.filter(reply => reply.kind === 'existing').length, 19);
  assert.equal(new Set(replies.map(reply => reply.notification.id)).size, 1);
  const row = await state(id);
  const clear = decryptPaymentEmailInvitation(row.invitation_ciphertext, secret, {
    id: row.id, marketId, reservationId: id, revision: 1, recipientEmail: 'lnooley@gmail.com',
  });
  const token = new URL(clear).hash.slice(7);
  assert.equal(hashVendorAccessToken(token), row.invitation_hash);
  const [counts] = await first`SELECT count(*)::int AS count FROM fame_vendor_payment_invitations WHERE reservation_id = ${id}`;
  assert.equal(counts.count, 1);
  assert.equal(JSON.stringify(row).includes(token), false);
  const visible = await publicStatus(id);
  assert.deepEqual(Object.keys(visible).sort(), ['canRetryPreflight', 'createdAt', 'id', 'status']);
  assert.equal(JSON.stringify(visible).includes('gmail.com'), false);
});

test('queue failure rolls back invitation rotation and leaves the existing private invitation usable', async () => {
  const id = await finalReservation();
  const original = hash();
  assert.equal((await issueVendorPaymentAccess({ config, reservationId: id, tokenHash: original, now }, first)).kind, 'issued');
  await first.unsafe(`CREATE FUNCTION qa_reject_email() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qa rollback'; END $$`);
  await first.unsafe(`CREATE TRIGGER qa_reject_email BEFORE INSERT ON fame_payment_email_outbox FOR EACH ROW EXECUTE FUNCTION qa_reject_email()`);
  try { await assert.rejects(queue(id), /qa rollback/); }
  finally { await first.unsafe('DROP TRIGGER qa_reject_email ON fame_payment_email_outbox'); await first.unsafe('DROP FUNCTION qa_reject_email()'); }
  const invites = await first`SELECT token_hash, revoked_at FROM fame_vendor_payment_invitations WHERE reservation_id = ${id}`;
  assert.equal(invites.length, 1);
  assert.equal(invites[0].token_hash, original);
  assert.equal(invites[0].revoked_at, null);
  assert.equal(await state(id), undefined);
  assert.equal((await queue(id)).kind, 'queued');
});

test('queue fences market, source recipient, private configuration and exact paid checkout eligibility', async () => {
  const id = await finalReservation();
  assert.equal((await queue(id, { actorAccountId: 'another-market' })).kind, 'forbidden');
  assert.equal((await queue(id, { deliveryConfig: { ...deliveryConfig, marketId: 'another-market' } })).kind, 'forbidden');
  assert.equal((await queue(id, { accessConfig: { ...config, allowCheckout: false } })).kind, 'not_eligible');
  assert.equal((await queue(await finalReservation({ email: 'live-vendor@example.com' }))).kind, 'invalid_source');
  assert.equal((await queue(await finalReservation({ nonprofit: true }))).kind, 'not_eligible');
  assert.equal((await queue(await finalReservation({ checkout: false }))).kind, 'not_eligible');
  assert.equal((await queue(id, { now: due })).kind, 'not_eligible');
  await queue(id);
  assert.equal(await getPaymentEmailStatus({ marketId, actorAccountId: 'another-market', reservationId: id }, first), null);
  await assert.rejects(first`UPDATE fame_payment_email_outbox SET recipient_email = 'nate@autocraftstudios.com' WHERE reservation_id = ${id}`, error => error.code === '55000');
});

test('concurrent workers issue one POST only after durable send_started and ciphertext erasure; accepted is not delivered', async () => {
  const id = await finalReservation();
  await queue(id);
  const mock = await provider(id, { post: async () => {
    const observed = await state(id);
    assert.equal(observed.state, 'send_started');
    assert.equal(observed.invitation_ciphertext, null);
    return Response.json({ messageId: 'qa-message', conversationId: 'qa-conversation', emailMessageId: 'qa-email' });
  } });
  await Promise.all(Array.from({ length: 20 }, (_, i) => dispatch(mock.transport, { limit: 5 }, i % 2 ? first : second)));
  assert.equal(mock.posts(), 1);
  assert.equal((await publicStatus(id)).status, 'accepted');
  assert.equal((await publicStatus(id)).sentAt, undefined);
  assert.equal((await state(id)).invitation_ciphertext, null);
  assert.equal(mock.posted.emailTo, 'lnooley@gmail.com');
  assert.match(mock.posted.message, /48 hours from the original payment request/);
  assert.equal((await queue(id)).kind, 'existing');
  await dispatch(mock.transport);
  assert.equal(mock.posts(), 1);
});

test('preflight sees wrong contact or opportunity and sends zero emails; transient GET failure retries safely', async () => {
  const wrongId = await finalReservation();
  await queue(wrongId);
  const wrong = await provider(wrongId, { contact: { email: 'live-vendor@example.com' } });
  await dispatch(wrong.transport, { notificationId: (await state(wrongId)).id });
  assert.equal((await state(wrongId)).state, 'failed');
  assert.equal(wrong.posts(), 0);
  assert.equal((await queue(wrongId)).kind, 'existing', 'permanent rejection does not silently reissue');
  const retryId = await finalReservation();
  await queue(retryId);
  const retry = await provider(retryId, { request: async (_url, _init, _row, calls) => calls.length === 1 ? new Response('', { status: 503 }) : undefined });
  await dispatch(retry.transport, { notificationId: (await state(retryId)).id });
  assert.equal((await state(retryId)).state, 'pending');
  assert.equal(retry.posts(), 0);
  await dispatch(retry.transport, { now: future(60_000), notificationId: (await state(retryId)).id });
  assert.equal((await state(retryId)).state, 'accepted');
  assert.equal(retry.posts(), 1);
});

test('paid, expired, rotated or stopped reservation between preflight and POST cancels without sending', async () => {
  for (const reason of ['paid', 'expired', 'rotated', 'stop']) {
    const id = await finalReservation();
    await queue(id);
    const accessConfig = { ...config };
    const mock = await provider(id, { request: async url => {
      if (url.includes('/opportunities/')) {
        if (reason === 'paid' || reason === 'expired') await first`UPDATE fame_reservations SET state = ${reason} WHERE id = ${id}`;
        if (reason === 'rotated') await issueVendorPaymentAccess({ config, reservationId: id, tokenHash: hash(), now }, first);
        if (reason === 'stop') accessConfig.allowCheckout = false;
      }
    } });
    await dispatch(mock.transport, { accessConfig, notificationId: (await state(id)).id });
    assert.equal((await state(id)).state, 'cancelled', reason);
    assert.equal((await state(id)).invitation_ciphertext, null, reason);
    assert.equal(mock.posts(), 0, reason);
  }
});

test('POST timeout is uncertain forever without automatic retry; interrupted send_started recovery also never POSTs', async () => {
  const id = await finalReservation();
  await queue(id);
  const timeout = await provider(id, { post: async () => { throw new Error('simulated provider timeout with private content'); } });
  await dispatch(timeout.transport, { notificationId: (await state(id)).id });
  assert.equal((await state(id)).state, 'uncertain');
  assert.equal(timeout.posts(), 1);
  for (const offset of [60_000, 3600_000, 24 * 3600_000]) await dispatch(timeout.transport, { now: future(offset) });
  assert.equal(timeout.posts(), 1);
  assert.equal((await queue(id)).kind, 'existing');
  assert.equal(JSON.stringify(await publicStatus(id)).includes('private content'), false);
  const crashId = await finalReservation();
  await queue(crashId);
  await first`UPDATE fame_payment_email_outbox SET state = 'send_started', invitation_ciphertext = NULL,
    send_started_at = ${now}, lease_id = 'interrupted-worker', lease_expires_at = ${future(30_000)} WHERE reservation_id = ${crashId}`;
  const crash = await provider(crashId);
  await dispatch(crash.transport, { now: future(60_000), notificationId: (await state(crashId)).id });
  assert.equal((await state(crashId)).state, 'uncertain');
  assert.equal(crash.calls.length, 0);
  await assert.rejects(first`UPDATE fame_payment_email_outbox SET state = 'pending', invitation_ciphertext = 'restore' WHERE reservation_id = ${crashId}`, error => error.code === '55000');
});

test('receipt polling survives expiry or paid state without invitation ciphertext and never interprets sent as delivered', async () => {
  const id = await finalReservation();
  await queue(id);
  const mock = await provider(id);
  await dispatch(mock.transport);
  await first`UPDATE fame_reservations SET state = 'paid' WHERE id = ${id}`;
  const waiting = await provider(id, { receipt: { status: 'sent' } });
  await dispatch(waiting.transport, { now: future(49 * 3600_000) });
  assert.equal((await publicStatus(id)).status, 'accepted');
  assert.ok((await publicStatus(id)).sentAt);
  assert.equal(waiting.posts(), 0);
  await dispatch(mock.transport, { now: future(50 * 3600_000) });
  assert.equal((await publicStatus(id)).status, 'delivered');
  assert.equal((await state(id)).invitation_ciphertext, null);
  assert.equal(mock.posts(), 1);
});

test('receipt mismatch stays accepted for GET reconciliation; verified bounced receipt fails without resend', async () => {
  const id = await finalReservation();
  await queue(id);
  const mock = await provider(id);
  await dispatch(mock.transport);
  const mismatch = await provider(id, { receipt: { to: ['live-vendor@example.com'] } });
  await dispatch(mismatch.transport, { now: future(60_000) });
  assert.equal((await state(id)).state, 'accepted');
  assert.equal((await state(id)).safe_error, 'payment_email_receipt_mismatch');
  const bounced = await provider(id, { receipt: { status: 'failed' } });
  await dispatch(bounced.transport, { now: future(120_000) });
  assert.equal((await state(id)).state, 'failed');
  assert.equal(mismatch.posts() + bounced.posts(), 0);
});

test('worker filters exact notification and market, bounds work to five, and reclaims expired preparing lease before one send', async () => {
  const ids = [];
  for (let i = 0; i < 7; i++) { const id = await finalReservation(); await queue(id); ids.push(id); }
  const target = await state(ids[0]);
  await first`UPDATE fame_payment_email_outbox SET state = 'preparing', lease_id = 'crashed-before-post',
    lease_expires_at = ${future(-1)}, prepare_attempts = 1 WHERE id = ${target.id}`;
  const mock = await provider(ids[0]);
  await dispatch(mock.transport, { notificationId: target.id, limit: 100 });
  assert.equal(mock.posts(), 1);
  assert.equal((await state(ids[1])).state, 'pending');
  const report = await dispatch(async () => new Response('', { status: 503 }), { limit: 100 });
  assert.equal(report.processed, 5);
  const [counts] = await first`SELECT count(*)::int AS count FROM fame_payment_email_outbox WHERE prepare_attempts = 0`;
  assert.equal(counts.count, 1);
  assert.equal((await dispatch(mock.transport, { notificationId: 'foreign-notification' })).processed, 0);
});

test('explicit preflight retry atomically rotates only an unsent failed job and reuses its stable notification identity', async () => {
  const id = await finalReservation();
  await queue(id);
  const original = await state(id);
  const wrong = await provider(id, { opportunity: { pipelineStageId: 'wrong-stage' } });
  await dispatch(wrong.transport);
  assert.equal((await publicStatus(id)).canRetryPreflight, true);
  assert.equal((await queue(id)).kind, 'existing');
  assert.equal((await state(id)).invitation_hash, original.invitation_hash);
  const retried = await queue(id, { retryPreflight: true });
  assert.equal(retried.kind, 'queued');
  assert.equal(retried.notification.id, original.id);
  assert.equal(retried.notification.canRetryPreflight, false);
  const retry = await state(id);
  assert.notEqual(retry.invitation_hash, original.invitation_hash);
  assert.equal(retry.created_at.valueOf(), original.created_at.valueOf());
  const [prior] = await first`SELECT revoked_at FROM fame_vendor_payment_invitations WHERE token_hash = ${original.invitation_hash}`;
  assert.ok(prior.revoked_at);
  const good = await provider(id);
  await dispatch(good.transport);
  assert.equal(good.posts(), 1);
  const sent = await state(id);
  assert.equal((await queue(id, { retryPreflight: true })).kind, 'existing');
  assert.equal((await state(id)).invitation_hash, sent.invitation_hash);
});

test('five unavailable receipt checks park uncertain and explicit retry cannot repeat a possible send', async () => {
  const id = await finalReservation();
  await queue(id);
  const good = await provider(id);
  await dispatch(good.transport);
  const unknown = await provider(id, { receipt: { contactId: 'foreign-contact' } });
  for (let i = 1; i <= 5; i++) await dispatch(unknown.transport, { now: future(i * 3600_000) });
  assert.equal((await state(id)).state, 'uncertain');
  assert.equal((await state(id)).receipt_failures, 5);
  assert.equal((await publicStatus(id)).canRetryPreflight, false);
  assert.equal((await queue(id, { retryPreflight: true })).kind, 'existing');
  const before = unknown.calls.length;
  await dispatch(unknown.transport, { now: future(6 * 3600_000) });
  assert.equal(unknown.calls.length, before);
  assert.equal(unknown.posts(), 0);
});

test('email requested immediately after checkout waits for exact Pending-stage receipt without spending attempt budget', async () => {
  const id = await finalReservation({ pendingStage: 'pending' });
  await queue(id);
  const original = await state(id);
  const mock = await provider(id);
  for (let i = 0; i < 9; i++) {
    if (i === 4) await first`UPDATE fame_payment_pending_sync_outbox SET status = 'processing', lease_token = 'qa-pending-worker',
      locked_until = ${future(20 * 60_000)} WHERE reservation_id = ${id}`;
    const report = await dispatch(mock.transport, { now: future(i * 60_000) });
    assert.equal(report.pending, 1);
    const row = await state(id);
    assert.equal(row.state, 'pending'); assert.equal(row.prepare_attempts, 0);
    assert.equal(row.invitation_ciphertext, original.invitation_ciphertext);
    assert.equal(row.invitation_hash, original.invitation_hash);
  }
  assert.equal(mock.calls.length, 0, 'no provider preflight before prerequisite receipt');
  await first`UPDATE fame_payment_pending_sync_outbox SET status = 'delivered', delivered_at = ${now}, locked_until = NULL, lease_token = NULL,
    delivery_receipt = ${first.json(pendingFieldProof(original.application_id))} WHERE reservation_id = ${id}`;
  await dispatch(mock.transport, { now: future(10 * 60_000) });
  assert.equal(mock.posts(), 1); assert.equal((await state(id)).state, 'accepted');
  await dispatch(mock.transport, { now: future(11 * 60_000) });
  assert.equal(mock.posts(), 1); assert.equal((await state(id)).state, 'delivered');
});

test('payment while waiting for Pending stage cancels email locally before any provider call', async () => {
  const id = await finalReservation({ pendingStage: 'pending' }); await queue(id);
  const mock = await provider(id);
  await dispatch(mock.transport);
  await first`UPDATE fame_reservations SET state = 'paid' WHERE id = ${id}`;
  const result = await dispatch(mock.transport, { now: future(60_000) });
  assert.equal(result.cancelled, 1); assert.equal(mock.calls.length, 0);
  assert.equal((await state(id)).state, 'cancelled'); assert.equal((await state(id)).invitation_ciphertext, null);
});

test('missing, mismatched or failed Pending-stage prerequisite fails closed with operator code and no provider calls', async () => {
  for (const pendingStage of ['missing', 'manual_review', 'mismatched']) {
    const id = await finalReservation({ pendingStage: pendingStage === 'manual_review' ? pendingStage : 'pending' });
    if (pendingStage === 'missing') await first`DELETE FROM fame_payment_pending_sync_outbox WHERE reservation_id = ${id}`;
    if (pendingStage === 'mismatched') {
      const [prior] = await first`DELETE FROM fame_payment_pending_sync_outbox WHERE reservation_id = ${id} RETURNING *`;
      await first`INSERT INTO fame_payment_pending_sync_outbox SELECT * FROM jsonb_populate_record(NULL::fame_payment_pending_sync_outbox,
        ${first.json({ ...prior, contact_id: 'foreign-contact' })})`;
    }
    await queue(id); const mock = await provider(id);
    const result = await dispatch(mock.transport);
    assert.equal(result.failed, 1); assert.equal(mock.calls.length, 0);
    const row = await state(id); assert.equal(row.safe_error, 'payment_email_pending_prerequisite_failed');
    assert.equal(row.invitation_ciphertext, null); assert.equal(row.send_started_at, null);
    assert.equal((await publicStatus(id)).canRetryPreflight, true);
  }
});

async function completePayment(id) {
  const [order] = await first`SELECT * FROM fame_payment_orders WHERE reservation_id = ${id}`;
  const at = future(60_000).toISOString();
  const event = { eventId: randomUUID(), eventType: 'payment.updated', merchantId: order.square_merchant_id, occurredAt: at,
    payment: { id: 'paid-' + randomUUID(), status: 'COMPLETED', locationId: order.square_location_id, orderId: order.square_order_id,
      amountCents: Number(order.expected_total_cents), currency: 'USD', createdAt: at, updatedAt: at } };
  event.rawBodySha256 = createHash('sha256').update(JSON.stringify(event)).digest('hex');
  assert.equal((await persistSquarePaymentWebhook(event, { environment: 'sandbox', now: future(60_000) }, first)).kind, 'paid');
}

test('provider Sent proof commits before field PUT; field failure retries only field sync and preserves email facts', async () => {
  const id = await finalReservation(); await queue(id); let putCount = 0;
  const mock = await provider(id, { receipt: { status: 'sent' }, put: async (_url, init) => {
    const recorded = await state(id);
    assert.equal(recorded.provider_receipt_status, 'sent'); assert.ok(recorded.provider_receipt_verified_at);
    assert.ok(recorded.sent_at); assert.equal(recorded.invitation_ciphertext, null);
    assert.deepEqual(JSON.parse(init.body), { customFields: [{ id: 'qa-payment-status', fieldValue: 'Payment Sent' }] });
    putCount++;
    if (putCount === 1) return new Response('', { status: 503 });
  } });
  await dispatch(mock.transport);
  await dispatch(mock.transport, { now: future(60_000) });
  assert.equal((await state(id)).state, 'accepted');
  assert.equal((await state(id)).payment_sent_sync_status, 'pending');
  assert.equal((await state(id)).payment_sent_sync_attempts, 1);
  const receiptReads = mock.calls.filter(c => c.url.includes('/messages/email/')).length;
  await dispatch(mock.transport, { now: future(180_000) });
  assert.equal((await state(id)).payment_sent_sync_status, 'delivered');
  assert.equal((await state(id)).payment_sent_delivery_receipt.fields[1].fieldValue, 'Payment Sent');
  assert.equal(mock.posts(), 1); assert.equal(putCount, 2);
  assert.equal(mock.calls.filter(c => c.url.includes('/messages/email/')).length, receiptReads, 'stored provider proof avoids another receipt read during field retry');
});

test('five field-sync failures park separately without changing delivered email or submitting another POST', async () => {
  const id = await finalReservation(); await queue(id);
  const mock = await provider(id, { put: async () => new Response('', { status: 503 }) });
  await dispatch(mock.transport);
  for (let i = 1; i <= 5; i++) await dispatch(mock.transport, { now: future(i * 3600_000) });
  const row = await state(id);
  assert.equal(row.state, 'delivered'); assert.ok(row.sent_at); assert.ok(row.provider_receipt_verified_at);
  assert.equal(row.payment_sent_sync_status, 'failed'); assert.equal(row.payment_sent_sync_attempts, 5);
  const calls = mock.calls.length;
  await dispatch(mock.transport, { now: future(6 * 3600_000) });
  assert.equal(mock.calls.length, calls); assert.equal(mock.posts(), 1);
  assert.equal((await publicStatus(id)).paymentSentSyncStatus, 'failed');
});

test('Paid serialization defers Sent field without budget loss then skips lower update after exact payment commits', async () => {
  const id = await finalReservation(); await queue(id);
  const mock = await provider(id); await dispatch(mock.transport);
  await withPaymentStageLock(second, { marketId, reservationId: id }, async () => {
    await dispatch(mock.transport, { now: future(60_000) });
    const row = await state(id);
    assert.equal(row.state, 'delivered'); assert.equal(row.payment_sent_sync_status, 'pending');
    assert.equal(row.payment_sent_sync_attempts, 0);
    assert.equal(mock.calls.filter(c => c.method === 'PUT').length, 0);
    await completePayment(id);
  });
  await dispatch(mock.transport, { now: future(120_000) });
  assert.equal((await state(id)).payment_sent_sync_status, 'skipped_paid');
  assert.equal(mock.calls.filter(c => c.method === 'PUT').length, 0); assert.equal(mock.posts(), 1);
});

test('a delivered legacy/misconfigured field receipt cannot authorize email from another field ID', async () => {
  const id = await finalReservation();
  const [job] = await first`SELECT * FROM fame_payment_pending_sync_outbox WHERE reservation_id = ${id}`;
  const mismatched = pendingFieldProof(job.application_id); mismatched.fields[1].fieldId = 'different-payment-field';
  await first`UPDATE fame_payment_pending_sync_outbox SET delivery_receipt = ${first.json(mismatched)} WHERE reservation_id = ${id}`;
  await queue(id); const mock = await provider(id);
  await dispatch(mock.transport);
  assert.equal((await state(id)).state, 'failed'); assert.equal(mock.calls.length, 0);
  assert.equal((await state(id)).safe_error, 'payment_email_pending_prerequisite_failed');
});

test('native Paid without exact reconciled Square evidence parks field sync without labeling payment confirmed', async () => {
  const id = await finalReservation(); await queue(id);
  const options = {};
  const mock = await provider(id, options);
  await dispatch(mock.transport);
  options.opportunity = { customFields: [{ id: 'qa-agreement-status', fieldValue: 'Signed' }, { id: 'qa-payment-status', fieldValue: 'Paid' }] };
  await dispatch(mock.transport, { now: future(60_000) });
  const row = await state(id);
  assert.equal(row.state, 'delivered'); assert.ok(row.sent_at); assert.ok(row.provider_receipt_verified_at);
  assert.equal(row.payment_sent_sync_status, 'failed');
  assert.equal(row.payment_sent_sync_error, 'payment_email_sent_paid_evidence_missing');
  assert.equal(row.payment_sent_delivery_receipt, null);
  assert.equal((await publicStatus(id)).paymentSentSyncStatus, 'failed');
  assert.equal(mock.posts(), 1); assert.equal(mock.calls.filter(c => c.method === 'PUT').length, 0);
  assert.equal((await first`SELECT 1 FROM fame_payment_paid_sync_eligible WHERE reservation_id = ${id}`).length, 0);
});
