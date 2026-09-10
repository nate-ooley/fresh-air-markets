const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPaymentPendingDeliveryConfig, deliverPaymentPendingToGhl } = require('../.test-build/ghl-payment-pending-delivery.js');
const { deliverPaymentPaidToGhl } = require('../.test-build/ghl-payment-paid-delivery.js');
const { env, job, fake, proof } = require('./ghl-status-field-fixture.cjs');
const config = readPaymentPendingDeliveryConfig(env);
test('Ready field delivery requires explicit routing, Approved stage, and distinct configured field IDs', () => {
  for (const patch of [{ GHL_PAYMENT_SYNC_ENABLED: undefined }, { GHL_AGREEMENT_STATUS_FIELD_ID: undefined },
    { GHL_AGREEMENT_STATUS_FIELD_ID: 'payment-field' }, { GHL_QA_APPLICATION_PIPELINE_ID: 'live-pipeline' },
    { GHL_PAYMENT_QA_ROUTING_VERIFIED: undefined }, { GHL_APPLICATION_APPROVED_STAGE_ID: undefined }]) {
    assert.throws(() => readPaymentPendingDeliveryConfig({ ...env, ...patch }), e => e.code === 'ghl_config_missing');
  }
});
test('Ready advances only Not Ready on exact Signed Approved/Open opportunity with field-only PUT and verified receipt', async () => {
  const mock = fake(); assert.deepEqual(await deliverPaymentPendingToGhl(job, config, mock.transport), proof(config, 'Ready for Payment'));
  assert.equal(mock.calls.length, 7);
  assert.deepEqual(JSON.parse(mock.puts()[0].body), { customFields: [{ id: 'payment-field', fieldValue: 'Ready for Payment' }] });
  assert.equal(mock.state.pipelineStageId, 'qa-approved'); assert.equal(mock.state.status, 'open');
});
test('Ready replay reads actual fields; Sent, Paid, Issue, blank and unsigned state cannot regress', async () => {
  const existing = fake({ payment: 'Ready for Payment' });
  assert.deepEqual(await deliverPaymentPendingToGhl(job, config, existing.transport), proof(config, 'Ready for Payment'));
  assert.equal(existing.puts().length, 0);
  for (const options of [{ payment: 'Paid' }, { payment: 'Payment Sent' }, { payment: 'Payment Issue' }, { payment: '' },
    { fields: [] }, { agreement: 'Sent' }, { agreement: 'Not Sent' }]) {
    const mock = fake(options); await assert.rejects(deliverPaymentPendingToGhl(job, config, mock.transport), e => e.code === 'ghl_field_mismatch');
    assert.equal(mock.puts().length, 0);
  }
});
test('Ready field update blocks live recipients, foreign identity, closed status and old operational stage', async () => {
  for (const options of [{ email: 'laura@autocraftstudios.com' }, { secondEmail: 'thomas@example.com' },
    { opportunity: { contactId: 'foreign' } }, { opportunity: { locationId: 'foreign' } }, { opportunity: { pipelineId: 'live-pipeline' } },
    { opportunity: { status: 'lost' } }, { opportunity: { pipelineStageId: 'old-signed-stage' } }]) {
    const mock = fake(options); await assert.rejects(deliverPaymentPendingToGhl(job, config, mock.transport)); assert.equal(mock.puts().length, 0);
  }
});
test('Ready cannot report success for expired order, invalid field metadata, failed provider or failed readback', async () => {
  const expired = fake(); await assert.rejects(deliverPaymentPendingToGhl({ ...job, paymentDueAt: new Date(0).toISOString() }, config, expired.transport));
  assert.equal(expired.calls.length, 0);
  for (const options of [{ metadata: { id: 'wrong' } }, { failPut: 503 }, { after: { customFields: [] } }]) {
    await assert.rejects(deliverPaymentPendingToGhl(job, config, fake(options).transport));
  }
});
test('a fast reconciled payment reaches Paid directly; delayed Ready retry cannot undo it', async () => {
  const mock = fake(); await deliverPaymentPaidToGhl(job, config, mock.transport);
  assert.deepEqual(JSON.parse(mock.puts()[0].body), { customFields: [{ id: 'payment-field', fieldValue: 'Paid' }] });
  await assert.rejects(deliverPaymentPendingToGhl(job, config, mock.transport), e => e.code === 'ghl_field_mismatch');
  assert.equal(mock.puts().length, 1); assert.equal(mock.state.pipelineStageId, 'qa-approved');
});
