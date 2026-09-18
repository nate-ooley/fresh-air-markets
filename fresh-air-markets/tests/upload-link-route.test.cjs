const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const { documentUploadLinkEmail } = require('../.test-build/email-templates.js');

const appId = '11111111-1111-4111-8111-111111111111';
function loadRoute({ session = 'fame-market', notify } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/applications/[id]/upload-link/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/auth') return { getSessionAccountId: async () => session };
    if (id === '@/lib/email') return { emailConfigured: () => true };
    if (id === '@/lib/notifications') return { notifyDocumentUploadLink: notify };
    if (id.startsWith('@/lib/')) return require('../.test-build/' + id.slice(6) + '.js');
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}
function withDb(run) {
  const saved = process.env.DATABASE_URL; process.env.DATABASE_URL = 'postgres://unit-test.invalid/db';
  return run().finally(() => { if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved; });
}
const post = (headers = {}) => new NextRequest(`https://freshairmarketsandevents.com/api/admin/applications/${appId}/upload-link`, { method: 'POST', headers });

test('sending the upload link needs a session, binds the session market, and reports the email outcome', () => withDb(async () => {
  const calls = [];
  const route = loadRoute({ notify: async input => { calls.push(input); return 'sent'; } });
  assert.equal((await loadRoute({ session: null, notify: async () => 'sent' }).POST(post(), { params: Promise.resolve({ id: appId }) })).status, 401);
  assert.equal((await route.POST(post({ 'sec-fetch-site': 'cross-site' }), { params: Promise.resolve({ id: appId }) })).status, 403);
  assert.equal((await route.POST(post(), { params: Promise.resolve({ id: 'nope' }) })).status, 400);
  assert.equal(calls.length, 0);
  const ok = await route.POST(post(), { params: Promise.resolve({ id: appId }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls, [{ applicationId: appId, marketId: 'fame-market' }]);
  assert.equal((await loadRoute({ notify: async () => 'not_found' }).POST(post(), { params: Promise.resolve({ id: appId }) })).status, 404);
  assert.equal((await loadRoute({ notify: async () => 'failed' }).POST(post(), { params: Promise.resolve({ id: appId }) })).status, 502);
}));

test('the upload-link email carries the link and the 14-day note', () => {
  const email = documentUploadLinkEmail({ name: 'Kim Wallace', businessName: 'Coastal Crave Co', link: 'https://freshairmarketsandevents.com/apply/documents#token=a.b' });
  assert.match(email.subject, /Upload your documents/);
  assert.match(email.text, /for Coastal Crave Co: https:\/\/freshairmarketsandevents\.com\/apply\/documents#token=a\.b/);
  assert.match(email.text, /14 days/);
});
