const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const fixture = {
  id: '11111111-1111-4111-8111-111111111111',
  sourceEventId: 'application:qa:current',
  reviewState: 'needs_review',
  reviewRevision: 0,
  hasOpportunity: true,
  identitySnapshot: {
    vendorName: 'QA Vendor',
    businessName: 'QA Booth',
    email: 'nate@autocraftstudios.com',
    applicantType: 'Vendor',
    dates: ['2027-05-29'],
    fullSeason: false,
    requiresFinalDateConfirmation: false,
    category: 'Produce',
    details: 'QA only',
  },
};

function loadRoute({ authenticated = true, list } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/applications/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/auth') return { getSessionAccountId: async () => authenticated ? 'qa-market' : null };
    if (id === '@/lib/application-review-pg') return { listApplicationReviewDetails: list || (async () => [fixture]) };
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}

test('application review list requires a session before reading any market data', async () => {
  let calls = 0;
  const route = loadRoute({ authenticated: false, list: async () => { calls++; throw new Error('must not run'); } });
  const response = await route.GET();
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('application review list binds its read to the signed-in market and a bounded limit', async () => {
  let input;
  const route = loadRoute({ list: async (...args) => { input = args; return [fixture]; } });
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(input, ['qa-market', 50]);
  assert.deepEqual(await response.json(), { applications: [fixture] });
});

test('application review list returns an empty scoped result and hides storage failures', async () => {
  const empty = await loadRoute({ list: async () => [] }).GET();
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { applications: [] });

  const failed = await loadRoute({ list: async () => { throw new Error('private database detail'); } }).GET();
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'Application reviews are unavailable.' });
});
