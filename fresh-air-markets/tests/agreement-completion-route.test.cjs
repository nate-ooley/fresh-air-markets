const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const event = {
  eventId: 'qa-complete-event', documentId: 'qa-document', templateId: 'qa-template',
  contactId: 'qa-contact', opportunityId: 'qa-opportunity', locationId: 'qa-location',
  marketId: 'qa-market', seasonId: '2026-2027', notificationEmail: 'nate@autocraftstudios.com',
  status: 'completed', payloadHash: 'qa-hash',
};

function loadRoute({ configured = false, persist, dispatch, deliver } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/integrations/highlevel/agreements/completed/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/agreement-completion') {
      return {
        handleAgreementCompleted: async (_request, _config, write) => {
          const result = await write(event);
          return new Response(JSON.stringify({ status: result }), { status: result === 'captured' ? 201 : 200 });
        },
      };
    }
    if (id === '@/lib/agreement-completion-pg') return {
      persistAgreementCompletionWithStageOutbox: persist || (async () => ({ outcome: 'captured', stageOutboxId: 'qa-stage-outbox' })),
      dispatchAgreementStageOutboxById: dispatch || (async () => ({ delivered: 1, deferred: 0, stale: 0 })),
    };
    if (id === '@/lib/ghl-agreement-completion-delivery') return {
      agreementStageDeliveryConfigured: () => configured,
      readAgreementStageDeliveryConfig: () => ({ pipelineId: 'qa-pipeline', agreementStatusFieldId: 'agreement-status' }),
      deliverAgreementStageToGhl: deliver || (async () => {}),
    };
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}

async function withDatabase(fn) {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://qa/unused';
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
}

test('agreement completion route refuses a missing durable store before the webhook handler runs', async () => {
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const route = loadRoute({ persist: async () => { throw new Error('must not run'); } });
    const response = await route.POST(new Request('https://unit-test.invalid/', { method: 'POST' }));
    assert.equal(response.status, 503);
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
});

test('captured completion immediately dispatches only its returned stage outbox ID when delivery is configured', async () => {
  await withDatabase(async () => {
    let persisted;
    let dispatched;
    let delivered = 0;
    const route = loadRoute({
      configured: true,
      persist: async value => {
        persisted = value;
        return { outcome: 'captured', stageOutboxId: 'qa-stage-outbox' };
      },
      dispatch: async (id, callback, options) => {
        dispatched = { id, options };
        await callback({ id: 'qa-stage-outbox' });
        return { delivered: 1, deferred: 0, stale: 0 };
      },
      deliver: async () => { delivered++; },
    });
    const response = await route.POST(new Request('https://unit-test.invalid/', { method: 'POST' }));
    assert.equal(response.status, 201);
    assert.equal(persisted.opportunityId, event.opportunityId);
    assert.deepEqual(dispatched, { id: 'qa-stage-outbox', options: {
      fieldScope: { pipelineId: 'qa-pipeline', agreementStatusFieldId: 'agreement-status' }, leaseSeconds: 60,
    } });
    assert.equal(delivered, 1);
  });
});

test('duplicate, unconfigured, or failed immediate delivery preserves the accepted completion response', async () => {
  await withDatabase(async () => {
    let dispatches = 0;
    const duplicate = loadRoute({
      configured: true,
      persist: async () => ({ outcome: 'duplicate' }),
      dispatch: async () => { dispatches++; },
    });
    assert.equal((await duplicate.POST(new Request('https://unit-test.invalid/', { method: 'POST' }))).status, 200);

    const unconfigured = loadRoute({
      configured: false,
      persist: async () => ({ outcome: 'captured', stageOutboxId: 'qa-stage-outbox' }),
      dispatch: async () => { dispatches++; },
    });
    assert.equal((await unconfigured.POST(new Request('https://unit-test.invalid/', { method: 'POST' }))).status, 201);

    const failing = loadRoute({
      configured: true,
      persist: async () => ({ outcome: 'captured', stageOutboxId: 'qa-stage-outbox' }),
      dispatch: async () => { dispatches++; throw new Error('provider unavailable'); },
    });
    assert.equal((await failing.POST(new Request('https://unit-test.invalid/', { method: 'POST' }))).status, 201);
    assert.equal(dispatches, 1);
  });
});
