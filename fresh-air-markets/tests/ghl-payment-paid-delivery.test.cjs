const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPaymentPaidDeliveryConfig, deliverPaymentPaidToGhl } = require('../.test-build/ghl-payment-paid-delivery.js');
const { paymentPaidSyncFailure } = require('../.test-build/payment-paid-sync-pg.js');
const env = {
  VERCEL: '1', VERCEL_ENV: 'preview', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ALLOW_LIVE_PAYMENTS: 'false',
  GHL_PAYMENT_SYNC_ENABLED: 'true', GHL_PAYMENT_DELIVERY_MODE: 'qa', GHL_PAYMENT_QA_ROUTING_VERIFIED: 'true',
  GHL_API_TOKEN: 'qa-token-not-a-real-provider-token', GHL_LOCATION_ID: 'aooAnUXF0COePorBo7wL',
  FAME_MARKET_ACCOUNT_ID: 'qa-market', FAME_SEASON_ID: '2026-2027',
  GHL_QA_APPLICATION_PIPELINE_ID: 'qa-pipeline', GHL_APPLICATION_PIPELINE_ID: 'live-pipeline',
  GHL_AGREEMENT_COMPLETED_STAGE_ID: 'qa-agreement-signed', GHL_PAYMENT_PENDING_STAGE_ID: 'qa-payment-pending', GHL_PAYMENT_CONFIRMED_STAGE_ID: 'qa-paid',
};
const config = readPaymentPaidDeliveryConfig(env);
const job = { ...config, paymentOrderId: 'order-1', applicationId: 'app-1', contactId: 'contact-1', opportunityId: 'opportunity-1', reservationId: 'reservation-1', reservationRevision: 1, squareMerchantId: 'merchant-1', squareLocationId: 'square-location', squareOrderId: 'square-order', paymentId: 'payment-1', eventId: 'event-1', attempt: 1, leaseToken: 'lease-1' };
const contact = { id: job.contactId, locationId: config.locationId, email: 'nate@autocraftstudios.com' };
const opportunity = { id: job.opportunityId, contactId: job.contactId, locationId: config.locationId, pipelineId: config.pipelineId, pipelineStageId: config.pendingStageId, status: 'open' };
function transportFor({ contactPatch, opportunityPatch, resultPatch, failPut, priorPaid = false } = {}) {
  const calls = [];
  let updated = priorPaid;
  const transport = async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(init.headers.Version, 'v3');
    assert.equal(init.redirect, 'error');
    assert.match(url, /^https:\/\/services\.leadconnectorhq\.com\/(contacts|opportunities)\//);
    if (url.includes('/contacts/')) return Response.json({ contact: { ...contact, ...contactPatch } });
    if (init.method === 'PUT') {
      if (failPut) return new Response('private-provider-body', { status: failPut, headers: { 'retry-after': '42' } });
      assert.deepEqual(JSON.parse(init.body), { pipelineStageId: config.confirmedStageId });
      updated = true;
      return Response.json({ success: true });
    }
    return Response.json({ opportunity: { ...opportunity, ...(updated ? { pipelineStageId: config.confirmedStageId, ...resultPatch } : {}), ...opportunityPatch } });
  };
  return { calls, transport };
}
test('paid sync is disabled by default and refuses unsafe runtime, tenant, pipeline and QA notification routing', () => {
  const invalid = [{ GHL_PAYMENT_SYNC_ENABLED: undefined }, { GHL_PAYMENT_QA_ROUTING_VERIFIED: undefined }, { VERCEL: undefined }, { VERCEL_ENV: 'production' }, { SQUARE_ALLOW_LIVE_PAYMENTS: 'true' }, { GHL_QA_APPLICATION_PIPELINE_ID: 'live-pipeline' }, { GHL_LOCATION_ID: 'other-location' }, { FAME_MARKET_ACCOUNT_ID: 'demo-market' }, { GHL_PAYMENT_DELIVERY_MODE: undefined }];
  invalid.push({ GHL_APPLICATION_PIPELINE_ID: undefined });
  for (const patch of invalid) assert.throws(() => readPaymentPaidDeliveryConfig({ ...env, ...patch }), e => e.code === 'ghl_config_missing');
  const prod = { ...env, VERCEL_ENV: 'production', SQUARE_ENVIRONMENT: 'production', SQUARE_ALLOW_LIVE_PAYMENTS: 'true', GHL_PAYMENT_DELIVERY_MODE: 'production', GHL_PAYMENT_QA_ROUTING_VERIFIED: undefined, GHL_QA_APPLICATION_PIPELINE_ID: undefined };
  assert.equal(readPaymentPaidDeliveryConfig(prod).pipelineId, 'live-pipeline');
  assert.throws(() => readPaymentPaidDeliveryConfig({ ...prod, SQUARE_QA_MODE: 'true' }), e => e.code === 'ghl_config_missing');
});
test('paid delivery GETs current exact contact and opportunity, updates only stage, then verifies the provider state', async () => {
  const mock = transportFor();
  await deliverPaymentPaidToGhl(job, config, mock.transport);
  assert.deepEqual(mock.calls.map(c => c.method), ['GET', 'GET', 'GET', 'PUT', 'GET']);
  assert.equal(mock.calls.filter(c => c.method === 'PUT').length, 1);
});
test('a receipt retry observes the already-paid stage and never sends another stage trigger', async () => {
  const mock = transportFor({ priorPaid: true });
  await deliverPaymentPaidToGhl(job, config, mock.transport);
  assert.deepEqual(mock.calls.map(c => c.method), ['GET', 'GET']);
});
test('QA uses the current contact email and blocks all non-test addresses before any opportunity update', async () => {
  for (const email of ['thomas@example.com', 'laura@autocraftstudios.com', 'nate+qa@autocraftstudios.com', '']) {
    const mock = transportFor({ contactPatch: { email } });
    await assert.rejects(deliverPaymentPaidToGhl(job, config, mock.transport), e => e.code === 'ghl_qa_recipient_rejected');
    assert.equal(mock.calls.filter(c => c.method === 'PUT').length, 0);
  }
  const allowed = transportFor({ contactPatch: { email: 'lnooley@gmail.com' } });
  await deliverPaymentPaidToGhl(job, config, allowed.transport);
});
test('wrong identities, closed opportunities and manually diverged stages never receive PUT', async () => {
  for (const opportunityPatch of [{ contactId: 'different-contact' }, { locationId: 'different-location' }, { pipelineId: 'live-pipeline' }, { status: 'won' }, { status: 'lost' }, { pipelineStageId: 'declined' }]) {
    const mock = transportFor({ opportunityPatch });
    await assert.rejects(deliverPaymentPaidToGhl(job, config, mock.transport));
    assert.equal(mock.calls.filter(c => c.method === 'PUT').length, 0);
  }
  const mock = transportFor();
  await assert.rejects(deliverPaymentPaidToGhl({ ...job, marketId: 'other-market' }, config, mock.transport), e => e.code === 'ghl_identity_mismatch');
  assert.equal(mock.calls.length, 0);
});
test('provider failures and a missing final state are not treated as delivery receipts', async () => {
  const limited = transportFor({ failPut: 429 });
  await assert.rejects(deliverPaymentPaidToGhl(job, config, limited.transport), e => e.code === 'ghl_rate_limited' && e.retryAfterSeconds === 42);
  const divergent = transportFor({ resultPatch: { pipelineStageId: 'still-pending' } });
  await assert.rejects(deliverPaymentPaidToGhl(job, config, divergent.transport), e => e.code === 'ghl_stage_diverged');
  assert.deepEqual(paymentPaidSyncFailure({ code: 'private-token-or-email', message: 'private-data' }, 1), { code: 'delivery_unavailable', terminal: false, delay: 30 });
  assert.equal(paymentPaidSyncFailure({ code: 'ghl_unavailable' }, 8).terminal, true);
});
