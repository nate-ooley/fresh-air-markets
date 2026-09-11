const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const TOKEN = 'A'.repeat(43);
const user = { id: 'staff-2', marketId: 'fame-market', email: 'thomas@example.com', name: 'Thomas', role: 'manager', status: 'invited', createdAt: '2026-09-11T00:00:00.000Z' };

function loadRoute(file, { session = { marketId: 'fame-market', userId: 'staff-1', role: 'owner' }, staff = {}, notify } = {}) {
  const filename = path.resolve(__dirname, `../src/app/api/admin/staff/${file}`);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/auth') return { getSessionStaff: async () => session };
    if (id === '@/lib/seed') return { DEMO_MARKET_ID: 'demo-market' };
    if (id === '@/lib/store') return { getStore: async () => ({ getAccountById: async () => ({ marketName: 'North Port Market' }) }) };
    if (id === '@/lib/email') return { emailConfigured: () => true };
    if (id === '@/lib/notifications') return { portalOrigin: () => 'https://freshairmarketsandevents.com', notifyStaffInvitation: notify || (async () => 'sent') };
    if (id === '@/lib/staff-users') return { INVITATION_TTL_DAYS: 7, listStaff: async () => [user], inviteStaff: async () => ({ kind: 'invited', user, token: TOKEN, expiresAt: '2026-09-18T00:00:00.000Z' }), removeStaff: async () => ({ kind: 'removed', user: { ...user, status: 'removed' } }), ...staff };
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
const post = (body, headers = {}) => new NextRequest('https://freshairmarketsandevents.com/api/admin/staff', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const del = (headers = {}) => new NextRequest('https://freshairmarketsandevents.com/api/admin/staff/staff-2', { method: 'DELETE', headers });

test('the directory is readable by any staff member, but inviting and removing need the owner and a same-origin request', () => withDb(async () => {
  const manager = { marketId: 'fame-market', userId: 'staff-2', role: 'manager' };
  const list = await loadRoute('route.ts', { session: manager }).GET();
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).me, { userId: 'staff-2', role: 'manager' });
  assert.equal((await loadRoute('route.ts', { session: null }).GET()).status, 401);
  let invites = 0;
  const counting = { inviteStaff: async () => { invites++; return { kind: 'invited', user, token: TOKEN, expiresAt: 'x' }; } };
  assert.equal((await loadRoute('route.ts', { session: manager, staff: counting }).POST(post({ email: 'a@b.co', name: 'A' }))).status, 403);
  assert.equal((await loadRoute('route.ts', { staff: counting }).POST(post({ email: 'a@b.co', name: 'A' }, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal((await loadRoute('route.ts', { staff: counting }).POST(post(null))).status, 400);
  assert.equal(invites, 0);
  assert.equal((await loadRoute('[id]/route.ts', { session: manager }).DELETE(del(), { params: Promise.resolve({ id: 'staff-2' }) })).status, 403);
  assert.equal((await loadRoute('[id]/route.ts').DELETE(del({ 'sec-fetch-site': 'cross-site' }), { params: Promise.resolve({ id: 'staff-2' }) })).status, 403);
  assert.equal((await loadRoute('[id]/route.ts').DELETE(del(), { params: Promise.resolve({ id: 'bad id' }) })).status, 400);
}));

test('an invitation emails the accept link and only exposes it to the owner when email fails', () => withDb(async () => {
  const sent = [];
  const ok = await loadRoute('route.ts', { notify: async input => { sent.push(input); return 'sent'; } }).POST(post({ email: 'Thomas@Example.com', name: 'Thomas' }));
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.equal(body.invitation, 'sent');
  assert.equal('inviteUrl' in body, false);
  assert.equal(sent[0].link, `https://freshairmarketsandevents.com/accept-invite#token=${TOKEN}`);
  assert.equal(sent[0].marketName, 'North Port Market');
  const failed = await loadRoute('route.ts', { notify: async () => 'failed' }).POST(post({ email: 'Thomas@Example.com', name: 'Thomas' }));
  assert.equal(failed.status, 201);
  const fallback = await failed.json();
  assert.equal(fallback.invitation, 'failed');
  assert.equal(fallback.inviteUrl, `https://freshairmarketsandevents.com/accept-invite#token=${TOKEN}`);
  assert.equal((await loadRoute('route.ts', { staff: { inviteStaff: async () => ({ kind: 'exists', user }) } }).POST(post({ email: 'x', name: 'y' }))).status, 409);
  assert.equal((await loadRoute('route.ts', { staff: { inviteStaff: async () => ({ kind: 'invalid', reason: 'Enter the person\'s name.' }) } }).POST(post({ email: 'x' }))).status, 400);
  const removed = await loadRoute('[id]/route.ts').DELETE(del(), { params: Promise.resolve({ id: 'staff-2' }) });
  assert.equal(removed.status, 200);
  assert.equal((await loadRoute('[id]/route.ts', { staff: { removeStaff: async () => ({ kind: 'refused', reason: 'The market owner cannot be removed.' }) } }).DELETE(del(), { params: Promise.resolve({ id: 'staff-2' }) })).status, 409);
}));
