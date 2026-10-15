const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const postgres = require('postgres');
const invoices = require('../../.test-build/vendor-invoice-pg.js');
const { hasLiveInvoice } = require('../../.test-build/reservation-withdraw-pg.js');

// Billing is published before its database update (032) is applied in
// production. Without the invoice table every other screen must behave as if
// no booking is on an invoice, and billing itself must say it's not ready.
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
const schema = 'qa_invoice_missing';
const admin = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
const sql = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: schema } });

before(async () => { await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.unsafe(`CREATE SCHEMA ${schema}`); });
after(async () => { await sql.end(); await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });

test('without the invoice table nothing breaks: no booking is on an invoice and billing reports unavailable', async () => {
  assert.equal(await hasLiveInvoice(sql, 'm', 'r'), false);
  assert.deepEqual([...await invoices.reservationsOnInvoice('m', sql)], []);
  assert.equal(await invoices.hasOpenInvoice('m', 'r', sql), false);
  assert.equal(await invoices.listInvoicesForApplication('m', 'a', sql), null);
  assert.equal(await sql.begin(tx => invoices.applyInvoicePayment(tx, { environment: 'sandbox', orderId: 'o', paymentId: 'p', status: 'COMPLETED', amountCents: 1, currency: 'USD' }, new Date())), null);
  assert.deepEqual(await invoices.beginInvoice({ marketId: 'm', reservationId: 'r', request: { plan: 'full', totalCents: 100, reason: '', installments: [] }, environment: 'sandbox', actorAccountId: 'm' }, sql), { kind: 'unavailable' });
});
