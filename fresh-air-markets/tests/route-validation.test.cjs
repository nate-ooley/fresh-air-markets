const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

// Invoke the real route functions in process. No server, browser, CRM or payment
// request is made. External boundaries are replaced with observable test doubles.
function loadRoute(relative, authenticated = true, overrides = {}, limit = async () => ({ allowed: true })) {
  let mutations = 0;
  const store = {
    getAccountBySlug: async () => ({ id: 'qa-route-market' }),
    getAccountByEmail: async () => null,
    getBooth: async () => null,
    createBooth: async () => { mutations++; },
    updateBooth: async () => { mutations++; return {}; },
    approveBooking: async () => { mutations++; return { ok: false, conflicts: [] }; },
    ...overrides,
  };
  const filename = path.resolve(__dirname, '../src/app/api', relative, 'route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/store') return { getStore: async () => store };
    if (id === '@/lib/auth') return { getSessionAccountId: async () => authenticated ? 'qa-route-market' : null };
    if (id === '@/lib/ghl') return { syncBookingToGhl: async () => { mutations++; } };
    if (id === '@/lib/inquiry-rate-limit') return { consumeInquiryLimit: limit, inquiryClient: () => 'qa-client' };
    if (id.startsWith('@/lib/')) return require('../.test-build/' + id.slice(6) + '.js');
    return require(id);
  };
  mod._compile(compiled, filename);
  return { route: mod.exports, mutations: () => mutations };
}

const cases = [
  ['auth/login', 'POST'], ['auth/signup', 'POST'],
  ['m/[slug]/inquiries', 'POST'], ['admin/bookings/[id]', 'PATCH'],
  ['admin/booths', 'POST'], ['admin/booths/[id]', 'PATCH'],
];

for (const [relative, method] of cases) {
  test(`${relative}: malformed and non-object JSON return 400 without mutations`, async () => {
    for (const body of ['null', '[]', '42', 'true', '"hello"', '{broken']) {
      const { route, mutations } = loadRoute(relative);
      const req = new NextRequest('https://unit-test.invalid/', { method, body, headers: { 'content-type': 'application/json' } });
      const response = await route[method](req, { params: Promise.resolve({ slug: 'qa', id: 'qa' }) });
      assert.equal(response.status, 400, `${relative} body=${body}`);
      assert.equal(mutations(), 0, 'invalid payload must not write or synchronize');
    }
  });
}

test('admin mutation routes reject missing authentication before reading the body', async () => {
  for (const [relative, method] of cases.filter(([r]) => r.startsWith('admin/'))) {
    const { route, mutations } = loadRoute(relative, false);
    const req = new NextRequest('https://unit-test.invalid/', { method, body: 'null' });
    const response = await route[method](req, { params: Promise.resolve({ id: 'qa' }) });
    assert.equal(response.status, 401);
    assert.equal(mutations(), 0);
  }
});

test('replayed approval does not send another HighLevel lifecycle event', async () => {
  const { route, mutations } = loadRoute('admin/bookings/[id]', true, {
    approveBooking: async () => ({ ok: true, alreadyApproved: true, booking: { id: 'qa', boothId: 'qa-booth', status: 'approved' } }),
  });
  const response = await route.PATCH(new NextRequest('https://unit-test.invalid/', { method: 'PATCH', body: '{"action":"approve"}' }), { params: Promise.resolve({ id: 'qa' }) });
  assert.equal(response.status, 200);
  assert.equal(mutations(), 0);
});

function inquiryBody() {
  const { bookableDates } = require('../.test-build/dates.js');
  return { name: 'QA Nate', businessName: "QA Nate's Citrus & Crafts", email: 'nate@autocraftstudios.com',
    category: 'Crafts & Artisan', boothId: 'qa-booth', dates: [[...bookableDates()][0]] };
}

async function callInquiry(body) {
  const writes = [];
  const { route, mutations } = loadRoute('m/[slug]/inquiries', true, {
    getBooth: async () => ({ id: 'qa-booth', label: 'QA', pricePerDay: 40 }),
    boothsWithAvailability: async () => [{ id: 'qa-booth', bookedDates: [] }],
    createInquiry: async (account, data, totalPrice) => {
      writes.push({ account, data, totalPrice });
      return { id: 'qa-inquiry', ...data };
    },
  });
  const response = await route.POST(new NextRequest('https://unit-test.invalid/', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }), { params: Promise.resolve({ slug: 'qa' }) });
  return { response, writes, syncs: mutations() };
}

test('inquiry rejects array/object/boolean/number required text fields without writes or email sync', async () => {
  for (const field of ['name', 'businessName', 'email', 'category', 'boothId']) {
    for (const value of [[inquiryBody()[field]], { value: inquiryBody()[field] }, true, 123, null]) {
      const result = await callInquiry({ ...inquiryBody(), [field]: value });
      assert.equal(result.response.status, 400, field + ':' + JSON.stringify(value));
      assert.equal(result.writes.length, 0);
      assert.equal(result.syncs, 0);
    }
  }
});

test('inquiry optional text allows omission and empty strings but rejects structured values', async () => {
  for (const field of ['phone', 'message']) {
    for (const value of [[], {}, false, 0, null]) {
      const result = await callInquiry({ ...inquiryBody(), [field]: value });
      assert.equal(result.response.status, 400);
      assert.equal(result.writes.length + result.syncs, 0);
    }
  }
  for (const body of [inquiryBody(), { ...inquiryBody(), phone: '', message: '' }]) {
    const result = await callInquiry(body);
    assert.equal(result.response.status, 201);
    assert.equal(result.writes.length, 1);
    assert.equal(result.syncs, 1);
  }
});

test('inquiry text size boundaries preserve allowed content and reject overflow', async () => {
  for (const [field, limit] of Object.entries({ name: 200, businessName: 200, phone: 40, message: 2000 })) {
    const accepted = await callInquiry({ ...inquiryBody(), [field]: 'x'.repeat(limit) });
    assert.equal(accepted.response.status, 201, field);
    assert.equal(accepted.writes[0].data[field].length, limit);
    const rejected = await callInquiry({ ...inquiryBody(), [field]: 'x'.repeat(limit + 1) });
    assert.equal(rejected.response.status, 400, field);
    assert.equal(rejected.writes.length + rejected.syncs, 0);
  }
});

test('inquiry rejects nested, non-string, missing, invalid and excessive date input', async () => {
  const { bookableDates } = require('../.test-build/dates.js');
  const date = inquiryBody().dates[0];
  for (const dates of [undefined, null, date, [], [[date]], [{}], [1], ['not-a-date'], Array(bookableDates().size + 1).fill(date)]) {
    const result = await callInquiry({ ...inquiryBody(), dates });
    assert.equal(result.response.status, 400, JSON.stringify(dates));
    assert.equal(result.writes.length + result.syncs, 0);
  }
});

test('inquiry normalizes email and duplicate dates while preserving punctuation and correct market', async () => {
  const body = inquiryBody();
  body.email = '  NATE@AUTOCRAFTSTUDIOS.COM  ';
  body.name = '  QA Nate  ';
  body.dates = [body.dates[0], body.dates[0]];
  const result = await callInquiry(body);
  assert.equal(result.response.status, 201);
  assert.equal(result.writes.length, 1);
  assert.equal(result.syncs, 1);
  assert.equal(result.writes[0].account, 'qa-route-market');
  assert.equal(result.writes[0].data.email, 'nate@autocraftstudios.com');
  assert.equal(result.writes[0].data.name, 'QA Nate');
  assert.equal(result.writes[0].data.businessName, "QA Nate's Citrus & Crafts");
  assert.deepEqual(result.writes[0].data.dates, [body.dates[0]]);
  assert.equal(result.writes[0].totalPrice, 40);
});

test('inquiry IP limit stops before body parsing, market lookup, booking writes and CRM sync', async () => {
  let lookups = 0;
  const { route, mutations } = loadRoute('m/[slug]/inquiries', true, {
    getAccountBySlug: async () => { lookups++; },
  }, async (kind) => { assert.equal(kind, 'ip'); return { allowed: false, retryAfterSeconds: 123 }; });
  const req = new NextRequest('https://unit-test.invalid/', { method: 'POST', body: '{broken' });
  const response = await route.POST(req, { params: Promise.resolve({ slug: 'qa' }) });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '123');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(req.bodyUsed, false);
  assert.equal(lookups + mutations(), 0);
});

test('inquiry email limit uses normalized market identity and blocks all downstream writes/sends', async () => {
  let writes = 0;
  const limits = [];
  const { route, mutations } = loadRoute('m/[slug]/inquiries', true, {
    getBooth: async () => ({ id: 'qa-booth', label: 'QA', pricePerDay: 40 }),
    createInquiry: async () => { writes++; },
  }, async (kind, subject) => {
    limits.push([kind, subject]);
    return { allowed: kind === 'ip', retryAfterSeconds: 600 };
  });
  const req = new NextRequest('https://unit-test.invalid/', { method: 'POST', body: JSON.stringify({ ...inquiryBody(), email: ' NATE@AUTOCRAFTSTUDIOS.COM ' }) });
  const response = await route.POST(req, { params: Promise.resolve({ slug: 'qa' }) });
  assert.equal(response.status, 429);
  assert.deepEqual(limits, [['ip', 'qa-client'], ['email', JSON.stringify(['qa-route-market', 'nate@autocraftstudios.com'])]]);
  assert.equal(writes + mutations(), 0);
});

test('inquiry fails closed when either shared limiter operation fails', async () => {
  for (const failedKind of ['ip', 'email']) {
    const { route, mutations } = loadRoute('m/[slug]/inquiries', true, {
      getBooth: async () => ({ id: 'qa-booth', label: 'QA', pricePerDay: 40 }),
    }, async kind => { if (kind === failedKind) throw new Error('Database unavailable'); return { allowed: true }; });
    const response = await route.POST(new NextRequest('https://unit-test.invalid/', { method: 'POST', body: JSON.stringify(inquiryBody()) }), { params: Promise.resolve({ slug: 'qa' }) });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(mutations(), 0);
    assert.doesNotMatch(await response.text(), /Database unavailable/);
  }
});

test('inquiry blocks oversized bodies even with false or absent content length', async () => {
  for (const headers of [{}, { 'content-length': '1' }, { 'content-length': '999999' }]) {
    const { route, mutations } = loadRoute('m/[slug]/inquiries');
    const response = await route.POST(new NextRequest('https://unit-test.invalid/', {
      method: 'POST', headers, body: JSON.stringify({ ...inquiryBody(), message: 'x'.repeat(32768) }),
    }), { params: Promise.resolve({ slug: 'qa' }) });
    assert.equal(response.status, 413);
    assert.equal(mutations(), 0);
  }
});
