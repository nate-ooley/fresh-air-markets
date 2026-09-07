const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const scriptUrl = pathToFileURL(path.resolve(__dirname, '../scripts/square-qa-webhook.mjs')).href;
const signerSecret = 'qa-preview-signer-secret-at-least-32-bytes';
const previewSandbox = {
  VERCEL: '1',
  VERCEL_ENV: 'preview',
  SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_ALLOW_LIVE_PAYMENTS: 'false',
  SQUARE_QA_SIGNER_SECRET: signerSecret,
  SQUARE_WEBHOOK_SIGNATURE_KEY: 'qa-webhook-signature-key',
  SQUARE_WEBHOOK_URL: 'https://preview.example.invalid/api/payments/square/webhook',
};

async function qaScript() {
  return import(scriptUrl);
}

test('the local QA signer refuses every non-Preview, non-Sandbox, or live-enabled environment', async () => {
  const { previewQaSignerSupport } = await qaScript();
  for (const environment of [
    { ...previewSandbox, VERCEL: '' },
    { ...previewSandbox, VERCEL_ENV: 'production' },
    { ...previewSandbox, SQUARE_ENVIRONMENT: 'production' },
    { ...previewSandbox, SQUARE_ALLOW_LIVE_PAYMENTS: 'true' },
    { ...previewSandbox, SQUARE_QA_SIGNER_SECRET: 'short' },
  ]) {
    assert.throws(() => previewQaSignerSupport(environment));
  }
});

test('the local QA signer mirrors target validation and reads no fixture before its Preview gate passes', async () => {
  const { main, previewQaSignerSupport } = await qaScript();
  assert.throws(() => previewQaSignerSupport({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: 'webhook_rollback',
    SQUARE_QA_FAULT_EVENT_ID: 'event-1',
    SQUARE_QA_FAULT_RESERVATION_ID: 'reservation-1',
  }));

  let calls = 0;
  await assert.rejects(main({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: 'checkout_429',
    SQUARE_QA_FAULT_RESERVATION_ID: 'qa-reservation-1',
  }, ['--ack-preview-sandbox', '--body-file', '/private/tmp/fame-qa-missing-fixture.json'], async () => {
    calls++;
    return new Response(null, { status: 200 });
  }));
  assert.equal(calls, 0);
});

test('the local signer sends a separately gated, deliberately invalid HMAC only through its supplied transport', async () => {
  const { main } = await qaScript();
  let request;
  await main({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: 'webhook_rollback',
    SQUARE_QA_FAULT_EVENT_ID: 'qa-event',
  }, ['--ack-preview-sandbox', '--oversized', '--invalid-hmac'], async (url, init) => {
    request = { url, init };
    return new Response(null, { status: 401 });
  });
  assert.equal(request.url, previewSandbox.SQUARE_WEBHOOK_URL);
  assert.equal(request.init.headers['x-fame-square-qa-signer'], signerSecret);
  assert.ok(Buffer.isBuffer(request.init.body));
  assert.equal(request.init.body.byteLength, 128 * 1024 + 1);
  const valid = createHmac('sha256', previewSandbox.SQUARE_WEBHOOK_SIGNATURE_KEY)
    .update(previewSandbox.SQUARE_WEBHOOK_URL)
    .update(request.init.body)
    .digest('base64');
  assert.notEqual(request.init.headers['x-square-hmacsha256-signature'], valid);
});
