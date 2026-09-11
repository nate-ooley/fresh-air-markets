const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const { createApplicationPrefillToken, verifyApplicationPrefillToken, normalizeApplicationPrefill } = require('../.test-build/application-prefill.js');
const { applicationInvitationEmail } = require('../.test-build/email-templates.js');

const env = { AUTH_SECRET: 'unit-test-secret-that-is-long-enough-1234567890' };
const NOW = Date.parse('2026-09-11T12:00:00Z');
const vendor = { firstName: ' Alyssa ', lastName: 'Botelho', email: 'Alyssa@Example.com', phone: '+18634145874', businessName: 'Top This! By Liam', vendorCategory: 'Baked Goods', fullSeason: false, dates: ['2026-11-14', '2026-10-03', '2026-10-03', 'junk'] };

test('prefill tokens round-trip normalized vendor details, expire after 90 days, and reject tampering', () => {
  const prefill = normalizeApplicationPrefill(vendor, 'fame-market', 'highlevel');
  assert.deepEqual(prefill, { marketId: 'fame-market', firstName: 'Alyssa', lastName: 'Botelho', email: 'alyssa@example.com', phone: '+18634145874', businessName: 'Top This! By Liam', vendorCategory: 'Baked Goods', fullSeason: false, dates: ['2026-10-03', '2026-11-14'], invitedFrom: 'highlevel' });
  assert.equal(normalizeApplicationPrefill({ ...vendor, email: 'nope' }, 'fame-market', 'highlevel'), null);
  const token = createApplicationPrefillToken(prefill, env, NOW);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(verifyApplicationPrefillToken(token, env, NOW + 89 * 86400000), prefill);
  assert.equal(verifyApplicationPrefillToken(token, env, NOW + 91 * 86400000), null);
  const [payload, sig] = token.split('.');
  assert.equal(verifyApplicationPrefillToken(`${payload}x.${sig}`, env, NOW), null);
  assert.equal(verifyApplicationPrefillToken(`${payload}.${sig.slice(1)}a`, env, NOW), null);
  assert.equal(verifyApplicationPrefillToken(token, { AUTH_SECRET: 'another-secret-that-is-long-enough-0987654321' }, NOW), null);
  assert.equal(verifyApplicationPrefillToken(undefined, env, NOW), null);
});

test('the invitation email carries the personal link, the requested dates and the steps to finish', () => {
  const email = applicationInvitationEmail({ name: 'Alyssa Botelho', businessName: 'Top This! By Liam', fullSeason: false, dates: ['2026-10-03'], link: 'https://freshairmarketsandevents.com/apply#prefill=abc.def' });
  assert.match(email.subject, /Finish your .* vendor application/);
  assert.match(email.text, /Saturday, October 3, 2026/);
  assert.match(email.text, /https:\/\/freshairmarketsandevents\.com\/apply#prefill=abc\.def/);
  assert.match(email.text, /sign the vendor agreement/);
  assert.match(applicationInvitationEmail({ name: '', businessName: '', fullSeason: true, dates: [], link: 'https://x.test/apply#prefill=a.b' }).text, /Hi there,[\s\S]*the full season/);
});

function loadRoute(file, stubs) {
  const filename = path.resolve(__dirname, file);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  mod.require = (id) => {
    if (stubs[id]) return stubs[id];
    if (id.startsWith('@/lib/')) return require('../.test-build/' + id.slice(6) + '.js');
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}
function withEnv(patch, run) {
  const saved = { ...process.env };
  Object.assign(process.env, patch);
  return run().finally(() => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); });
}
const portal = { ...env, DATABASE_URL: 'postgres://unit-test.invalid/db', FAME_MARKET_ACCOUNT_ID: 'fame-market', FAME_SEASON_ID: '2026-2027', RESEND_API_KEY: 'k' };
const limiter = { consumeInquiryLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }), inquiryClient: () => 'client' };
const post = (url, body, headers = {}) => new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the public prefill route returns form values for a valid token of this market and nothing else', () => withEnv(portal, async () => {
  const route = loadRoute('../src/app/api/apply/prefill/route.ts', { '@/lib/inquiry-rate-limit': limiter });
  const token = createApplicationPrefillToken(normalizeApplicationPrefill(vendor, 'fame-market', 'highlevel'), process.env);
  const ok = await route.POST(post('https://freshairmarketsandevents.com/api/apply/prefill', { token }));
  assert.equal(ok.status, 200);
  const { prefill } = await ok.json();
  assert.equal(prefill.email, 'alyssa@example.com');
  assert.equal('marketId' in prefill, false);
  assert.equal('invitedFrom' in prefill, false);
  const foreign = createApplicationPrefillToken(normalizeApplicationPrefill(vendor, 'other-market', 'highlevel'), process.env);
  assert.equal((await route.POST(post('https://freshairmarketsandevents.com/api/apply/prefill', { token: foreign }))).status, 410);
  assert.equal((await route.POST(post('https://freshairmarketsandevents.com/api/apply/prefill', { token: 'junk' }))).status, 410);
  assert.equal((await route.POST(post('https://freshairmarketsandevents.com/api/apply/prefill', { token }, { 'sec-fetch-site': 'cross-site' }))).status, 403);
}));

test('the owner invitation route sends one personal link per vendor and reports invalid rows', () => withEnv(portal, async () => {
  const sent = [];
  const stubs = {
    '@/lib/auth': { getSessionStaff: async () => ({ marketId: 'fame-market', userId: 'staff-1', role: 'owner' }) },
    '@/lib/notifications': { portalOrigin: () => 'https://freshairmarketsandevents.com', notifyApplicationInvitation: async input => { sent.push(input); return 'sent'; } },
  };
  const route = loadRoute('../src/app/api/admin/applications/invite/route.ts', stubs);
  const res = await route.POST(post('https://freshairmarketsandevents.com/api/admin/applications/invite', { invitedFrom: 'highlevel', vendors: [vendor, { firstName: 'No', lastName: 'Email' }] }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sent, 1);
  assert.deepEqual(body.results, [{ email: 'alyssa@example.com', outcome: 'sent' }, { email: '', outcome: 'invalid_email' }]);
  assert.match(sent[0].link, /^https:\/\/freshairmarketsandevents\.com\/apply#prefill=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const token = sent[0].link.split('#prefill=')[1];
  assert.equal(verifyApplicationPrefillToken(token, process.env).invitedFrom, 'highlevel');
  assert.deepEqual(sent[0].dates, ['2026-10-03', '2026-11-14']);
  const manager = loadRoute('../src/app/api/admin/applications/invite/route.ts', { ...stubs, '@/lib/auth': { getSessionStaff: async () => ({ marketId: 'fame-market', userId: 'staff-2', role: 'manager' }) } });
  assert.equal((await manager.POST(post('https://freshairmarketsandevents.com/api/admin/applications/invite', { vendors: [vendor] }))).status, 403);
  assert.equal((await route.POST(post('https://freshairmarketsandevents.com/api/admin/applications/invite', { vendors: [] }))).status, 400);
  assert.equal(sent.length, 1);
}));
