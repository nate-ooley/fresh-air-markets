const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const documentId = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';

function loadRoute({ authenticated = true, record } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/documents/[id]/review/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/auth') return { getSessionAccountId: async () => authenticated ? 'qa-market' : null };
    if (id === '@/lib/application-document-pg') return {
      recordApplicationDocumentReview: record || (async () => ({ kind: 'applied', documentId, reviewState: 'approved', reviewEventId: 'event', outboxId: 'outbox' })),
    };
    if (id.startsWith('@/lib/')) return require('../.test-build/' + id.slice(6) + '.js');
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}

function request(body, headers = {}) {
  return new NextRequest('https://unit-test.invalid/', {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

test('document review requires a signed-in market session before parsing or writing', async () => {
  let writes = 0;
  const route = loadRoute({ authenticated: false, record: async () => { writes++; throw new Error('must not run'); } });
  assert.equal((await route.PATCH(request(null), { params: Promise.resolve({ id: documentId }) })).status, 401);
  assert.equal(writes, 0);
});

test('document review binds the route document and session market instead of client-supplied application or storage fields', async () => {
  let received;
  const route = loadRoute({ record: async input => {
    received = input;
    return { kind: 'applied', documentId, reviewState: 'approved', reviewEventId: 'event', outboxId: 'outbox' };
  } });
  const response = await route.PATCH(request({
    expectedVersion: 1, action: 'approve', applicationId: 'attacker-app', marketId: 'attacker-market', storageKey: 'documents/attacker/file.pdf',
  }, { 'Idempotency-Key': key }), { params: Promise.resolve({ id: documentId }) });
  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    documentId, marketId: 'qa-market', actorAccountId: 'qa-market', expectedVersion: 1, action: 'approve', reason: '', idempotencyKey: key,
  });
});

test('document review rejects malformed paths, replay keys, and reasons before persistence', async () => {
  let writes = 0;
  const route = loadRoute({ record: async () => { writes++; throw new Error('must not run'); } });
  for (const [id, body, header] of [
    ['not-a-document', { expectedVersion: 1, action: 'approve' }, key],
    [documentId, { expectedVersion: 1, action: 'approve' }, 'bad'],
    [documentId, { expectedVersion: 1, action: 'request_changes', reason: ' ' }, key],
  ]) {
    assert.equal((await route.PATCH(request(body, { 'Idempotency-Key': header }), { params: Promise.resolve({ id }) })).status, 400);
  }
  assert.equal(writes, 0);
});

test('document review gives validation, stale version, terminal and idempotent results safe HTTP outcomes', async () => {
  const cases = [
    [{ kind: 'awaiting_validation', validationState: 'pending_scan' }, 'Document must pass validation before review.'],
    [{ kind: 'stale', currentVersion: 2, isCurrent: true }, 'Document changed; reload before reviewing.'],
    [{ kind: 'terminal', reviewState: 'approved' }, 'Document is already approved.'],
    [{ kind: 'conflict' }, 'This review key was already used for different content.'],
  ];
  for (const [result, message] of cases) {
    const route = loadRoute({ record: async () => result });
    const response = await route.PATCH(request({ expectedVersion: 1, action: 'approve' }, { 'Idempotency-Key': key }), { params: Promise.resolve({ id: documentId }) });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: message });
  }
});
