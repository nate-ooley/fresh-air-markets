const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPaymentPendingDeliveryConfig, deliverPaymentPendingToGhl } = require('../.test-build/ghl-payment-pending-delivery.js');
const { deliverPaymentPaidToGhl } = require('../.test-build/ghl-payment-paid-delivery.js');
const env = { VERCEL: '1', VERCEL_ENV: 'preview', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ALLOW_LIVE_PAYMENTS: 'false',
  GHL_PAYMENT_SYNC_ENABLED: 'true', GHL_PAYMENT_DELIVERY_MODE: 'qa', GHL_PAYMENT_QA_ROUTING_VERIFIED: 'true',
  GHL_API_TOKEN: 'not-a-real-provider-token', GHL_LOCATION_ID: 'aooAnUXF0COePorBo7wL', FAME_MARKET_ACCOUNT_ID: 'qa-market', FAME_SEASON_ID: '2026-2027',
  GHL_QA_APPLICATION_PIPELINE_ID: 'qa-pipeline', GHL_APPLICATION_PIPELINE_ID: 'live-pipeline',
  GHL_AGREEMENT_COMPLETED_STAGE_ID: 'signed', GHL_PAYMENT_PENDING_STAGE_ID: 'pending', GHL_PAYMENT_CONFIRMED_STAGE_ID: 'confirmed' };
const config = readPaymentPendingDeliveryConfig(env);
const job = { ...config, paymentOrderId: 'order', applicationId: 'application', agreementCompletionId: 'agreement', contactId: 'contact', opportunityId: 'opportunity',
  reservationId: 'reservation', reservationRevision: 1, squareOrderId: 'square-order', paymentDueAt: new Date(Date.now() + 3600_000).toISOString(), attempt: 1, leaseToken: 'lease' };
function fake(options = {}) {
  const calls = []; let stage = options.stage || 'signed';
  return { calls, transport: async (url, init) => {
    calls.push({ url, ...init });
    if (url.includes('/contacts/')) return Response.json({ contact: { id: job.contactId, locationId: job.locationId, email: options.email || 'nate@autocraftstudios.com' } });
    if (init.method === 'PUT') { if (options.failPut) return new Response('', { status: options.failPut }); stage = JSON.parse(init.body).pipelineStageId; return Response.json({}); }
    return Response.json({ opportunity: { id: job.opportunityId, contactId: job.contactId, locationId: job.locationId, pipelineId: config.pipelineId,
      pipelineStageId: stage, status: 'open', ...options.opportunity } });
  } };
}
test('pending sync requires explicit payment routing and distinct configured source and target stages', () => {
  for (const patch of [{ GHL_PAYMENT_SYNC_ENABLED: undefined }, { GHL_AGREEMENT_COMPLETED_STAGE_ID: undefined },
    { GHL_AGREEMENT_COMPLETED_STAGE_ID: 'pending' }, { GHL_QA_APPLICATION_PIPELINE_ID: 'live-pipeline' }, { GHL_PAYMENT_QA_ROUTING_VERIFIED: undefined }]) {
    assert.throws(() => readPaymentPendingDeliveryConfig({ ...env, ...patch }), e => e.code === 'ghl_config_missing');
  }
});
test('pending advances only exact signed opportunity with a stage-only PUT and verified readback', async () => {
  const mock = fake(); await deliverPaymentPendingToGhl(job, config, mock.transport);
  assert.deepEqual(mock.calls.map(c => c.method), ['GET', 'GET', 'GET', 'PUT', 'GET']);
  assert.deepEqual(JSON.parse(mock.calls.find(c => c.method === 'PUT').body), { pipelineStageId: 'pending' });
});
test('already-pending retry is an idempotent read; confirmed and other stages never regress', async () => {
  const existing = fake({ stage: 'pending' }); await deliverPaymentPendingToGhl(job, config, existing.transport);
  assert.deepEqual(existing.calls.map(c => c.method), ['GET', 'GET']);
  for (const stage of ['confirmed', 'declined', 'agreement-sent']) {
    const mock = fake({ stage }); await assert.rejects(deliverPaymentPendingToGhl(job, config, mock.transport), e => e.code === 'ghl_stage_diverged');
    assert.equal(mock.calls.some(c => c.method === 'PUT'), false);
  }
});
test('foreign current contact, pipeline and closed opportunity are rejected without mutations', async () => {
  for (const options of [{ email: 'laura@autocraftstudios.com' }, { opportunity: { contactId: 'foreign' } }, { opportunity: { locationId: 'foreign' } },
    { opportunity: { pipelineId: 'live-pipeline' } }, { opportunity: { status: 'lost' } }]) {
    const mock = fake(options); await assert.rejects(deliverPaymentPendingToGhl(job, config, mock.transport));
    assert.equal(mock.calls.some(c => c.method === 'PUT'), false);
  }
});
test('expired job and provider errors cannot be reported as successful pending delivery', async () => {
  const expired = fake(); await assert.rejects(deliverPaymentPendingToGhl({ ...job, paymentDueAt: new Date(0).toISOString() }, config, expired.transport));
  assert.equal(expired.calls.length, 0);
  const rejected = fake({ failPut: 503 }); await assert.rejects(deliverPaymentPendingToGhl(job, config, rejected.transport), e => e.code === 'ghl_unavailable');
});
test('verified-paid worker can advance Signed directly to Confirmed when payment beats pending stage delivery', async () => {
  const mock = fake(); await deliverPaymentPaidToGhl({ ...job, paymentId: 'payment', eventId: 'event', squareMerchantId: 'merchant', squareLocationId: 'location' }, config, mock.transport);
  assert.deepEqual(JSON.parse(mock.calls.find(c => c.method === 'PUT').body), { pipelineStageId: 'confirmed' });
});
