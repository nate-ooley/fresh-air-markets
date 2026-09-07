const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

// Invoke the real route functions in process. No server, browser, CRM or payment
// request is made. External boundaries are replaced with observable test doubles.
function loadRoute(relative, authenticated = true, overrides = {}) {
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
