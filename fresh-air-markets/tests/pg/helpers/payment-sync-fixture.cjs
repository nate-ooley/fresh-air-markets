const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { makeOpportunityFieldProof } = require('../../../.test-build/ghl-opportunity-field-proof.js');
const { reserveFinalApplication } = require('../../../.test-build/final-reservation-pg.js');

async function seedEligibleApplication(sql, scope, now, patch = {}) {
  const { marketId, locationId } = scope;
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


async function seedPaymentSync(sql, scope, now = new Date(), options = {}) {
  const application = await seedEligibleApplication(sql, scope, now, options);
  const app = application.applicationId;
  const agreement = application.agreementId;
  const stageJob = randomUUID();
  if (options.agreementStage !== 'missing') {
    const status = options.agreementStage || 'delivered';
    await sql`INSERT INTO fame_agreement_stage_outbox (id, market_id, application_id, completion_id, topic,
      dedupe_key, payload, status, delivered_at, delivery_receipt)
      VALUES (${stageJob}, ${scope.marketId}, ${app}, ${agreement}, 'agreement-completed-stage', ${`agreement-stage:${agreement}`},
        ${sql.json({ marketId: scope.marketId, applicationId: app, completionId: agreement, locationId: scope.locationId,
          contactId: `contact-${app}`, opportunityId: `opportunity-${app}`, seasonId: scope.seasonId })},
        ${status}, ${status === 'delivered' ? now : null}, ${status === 'delivered' ? sql.json(agreementProof({ locationId: scope.locationId, contactId: `contact-${app}`, opportunityId: `opportunity-${app}` }, scope)) : null})`;
  }
  const result = await reserveFinalApplication({ marketId: scope.marketId, applicationId: app, actorAccountId: scope.marketId, now,
    config: { marketId: scope.marketId, seasonId: scope.seasonId, boothCapacity: 100, calendarDates: ['2026-10-03'], quoteVersion: 'fresh-air-2026-2027-v1' },
    selection: { applicantType: 'Vendor', vendorCategory: 'Arts & Crafts', selectedDates: ['2026-10-03'], fullSeason: false,
      boothsPerMarket: 1, foodLicenseRequired: false, idempotencyKey: randomUUID() },
  }, sql);
  assert.equal(result.kind, 'created');
  const reservation = result.reservation.id;
  const order = `order-${randomUUID()}`;
  const due = new Date(now.valueOf() + 48 * 3600_000);
  const status = options.checkoutStatus || 'checkout_created';
  await sql`UPDATE fame_reservations SET state = 'payment_pending', payment_request_sent_at = ${now}, payment_due_at = ${due} WHERE id = ${reservation}`;
  await sql`INSERT INTO fame_payment_orders (id, market_id, reservation_id, reservation_revision, square_environment,
    square_merchant_id, square_location_id, expected_currency, expected_total_cents, idempotency_key, status,
    square_payment_link_id, square_order_id, checkout_url, payment_request_sent_at, payment_due_at)
    VALUES (${order}, ${scope.marketId}, ${reservation}, 1, 'sandbox', 'merchant', 'square-location', 'USD', 4000, ${order}, ${status},
      ${`link-${order}`}, ${`square-${order}`}, 'https://sandbox.square.link/u/qa-private', ${now}, ${due})`;
  const paymentTime = new Date(now.valueOf() + 60_000).toISOString();
  const event = { eventId: `event-${order}`, eventType: 'payment.updated', merchantId: 'merchant', occurredAt: paymentTime,
    payment: { id: `payment-${order}`, status: 'COMPLETED', locationId: 'square-location', orderId: `square-${order}`,
      amountCents: 4000, currency: 'USD', createdAt: paymentTime, updatedAt: paymentTime } };
  event.rawBodySha256 = createHash('sha256').update(JSON.stringify(event)).digest('hex');
  return { app, reservation, order, event, agreement, stageJob, now, due };
}
function agreementProof(identity, scope) {
  return makeOpportunityFieldProof({ locationId: identity.locationId, contactId: identity.contactId,
    opportunityId: identity.opportunityId, pipelineId: scope.pipelineId },
    [{ fieldId: scope.agreementStatusFieldId, fieldValue: 'Signed' }]);
}
function paymentProof(job, scope, value = 'Paid') {
  return makeOpportunityFieldProof({ locationId: job.locationId, contactId: job.contactId,
    opportunityId: job.opportunityId, pipelineId: scope.pipelineId }, [
    { fieldId: scope.agreementStatusFieldId, fieldValue: 'Signed' },
    { fieldId: scope.paymentStatusFieldId, fieldValue: value },
  ]);
}
module.exports = { seedPaymentSync, agreementProof, paymentProof };
