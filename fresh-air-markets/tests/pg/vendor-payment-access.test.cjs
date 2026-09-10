const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const postgres = require('postgres');
const { reserveFinalApplication } = require('../../.test-build/final-reservation-pg.js');
const { createVendorAccessToken, hashVendorAccessToken } = require('../../.test-build/vendor-payment-access.js');
const { issueVendorPaymentAccess, exchangeVendorPaymentAccess, readVendorPaymentAccess, revokeVendorPaymentAccess } = require('../../.test-build/vendor-payment-access-pg.js');
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = 'qa_vendor_payment_access';
const admin = postgres(url.toString(), { max: 1, prepare: false });
const connect = () => postgres(url.toString(), { max: 12, prepare: false, connection: { search_path: schema, statement_timeout: 15000 } });
const first = connect();
const second = connect();
const marketId = 'qa-private-vendor-market';
const locationId = 'qa-private-vendor-location';
const now = new Date('2026-10-01T12:00:00.000Z');
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
      '011-square-payment-checkout-ledger.sql', '012-square-webhook-events.sql',
      '013-final-reservation-writer.sql', '014-square-payment-expiry.sql',
      '017-vendor-payment-access.sql',
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

async function finalReservation({ nonprofit = false, checkout = true } = {}) {
  const application = await seedEligibleApplication();
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
  }
  return id;
}
async function invitation(reservationId, options = {}) {
  const tokenHash = options.tokenHash || hash();
  const result = await issueVendorPaymentAccess({ config, reservationId, tokenHash, now, ...options }, first);
  return { ...result, tokenHash };
}
async function establish(reservationId) {
  const link = await invitation(reservationId);
  assert.equal(link.kind, 'issued');
  const sessionHash = hash();
  const result = await exchangeVendorPaymentAccess({ config, invitationHash: link.tokenHash, sessionHash, now }, first);
  assert.equal(result.kind, 'exchanged');
  return { ...link, sessionHash };
}
function read(sessionHash, options = {}) { return readVendorPaymentAccess({ config, sessionHash, now, ...options }, first); }

test('100 concurrent exchanges consume one invitation and produce only one independent vendor session', async () => {
  const id = await finalReservation();
  const link = await invitation(id);
  assert.equal(link.kind, 'issued');
  assert.equal(link.expiresAt, due.toISOString());
  const attempts = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
    const sessionHash = hash();
    return { sessionHash, result: await exchangeVendorPaymentAccess({ config, invitationHash: link.tokenHash, sessionHash, now }, index % 2 ? first : second) };
  }));
  assert.equal(attempts.filter(({ result }) => result.kind === 'exchanged').length, 1);
  assert.equal(attempts.filter(({ result }) => result.kind === 'invalid').length, 99);
  const [{ count }] = await first`SELECT count(*)::int AS count FROM fame_vendor_payment_sessions`;
  assert.equal(count, 1);
  const success = attempts.find(({ result }) => result.kind === 'exchanged');
  const view = await read(success.sessionHash);
  assert.deepEqual(view, {
    dates: ['2026-10-03'], boothsPerMarket: 1, rateCents: 4000, totalCents: 4000, currency: 'USD', quoteTier: 'standard',
    paymentRequired: true, paymentDueAt: due.toISOString(), status: 'pending', checkoutUrl: 'https://sandbox.square.link/u/qa-private', environment: 'sandbox',
  });
  assert.equal(JSON.stringify(view).includes(id), false);
  for (const key of ['applicationId', 'marketId', 'snapshot', 'email', 'contactId', 'opportunityId', 'token']) assert.equal(Object.hasOwn(view, key), false);
  assert.equal(await read(link.tokenHash), null, 'an invitation hash never authenticates as session');
});

test('new invitation rotates all old invitations/sessions; concurrent rotations leave only the latest usable', async () => {
  const id = await finalReservation();
  const prior = await establish(id);
  const links = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
    const tokenHash = hash();
    const result = await issueVendorPaymentAccess({ config, reservationId: id, tokenHash, now }, index % 2 ? first : second);
    return { ...result, tokenHash };
  }));
  assert.ok(links.every(link => link.kind === 'issued'));
  assert.equal(await read(prior.sessionHash), null);
  const results = await Promise.all(links.map(link => exchangeVendorPaymentAccess({ config, invitationHash: link.tokenHash, sessionHash: hash(), now }, first)));
  assert.equal(results.filter(result => result.kind === 'exchanged').length, 1);
  assert.equal(results.filter(result => result.kind === 'invalid').length, 4);
});

test('issuance, exchange and projection fence market, committed finalization and exact revision', async () => {
  const id = await finalReservation();
  assert.equal((await invitation(id, { config: { ...config, marketId: 'another-market' } })).kind, 'not_found');
  assert.equal((await invitation(id, { config: { ...config, marketId: 'demo-market' } })).kind, 'not_found');
  const link = await invitation(id);
  assert.equal((await exchangeVendorPaymentAccess({ config: { ...config, marketId: 'another-market' }, invitationHash: link.tokenHash, sessionHash: hash(), now }, first)).kind, 'invalid');
  await assert.rejects(first`UPDATE fame_vendor_payment_invitations SET reservation_revision = 2 WHERE token_hash = ${link.tokenHash}`, error => error.code === '23503');
  const sessionHash = hash();
  assert.equal((await exchangeVendorPaymentAccess({ config, invitationHash: link.tokenHash, sessionHash, now }, first)).kind, 'exchanged');
  assert.equal(await read(sessionHash, { config: { ...config, marketId: 'another-market' } }), null);
  const notFinalId = randomUUID();
  await first`INSERT INTO fame_reservations
    (id, market_id, revision, state, payment_required, currency, total_cents, checkout_description, quote_version, final_booth_quantity, final_dates)
    VALUES (${notFinalId}, ${marketId}, 1, 'held', TRUE, 'USD', 4000, 'No finalization', 'qa', 1, ${first.json(['2026-10-03'])})`;
  assert.equal((await invitation(notFinalId)).kind, 'not_found');
});

test('deadline invalidates unused invitation but preserves authenticated expired/paid status until session expiry', async () => {
  const id = await finalReservation();
  const link = await invitation(id);
  assert.equal((await exchangeVendorPaymentAccess({ config, invitationHash: link.tokenHash, sessionHash: hash(), now: due }, first)).kind, 'invalid');
  const session = await establish(id);
  const expired = await read(session.sessionHash, { now: due });
  assert.equal(expired.status, 'expired');
  assert.equal(expired.checkoutUrl, null);
  await first`UPDATE fame_reservations SET state = 'paid' WHERE id = ${id}`;
  await first`UPDATE fame_payment_orders SET status = 'paid', payment_id = 'verified-payment', payment_status = 'COMPLETED' WHERE reservation_id = ${id}`;
  const paid = await read(session.sessionHash, { now: new Date(due.valueOf() + 3600_000) });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.checkoutUrl, null);
  assert.equal(await read(session.sessionHash, { now: new Date(now.valueOf() + 7 * 24 * 3600_000) }), null);
  const receiptLink = await invitation(id, { now: new Date(due.valueOf() + 3600_000) });
  assert.equal(receiptLink.kind, 'issued');
  assert.equal(Date.parse(receiptLink.expiresAt), due.valueOf() + 3600_000 + 7 * 24 * 3600_000);
});

test('hold without checkout, cancelled/manual review, wrong totals, wrong environment and malicious URLs expose no payable invitation', async () => {
  const held = await finalReservation({ checkout: false });
  assert.equal((await invitation(held)).kind, 'not_eligible');
  const id = await finalReservation();
  const session = await establish(id);
  for (const checkoutUrl of ['https://attacker.invalid/pay', 'javascript:alert(1)', 'https://square.link/u/live', 'https://sandbox.square.link.evil.invalid/u/qa', 'https://user:pass@sandbox.square.link/u/qa']) {
    await first`UPDATE fame_payment_orders SET checkout_url = ${checkoutUrl} WHERE reservation_id = ${id}`;
    assert.equal((await invitation(id)).kind, 'not_eligible');
    const value = await read(session.sessionHash);
    assert.equal(value.status, 'unavailable');
    assert.equal(value.checkoutUrl, null);
  }
  await first`UPDATE fame_payment_orders SET checkout_url = 'https://sandbox.square.link/u/qa', expected_total_cents = 1 WHERE reservation_id = ${id}`;
  assert.equal((await invitation(id)).kind, 'not_eligible');
  await first`UPDATE fame_payment_orders SET expected_total_cents = 4000 WHERE reservation_id = ${id}`;
  assert.equal((await invitation(id, { config: { ...config, environment: 'production' } })).kind, 'not_eligible');
  for (const state of ['cancelled', 'manual_review', 'declined']) {
    await first`UPDATE fame_reservations SET state = ${state} WHERE id = ${id}`;
    assert.equal((await invitation(id)).kind, 'not_eligible');
    assert.equal((await read(session.sessionHash)).checkoutUrl, null);
  }
});

test('confirmed nonprofit can access immutable zero-dollar reservation without Square order or payment deadline', async () => {
  const id = await finalReservation({ nonprofit: true });
  const session = await establish(id);
  assert.equal(Date.parse(session.expiresAt), now.valueOf() + 7 * 24 * 3600_000);
  const view = await read(session.sessionHash);
  assert.equal(view.status, 'confirmed');
  assert.equal(view.totalCents, 0);
  assert.equal(view.paymentRequired, false);
  assert.equal(view.paymentDueAt, null);
  assert.equal(view.environment, null);
  assert.equal(view.checkoutUrl, null);
  const [{ count }] = await first`SELECT count(*)::int AS count FROM fame_payment_orders`;
  assert.equal(count, 0);
});

test('failed exchange transaction rolls back consumption and permits retry; logout revokes the surviving session', async () => {
  const existing = await establish(await finalReservation());
  const nextId = await finalReservation();
  const nextLink = await invitation(nextId);
  await assert.rejects(exchangeVendorPaymentAccess({ config, invitationHash: nextLink.tokenHash, sessionHash: existing.sessionHash, now }, first), error => error.code === '23505');
  const [link] = await first`SELECT consumed_at FROM fame_vendor_payment_invitations WHERE token_hash = ${nextLink.tokenHash}`;
  assert.equal(link.consumed_at, null);
  const sessionHash = hash();
  assert.equal((await exchangeVendorPaymentAccess({ config, invitationHash: nextLink.tokenHash, sessionHash, now }, first)).kind, 'exchanged');
  await revokeVendorPaymentAccess({ config, sessionHash, now }, first);
  assert.equal(await read(sessionHash), null);
  assert.equal((await read(existing.sessionHash)).status, 'pending', 'logout does not revoke another reservation');
});

test('payment stop hides previously issued checkout but leaves verified paid receipts readable', async () => {
  const id = await finalReservation();
  const session = await establish(id);
  const disabled = { ...config, allowCheckout: false };
  assert.equal((await invitation(id, { config: disabled })).kind, 'not_eligible');
  const paused = await read(session.sessionHash, { config: disabled });
  assert.equal(paused.status, 'unavailable');
  assert.equal(paused.checkoutUrl, null);
  await first`UPDATE fame_reservations SET state = 'paid' WHERE id = ${id}`;
  assert.equal((await read(session.sessionHash)).status, 'unavailable', 'reservation state alone cannot prove payment');
  await first`UPDATE fame_payment_orders SET status = 'paid', payment_id = 'verified-payment', payment_status = 'COMPLETED' WHERE reservation_id = ${id}`;
  assert.equal((await read(session.sessionHash, { config: disabled })).status, 'paid');
  assert.equal((await invitation(id, { config: disabled })).kind, 'issued');
});
