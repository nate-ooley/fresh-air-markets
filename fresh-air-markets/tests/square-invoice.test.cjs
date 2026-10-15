const { test } = require('node:test');
const assert = require('node:assert/strict');
const sq = require('../.test-build/square-invoice.js');

const config = { environment: 'production', accessToken: 'EAAA-unit', locationId: 'L1' };
function transport(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    const next = responses.shift();
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  };
  fn.calls = calls;
  return fn;
}

test('an existing Square customer is reused by email; otherwise one is created once', async () => {
  const reuse = transport([{ body: { customers: [{ id: 'CUST1' }] } }]);
  assert.equal(await sq.ensureSquareCustomer(config, { email: 'v@x.org', name: 'Ann Lee', businessName: 'Ann Co', reference: 'app-1' }, reuse), 'CUST1');
  assert.equal(reuse.calls.length, 1);
  assert.deepEqual(reuse.calls[0].body.query.filter.email_address, { exact: 'v@x.org' });
  const create = transport([{ body: {} }, { body: { customer: { id: 'CUST2' } } }]);
  assert.equal(await sq.ensureSquareCustomer(config, { email: 'v@x.org', name: 'Ann Lee', businessName: 'Ann Co', reference: 'app-1' }, create), 'CUST2');
  assert.match(create.calls[1].url, /\/v2\/customers$/);
  assert.equal(create.calls[1].body.given_name, 'Ann');
  assert.equal(create.calls[1].body.family_name, 'Lee');
  assert.equal(create.calls[1].body.company_name, 'Ann Co');
});

test('a monthly plan becomes an order plus a DRAFT invoice with one installment request per month', async () => {
  const t = transport([{ body: { order: { id: 'ORD1' } } }, { body: { invoice: { id: 'INV1', version: 0 } } }]);
  const draft = await sq.createDraftSquareInvoice(config, {
    invoiceRowId: 'row-1', customerId: 'CUST1', title: 'Booth', description: '1 booth on Sat, Oct 24.',
    installments: [{ seq: 1, dueOn: '2026-11-01', amountCents: 50000 }, { seq: 2, dueOn: '2026-12-01', amountCents: 55000 }],
  }, t);
  assert.deepEqual(draft, { orderId: 'ORD1', invoiceId: 'INV1', version: 0 });
  assert.equal(t.calls[0].body.order.line_items[0].base_price_money.amount, 105000);
  const invoice = t.calls[1].body.invoice;
  assert.equal(invoice.order_id, 'ORD1');
  assert.equal(invoice.delivery_method, 'EMAIL');
  assert.deepEqual(invoice.payment_requests.map(r => [r.request_type, r.due_date, r.fixed_amount_requested_money.amount]), [['INSTALLMENT', '2026-11-01', 50000], ['INSTALLMENT', '2026-12-01', 55000]]);
  assert.equal(t.calls.some(call => /publish/.test(call.url)), false);
  // Same row → same idempotency keys, so a retry can't create a second invoice.
  const again = transport([{ body: { order: { id: 'ORD1' } } }, { body: { invoice: { id: 'INV1', version: 0 } } }]);
  await sq.createDraftSquareInvoice(config, { invoiceRowId: 'row-1', customerId: 'CUST1', title: 'Booth', description: 'd', installments: [{ seq: 1, dueOn: '2026-11-01', amountCents: 50000 }, { seq: 2, dueOn: '2026-12-01', amountCents: 55000 }] }, again);
  assert.equal(again.calls[1].body.idempotency_key, t.calls[1].body.idempotency_key);
});

test('pay in full is a single BALANCE request; publish returns the Square invoice page', async () => {
  const t = transport([{ body: { order: { id: 'ORD2' } } }, { body: { invoice: { id: 'INV2', version: 0 } } }, { body: { invoice: { version: 1, status: 'UNPAID', public_url: 'https://squareup.com/pay-invoice/inv2' } } }]);
  const draft = await sq.createDraftSquareInvoice(config, { invoiceRowId: 'row-2', customerId: 'C', title: 'T', description: 'd', installments: [{ seq: 1, dueOn: '2026-11-01', amountCents: 14000 }] }, t);
  assert.equal(t.calls[1].body.invoice.payment_requests[0].request_type, 'BALANCE');
  assert.equal(t.calls[1].body.invoice.payment_requests[0].fixed_amount_requested_money, undefined);
  const published = await sq.publishSquareInvoice(config, draft.invoiceId, draft.version, t);
  assert.deepEqual(published, { version: 1, publicUrl: 'https://squareup.com/pay-invoice/inv2', status: 'UNPAID' });
});

test('Square refusals keep only the documented error codes; drafts are deleted, published invoices cancelled', async () => {
  const refused = transport([{ status: 403, body: { errors: [{ code: 'INSUFFICIENT_SCOPES', detail: 'private text' }] } }]);
  await assert.rejects(sq.ensureSquareCustomer(config, { email: 'v@x.org', name: 'A', businessName: '', reference: 'r' }, refused), error => {
    assert.ok(error instanceof sq.SquareInvoiceError);
    assert.deepEqual(error.codes, ['INSUFFICIENT_SCOPES']);
    assert.doesNotMatch(error.message, /private text/);
    return true;
  });
  const del = transport([{ status: 200 }]);
  await sq.cancelSquareInvoice(config, 'INV1', 0, false, del);
  assert.equal(del.calls[0].method, 'DELETE');
  assert.match(del.calls[0].url, /\/v2\/invoices\/INV1\?version=0$/);
  const cancel = transport([{ body: { invoice: {} } }]);
  await sq.cancelSquareInvoice(config, 'INV1', 3, true, cancel);
  assert.match(cancel.calls[0].url, /\/v2\/invoices\/INV1\/cancel$/);
  assert.deepEqual(cancel.calls[0].body, { version: 3 });
});
