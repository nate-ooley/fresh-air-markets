const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest, NextResponse } = require('next/server');

const origin = 'https://freshairmarketsandevents.com';
const RES = '11111111-1111-4111-8111-111111111111';

function load({ log = [], owed = 8000, retired = { kind: 'retired', linksCancelled: 1 }, session = 'fame-market' } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/reservations/[id]/manual-payment/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  mod.require = id => {
    if (id === '@/lib/admin-gate') return { adminGate: async () => session ? { marketId: session } : { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } };
    if (id === '@/lib/reservation-withdraw-pg') return { retireCheckoutLinks: async () => { log.push('retire'); return retired; } };
    if (id === '@/lib/square-link-cancel') return { squareLinkCanceller: () => async () => 'cancelled' };
    if (id === '@/lib/vendor-booking-pg') return { marketToday: () => '2026-10-16' };
    if (id === '@/lib/vendor-balance-pg') return {
      bookingBalanceDue: async () => ({ reservationId: RES, state: 'payment_pending', balanceCents: owed }),
      recordManualPayment: async input => { log.push(['record', input.amountCents]); return { kind: 'saved', paymentId: 'p1', amountCents: input.amountCents, bookingPaid: input.amountCents === owed }; },
    };
    if (id.startsWith('@/lib/')) return require('../.test-build/' + id.slice(6) + '.js');
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}
const call = (route, body) => route.POST(new NextRequest(`${origin}/api/admin/reservations/${RES}/manual-payment`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: RES }) });

test('paying the booking in full turns off its online link (proved by Square) before recording', async () => {
  const log = [];
  const response = await call(load({ log }), { amountCents: 8000, paidOn: '2026-10-15', note: 'Square invoice' });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).bookingPaid, true);
  assert.deepEqual(log, ['retire', ['record', 8000]]);
});

test('a part payment is recorded without touching the online link', async () => {
  const log = [];
  assert.equal((await call(load({ log }), { amountCents: 3000, paidOn: '2026-10-15' })).status, 201);
  assert.deepEqual(log, [['record', 3000]]);
});

test('if Square cannot prove the online link is dead, nothing is saved', async () => {
  const log = [];
  const response = await call(load({ log, retired: { kind: 'cancellation_unproven', squareOrderId: 'SQ-7' } }), { amountCents: 8000, paidOn: '2026-10-15' });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /SQ-7.*Nothing was saved/);
  assert.deepEqual(log, ['retire']);
});

test('bad amounts and dates are refused before Square or the database', async () => {
  for (const body of [{ amountCents: 0, paidOn: '2026-10-15' }, { amountCents: 9000, paidOn: '2026-10-15' }, { amountCents: 1000, paidOn: '2026-10-17' }, { amountCents: 1000 }]) {
    const log = [];
    assert.equal((await call(load({ log }), body)).status, 400, JSON.stringify(body));
    assert.deepEqual(log, []);
  }
  assert.equal((await call(load({ session: null }), { amountCents: 1000, paidOn: '2026-10-15' })).status, 401);
});
