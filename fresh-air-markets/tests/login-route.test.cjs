const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'unit-test-secret-that-is-long-enough-1234567890';
const auth = require('../.test-build/auth.js');
const { hashPassword } = require('../.test-build/password-hash.js');

const hash = hashPassword('correct horse battery staple');
const account = { id: 'fame-market', email: 'owner@example.com', passwordHash: hash, ownerName: 'Nathan', marketName: 'North Port', slug: 'north-port', plan: 'pro', licenseKey: 'k', licenseStatus: 'active', trialEndsAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' };

function loadRoute({ staff = {}, store = {} } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/auth/login/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/store') return { getStore: async () => ({ getAccountByEmail: async email => email === account.email ? account : null, getAccountById: async id => id === account.id ? account : null, ...store }) };
    if (id === '@/lib/staff-users') return { findStaffLogin: async () => ({ kind: 'none' }), ensureOwnerStaff: async () => ({ id: 'staff-fame-market' }), ...staff };
    if (id === '@/lib/seed') return { DEMO_MARKET_ID: 'demo-market' };
    if (id === '@/lib/demo-tenant') return { demoTenantAllowed: () => false };
    if (id === '@/lib/types') return { toPublicAccount: a => ({ id: a.id, email: a.email }) };
    if (id.startsWith('@/lib/')) return require('../.test-build/' + id.slice(6) + '.js');
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}
function withDb(run) {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://unit-test.invalid/db';
  return run().finally(() => { if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved; });
}
const login = (body) => new NextRequest('https://freshairmarketsandevents.com/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const cookie = res => (res.headers.get('set-cookie') || '').match(/bhq_session=([^;]+)/)?.[1];

test('a staff member signs in with their own password and gets a session naming market and person', () => withDb(async () => {
  const route = loadRoute({ staff: { findStaffLogin: async email => email === 'thomas@example.com' ? { kind: 'found', user: { id: 'staff-2', marketId: 'fame-market', name: 'Thomas', role: 'manager' }, passwordHash: hash } : { kind: 'none' } } });
  const ok = await route.POST(login({ email: 'Thomas@Example.com', password: 'correct horse battery staple' }));
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).staff, { id: 'staff-2', name: 'Thomas', role: 'manager' });
  assert.deepEqual(auth.verifySessionIdentity(cookie(ok)), { marketId: 'fame-market', userId: 'staff-2' });
  assert.equal((await route.POST(login({ email: 'thomas@example.com', password: 'wrong' }))).status, 401);
}));

test('the legacy account login still works and is carried over as the owner; invited and ambiguous emails are explained', () => withDb(async () => {
  const route = loadRoute();
  const ok = await route.POST(login({ email: 'owner@example.com', password: 'correct horse battery staple' }));
  assert.equal(ok.status, 200);
  assert.deepEqual(auth.verifySessionIdentity(cookie(ok)), { marketId: 'fame-market', userId: 'staff-fame-market' });
  const invited = await loadRoute({ staff: { findStaffLogin: async () => ({ kind: 'invited', user: {} }) } }).POST(login({ email: 'x@y.co', password: 'p' }));
  assert.equal(invited.status, 401);
  assert.match((await invited.json()).error, /invitation email/);
  assert.equal((await loadRoute({ staff: { findStaffLogin: async () => ({ kind: 'ambiguous' }) } }).POST(login({ email: 'x@y.co', password: 'p' }))).status, 409);
  assert.equal((await loadRoute({ staff: { findStaffLogin: async () => { throw new Error('db down'); } } }).POST(login({ email: 'x@y.co', password: 'p' }))).status, 503);
  assert.equal((await route.POST(login({ email: 'owner@example.com', password: 'nope' }))).status, 401);
}));

test('without a database the demo/memory path issues a legacy market session', async () => {
  const saved = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  try {
    const ok = await loadRoute().POST(login({ email: 'owner@example.com', password: 'correct horse battery staple' }));
    assert.equal(ok.status, 200);
    assert.deepEqual(auth.verifySessionIdentity(cookie(ok)), { marketId: 'fame-market', userId: null });
  } finally { if (saved !== undefined) process.env.DATABASE_URL = saved; }
});
