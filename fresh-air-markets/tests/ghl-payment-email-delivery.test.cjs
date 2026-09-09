const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPaymentEmailDeliveryConfig, preflightPaymentEmail, sendPaymentEmail,
  verifyPaymentEmailReceipt, deliverPaymentEmailSentToGhl, PaymentEmailDeliveryError } = require('../.test-build/ghl-payment-email-delivery.js');
const env = {
  GHL_PAYMENT_EMAIL_ENABLED: 'true', VERCEL: '1', VERCEL_ENV: 'preview', SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_ALLOW_LIVE_PAYMENTS: 'false', GHL_PAYMENT_DELIVERY_MODE: 'qa', GHL_PAYMENT_QA_ROUTING_VERIFIED: 'true',
  GHL_API_TOKEN: 'mock-token-at-least-sixteen-characters', FAME_MARKET_ACCOUNT_ID: 'private-market',
  GHL_LOCATION_ID: 'aooAnUXF0COePorBo7wL', GHL_QA_APPLICATION_PIPELINE_ID: 'qa-pipeline',
  GHL_APPLICATION_PIPELINE_ID: 'production-pipeline', GHL_APPLICATION_APPROVED_STAGE_ID: 'qa-approved',
  GHL_AGREEMENT_STATUS_FIELD_ID: 'agreement-status', GHL_PAYMENT_STATUS_FIELD_ID: 'payment-status',
  GHL_PAYMENT_EMAIL_FROM: 'nate@autocraftstudios.com', FAME_VENDOR_PORTAL_ORIGIN: 'https://qa-farmers-market.vercel.app',
};
const config = readPaymentEmailDeliveryConfig(env);
const now = new Date('2026-09-09T12:00:00.000Z');
function message(patch = {}) { return {
  id: '11111111-1111-4111-8111-111111111111', marketId: 'private-market', applicationId: 'application-1',
  reservationId: 'reservation-1', revision: 1, contactId: 'contact-1', locationId: env.GHL_LOCATION_ID,
  opportunityId: 'opportunity-1', recipientEmail: 'lnooley@gmail.com',
  invitationUrl: env.FAME_VENDOR_PORTAL_ORIGIN + '/vendor/payment#token=' + Buffer.alloc(32, 4).toString('base64url'),
  totalCents: 4000, paymentDueAt: '2026-09-11T12:00:00.000Z', ...patch,
}; }
function contact(patch = {}) { return Response.json({ contact: {
  id: 'contact-1', locationId: env.GHL_LOCATION_ID, email: 'lnooley@gmail.com', ...patch,
} }); }
function opportunity(patch = {}) { return Response.json({ opportunity: {
  id: 'opportunity-1', contactId: 'contact-1', locationId: env.GHL_LOCATION_ID, pipelineId: 'qa-pipeline',
  pipelineStageId: 'qa-approved', status: 'open', customFields: [{ id: 'agreement-status', fieldValue: 'Signed' }, { id: 'payment-status', fieldValue: 'Ready for Payment' }], ...patch,
} }); }
const receipt = { messageId: 'message-1', conversationId: 'conversation-1', emailMessageId: 'email-1' };
function email(patch = {}) { return Response.json({
  id: receipt.emailMessageId, threadId: receipt.messageId, conversationId: receipt.conversationId,
  locationId: env.GHL_LOCATION_ID, contactId: 'contact-1', direction: 'outbound', to: ['lnooley@gmail.com'],
  cc: [], bcc: [], subject: '[TEST] Fresh Air Markets payment request — ' + message().id,
  body: '<p>Reference: ' + message().id + '</p>', status: 'delivered', ...patch,
}); }
function metadata(fieldId, patch = {}) { return Response.json({ customField: { id: fieldId, locationId: env.GHL_LOCATION_ID, model: 'opportunity', dataType: 'SINGLE_OPTIONS',
  fieldKey: 'opportunity.' + fieldId.replaceAll('-', '_'), name: fieldId === 'agreement-status' ? 'Vendor Agreement Status' : 'Vendor Payment Status',
  picklistOptions: fieldId === 'agreement-status' ? ['Not Sent', 'Sent', 'Signed'] : ['Not Ready', 'Ready for Payment', 'Payment Sent', 'Paid', 'Payment Issue'], ...patch } }); }
function script(...responses) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/customFields/')) return metadata(url.endsWith('/agreement-status') ? 'agreement-status' : 'payment-status');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, 'Unexpected provider call');
    return next;
  };
  return { calls, transport };
}
function rejectsCode(fn, code) { return assert.rejects(fn, error => error instanceof PaymentEmailDeliveryError && error.code === code); }

test('email delivery is disabled by default and requires the exact Preview and QA routing fences', () => {
  for (const patch of [
    { GHL_PAYMENT_EMAIL_ENABLED: undefined }, { VERCEL: undefined }, { VERCEL_ENV: 'production' },
    { SQUARE_ENVIRONMENT: 'production' }, { SQUARE_ALLOW_LIVE_PAYMENTS: 'true' },
    { GHL_PAYMENT_DELIVERY_MODE: 'production' }, { GHL_PAYMENT_QA_ROUTING_VERIFIED: undefined },
    { GHL_LOCATION_ID: 'wrong-subaccount' }, { FAME_MARKET_ACCOUNT_ID: 'demo-market' },
    { GHL_QA_APPLICATION_PIPELINE_ID: 'production-pipeline' }, { GHL_APPLICATION_PIPELINE_ID: undefined },
    { FAME_VENDOR_PORTAL_ORIGIN: 'https://evil.invalid' }, { FAME_VENDOR_PORTAL_ORIGIN: 'https://qa.vercel.app/path' },
    { FAME_VENDOR_PORTAL_ORIGIN: 'https://qa.vercel.app:8443' },
  ]) assert.throws(() => readPaymentEmailDeliveryConfig({ ...env, ...patch }), PaymentEmailDeliveryError);
});

test('production requires explicit production flags, the Fresh Air domain and no residual QA configuration', () => {
  const production = { ...env, VERCEL_ENV: 'production', SQUARE_ENVIRONMENT: 'production', SQUARE_ALLOW_LIVE_PAYMENTS: 'true',
    GHL_PAYMENT_DELIVERY_MODE: 'production', GHL_PAYMENT_QA_ROUTING_VERIFIED: undefined, GHL_QA_APPLICATION_PIPELINE_ID: undefined,
    FAME_VENDOR_PORTAL_ORIGIN: 'https://freshairmarketsandevents.com' };
  assert.equal(readPaymentEmailDeliveryConfig(production).pipelineId, 'production-pipeline');
  for (const patch of [{ SQUARE_QA_TEST: 'true' }, { GHL_PAYMENT_QA_ROUTING_VERIFIED: 'false' },
    { GHL_QA_APPLICATION_PIPELINE_ID: 'qa' }, { SQUARE_ALLOW_LIVE_PAYMENTS: 'false' },
    { FAME_VENDOR_PORTAL_ORIGIN: 'https://other.example' }]) {
    assert.throws(() => readPaymentEmailDeliveryConfig({ ...production, ...patch }), PaymentEmailDeliveryError);
  }
});

test('sender config accepts only a single valid mailbox and rejects header injection or display-name lists', () => {
  for (const sender of ['Name <nate@autocraftstudios.com>', 'nate@autocraftstudios.com,bad@example.com',
    'nate@autocraftstudios.com\r\nBcc: bad@example.com', ' nate@autocraftstudios.com', 'a..b@example.com']) {
    assert.throws(() => readPaymentEmailDeliveryConfig({ ...env, GHL_PAYMENT_EMAIL_FROM: sender }), PaymentEmailDeliveryError);
  }
  assert.throws(() => readPaymentEmailDeliveryConfig({ ...env, GHL_API_TOKEN: 'abcdefghijklmnop\r\nInjected: yes' }), PaymentEmailDeliveryError);
});

test('preflight reads only the exact contact and opportunity with v3 and cannot mutate CRM', async () => {
  const s = script(contact(), opportunity());
  await preflightPaymentEmail(message(), config, s.transport, now);
  assert.deepEqual(s.calls.map(call => call.url), [
    'https://services.leadconnectorhq.com/contacts/contact-1',
    'https://services.leadconnectorhq.com/locations/' + env.GHL_LOCATION_ID + '/customFields/agreement-status',
    'https://services.leadconnectorhq.com/locations/' + env.GHL_LOCATION_ID + '/customFields/payment-status',
    'https://services.leadconnectorhq.com/opportunities/opportunity-1',
  ]);
  for (const call of s.calls) {
    assert.equal(call.init.method, 'GET'); assert.equal(call.init.body, undefined);
    assert.equal(call.init.headers.Version, 'v3'); assert.equal(call.init.redirect, 'error');
  }
});

test('Preview rejects live recipient, switched market, forged link and expired deadline before any request', async () => {
  for (const [patch, code] of [
    [{ recipientEmail: 'thomas@example.com' }, 'payment_email_recipient_blocked'],
    [{ recipientEmail: 'lnooley+qa@gmail.com' }, 'payment_email_recipient_blocked'],
    [{ marketId: 'other-market' }, 'payment_email_message_invalid'],
    [{ locationId: 'other-location' }, 'payment_email_message_invalid'],
    [{ totalCents: 1.5 }, 'payment_email_message_invalid'],
    [{ invitationUrl: message().invitationUrl.replace('qa-farmers-market.vercel.app', 'attacker.invalid') }, 'payment_email_link_invalid'],
    [{ invitationUrl: message().invitationUrl.replace('/vendor/payment#', '/vendor/payment?leak=true#') }, 'payment_email_link_invalid'],
    [{ invitationUrl: message().invitationUrl.replace('#token=', '#other=') }, 'payment_email_link_invalid'],
    [{ paymentDueAt: now.toISOString() }, 'payment_email_deadline_invalid'],
  ]) {
    const s = script(); await rejectsCode(() => preflightPaymentEmail(message(patch), config, s.transport, now), code);
    assert.equal(s.calls.length, 0);
  }
});

test('current CRM contact email and location must match before opportunity access or sending', async () => {
  for (const patch of [{ id: 'other' }, { email: 'nate@autocraftstudios.com' }, { email: 'live@example.com' },
    { locationId: 'other' }, { locationId: undefined }]) {
    const s = script(contact(patch));
    await rejectsCode(() => preflightPaymentEmail(message(), config, s.transport, now), 'payment_email_contact_mismatch');
    assert.equal(s.calls.length, 1);
  }
  const s = script(contact({ email: 'NATE@AUTOCRAFTSTUDIOS.COM' }), opportunity());
  await preflightPaymentEmail(message({ recipientEmail: 'nate@autocraftstudios.com' }), config, s.transport, now);
});

test('wrong opportunity identity, pipeline, closed state or stage prevents email eligibility', async () => {
  for (const patch of [{ id: 'other' }, { contactId: 'other' }, { locationId: 'other' },
    { locationId: undefined }, { pipelineId: 'production-pipeline' }]) {
    const s = script(contact(), opportunity(patch));
    await rejectsCode(() => preflightPaymentEmail(message(), config, s.transport, now), 'payment_email_opportunity_mismatch');
    assert.equal(s.calls.length, 4);
  }
  for (const patch of [{ status: 'won' }, { status: 'lost' }, { pipelineStageId: 'paid-stage' }]) {
    const s = script(contact(), opportunity(patch));
    await rejectsCode(() => preflightPaymentEmail(message(), config, s.transport, now), 'payment_email_stage_diverged');
  }
});

test('preflight failures expose safe retry classification without provider secrets', async () => {
  for (const [response, retryable] of [[new Error('secret token'), true], [new Response('private body', { status: 429 }), true],
    [new Response('private body', { status: 403 }), false], [new Response('secret', { status: 200 }), true]]) {
    const s = script(response);
    await assert.rejects(() => preflightPaymentEmail(message(), config, s.transport, now), error => {
      assert.equal(error.retryable, retryable); assert.doesNotMatch(error.message, /secret|token|private body/); return true;
    });
  }
});

test('one send uses only explicit Email routing and returns acceptance rather than delivered', async () => {
  const s = script(Response.json(receipt));
  const result = await sendPaymentEmail(message(), config, s.transport, now);
  assert.deepEqual(result, { kind: 'accepted', ...receipt });
  assert.equal(s.calls.length, 1);
  const call = s.calls[0]; const body = JSON.parse(call.init.body);
  assert.equal(call.url, 'https://services.leadconnectorhq.com/conversations/messages');
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'error');
  assert.equal(body.type, 'Email'); assert.equal(body.emailTo, 'lnooley@gmail.com');
  assert.equal(body.emailFrom, 'nate@autocraftstudios.com'); assert.equal(body.contactId, 'contact-1');
  assert.equal(body.status, 'pending'); assert.match(body.subject, /^\[TEST\]/);
  assert.ok(body.html.includes(message().invitationUrl)); assert.ok(body.message.includes('$40.00'));
  assert.ok(body.message.includes('48 hours')); assert.ok(body.message.includes('Reference: ' + message().id));
  assert.deepEqual(Object.keys(body).sort(), ['type', 'contactId', 'emailTo', 'emailFrom', 'status', 'subject', 'html', 'message'].sort());
});

test('POST timeout, any rejected HTTP status and malformed success never trigger an automatic resend', async () => {
  for (const response of [new Error('private timeout'), new Response('secret body', { status: 429 }),
    new Response('secret body', { status: 500 }), new Response('secret body', { status: 403 }),
    Response.json({ messageId: 'only-main-id' }), new Response('not-json', { status: 200 })]) {
    const s = script(response);
    const result = await sendPaymentEmail(message(), config, s.transport, now);
    assert.equal(result.kind, 'uncertain'); assert.equal(s.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret|timeout|token/);
  }
});

test('send independently rejects an invalid deadline or live recipient before POST', async () => {
  for (const patch of [{ paymentDueAt: now.toISOString() }, { recipientEmail: 'live@example.com' }]) {
    const s = script(); await assert.rejects(() => sendPaymentEmail(message(patch), config, s.transport, now), PaymentEmailDeliveryError);
    assert.equal(s.calls.length, 0);
  }
});

test('receipt verification requires no invitation secret and preserves distinct provider statuses', async () => {
  const context = { id: message().id, marketId: message().marketId, locationId: message().locationId,
    contactId: message().contactId, recipientEmail: message().recipientEmail };
  for (const status of ['pending', 'sent', 'delivered', 'opened', 'read', 'failed', 'undelivered']) {
    const s = script(email({ status }));
    assert.deepEqual(await verifyPaymentEmailReceipt(context, receipt, config, s.transport), { kind: 'verified', status, ...receipt });
    assert.equal(s.calls[0].url, 'https://services.leadconnectorhq.com/conversations/messages/email/email-1');
    assert.equal(s.calls[0].init.method, 'GET'); assert.equal(s.calls.length, 1);
  }
});

test('receipt mismatch, copies, wrong actual recipient or unknown status cannot claim email delivery', async () => {
  for (const patch of [{ id: 'other' }, { threadId: 'other' }, { conversationId: 'other' }, { locationId: 'other' },
    { contactId: 'other' }, { direction: 'inbound' }, { to: ['nate@autocraftstudios.com'] }, { to: ['lnooley@gmail.com', 'live@example.com'] },
    { cc: ['live@example.com'] }, { bcc: ['live@example.com'] }, { subject: 'wrong' }, { body: 'missing reference' },
    { status: 'scheduled' }]) {
    const s = script(email(patch));
    assert.equal((await verifyPaymentEmailReceipt(message(), receipt, config, s.transport)).kind, 'unavailable');
    assert.equal(s.calls.length, 1);
  }
});

test('lost provider IDs remain unavailable with no search heuristics or resend', async () => {
  const s = script();
  assert.deepEqual(await verifyPaymentEmailReceipt(message(), { ...receipt, emailMessageId: '' }, config, s.transport),
    { kind: 'unavailable', code: 'payment_email_receipt_missing' });
  assert.equal(s.calls.length, 0);
  const failed = script(new Error('private failure'));
  assert.equal((await verifyPaymentEmailReceipt(message(), receipt, config, failed.transport)).kind, 'unavailable');
  assert.equal(failed.calls.length, 1);
});

test('email preflight requires native opportunity Signed and Ready for Payment fields while staying Approved/Open', async () => {
  for (const customFields of [[], [{ id: 'agreement-status', fieldValue: 'Sent' }, { id: 'payment-status', fieldValue: 'Ready for Payment' }],
    [{ id: 'agreement-status', fieldValue: 'Signed' }, { id: 'payment-status', fieldValue: 'Paid' }],
    [{ id: 'agreement-status', fieldValue: 'Signed' }, { id: 'payment-status', fieldValue: 'Payment Sent' }]]) {
    const mock = script(contact(), opportunity({ customFields }));
    await rejectsCode(() => preflightPaymentEmail(message(), config, mock.transport, now), 'payment_email_status_diverged');
    assert.equal(mock.calls.some(c => c.init.method !== 'GET'), false);
  }
  for (const customFields of [[{ id: 'agreement-status', fieldValue: 'Signed' }, { id: 'agreement-status', fieldValue: 'Signed' }],
    [{ id: 'agreement-status', fieldValue: ['Signed'] }]]) {
    await rejectsCode(() => preflightPaymentEmail(message(), config, script(contact(), opportunity({ customFields })).transport, now), 'payment_email_field_mapping_invalid');
  }
});

test('email metadata must identify the exact native Opportunity dropdowns and required options', async () => {
  for (const patch of [{ model: 'contact' }, { name: 'Other field' }, { fieldKey: 'contact.vendor_payment_status' }, { dataType: 'TEXT' },
    { picklistOptions: ['Signed'] }, { locationId: 'another-location' }]) {
    await rejectsCode(() => preflightPaymentEmail(message(), config, async url => url.includes('/contacts/') ? contact() : metadata('agreement-status', patch), now), 'payment_email_field_mapping_invalid');
  }
  for (const patch of [{ GHL_APPLICATION_APPROVED_STAGE_ID: undefined }, { GHL_PAYMENT_STATUS_FIELD_ID: undefined },
    { GHL_AGREEMENT_STATUS_FIELD_ID: 'payment-status' }]) assert.throws(() => readPaymentEmailDeliveryConfig({ ...env, ...patch }), PaymentEmailDeliveryError);
});

const sentEvidence = { kind: 'verified', status: 'sent', ...receipt };
function withPayment(value) { return opportunity({ customFields: [{ id: 'agreement-status', fieldValue: 'Signed' }, { id: 'payment-status', fieldValue: value }] }); }
test('Payment Sent is a field-only write after provider sent proof and verified field readback', async () => {
  const mock = script(contact(), opportunity(), contact(), Response.json({}), withPayment('Payment Sent'));
  const proof = await deliverPaymentEmailSentToGhl(message(), sentEvidence, config, mock.transport);
  const put = mock.calls.filter(c => c.init.method === 'PUT');
  assert.equal(put.length, 1); assert.deepEqual(JSON.parse(put[0].init.body), { customFields: [{ id: 'payment-status', fieldValue: 'Payment Sent' }] });
  assert.equal(mock.calls.some(c => c.init.method === 'POST'), false);
  assert.equal(proof.deliveryContract, 'ghl_opportunity_fields_v1');
  assert.deepEqual(proof.fields, [{ fieldId: 'agreement-status', fieldValue: 'Signed' }, { fieldId: 'payment-status', fieldValue: 'Payment Sent' }]);
});
test('accepted or pending email is not Sent proof; existing Payment Sent and Paid never regress or duplicate writes', async () => {
  for (const evidence of [{ kind: 'unavailable', code: 'unknown' }, { ...sentEvidence, status: 'pending' }, { ...sentEvidence, status: 'failed' }]) {
    const mock = script(); await rejectsCode(() => deliverPaymentEmailSentToGhl(message(), evidence, config, mock.transport), 'payment_email_sent_evidence_invalid');
    assert.equal(mock.calls.length, 0);
  }
  for (const value of ['Payment Sent', 'Paid']) {
    const mock = script(contact(), withPayment(value)); const proof = await deliverPaymentEmailSentToGhl(message(), sentEvidence, config, mock.transport);
    assert.equal(mock.calls.some(c => c.init.method !== 'GET'), false);
    assert.equal(proof.fields[1].fieldValue, value);
  }
});
test('Payment Sent mapping or provider write failure preserves a bounded error and performs no email resend', async () => {
  for (const response of [new Response('', { status: 503 }), new Error('private provider body')]) {
    const mock = script(contact(), opportunity(), contact(), response);
    await assert.rejects(deliverPaymentEmailSentToGhl(message(), sentEvidence, config, mock.transport), e => e instanceof PaymentEmailDeliveryError && e.retryable === true);
    assert.equal(mock.calls.filter(c => c.init.method === 'PUT').length, 1);
    assert.equal(mock.calls.filter(c => c.init.method === 'POST').length, 0);
  }
});
