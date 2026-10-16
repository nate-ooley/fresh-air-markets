const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest, NextResponse } = require('next/server');

const origin = 'https://freshairmarketsandevents.com';
const env = { DATABASE_URL: 'postgres://unit-test.invalid/db', FAME_MARKET_ACCOUNT_ID: 'fame-market', FAME_VENDOR_PORTAL_ORIGIN: origin, VERCEL: '1', VERCEL_ENV: 'production', SQUARE_ENVIRONMENT: 'production', SQUARE_ALLOW_LIVE_PAYMENTS: 'true', SQUARE_ACCESS_TOKEN: 'EAAA-unit', SQUARE_LOCATION_ID: 'L1', SQUARE_MERCHANT_ID: 'M1', SQUARE_WEBHOOK_SIGNATURE_KEY: 'sig', SQUARE_WEBHOOK_URL: `${origin}/api/payments/square/webhook` };
const RES = '11111111-1111-4111-8111-111111111111';
const sqInvoice = require('../.test-build/square-invoice.js');

function invoice(patch = {}) {
  return { id: 'inv-row', reservationId: RES, plan: 'monthly', status: 'creating', totalCents: 105000, quotedCents: 105000, paidCents: 0, adjustmentReason: '', publicUrl: null, lastError: null, createdAt: '2026-10-15T00:00:00.000Z',
    installments: [{ seq: 1, dueOn: '2026-11-01', amountCents: 35000 }, { seq: 2, dueOn: '2026-12-01', amountCents: 35000 }, { seq: 3, dueOn: '2027-01-01', amountCents: 35000 }], installmentsPaid: 0,
    environment: 'production', squareCustomerId: null, squareOrderId: null, squareInvoiceId: null, squareInvoiceVersion: null,
    squareInstallments: [1, 2, 3].map(seq => ({ seq, dueOn: ['2026-10-16', '2026-11-16', '2026-12-16'][seq - 1], amountCents: 35000, squareOrderId: null, squareInvoiceId: null, squareInvoiceVersion: null, published: false, cancelled: false, paidCents: 0 })),
    ...patch };
}
const target = { reservationId: RES, applicationId: 'app-1', state: 'payment_pending', quotedCents: 105000, dates: ['2026-10-24'], booths: 1, description: '1 market date, 1 booth' };

function load({ session = 'fame-market', log = [], begun = { kind: 'started', invoice: invoice(), target }, retired = { kind: 'retired', linksCancelled: 1 }, customerError = null, publishError = null, contact = { email: 'v@vendor.org', name: 'Ann Lee', businessName: 'Ann Co' } } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/reservations/[id]/invoice/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  mod.require = id => {
    if (id === '@/lib/admin-gate') return { adminGate: async () => session ? { marketId: session } : { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } };
    if (id === '@/lib/email') return { applicantContact: async () => contact };
    if (id === '@/lib/reservation-withdraw-pg') return { retireCheckoutLinks: async input => { log.push(['retire', input.reservationId]); return retired; } };
    if (id === '@/lib/square') return { ...require('../.test-build/square.js'), verifySquareIdentity: async () => ({ merchantId: 'M1', locationId: 'L1' }) };
    if (id === '@/lib/square-invoice') return {
      SquareInvoiceError: sqInvoice.SquareInvoiceError,
      ensureSquareCustomer: async input => { log.push(['customer', input.email]); if (customerError) throw customerError; return 'CUST1'; },
      createDraftSquareInvoice: async (_c, input) => { log.push(['draft', input.seq, input.amountCents, input.dueOn, input.scheduledAt]); return { orderId: `ORD${input.seq}`, invoiceId: `INV${input.seq}`, version: 0 }; },
      publishSquareInvoice: async (_c, invoiceId, version) => { log.push(['publish', invoiceId, version]); if (publishError && invoiceId === publishError.on) throw publishError.error; return { version: 1, publicUrl: `https://squareup.com/pay-invoice/${invoiceId}`, status: 'UNPAID' }; },
      cancelSquareInvoice: async (_c, invoiceId, _v, published) => { log.push(['delete-draft', invoiceId, published]); },
    };
    if (id === '@/lib/square-link-cancel') return { squareLinkCanceller: () => async () => 'cancelled' };
    if (id === '@/lib/vendor-booking-pg') return { marketToday: () => '2026-10-15' };
    if (id === '@/lib/vendor-invoice-pg') return {
      readBillingQuote: async () => 105000,
      beginInvoice: async input => { log.push(['begin', input.request.plan, input.request.installments.length, input.request.totalCents]); return begun; },
      recordInstallmentDraft: async input => { log.push(['record', input.seq, input.squareInvoiceId]); },
      markInstallmentPublished: async input => { log.push(['published', input.seq]); },
      markInvoiceOpen: async input => { log.push(['open', input.invoiceId, input.publicUrl]); },
      markInvoiceFailed: async input => { log.push(['failed', input.error]); },
      invoiceView: record => ({ id: record.id, status: record.status, installments: record.installments }),
    };
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
const call = (route, body, id = RES) => route.POST(new NextRequest(`${origin}/api/admin/reservations/${id}/invoice`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const monthly = { plan: 'monthly', installments: 3, firstDueOn: '2026-11-01', totalCents: 105000 };

test('a plan drafts one invoice per payment (later ones scheduled 3 days before due), retires the old link, THEN sends them', () => withEnv(env, async () => {
  const log = [];
  const response = await call(load({ log }), monthly);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).invoice.publicUrl, 'https://squareup.com/pay-invoice/INV1');
  assert.deepEqual(log.map(entry => entry[0]), ['begin', 'customer', 'draft', 'record', 'draft', 'record', 'draft', 'record', 'retire', 'publish', 'published', 'publish', 'published', 'publish', 'published', 'open']);
  assert.deepEqual(log.filter(entry => entry[0] === 'draft').map(entry => entry.slice(1)), [
    [1, 35000, '2026-10-16', null],
    [2, 35000, '2026-11-16', '2026-11-13T13:00:00Z'],
    [3, 35000, '2026-12-16', '2026-12-13T13:00:00Z'],
  ]);
}));

test('if Square cannot prove the old link is dead, every draft is deleted and nothing is sent', () => withEnv(env, async () => {
  const log = [];
  const response = await call(load({ log, retired: { kind: 'cancellation_unproven', squareOrderId: 'SQ-9' } }), monthly);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /SQ-9.*No invoice was sent/);
  assert.equal(log.some(entry => entry[0] === 'publish'), false);
  assert.deepEqual(log.filter(entry => entry[0] === 'delete-draft').map(entry => entry[1]), ['INV1', 'INV2', 'INV3']);
  assert.ok(log.some(entry => entry[0] === 'failed'));
}));

test('a retry after a half-sent plan skips what Square already has and sends only the rest', () => withEnv(env, async () => {
  const log = [];
  const base = invoice();
  base.squareCustomerId = 'CUST1';
  base.squareInstallments = base.squareInstallments.map(item => ({ ...item, squareOrderId: `ORD${item.seq}`, squareInvoiceId: `INV${item.seq}`, squareInvoiceVersion: 0, published: item.seq === 1 }));
  const response = await call(load({ log, begun: { kind: 'resume', invoice: base, target } }), monthly);
  assert.equal(response.status, 201);
  assert.deepEqual(log.map(entry => entry[0]), ['begin', 'retire', 'publish', 'published', 'publish', 'published', 'open']);
  assert.deepEqual(log.filter(entry => entry[0] === 'publish').map(entry => entry[1]), ['INV2', 'INV3']);
}));

test('Square permission problems are explained in plain words and recorded', () => withEnv(env, async () => {
  const log = [];
  const response = await call(load({ log, customerError: new sqInvoice.SquareInvoiceError('customer search', 403, ['INSUFFICIENT_SCOPES']) }), monthly);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /isn't allowed to create invoices.*customer search, 403 INSUFFICIENT_SCOPES/);
  // A 403 on an installment plan is the account's Square plan, not the connection.
  const plan = await call(load({ customerError: new sqInvoice.SquareInvoiceError('invoice create', 403, ['FORBIDDEN']) }), monthly);
  assert.match((await plan.json()).error, /Invoices Plus.*"Pay in full" still works.*invoice create, 403 FORBIDDEN/);
  assert.ok(log.some(entry => entry[0] === 'failed'));
  assert.equal(log.some(entry => entry[0] === 'retire'), false);
}));

test('a send failure part-way says how many went out and to click again (drafts are kept)', () => withEnv(env, async () => {
  const log = [];
  const response = await call(load({ log, publishError: { on: 'INV2', error: new sqInvoice.SquareInvoiceError('invoice publish', 500, []) } }), monthly);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /1 of 3 payments were already sent or scheduled.*click "Send invoice" again/);
  assert.equal(log.some(entry => entry[0] === 'failed' || entry[0] === 'delete-draft' || entry[0] === 'open'), false);
}));

test('open invoices, paid, nonprofit and lapsed bookings, missing email and bad input are refused before Square', () => withEnv(env, async () => {
  const cases = [
    [{ begun: { kind: 'already_open', invoice: invoice({ status: 'open' }) } }, monthly, 409, /already has an open Square invoice/],
    [{ begun: { kind: 'not_billable', state: 'paid' } }, monthly, 409, /already paid/],
    [{ begun: { kind: 'not_billable', state: 'nonprofit' } }, monthly, 409, /Nonprofit/],
    [{ begun: { kind: 'not_billable', state: 'expired' } }, monthly, 409, /Reopen it first/],
    [{ contact: null }, monthly, 409, /no usable email/],
    [{}, { ...monthly, installments: 13 }, 400, /2 to 12 payments/],
    [{}, { ...monthly, totalCents: 90000 }, 400, /Say why/],
    [{}, { ...monthly, firstDueOn: '2026-10-01' }, 400, /past/],
  ];
  for (const [options, body, status, message] of cases) {
    const log = [];
    const response = await call(load({ log, ...options }), body);
    assert.equal(response.status, status, message.source);
    assert.match((await response.json()).error, message);
    assert.equal(log.some(entry => entry[0] === 'publish' || entry[0] === 'retire'), false);
  }
  assert.equal((await call(load({ session: null }), monthly)).status, 401);
  assert.equal((await call(load(), monthly, 'bad%20id')).status, 400);
}));
