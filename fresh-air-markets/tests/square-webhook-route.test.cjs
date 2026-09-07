const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadRoute({ checkout, webhook, handle, persist, qaSupport, qaSigner, qaRollback } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/payments/square/webhook/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/square') return {
      squarePreviewSandboxRuntimeConfig: checkout || (() => ({ environment: 'sandbox', accessToken: 'qa', locationId: 'location' })),
      squareWebhookConfig: webhook || (() => ({ webhookSignatureKey: 'key', webhookUrl: 'https://unit-test.invalid/webhook' })),
    };
    if (id === '@/lib/square-webhook') return { handleSquarePaymentWebhook: handle || (async (_request, _config, write) => {
      await write({ eventId: 'qa-event' });
      return Response.json({ status: 'paid' });
    }) };
    if (id === '@/lib/square-webhook-pg') return { persistSquarePaymentWebhook: persist || (async () => ({ kind: 'paid' })) };
    if (id === '@/lib/square-qa-faults') return {
      QA_SIGNER_HEADER: 'x-fame-square-qa-signer',
      squareQaSupportConfig: qaSupport || (() => null),
      squareQaSignerAuthorization: qaSigner || (() => 'absent'),
      squareQaWebhookRollbackEventId: qaRollback || (() => null),
    };
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}

async function withDatabase(fn) {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://qa/unused';
  try { await fn(); } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
}

test('Square webhook route refuses missing durable storage before reading configuration or a body', async () => {
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    let configCalls = 0;
    const route = loadRoute({ checkout: () => { configCalls++; throw new Error('must not run'); } });
    const response = await route.POST(new Request('https://unit-test.invalid/webhook', { method: 'POST' }));
    assert.equal(response.status, 503);
    assert.equal(configCalls, 0);
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
});

test('Square webhook route passes only the fixed configured identity and persistence callback to the verified raw-body boundary', async () => {
  await withDatabase(async () => {
    let supplied;
    let persisted;
    const route = loadRoute({
      handle: async (_request, config, write) => {
        supplied = config;
        persisted = await write({ eventId: 'qa-event', merchantId: 'qa-merchant' });
        return Response.json({ status: 'paid' });
      },
      persist: async (event, config) => ({ ...event, config }),
    });
    const response = await route.POST(new Request('https://attacker.invalid/', { method: 'POST', body: '{"host":"attacker"}' }));
    assert.equal(response.status, 200);
    assert.deepEqual(supplied, { webhookSignatureKey: 'key', webhookUrl: 'https://unit-test.invalid/webhook' });
    assert.deepEqual(persisted, { eventId: 'qa-event', merchantId: 'qa-merchant', config: { environment: 'sandbox' } });
  });
});

test('Square webhook route blocks production, malformed configuration, and persistence diagnostics', async () => {
  await withDatabase(async () => {
    let calls = 0;
    const production = loadRoute({
      checkout: () => ({ environment: 'production', accessToken: 'qa', locationId: 'location' }),
      handle: async () => { calls++; throw new Error('must not run'); },
    });
    assert.equal((await production.POST(new Request('https://unit-test.invalid/', { method: 'POST' }))).status, 503);
    assert.equal(calls, 0);

    const broken = loadRoute({ checkout: () => { throw new Error('private access token'); } });
    const body = await (await broken.POST(new Request('https://unit-test.invalid/', { method: 'POST' }))).json();
    assert.deepEqual(body, { error: 'Square payment processing is not configured.' });

    let runtimeCalls = 0;
    const previewGateFailure = loadRoute({
      checkout: () => { throw new Error('not Preview'); },
      handle: async () => { runtimeCalls++; return Response.json({ status: 'paid' }); },
    });
    assert.equal((await previewGateFailure.POST(new Request('https://unit-test.invalid/', { method: 'POST' }))).status, 503);
    assert.equal(runtimeCalls, 0);

    const unsafeQaControl = loadRoute({
      qaSupport: () => { throw new Error('QA controls are not permitted here'); },
      handle: async () => { calls++; throw new Error('must not run'); },
    });
    assert.equal((await unsafeQaControl.POST(new Request('https://unit-test.invalid/', { method: 'POST' }))).status, 503);
    assert.equal(calls, 0);
  });
});

test('Square webhook rollback is available only to the configured Preview QA signer', async () => {
  await withDatabase(async () => {
    let writes = 0;
    const denied = loadRoute({
      qaSupport: () => ({ fault: { kind: 'webhook', mode: 'webhook_rollback', eventId: 'qa-event' }, signerSecret: 'private' }),
      qaSigner: () => 'unauthorized',
      handle: async () => { writes++; return Response.json({ status: 'paid' }); },
    });
    const deniedResponse = await denied.POST(new Request('https://unit-test.invalid/webhook', {
      method: 'POST', headers: { 'x-fame-square-qa-signer': 'wrong' }, body: '{}',
    }));
    assert.equal(deniedResponse.status, 401);
    assert.equal(writes, 0);

    let persisted;
    const authorized = loadRoute({
      qaSupport: () => ({ fault: { kind: 'webhook', mode: 'webhook_rollback', eventId: 'qa-event' }, signerSecret: 'private' }),
      qaSigner: () => 'authorized',
      qaRollback: () => 'qa-event',
      handle: async (_request, _config, write) => {
        persisted = await write({ eventId: 'qa-event' });
        return Response.json({ status: 'paid' });
      },
      persist: async (_event, config) => config,
    });
    assert.equal((await authorized.POST(new Request('https://unit-test.invalid/webhook', { method: 'POST', body: '{}' }))).status, 200);
    assert.deepEqual(persisted, { environment: 'sandbox', qaRollbackEventId: 'qa-event' });
  });
});
