import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AgreementStageDeliveryMessage } from "../src/lib/agreement-completion-pg.ts";
const require = createRequire(import.meta.url);
const { deliverAgreementStageToGhl, readAgreementStageDeliveryConfig } = require('../.test-build/ghl-agreement-completion-delivery.js');
const { readApplicationReviewDeliveryConfig, deliverApplicationReviewToGhl } = require('../.test-build/ghl-application-review-delivery.js');
const { env, job, fake, proof } = require('./ghl-status-field-fixture.cjs');
const config = readAgreementStageDeliveryConfig(env);
function message(): AgreementStageDeliveryMessage {
  return {
    id: 'agreement-message', marketId: job.marketId, attempt: 1, leaseToken: 'lease',
    payload: { applicationId: job.applicationId, completionId: 'completion-1', documentId: 'document-1', templateId: 'template-1',
      marketId: job.marketId, locationId: job.locationId, contactId: job.contactId, opportunityId: job.opportunityId, seasonId: job.seasonId },
  };
}
const fieldFailure = (error: unknown) => (error as { code?: string }).code === 'ghl_field_mismatch';

test('agreement completion changes only exact Agreement Status to Signed and preserves Approved/Open', async () => {
  const mock = fake({ agreement: 'Sent' });
  assert.deepEqual(await deliverAgreementStageToGhl(message(), config, mock.transport), proof(config));
  assert.equal(mock.calls.length, 6);
  assert.deepEqual(JSON.parse(mock.puts()[0].body), { customFields: [{ id: 'agreement-field', fieldValue: 'Signed' }] });
  assert.equal(mock.state.pipelineStageId, 'qa-approved'); assert.equal(mock.state.status, 'open');
});

test('Signed field replay returns newly verified field evidence with no second provider write', async () => {
  const mock = fake({ agreement: 'Signed' });
  assert.deepEqual(await deliverAgreementStageToGhl(message(), config, mock.transport), proof(config));
  assert.equal(mock.puts().length, 0); assert.equal(mock.calls.length, 3);
});

test('agreement identity mismatches cannot change a provider field', async () => {
  for (const opportunity of [{ id: 'other' }, { contactId: 'other' }, { locationId: 'other' }, { locationId: undefined }, { pipelineId: 'live-pipeline' }]) {
    const mock = fake({ agreement: 'Sent', opportunity });
    await assert.rejects(deliverAgreementStageToGhl(message(), config, mock.transport)); assert.equal(mock.puts().length, 0);
  }
  for (const payload of [{ locationId: 'other' }, { contactId: 'contact/other' }, { completionId: '' }]) {
    const mock = fake({ agreement: 'Sent' });
    await assert.rejects(deliverAgreementStageToGhl({ ...message(), payload: { ...message().payload, ...payload } }, config, mock.transport));
    assert.equal(mock.calls.length, 0);
  }
});

test('Not Sent, absent, unknown, array and duplicate agreement values do not count as sent or signed', async () => {
  for (const options of [{ agreement: 'Not Sent' }, { agreement: '' }, { agreement: ['Sent'] }, { fields: [] },
    { fields: [{ id: 'agreement-field', fieldValue: 'Signed' }, { id: 'agreement-field', fieldValue: 'Sent' }] }]) {
    const mock = fake(options); await assert.rejects(deliverAgreementStageToGhl(message(), config, mock.transport), fieldFailure);
    assert.equal(mock.puts().length, 0);
  }
});

test('closed or manually moved opportunities never receive a field update, including Signed replay', async () => {
  for (const opportunity of [{ status: 'won' }, { status: 'lost' }, { status: 'abandoned' }, { pipelineStageId: 'old-agreement-signed-stage' }]) {
    const mock = fake({ agreement: 'Signed', opportunity });
    await assert.rejects(deliverAgreementStageToGhl(message(), config, mock.transport)); assert.equal(mock.puts().length, 0);
  }
});

test('agreement readback must prove exact field value and retain open approved identity', async () => {
  for (const after of [{ status: 'lost' }, { pipelineStageId: 'other' }, { contactId: 'other' }, { customFields: [] },
    { customFields: [{ id: 'agreement-field', fieldValue: 'Sent' }] }]) {
    const mock = fake({ agreement: 'Sent', after });
    await assert.rejects(deliverAgreementStageToGhl(message(), config, mock.transport)); assert.equal(mock.puts().length, 1);
  }
});

test('agreement selects review pipeline and Approved stage with exact field ID, not legacy operational stages', () => {
  const review = readApplicationReviewDeliveryConfig(env);
  assert.equal(config.pipelineId, review.pipelineId); assert.equal(config.approvedStageId, review.stageForOutcome.approved);
  for (const patch of [{ GHL_AGREEMENT_PIPELINE_ID: 'another' }, { GHL_QA_APPLICATION_PIPELINE_ID: 'live-pipeline' },
    { GHL_PAYMENT_QA_ROUTING_VERIFIED: 'false' }, { GHL_APPLICATION_PIPELINE_ID: '' }, { GHL_AGREEMENT_STATUS_FIELD_ID: '' },
    { GHL_APPLICATION_APPROVED_STAGE_ID: '' }, { VERCEL: '' }, { VERCEL_ENV: 'development' }]) {
    assert.throws(() => readAgreementStageDeliveryConfig({ ...env, ...patch }));
  }
  const prod = { ...env, VERCEL_ENV: 'production', GHL_PAYMENT_QA_ROUTING_VERIFIED: undefined, GHL_QA_APPLICATION_PIPELINE_ID: undefined };
  assert.equal(readAgreementStageDeliveryConfig(prod).pipelineId, 'live-pipeline');
  assert.throws(() => readAgreementStageDeliveryConfig({ ...prod, GHL_QA_TEST: 'true' }));
});

test('agreement blocks live recipients and recipient changes immediately before field PUT', async () => {
  for (const options of [{ email: 'laura@autocraftstudios.com' }, { email: 'thomas@example.com' },
    { email: 'nate+qa@autocraftstudios.com' }, { secondEmail: 'laura@autocraftstudios.com' }]) {
    const mock = fake({ agreement: 'Sent', ...options });
    await assert.rejects(deliverAgreementStageToGhl(message(), config, mock.transport)); assert.equal(mock.puts().length, 0);
  }
  await deliverAgreementStageToGhl(message(), config, fake({ agreement: 'Sent', email: 'lnooley@gmail.com' }).transport);
});

test('the same QA opportunity traverses review to Approved then agreement Signed without an operational stage', async () => {
  const mock = fake({ review: true, agreement: 'Sent', opportunity: { pipelineStageId: env.GHL_APPLICATION_REVIEW_STAGE_ID } });
  const agreement = message();
  await deliverApplicationReviewToGhl({ ...agreement, payload: { ...agreement.payload, reviewEventId: 'review-1', sourceEventId: 'source-1',
    reviewState: 'approved', actorAccountId: agreement.marketId, reason: '' } }, readApplicationReviewDeliveryConfig(env), mock.transport);
  await deliverAgreementStageToGhl(agreement, config, mock.transport);
  assert.equal(mock.state.pipelineStageId, 'qa-approved'); assert.equal(mock.puts().length, 2);
  assert.equal(mock.puts()[0].url, mock.puts()[1].url);
  assert.deepEqual(JSON.parse(mock.puts()[1].body), { customFields: [{ id: 'agreement-field', fieldValue: 'Signed' }] });
});

test('metadata mapping and provider failures cannot produce agreement field receipts', async () => {
  for (const metadata of [{ id: 'other' }, { model: 'contact' }, { locationId: 'other' }, { fieldKey: 'contact.status' },
    { name: 'Vendor Payment Status' }, { dataType: 'TEXT' }, { picklistOptions: ['Signed'] }]) {
    const mock = fake({ agreement: 'Sent', metadata });
    await assert.rejects(deliverAgreementStageToGhl(message(), config, mock.transport), fieldFailure); assert.equal(mock.puts().length, 0);
  }
  const limited = fake({ agreement: 'Sent', failPut: 429 });
  await assert.rejects(deliverAgreementStageToGhl(message(), config, limited.transport), (error: unknown) => {
    const e = error as { code?: string; retryAfterSeconds?: number }; return e.code === 'ghl_rate_limited' && e.retryAfterSeconds === 42;
  });
});
