const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const TOKEN = 'A'.repeat(43);

function loadRoute(name, stubs) {
  const filename = path.resolve(__dirname, `../src/app/api/auth/${name}/route.ts`);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => {
    if (stubs[id]) return stubs[id];
    if (id.startsWith('@/lib/')) return require('../.test-build/' + id.slice(6) + '.js');
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}

function request(body, headers = {}) {
  return new NextRequest('https://unit-test.invalid/api/auth/x', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function withEnv(patch, run) {
  const saved = { ...process.env };
  Object.assign(process.env, patch);
  for (const key of Object.keys(patch)) if (patch[key] === undefined) delete process.env[key];
  return run().finally(() => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); });
}

const configured = { DATABASE_URL: 'postgres://unit-test.invalid/db', RESEND_API_KEY: 'k', NODE_ENV: 'test' };
const limiterAllow = { consumeInquiryLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }), inquiryClient: () => 'client' };

test('forgot-password answers identically for known and unknown emails and only emails real accounts', () => withEnv(configured, async () => {
  const sent = [];
  const route = loadRoute('forgot-password', {
    '@/lib/inquiry-rate-limit': limiterAllow,
    '@/lib/password-reset': { PASSWORD_RESET_TTL_MINUTES: 30, requestPasswordReset: async email => email === 'staff@example.com'
      ? { accountId: 'fame-market', email, ownerName: 'Thomas', token: TOKEN, expiresAt: '2026-09-11T00:30:00.000Z' } : null },
    '@/lib/notifications': { portalOrigin: () => 'https://freshairmarketsandevents.com', notifyPasswordReset: async input => { sent.push(input); return 'sent'; } },
  });
  const known = await route.POST(request({ email: 'Staff@Example.com ' }));
  const unknown = await route.POST(request({ email: 'nobody@example.com' }));
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(await known.json(), await unknown.json());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].email, 'staff@example.com');
  assert.equal(sent[0].link, `https://freshairmarketsandevents.com/reset-password#token=${TOKEN}`);
  assert.equal(sent[0].minutes, 30);
}));

test('forgot-password validates input, enforces the limiter, and refuses when email or storage is unconfigured', async () => {
  let requests = 0;
  const stubs = {
    '@/lib/inquiry-rate-limit': limiterAllow,
    '@/lib/password-reset': { PASSWORD_RESET_TTL_MINUTES: 30, requestPasswordReset: async () => { requests++; return null; } },
    '@/lib/notifications': { portalOrigin: () => 'https://x.test', notifyPasswordReset: async () => 'sent' },
  };
  await withEnv(configured, async () => {
    const route = loadRoute('forgot-password', stubs);
    assert.equal((await route.POST(request('null'))).status, 400);
    assert.equal((await route.POST(request({ email: 'not-an-email' }))).status, 400);
    assert.equal((await route.POST(request({ email: 'a@b.co' }, { 'sec-fetch-site': 'cross-site' }))).status, 403);
    assert.equal(requests, 0);
    const limited = loadRoute('forgot-password', { ...stubs, '@/lib/inquiry-rate-limit': { inquiryClient: () => 'c', consumeInquiryLimit: async () => ({ allowed: false, retryAfterSeconds: 60 }) } });
    const response = await limited.POST(request({ email: 'a@b.co' }));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.equal(requests, 0);
  });
  await withEnv({ ...configured, RESEND_API_KEY: undefined }, async () => {
    assert.equal((await loadRoute('forgot-password', stubs).POST(request({ email: 'a@b.co' }))).status, 503);
  });
  await withEnv({ ...configured, DATABASE_URL: undefined }, async () => {
    assert.equal((await loadRoute('forgot-password', stubs).POST(request({ email: 'a@b.co' }))).status, 503);
  });
  assert.equal(requests, 0);
});

test('reset-password checks the password before touching storage and maps outcomes to clear statuses', () => withEnv(configured, async () => {
  const seen = [];
  const outcomes = { good: { kind: 'reset', accountId: 'fame-market', email: 'staff@example.com' }, old: { kind: 'expired' }, bad: { kind: 'invalid' } };
  const route = loadRoute('reset-password', {
    '@/lib/inquiry-rate-limit': limiterAllow,
    '@/lib/password-reset': {
      passwordProblem: p => typeof p === 'string' && p.length >= 12 ? null : 'Use at least 12 characters.',
      consumePasswordReset: async (token, password) => { seen.push([token, password]); return outcomes[token]; },
    },
  });
  assert.equal((await route.POST(request({ token: 'good', password: 'short' }))).status, 400);
  assert.equal(seen.length, 0);
  assert.equal((await route.POST(request({ token: 'good', password: 'correct horse battery' }))).status, 200);
  const expired = await route.POST(request({ token: 'old', password: 'correct horse battery' }));
  assert.equal(expired.status, 400);
  assert.match((await expired.json()).error, /expired/);
  const invalid = await route.POST(request({ token: 'bad', password: 'correct horse battery' }));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /not valid/);
  assert.deepEqual(seen.map(([t]) => t), ['good', 'old', 'bad']);
  assert.equal((await route.POST(request({ token: 'good', password: 'correct horse battery' }, { 'sec-fetch-site': 'cross-site' }))).status, 403);
}));
