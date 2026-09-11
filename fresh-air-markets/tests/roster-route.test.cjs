const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const vendor = { reservationId: 'r1', applicationId: 'a1', businessName: 'Sunrise Farms', vendorName: 'Rosa', email: 'rosa@example.com', phone: '', applicantType: 'Vendor', category: 'Produce', booths: 2, dates: ['2026-10-03'], status: 'paid', totalCents: 8000, paymentDueAt: null };
const env = { DATABASE_URL: 'postgres://unit-test.invalid/db', FAME_MARKET_ACCOUNT_ID: 'fame-market', FAME_SEASON_ID: '2026-2027', FAME_BOOTH_CAPACITY: '50' };

function loadRoute({ session = 'fame-market', load = async () => [vendor] } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/roster/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/auth') return { getSessionAccountId: async () => session };
    if (id === '@/lib/market-roster') return { ...require('../.test-build/market-roster.js'), loadMarketRoster: load };
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
const get = (query = '') => new NextRequest(`https://freshairmarketsandevents.com/api/admin/roster${query}`, { method: 'GET' });

test('the roster needs a session and a matching market, defaults to the next market date, and validates the date', () => withEnv(env, async () => {
  assert.equal((await loadRoute({ session: null }).GET(get())).status, 401);
  assert.equal((await loadRoute({ session: 'other-market' }).GET(get())).status, 503);
  const bad = await loadRoute().GET(get('?date=2026-10-04'));
  assert.equal(bad.status, 400);
  assert.ok(Array.isArray((await bad.json()).dates));
  const ok = await loadRoute().GET(get('?date=2026-10-03'));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.date, '2026-10-03');
  assert.equal(body.capacity, 50);
  assert.deepEqual(body.day.totals, { confirmedVendors: 1, confirmedBooths: 2, pendingVendors: 0, pendingBooths: 0 });
  assert.equal(body.season.length, body.dates.length);
  const defaulted = await loadRoute().GET(get());
  assert.equal(defaulted.status, 200);
  assert.ok(body.dates.includes((await defaulted.json()).date));
  assert.equal((await loadRoute({ load: async () => { throw new Error('down'); } }).GET(get('?date=2026-10-03'))).status, 503);
}));

test('format=csv downloads the date as a spreadsheet', () => withEnv(env, async () => {
  const res = await loadRoute().GET(get('?date=2026-10-03&format=csv'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="market-roster-2026-10-03.csv"');
  const text = await res.text();
  assert.match(text, /^Market date,Status,Category,Business/);
  assert.match(text, /2026-10-03,Paid,Produce,Sunrise Farms,Rosa,rosa@example.com,,2,Vendor/);
}));
