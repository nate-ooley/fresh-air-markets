const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readApplicationReviewDeliveryConfig, deliverApplicationReviewToGhl } = require('../.test-build/ghl-application-review-delivery.js');
const { readPaymentPaidDeliveryConfig, deliverPaymentPaidToGhl } = require('../.test-build/ghl-payment-paid-delivery.js');
const { readPaymentEmailDeliveryConfig, preflightPaymentEmail } = require('../.test-build/ghl-payment-email-delivery.js');

const env = {
  VERCEL: '1', VERCEL_ENV: 'preview', GHL_API_TOKEN: 'test-only-token-at-least-16-characters',
  GHL_LOCATION_ID: 'aooAnUXF0COePorBo7wL', GHL_APPLICATION_PIPELINE_ID: 'production-pipeline',
  GHL_QA_APPLICATION_PIPELINE_ID: 'qa-pipeline', GHL_PAYMENT_QA_ROUTING_VERIFIED: 'true',
  GHL_APPLICATION_REVIEW_STAGE_ID: 'qa-review', GHL_APPLICATION_APPROVED_STAGE_ID: 'qa-approved',
  GHL_APPLICATION_CHANGES_REQUESTED_STAGE_ID: 'qa-changes', GHL_APPLICATION_DECLINED_STAGE_ID: 'qa-declined',
  GHL_PAYMENT_SYNC_ENABLED: 'true', GHL_PAYMENT_EMAIL_ENABLED: 'true', GHL_PAYMENT_DELIVERY_MODE: 'qa',
  GHL_PAYMENT_PENDING_STAGE_ID: 'qa-payment-pending', GHL_PAYMENT_CONFIRMED_STAGE_ID: 'qa-paid',
  GHL_AGREEMENT_COMPLETED_STAGE_ID: 'qa-agreement-signed',
  GHL_PAYMENT_EMAIL_FROM: 'nate@autocraftstudios.com', FAME_VENDOR_PORTAL_ORIGIN: 'https://qa-farmers-market.vercel.app',
  FAME_MARKET_ACCOUNT_ID: 'qa-market', FAME_SEASON_ID: '2026-2027',
  SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ALLOW_LIVE_PAYMENTS: 'false',
};
const reviewConfig = readApplicationReviewDeliveryConfig(env);
const review = { id: 'review-job', marketId: env.FAME_MARKET_ACCOUNT_ID, attempt: 1, leaseToken: 'lease', payload: {
  applicationId: 'application-1', sourceEventId: 'source-1', reviewEventId: 'review-1',
  marketId: env.FAME_MARKET_ACCOUNT_ID, locationId: env.GHL_LOCATION_ID, seasonId: env.FAME_SEASON_ID,
  contactId: 'contact-1', opportunityId: 'opportunity-1', actorAccountId: env.FAME_MARKET_ACCOUNT_ID,
  reviewState: 'approved', reason: '',
} };
function provider({ contactPatch = {}, opportunityPatch = {}, changedEmail } = {}) {
  const calls = [];
  let contactReads = 0;
  const opportunity = { id: review.payload.opportunityId, contactId: review.payload.contactId,
    locationId: env.GHL_LOCATION_ID, pipelineId: env.GHL_QA_APPLICATION_PIPELINE_ID,
    pipelineStageId: env.GHL_APPLICATION_REVIEW_STAGE_ID, status: 'open', ...opportunityPatch };
  const transport = async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Version, 'v3');
    if (url === `https://services.leadconnectorhq.com/contacts/${review.payload.contactId}`) {
      contactReads += 1;
      return Response.json({ contact: { id: review.payload.contactId, locationId: env.GHL_LOCATION_ID,
        email: contactReads > 1 && changedEmail ? changedEmail : 'nate@autocraftstudios.com', ...contactPatch } });
    }
    assert.equal(url, `https://services.leadconnectorhq.com/opportunities/${review.payload.opportunityId}`);
    if (init.method === 'PUT') Object.assign(opportunity, JSON.parse(init.body));
    return Response.json({ opportunity });
  };
  return { calls, opportunity, transport };
}

test('one Preview configuration keeps the same exact opportunity in the QA pipeline through review and payment adapters', async () => {
  const paidConfig = readPaymentPaidDeliveryConfig(env);
  const emailConfig = readPaymentEmailDeliveryConfig(env);
  assert.equal(reviewConfig.pipelineId, env.GHL_QA_APPLICATION_PIPELINE_ID);
  assert.equal(reviewConfig.pipelineId, paidConfig.pipelineId);
  assert.equal(reviewConfig.pipelineId, emailConfig.pipelineId);
  const mock = provider();
  await deliverApplicationReviewToGhl(review, reviewConfig, mock.transport);
  assert.equal(mock.opportunity.pipelineStageId, env.GHL_APPLICATION_APPROVED_STAGE_ID);
  assert.deepEqual(mock.calls.map(call => call.method), ['GET', 'GET', 'GET', 'PUT', 'GET']);
  // The agreement/reservation workflow owns this intervening state transition.
  // This test exercises adapter compatibility, not those independent workflows.
  mock.opportunity.pipelineStageId = env.GHL_PAYMENT_PENDING_STAGE_ID;
  await preflightPaymentEmail({ id: 'email-1', marketId: env.FAME_MARKET_ACCOUNT_ID,
    applicationId: review.payload.applicationId, reservationId: 'reservation-1', revision: 1,
    contactId: review.payload.contactId, locationId: env.GHL_LOCATION_ID, opportunityId: review.payload.opportunityId,
    recipientEmail: 'nate@autocraftstudios.com', totalCents: 5000, paymentDueAt: '2026-10-03T12:00:00.000Z',
    invitationUrl: `${env.FAME_VENDOR_PORTAL_ORIGIN}/vendor/payment#token=${Buffer.alloc(32, 1).toString('base64url')}`,
  }, emailConfig, mock.transport, new Date('2026-10-01T12:00:00.000Z'));
  await deliverPaymentPaidToGhl({ ...paidConfig, contactId: review.payload.contactId,
    opportunityId: review.payload.opportunityId, applicationId: review.payload.applicationId,
    paymentOrderId: 'order-1', reservationId: 'reservation-1', reservationRevision: 1,
    squareMerchantId: 'merchant-1', squareLocationId: 'square-location', squareOrderId: 'square-order',
    paymentId: 'payment-1', eventId: 'event-1', attempt: 1, leaseToken: 'lease',
  }, paidConfig, mock.transport);
  assert.equal(mock.opportunity.pipelineStageId, env.GHL_PAYMENT_CONFIRMED_STAGE_ID);
  assert.equal(mock.opportunity.pipelineId, env.GHL_QA_APPLICATION_PIPELINE_ID);
  assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 2);
});

test('Preview review configuration cannot fall back to production or bypass verified test routing', () => {
  for (const patch of [
    { VERCEL: undefined }, { VERCEL_ENV: undefined }, { VERCEL_ENV: 'development' },
    { GHL_QA_APPLICATION_PIPELINE_ID: undefined }, { GHL_QA_APPLICATION_PIPELINE_ID: 'production-pipeline' },
    { GHL_APPLICATION_PIPELINE_ID: undefined }, { GHL_PAYMENT_QA_ROUTING_VERIFIED: undefined },
    { GHL_PAYMENT_QA_ROUTING_VERIFIED: 'false' }, { GHL_LOCATION_ID: 'other-location' },
  ]) assert.throws(() => readApplicationReviewDeliveryConfig({ ...env, ...patch }), error => error.code === 'ghl_config_missing');
});

test('a production or unrelated opportunity pipeline never receives a Preview review update', async () => {
  for (const pipelineId of [env.GHL_APPLICATION_PIPELINE_ID, 'unrelated-pipeline']) {
    const mock = provider({ opportunityPatch: { pipelineId } });
    await assert.rejects(deliverApplicationReviewToGhl(review, reviewConfig, mock.transport), error => error.code === 'ghl_pipeline_mismatch');
    assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 0);
  }
});

test('Preview review blocks live recipients, changed contact identities, and email changes immediately before PUT', async () => {
  for (const contactPatch of [
    { email: 'thomas@example.com' }, { email: 'laura@autocraftstudios.com' },
    { email: 'nate+qa@autocraftstudios.com' }, { email: '' },
    { id: 'another-contact' }, { locationId: 'another-location' },
  ]) {
    const mock = provider({ contactPatch });
    await assert.rejects(deliverApplicationReviewToGhl(review, reviewConfig, mock.transport), error => error.code === 'ghl_identity_mismatch');
    assert.equal(mock.calls.length, 1);
  }
  const changed = provider({ changedEmail: 'live-vendor@example.com' });
  await assert.rejects(deliverApplicationReviewToGhl(review, reviewConfig, changed.transport), error => error.code === 'ghl_identity_mismatch');
  assert.deepEqual(changed.calls.map(call => call.method), ['GET', 'GET', 'GET']);
  const allowed = provider({ contactPatch: { email: 'lnooley@gmail.com' } });
  await deliverApplicationReviewToGhl(review, reviewConfig, allowed.transport);
  assert.equal(allowed.calls.filter(call => call.method === 'PUT').length, 1);
});

test('Production review keeps its configured production pipeline and refuses leftover QA routing controls', async () => {
  const prodEnv = { ...env, VERCEL_ENV: 'production', GHL_QA_APPLICATION_PIPELINE_ID: undefined,
    GHL_PAYMENT_QA_ROUTING_VERIFIED: undefined };
  const config = readApplicationReviewDeliveryConfig(prodEnv);
  assert.equal(config.mode, 'production');
  assert.equal(config.pipelineId, env.GHL_APPLICATION_PIPELINE_ID);
  const mock = provider({ opportunityPatch: { pipelineId: env.GHL_APPLICATION_PIPELINE_ID },
    contactPatch: { email: 'production-vendor@example.com' } });
  await deliverApplicationReviewToGhl(review, config, mock.transport);
  assert.deepEqual(mock.calls.map(call => call.method), ['GET', 'PUT', 'GET']);
  for (const patch of [{ GHL_QA_APPLICATION_PIPELINE_ID: 'qa-pipeline' }, { GHL_PAYMENT_QA_ROUTING_VERIFIED: 'true' }]) {
    assert.throws(() => readApplicationReviewDeliveryConfig({ ...prodEnv, ...patch }), error => error.code === 'ghl_config_missing');
  }
});
