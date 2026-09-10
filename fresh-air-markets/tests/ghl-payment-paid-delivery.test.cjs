const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPaymentPaidDeliveryConfig, deliverPaymentPaidToGhl } = require('../.test-build/ghl-payment-paid-delivery.js');
const { env, job, fake, proof } = require('./ghl-status-field-fixture.cjs');
const config = readPaymentPaidDeliveryConfig(env);
test('paid field sync rejects unconfigured fields and unsafe runtime, tenant or notification routing', () => {
  const invalid = [{ GHL_PAYMENT_SYNC_ENABLED: undefined }, { GHL_PAYMENT_QA_ROUTING_VERIFIED: undefined }, { VERCEL: undefined },
    { VERCEL_ENV: 'production' }, { SQUARE_ALLOW_LIVE_PAYMENTS: 'true' }, { GHL_QA_APPLICATION_PIPELINE_ID: 'live-pipeline' },
    { GHL_LOCATION_ID: 'other-location' }, { FAME_MARKET_ACCOUNT_ID: 'demo-market' }, { GHL_PAYMENT_DELIVERY_MODE: undefined },
    { GHL_APPLICATION_PIPELINE_ID: undefined }, { GHL_APPLICATION_APPROVED_STAGE_ID: undefined },
    { GHL_PAYMENT_STATUS_FIELD_ID: undefined }, { GHL_AGREEMENT_STATUS_FIELD_ID: 'payment-field' }];
  for (const patch of invalid) assert.throws(() => readPaymentPaidDeliveryConfig({ ...env, ...patch }), e => e.code === 'ghl_config_missing');
  const prod = { ...env, VERCEL_ENV: 'production', SQUARE_ENVIRONMENT: 'production', SQUARE_ALLOW_LIVE_PAYMENTS: 'true',
    GHL_PAYMENT_DELIVERY_MODE: 'production', GHL_PAYMENT_QA_ROUTING_VERIFIED: undefined, GHL_QA_APPLICATION_PIPELINE_ID: undefined };
  assert.equal(readPaymentPaidDeliveryConfig(prod).pipelineId, 'live-pipeline');
  assert.throws(() => readPaymentPaidDeliveryConfig({ ...prod, SQUARE_QA_MODE: 'true' }));
});
test('paid delivery changes only Payment Status, preserves Approved/Open and returns exact field evidence', async () => {
  for (const payment of ['Not Ready', 'Ready for Payment', 'Payment Sent']) {
    const mock = fake({ payment });
    assert.deepEqual(await deliverPaymentPaidToGhl(job, config, mock.transport), proof(config, 'Paid'));
    assert.equal(mock.calls.length, 7);
    assert.deepEqual(JSON.parse(mock.puts()[0].body), { customFields: [{ id: 'payment-field', fieldValue: 'Paid' }] });
    assert.equal(mock.state.pipelineStageId, 'qa-approved'); assert.equal(mock.state.status, 'open');
    assert.ok(mock.state.customFields.some(f => f.id === 'unrelated-field' && f.fieldValue === 'preserve me'));
  }
});
test('retry verifies actual Paid field, not legacy target stage, and never repeats the PUT', async () => {
  const mock = fake({ payment: 'Paid' });
  assert.deepEqual(await deliverPaymentPaidToGhl(job, config, mock.transport), proof(config, 'Paid'));
  assert.equal(mock.puts().length, 0); assert.equal(mock.calls.length, 4);
  const legacy = fake({ opportunity: { pipelineStageId: 'old-paid-stage' } });
  await assert.rejects(deliverPaymentPaidToGhl(job, config, legacy.transport), e => e.code === 'ghl_stage_diverged');
  assert.equal(legacy.puts().length, 0);
});
test('paid field update requires exact current contact, correct open approved opportunity and local payment identity', async () => {
  for (const options of [{ email: 'laura@autocraftstudios.com' }, { email: 'nate+qa@autocraftstudios.com' },
    { secondEmail: 'thomas@example.com' }, { opportunity: { contactId: 'foreign' } }, { opportunity: { locationId: 'foreign' } },
    { opportunity: { pipelineId: 'live-pipeline' } }, { opportunity: { status: 'lost' } }, { opportunity: { pipelineStageId: 'declined' } }]) {
    const mock = fake(options); await assert.rejects(deliverPaymentPaidToGhl(job, config, mock.transport)); assert.equal(mock.puts().length, 0);
  }
  for (const patch of [{ marketId: 'other' }, { paymentId: undefined }, { eventId: '' }, { reservationRevision: 0 }]) {
    const mock = fake(); await assert.rejects(deliverPaymentPaidToGhl({ ...job, ...patch }, config, mock.transport)); assert.equal(mock.calls.length, 0);
  }
  await deliverPaymentPaidToGhl(job, config, fake({ email: 'lnooley@gmail.com' }).transport);
});
test('paid transition rejects unsigned, ambiguous, absent, manual Issue and wrong metadata fields', async () => {
  for (const options of [{ agreement: 'Sent' }, { payment: 'Payment Issue' }, { payment: '' }, { fields: [] },
    { fields: [{ id: 'agreement-field', fieldValue: 'Signed' }, { id: 'payment-field', fieldValue: 'Paid' }, { id: 'payment-field', fieldValue: 'Not Ready' }] },
    { payment: ['Ready for Payment'] }, { metadata: { id: 'foreign-field' } }, { metadata: { model: 'contact' } },
    { metadata: { locationId: 'foreign' } }, { metadata: { name: 'Wrong field' } }, { metadata: { dataType: 'TEXT' } },
    { metadata: { fieldKey: 'contact.vendor_payment_status' } }, { metadata: { picklistOptions: ['Paid'] } }]) {
    const mock = fake(options); await assert.rejects(deliverPaymentPaidToGhl(job, config, mock.transport), e => e.code === 'ghl_field_mismatch'); assert.equal(mock.puts().length, 0);
  }
});
test('paid delivery fails closed on provider error, failed field readback or concurrent operator status change', async () => {
  const limited = fake({ failPut: 429 });
  await assert.rejects(deliverPaymentPaidToGhl(job, config, limited.transport), e => e.code === 'ghl_rate_limited' && e.retryAfterSeconds === 42);
  for (const after of [{ status: 'won' }, { pipelineId: 'other' }, { customFields: [] },
    { customFields: [{ id: 'agreement-field', fieldValue: 'Not Sent' }, { id: 'payment-field', fieldValue: 'Paid' }] }]) {
    await assert.rejects(deliverPaymentPaidToGhl(job, config, fake({ after }).transport));
  }
});
