// Injected transport only: these tests never contact HighLevel.
const assert = require('node:assert/strict');
const env = {
  VERCEL: '1', VERCEL_ENV: 'preview', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ALLOW_LIVE_PAYMENTS: 'false',
  GHL_PAYMENT_SYNC_ENABLED: 'true', GHL_PAYMENT_DELIVERY_MODE: 'qa', GHL_PAYMENT_QA_ROUTING_VERIFIED: 'true',
  GHL_API_TOKEN: 'qa-token-not-a-real-provider-token', GHL_LOCATION_ID: 'aooAnUXF0COePorBo7wL',
  FAME_MARKET_ACCOUNT_ID: 'qa-market', FAME_SEASON_ID: '2026-2027',
  GHL_QA_APPLICATION_PIPELINE_ID: 'qa-pipeline', GHL_APPLICATION_PIPELINE_ID: 'live-pipeline',
  GHL_APPLICATION_REVIEW_STAGE_ID: 'qa-review', GHL_APPLICATION_APPROVED_STAGE_ID: 'qa-approved',
  GHL_APPLICATION_DECLINED_STAGE_ID: 'qa-declined',
  GHL_AGREEMENT_STATUS_FIELD_ID: 'agreement-field', GHL_PAYMENT_STATUS_FIELD_ID: 'payment-field',
};
const job = { marketId: env.FAME_MARKET_ACCOUNT_ID, seasonId: env.FAME_SEASON_ID, locationId: env.GHL_LOCATION_ID,
  squareEnvironment: 'sandbox', paymentOrderId: 'order-1', applicationId: 'app-1', agreementCompletionId: 'agreement-1',
  contactId: 'contact-1', opportunityId: 'opportunity-1', reservationId: 'reservation-1', reservationRevision: 1,
  squareMerchantId: 'merchant-1', squareLocationId: 'square-location', squareOrderId: 'square-order',
  paymentId: 'payment-1', eventId: 'event-1', attempt: 1, leaseToken: 'lease-1',
  paymentDueAt: '2099-01-01T00:00:00.000Z' };
function fake(options = {}) {
  const calls = []; let contactReads = 0; let written = false;
  const fields = options.fields || [
    { id: env.GHL_AGREEMENT_STATUS_FIELD_ID, fieldValue: options.agreement ?? 'Signed' },
    { id: env.GHL_PAYMENT_STATUS_FIELD_ID, fieldValue: options.payment ?? 'Not Ready' },
    { id: 'unrelated-field', fieldValue: 'preserve me' },
  ];
  const state = { id: job.opportunityId, contactId: job.contactId, locationId: job.locationId,
    pipelineId: env.GHL_QA_APPLICATION_PIPELINE_ID, pipelineStageId: env.GHL_APPLICATION_APPROVED_STAGE_ID,
    status: 'open', customFields: fields, ...options.opportunity };
  const transport = async (url, init) => {
    calls.push({ url: String(url), ...init });
    assert.equal(init.headers.Version, 'v3'); assert.equal(init.redirect, 'error');
    assert.match(String(url), /^https:\/\/services\.leadconnectorhq\.com\/(contacts|opportunities|locations)\//);
    if (String(url).includes('/contacts/')) {
      contactReads++;
      return Response.json({ contact: { id: job.contactId, locationId: job.locationId,
        email: (contactReads > 1 ? options.secondEmail : options.email) ?? 'nate@autocraftstudios.com', ...options.contact } });
    }
    if (String(url).includes('/customFields/')) {
      const agreement = String(url).endsWith('/agreement-field');
      const customField = { id: agreement ? 'agreement-field' : 'payment-field', locationId: job.locationId,
        model: 'opportunity', name: agreement ? 'Vendor Agreement Status' : 'Vendor Payment Status',
        fieldKey: agreement ? 'opportunity.vendor_agreement_status' : 'opportunity.vendor_payment_status', dataType: 'SINGLE_OPTIONS',
        picklistOptions: agreement ? ['Not Sent', 'Sent', 'Signed'] : ['Not Ready', 'Ready for Payment', 'Payment Sent', 'Paid', 'Payment Issue'],
        ...options.metadata };
      return Response.json({ customField });
    }
    assert.equal(String(url).endsWith('/opportunities/opportunity-1'), true);
    if (init.method === 'PUT') {
      if (options.failPut) return new Response('private-provider-body', { status: options.failPut, headers: { 'retry-after': '42' } });
      const update = JSON.parse(init.body);
      // Reviews may move the stage; operational writes may only change customFields.
      if (update.pipelineStageId && options.review) state.pipelineStageId = update.pipelineStageId;
      else {
        assert.deepEqual(Object.keys(update), ['customFields']);
        assert.equal(update.customFields.length, 1);
        for (const value of update.customFields) {
          const index = fields.findIndex(field => field.id === value.id);
          if (index >= 0) fields[index] = value; else fields.push(value);
        }
      }
      written = true;
      return Response.json({ success: true });
    }
    return Response.json({ opportunity: { ...state, ...(written ? options.after : {}) } });
  };
  return { calls, state, transport, puts: () => calls.filter(call => call.method === 'PUT') };
}
function proof(config, payment) {
  return { deliveryContract: 'ghl_opportunity_fields_v1', locationId: job.locationId, contactId: job.contactId,
    opportunityId: job.opportunityId, pipelineId: config.pipelineId,
    fields: [{ fieldId: config.agreementStatusFieldId, fieldValue: 'Signed' }, ...(payment ? [{ fieldId: config.paymentStatusFieldId, fieldValue: payment }] : [])] };
}
module.exports = { env, job, fake, proof };
