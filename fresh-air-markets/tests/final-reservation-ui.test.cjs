const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function sourceModule(relative, overrides = {}) {
  const filename = path.resolve(__dirname, '..', relative);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = id => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id.startsWith('@/lib/')) return sourceModule(`src/lib/${id.slice(6)}.ts`);
    if (id.startsWith('./')) return sourceModule(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(filename), `${id}.ts`)));
    return require(id);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
  return mod.exports;
}

const helper = sourceModule('src/lib/final-reservation-ui.ts');
const form = {
  applicantType: 'Vendor', vendorCategory: 'Produce', selectedDates: ['2027-05-29', '2026-10-03'],
  fullSeason: false, boothsPerMarket: '2', foodLicenseDecision: 'not_required', finalDatesConfirmed: false,
};
const reservation = {
  id: '11111111-1111-4111-8111-111111111111', state: 'held', paymentRequired: true,
  totalCents: 16000, finalDates: ['2026-10-03', '2027-05-29'], finalBoothQuantity: 2,
  quoteVersion: 'fresh-air-2026-2027-v1',
};
const order = {
  id: '22222222-2222-4222-8222-222222222222', checkoutUrl: 'https://sandbox.square.link/u/test',
  paymentDueAt: '2026-10-02T16:00:00Z', status: 'checkout_created',
};

test('requested-date suggestions accept exact canonical labels and ISO values without moving historical dates', () => {
  assert.deepEqual(helper.requestedReservationDates([
    'Sat, Oct 3, 2026', '2027-05-29', 'Thu, May 27, 2027', '2027-05-27', '2026-10-03', 'Full Season (Oct 3 - May 27)',
  ]), ['2026-10-03', '2027-05-29']);
  assert.equal(helper.reservationDateLabel('2027-05-29'), 'Sat, May 29, 2027');
});

test('final manager request contains only six allowed planning fields and requires explicit classification/license decisions', () => {
  const parsed = helper.finalReservationRequest({ ...form, totalCents: 1, marketId: 'attacker', checkoutUrl: 'https://invalid.test' }, false);
  assert.deepEqual(parsed.body, {
    applicantType: 'Vendor', vendorCategory: 'Produce', selectedDates: ['2026-10-03', '2027-05-29'],
    fullSeason: false, boothsPerMarket: 2, foodLicenseRequired: false,
  });
  assert.match(helper.finalReservationRequest({ ...form, applicantType: '' }, false).error, /final applicant type/);
  assert.match(helper.finalReservationRequest({ ...form, foodLicenseDecision: '' }, false).error, /food license/);
  for (const quantity of ['0', '-1', '1.5', '1001', '1e2', '', '02']) {
    assert.ok(helper.finalReservationRequest({ ...form, boothsPerMarket: quantity }, false).error, quantity);
  }
});

test('full season submits no individual dates and historical requests require a deliberate final-date confirmation', () => {
  assert.match(helper.finalReservationRequest({ ...form, fullSeason: true }, true).error, /Confirm the corrected/);
  const parsed = helper.finalReservationRequest({ ...form, fullSeason: true, finalDatesConfirmed: true }, true);
  assert.deepEqual(parsed.body.selectedDates, []);
  assert.equal(parsed.body.fullSeason, true);
  assert.ok(helper.finalReservationRequest({ ...form, selectedDates: ['2027-05-27'] }, false).error);
  assert.ok(helper.finalReservationRequest({ ...form, selectedDates: ['2026-10-03', '2026-10-03'] }, false).error);
  const nonprofit = helper.finalReservationRequest({ ...form, applicantType: 'Non-Profit Organization', vendorCategory: 'Food Truck' }, false);
  assert.equal(nonprofit.body.vendorCategory, 'Non-Profit Organization');
});

test('saved reservation guards reject invalid quote/date shapes and retain domain-specific missing-document/capacity errors', () => {
  assert.equal(helper.isFinalReservationView(reservation), true);
  for (const patch of [{ totalCents: -1 }, { totalCents: 0 }, { finalDates: ['2027-05-27'] }, { finalDates: ['2026-10-03', '2026-10-03'] }, { finalBoothQuantity: 1.5 }]) {
    assert.equal(helper.isFinalReservationView({ ...reservation, ...patch }), false);
  }
  assert.equal(helper.isFinalReservationView({ ...reservation, paymentRequired: false, totalCents: 0, state: 'confirmed' }), true);
  assert.match(helper.reservationError({ eligibility: 'insurance_not_approved', error: 'Not eligible' }, ''), /insurance document/);
  assert.match(helper.reservationError({ eligibility: 'food_license_not_approved' }, ''), /food-license document/);
  assert.match(helper.reservationError({ eligibility: 'agreement_not_signed' }, ''), /agreement/);
  assert.deepEqual(helper.unavailableReservationDates({ availability: [
    { date: '2026-10-03', available: false, reasons: ['Food truck limit reached (4)'] },
    { date: '2026-10-10', available: true, reasons: [] },
    { date: 'invalid', available: false, reasons: ['wrong'] },
  ] }), [{ date: '2026-10-03', reasons: ['Food truck limit reached (4)'] }]);
});

test('private invitation presentation accepts only matching HTTPS fragment links and never returns the separate token', () => {
  const valid = { invitationToken: 'private-token', invitationUrl: 'https://freshairmarketsandevents.com/vendor/payment#token=private-token', expiresAt: '2026-10-02T16:00:00Z' };
  assert.deepEqual(helper.vendorInvitationView(valid), { invitationUrl: valid.invitationUrl, expiresAt: valid.expiresAt });
  for (const invitationUrl of [
    'javascript:alert(1)', 'http://freshairmarketsandevents.com/vendor/payment#token=private-token',
    'https://user:password@freshairmarketsandevents.com/vendor/payment#token=private-token',
    'https://freshairmarketsandevents.com/vendor/payment?token=private-token',
    'https://freshairmarketsandevents.com/vendor/payment#token=wrong',
  ]) assert.equal(helper.vendorInvitationView({ ...valid, invitationUrl }), null);
});

function renderPanel(options = {}) {
  const states = [
    { ...form, ...options.form }, options.reservation ?? null, options.order ?? null, null,
    false, null, '', '', '', [], options.replaceConfirmed ?? false, '',
  ];
  let index = 0;
  const updates = [];
  const router = { replace(url) { updates.push(['redirect', url]); } };
  const component = sourceModule('src/components/FinalReservationPanel.tsx', {
    react: {
      useState: () => { const current = index++; return [states[current], value => updates.push([current, value])]; },
      useRef: value => ({ current: value && Object.hasOwn(value, 'revision') ? { revision: 1, pending: false } : value }),
      useCallback: fn => fn,
      useEffect() {},
    },
    'next/navigation': { useRouter: () => router },
  }).default;
  const element = component({
    applicationId: '33333333-3333-4333-8333-333333333333', sourceEventId: 'qa:current',
    snapshot: { applicantType: 'Vendor', category: 'Produce', dates: ['2026-10-03'], fullSeason: false, requiresFinalDateConfirmation: options.historical ?? false },
  });
  function elements(node, predicate) {
    if (!node || typeof node !== 'object') return [];
    return [ ...(predicate(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => elements(child, predicate)) ];
  }
  return {
    updates,
    submit: () => elements(element, node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} }),
    click: async label => {
      const button = elements(element, node => node.type === 'button' && node.props.children === label)[0];
      assert.ok(button, label);
      button.props.onClick();
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

async function browserBoundary(run, blockedStorage = false) {
  const originalFetch = global.fetch;
  const priorStorage = Object.getOwnPropertyDescriptor(global, 'sessionStorage');
  const storage = new Map();
  Object.defineProperty(global, 'sessionStorage', { configurable: true, value: {
    getItem(key) { if (blockedStorage) throw new Error('unavailable'); return storage.get(key); },
    setItem(key, value) { if (blockedStorage) throw new Error('unavailable'); storage.set(key, value); },
  } });
  try { await run(storage); } finally {
    global.fetch = originalFetch;
    if (priorStorage) Object.defineProperty(global, 'sessionStorage', priorStorage); else delete global.sessionStorage;
  }
}

test('rapid reserve clicks produce one request and only the server-calculated saved total is accepted', async () => browserBoundary(async () => {
  let release, started;
  const atFetch = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  global.fetch = async (url, options) => { calls.push([url, options]); started(); return pending; };
  const panel = renderPanel();
  const first = panel.submit(), second = panel.submit(), third = panel.submit();
  await atFetch;
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /applications\/33333333-3333-4333-8333-333333333333\/reserve$/);
  assert.equal(JSON.parse(calls[0][1].body).totalCents, undefined);
  release(new Response(JSON.stringify({ reservation, duplicate: false }), { status: 201 }));
  await Promise.all([first, second, third]);
  assert.deepEqual(panel.updates.find(([index, value]) => index === 1 && value), [1, reservation]);
}));

test('uncertain reserve retries and same-tab reload retain identity; changed decisions get another key without storing application data', async () => browserBoundary(async storage => {
  const calls = [];
  global.fetch = async (_url, options) => { calls.push(options); throw new Error('lost response'); };
  const panel = renderPanel();
  await panel.submit(); await panel.submit(); await renderPanel().submit();
  await renderPanel({ form: { boothsPerMarket: '3' } }).submit();
  assert.equal(calls.length, 4);
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
  assert.equal(calls[1].headers['Idempotency-Key'], calls[2].headers['Idempotency-Key']);
  assert.notEqual(calls[2].headers['Idempotency-Key'], calls[3].headers['Idempotency-Key']);
  assert.doesNotMatch(JSON.stringify([...storage]), /33333333|qa:current|Produce|2027-05-29/);
}));

test('historical dates and missing license choice prevent reserve calls; blocked storage keeps explicit retry idempotent', async () => browserBoundary(async () => {
  const calls = [];
  global.fetch = async (_url, options) => { calls.push(options); throw new Error('offline'); };
  await renderPanel({ historical: true }).submit();
  await renderPanel({ form: { foodLicenseDecision: '' } }).submit();
  assert.equal(calls.length, 0);
  const panel = renderPanel();
  await panel.submit(); await panel.submit();
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
}, true));

test('checkout in progress reports pending without claiming payment or creating a vendor link', async () => browserBoundary(async () => {
  const calls = [];
  global.fetch = async (url, options) => { calls.push([url, options]); return new Response(JSON.stringify({ status: 'checkout_pending' }), { status: 202 }); };
  const panel = renderPanel({ reservation });
  await panel.click('Create payment request');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].body, undefined);
  assert.equal(panel.updates.some(([index]) => index === 2 || index === 3), false);
  assert.match(panel.updates.find(([index, value]) => index === 8 && value)[1], /still being prepared/);
}));

test('private access requires explicit replacement consent and keeps the returned link out of session storage', async () => browserBoundary(async storage => {
  let calls = 0;
  const payload = { invitationToken: 'private-token', invitationUrl: 'https://freshairmarketsandevents.com/vendor/payment#token=private-token', expiresAt: '2026-10-02T16:00:00Z' };
  global.fetch = async (_url, options) => { calls++; assert.equal(options.body, '{}'); return new Response(JSON.stringify(payload), { status: 201 }); };
  const blocked = renderPanel({ reservation, order });
  await blocked.click('Create private vendor link');
  assert.equal(calls, 0);
  const panel = renderPanel({ reservation: { ...reservation, state: 'paid' }, replaceConfirmed: true });
  await panel.click('Create private vendor link');
  assert.equal(calls, 1);
  assert.equal(storage.size, 0);
  assert.match(panel.updates.find(([index, value]) => index === 8 && value)[1], /No email has been sent/);
  assert.deepEqual(panel.updates.find(([index, value]) => index === 3 && value)[1], { invitationUrl: payload.invitationUrl, expiresAt: payload.expiresAt });
}));
