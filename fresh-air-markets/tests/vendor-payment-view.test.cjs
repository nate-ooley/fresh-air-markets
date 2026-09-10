const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/lib/vendor-payment-view.ts');
const mod = new Module(filename, module);
mod.require = id => id === './fresh-air-season' ? require('../.test-build/fresh-air-season.js') : require(id);
mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const { invitationFromFragment, trustedVendorCheckoutUrl, parseVendorPaymentView, canOpenVendorCheckout } = mod.exports;
const due = '2026-10-01T12:00:00.000Z';
const view = { dates: ['2026-10-03'], boothsPerMarket: 1, rateCents: 4000, totalCents: 4000, currency: 'USD', quoteTier: 'standard', paymentRequired: true, paymentDueAt: due, status: 'pending', checkoutUrl: 'https://sandbox.square.link/u/qa', environment: 'sandbox' };

test('private link requires one complete fragment token and rejects query or duplicate values', () => {
  const token = 'a'.repeat(43);
  assert.equal(invitationFromFragment('#token=' + token), token);
  for (const fragment of ['', '#token=bad', '#token=' + token + '&token=' + token, '#token=' + token + '&next=https://evil.invalid', '?token=' + token]) assert.equal(invitationFromFragment(fragment), null);
});
test('checkout links are restricted to Square hosts and exact Sandbox test-panel path', () => {
  assert.ok(trustedVendorCheckoutUrl(view.checkoutUrl, 'sandbox'));
  assert.ok(trustedVendorCheckoutUrl('https://square.link/u/qa', 'production'));
  for (const url of ['javascript:alert(1)', 'https://square.link.evil.invalid/u/qa', 'https://evil.invalid', 'https://user@square.link/u/qa', 'https://square.link:443/u/qa#token=bad', 'https://connect.squareupsandbox.com/v2/merchants']) assert.equal(trustedVendorCheckoutUrl(url, 'sandbox'), false);
  assert.equal(trustedVendorCheckoutUrl(view.checkoutUrl, 'production'), false);
});
test('payment button closes exactly at deadline and cannot open for paid or terminal states', () => {
  assert.ok(canOpenVendorCheckout(view, Date.parse(due) - 1));
  assert.equal(canOpenVendorCheckout(view, Date.parse(due)), false);
  for (const status of ['paid', 'confirmed', 'expired', 'unavailable']) assert.equal(canOpenVendorCheckout({ ...view, status }, Date.parse(due) - 1), false);
  assert.equal(canOpenVendorCheckout({ ...view, paymentRequired: false }, Date.parse(due) - 1), false);
});
test('browser only renders a valid server reservation and has no redirect-to-paid inference', () => {
  assert.deepEqual(parseVendorPaymentView(view), view);
  assert.equal(parseVendorPaymentView({ returned: '1', paid: 'true' }), null);
  for (const patch of [{ totalCents: -1 }, { currency: 'EUR' }, { dates: [] }, { dates: ['2026-99-99'] }, { dates: ['2026-10-03','2026-10-03'] }, { totalCents: 1 }, { rateCents: 3500 }, { paymentDueAt: 'not-a-date' }, { status: 'success' }, { checkoutUrl: 'https://evil.invalid' }]) assert.equal(parseVendorPaymentView({ ...view, ...patch }), null);
});
