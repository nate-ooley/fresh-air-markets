const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
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

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function fixtureFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fame-square-qa-webhook-'));
  const filename = path.join(directory, 'event.json');
  fs.writeFileSync(filename, '{"event_id":"qa-event"}');
  return { directory, filename };
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
  assert.doesNotThrow(() => previewQaSignerSupport({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: 'expiry_429',
    SQUARE_QA_FAULT_PAYMENT_ORDER_ID: 'qa-payment-order-1',
  }));
  assert.throws(() => previewQaSignerSupport({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: 'expiry_429',
    SQUARE_QA_FAULT_PAYMENT_ORDER_ID: 'qa-payment-order-1',
    SQUARE_QA_FAULT_EVENT_ID: 'qa-event-1',
  }));

  let calls = 0;
  await assert.rejects(main({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: 'checkout_429',
    SQUARE_QA_FAULT_RESERVATION_ID: 'qa-reservation-1',
  }, ['--ack-preview-sandbox', '--body-file', '/private/tmp/fame-qa-missing-fixture.json', '--expect', 'paid'], async () => {
    calls++;
    return new Response(null, { status: 200 });
  }));
  assert.equal(calls, 0);
});

test('the local signer sends a separately gated, deliberately invalid HMAC only through its supplied transport and requires the route-owned 401 body', async () => {
  const { main } = await qaScript();
  const fixture = fixtureFile();
  let request;
  try {
    await main({
      ...previewSandbox,
      SQUARE_QA_FAULT_MODE: 'webhook_rollback',
      SQUARE_QA_FAULT_EVENT_ID: 'qa-event',
    }, ['--ack-preview-sandbox', '--body-file', fixture.filename, '--invalid-hmac'], async (url, init) => {
      request = { url, init };
      return response(401, { error: 'Unauthorized.' });
    });
    assert.equal(request.url, previewSandbox.SQUARE_WEBHOOK_URL);
    assert.equal(request.init.headers['x-fame-square-qa-signer'], undefined);
    assert.equal(request.init.redirect, 'error');
    assert.ok(Buffer.isBuffer(request.init.body));
    const valid = createHmac('sha256', previewSandbox.SQUARE_WEBHOOK_SIGNATURE_KEY)
      .update(previewSandbox.SQUARE_WEBHOOK_URL)
      .update(request.init.body)
      .digest('base64');
    assert.notEqual(request.init.headers['x-square-hmacsha256-signature'], valid);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('the webhook QA dispatcher refuses a proxy 401 and requires exact route-owned normal, malformed, and oversized responses', async () => {
  const { assertRouteOwnedResponse, main } = await qaScript();
  await assert.doesNotReject(() => assertRouteOwnedResponse(response(200, { status: 'paid' }), 'paid'));
  await assert.doesNotReject(() => assertRouteOwnedResponse(response(400, { error: 'Invalid Square payment event.' }), 'invalid_event'));
  await assert.doesNotReject(() => assertRouteOwnedResponse(response(413, { error: 'Square webhook is too large.' }), 'oversized'));
  await assert.rejects(
    assertRouteOwnedResponse(new Response('<html>Vercel authentication</html>', { status: 401, headers: { 'content-type': 'text/html' } }), 'invalid_hmac'),
    /route-owned result/,
  );

  await main({ ...previewSandbox, SQUARE_QA_SIGNER_SECRET: signerSecret }, ['--ack-preview-sandbox', '--oversized'], async () => (
    response(413, { error: 'Square webhook is too large.' })
  ));
});

test('the dispatcher tells fetch to reject redirects so a redirected request cannot become a green result', async () => {
  const { main } = await qaScript();
  const fixture = fixtureFile();
  let redirect;
  try {
    await assert.rejects(main(
      previewSandbox,
      ['--ack-preview-sandbox', '--body-file', fixture.filename, '--invalid-hmac'],
      async (_url, init) => {
        redirect = init.redirect;
        if (init.redirect === 'error') throw new TypeError('redirect blocked by fetch');
        return response(401, { error: 'Unauthorized.' });
      },
    ), /QA webhook request failed/);
    assert.equal(redirect, 'error');
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('the webhook QA dispatcher requires an explicit expected result for every signed body and asserts only that route outcome', async () => {
  const { parseArguments, assertRouteOwnedResponse } = await qaScript();
  assert.deepEqual(parseArguments(['--ack-preview-sandbox', '--body-file', '/tmp/fixture.json', '--expect', 'manual-review']), {
    bodyFile: '/tmp/fixture.json', invalidHmac: false, oversized: false, expectation: 'manual_review',
  });
  assert.throws(() => parseArguments(['--ack-preview-sandbox', '--oversized', '--invalid-hmac']));
  assert.throws(() => parseArguments(['--ack-preview-sandbox', '--oversized', '--expect', 'paid']));
  assert.throws(() => parseArguments(['--ack-preview-sandbox', '--body-file', '/tmp/a.json', '--body-file', '/tmp/b.json']));
  assert.throws(() => parseArguments(['--ack-preview-sandbox', '--body-file', '/tmp/fixture.json']));
  await assert.rejects(
    assertRouteOwnedResponse(response(202, { status: 'manual_review' }), 'paid'),
    /route-owned result/,
  );
  for (const [outcome, expected] of Object.entries({
    paid: [200, { status: 'paid' }],
    duplicate: [200, { status: 'duplicate' }],
    ignored: [200, { status: 'ignored' }],
    manual_review: [202, { status: 'manual_review' }],
    rollback: [503, { error: 'Square payment processing is unavailable; retry the same event.' }],
  })) {
    await assert.doesNotReject(() => assertRouteOwnedResponse(response(...expected), outcome));
  }
});

test('only the deliberate rollback case carries the local signer capability', async () => {
  const { main } = await qaScript();
  const fixture = fixtureFile();
  try {
    let rollbackRequest;
    await main({
      ...previewSandbox,
      SQUARE_QA_FAULT_MODE: 'webhook_rollback',
      SQUARE_QA_FAULT_EVENT_ID: 'qa-event',
    }, ['--ack-preview-sandbox', '--body-file', fixture.filename, '--expect', 'rollback'], async (_url, init) => {
      rollbackRequest = init;
      return response(503, { error: 'Square payment processing is unavailable; retry the same event.' });
    });
    assert.equal(rollbackRequest.headers['x-fame-square-qa-signer'], signerSecret);

    fs.writeFileSync(fixture.filename, '{"event_id":"different-qa-event"}');
    let mismatchedCalls = 0;
    await assert.rejects(main(
      {
        ...previewSandbox,
        SQUARE_QA_FAULT_MODE: 'webhook_rollback',
        SQUARE_QA_FAULT_EVENT_ID: 'qa-event',
      },
      ['--ack-preview-sandbox', '--body-file', fixture.filename, '--expect', 'rollback'],
      async () => { mismatchedCalls++; return response(503, { error: 'Square payment processing is unavailable; retry the same event.' }); },
    ));
    assert.equal(mismatchedCalls, 0);

    let calls = 0;
    await assert.rejects(main(
      { ...previewSandbox, SQUARE_QA_SIGNER_SECRET: signerSecret },
      ['--ack-preview-sandbox', '--body-file', fixture.filename, '--expect', 'rollback'],
      async () => { calls++; return response(503, { error: 'Square payment processing is unavailable; retry the same event.' }); },
    ));
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
