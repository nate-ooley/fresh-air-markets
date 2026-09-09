const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/lib/ghl-payment-email-delivery.ts');
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = module.paths;
mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText, filename);
const { readPaymentEmailDeliveryConfig, preflightPaymentEmail, sendPaymentEmail,
  verifyPaymentEmailReceipt, PaymentEmailDeliveryError } = mod.exports;
const env = {
  GHL_PAYMENT_EMAIL_ENABLED: 'true', VERCEL: '1', VERCEL_ENV: 'preview', SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_ALLOW_LIVE_PAYMENTS: 'false', GHL_PAYMENT_DELIVERY_MODE: 'qa', GHL_PAYMENT_QA_ROUTING_VERIFIED: 'true',
  GHL_API_TOKEN: 'mock-token-at-least-sixteen-characters', FAME_MARKET_ACCOUNT_ID: 'private-market',
  GHL_LOCATION_ID: 'aooAnUXF0COePorBo7wL', GHL_QA_APPLICATION_PIPELINE_ID: 'qa-pipeline',
  GHL_APPLICATION_PIPELINE_ID: 'production-pipeline', GHL_PAYMENT_PENDING_STAGE_ID: 'qa-payment-pending',
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
  pipelineStageId: 'qa-payment-pending', status: 'open', ...patch,
} }); }
const receipt = { messageId: 'message-1', conversationId: 'conversation-1', emailMessageId: 'email-1' };
function email(patch = {}) { return Response.json({
  id: receipt.emailMessageId, threadId: receipt.messageId, conversationId: receipt.conversationId,
  locationId: env.GHL_LOCATION_ID, contactId: 'contact-1', direction: 'outbound', to: ['lnooley@gmail.com'],
  cc: [], bcc: [], subject: '[TEST] Fresh Air Markets payment request — ' + message().id,
  body: '<p>Reference: ' + message().id + '</p>', status: 'delivered', ...patch,
}); }
function script(...responses) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
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
    assert.equal(s.calls.length, 2);
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
