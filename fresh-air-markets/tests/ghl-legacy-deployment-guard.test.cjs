const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Exercise the real legacy adapter and date formatting, with no live transport.
// Loading directly also keeps this test independent of the shared build list.
function loadSource(name) {
  const filename = path.resolve(__dirname, '../src/lib', name + '.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = id => id === './dates' ? loadSource('dates') : require(id);
  mod._compile(compiled, filename);
  return mod.exports;
}
const { syncBookingToGhl, syncOperatorToGhl } = loadSource('ghl');
const FRESH_AIR_LOCATION = 'aooAnUXF0COePorBo7wL';
const EVENTS = ['booth-inquiry', 'booth-approved', 'booth-rejected'];
const operator = marketId => ({ id: marketId, ownerName: 'Test Operator', email: 'operator-private@example.invalid', marketName: 'Test Market', plan: 'starter' });
const booking = marketId => ({
  id: 'legacy-booking', marketId, boothId: 'booth-1', dates: ['2026-10-03'], totalPrice: 40, message: 'Private booking note',
  vendor: { name: 'Test Vendor', email: 'vendor-private@example.invalid', phone: '5550100', businessName: 'Test Booth', category: 'Arts & Crafts' },
});

async function withDeployment(patch, run) {
  const keys = ['GHL_API_TOKEN', 'GHL_LOCATION_ID', 'FAME_MARKET_ACCOUNT_ID'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const oldFetch = global.fetch;
  const oldLog = console.log;
  const oldError = console.error;
  const calls = [];
  const logs = [];
  for (const key of keys) {
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return Response.json({ contact: { id: 'legacy-contact' } });
  };
  console.log = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  try { await run({ calls, logs }); }
  finally {
    global.fetch = oldFetch;
    console.log = oldLog;
    console.error = oldError;
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

async function assertEverySyncBlocked(state) {
  for (const marketId of ['demo-market', 'another-market', 'fresh-air-market']) {
    assert.equal(await syncOperatorToGhl(operator(marketId)), false);
    for (const event of EVENTS) assert.equal(await syncBookingToGhl(booking(marketId), event, 'A1'), false);
  }
  assert.deepEqual(state.calls, [], 'blocked deployments must never reach contacts/upsert or notes');
  assert.deepEqual(state.logs, [], 'blocked paths must not log private email, token, or provider data');
}

test('Fresh Air location alone blocks every legacy event and operator regardless of caller market', async () => {
  await withDeployment({ GHL_LOCATION_ID: FRESH_AIR_LOCATION, GHL_API_TOKEN: 'test-token-not-a-live-credential' }, assertEverySyncBlocked);
});

test('whitespace around the Fresh Air location cannot bypass the deployment guard', async () => {
  await withDeployment({ GHL_LOCATION_ID: ' ' + FRESH_AIR_LOCATION + ' ', GHL_API_TOKEN: 'test-token-not-a-live-credential' }, assertEverySyncBlocked);
});

test('a Fresh Air mapping blocks legacy sync even with mismatched, missing, or malformed location', async () => {
  for (const GHL_LOCATION_ID of ['unrelated-legacy-location', undefined, '']) {
    await withDeployment({ FAME_MARKET_ACCOUNT_ID: 'fresh-air-market', GHL_LOCATION_ID, GHL_API_TOKEN: 'test-token-not-a-live-credential' }, assertEverySyncBlocked);
  }
});

test('present but empty mappings and missing Fresh Air tokens fail closed without private skip logs', async () => {
  for (const FAME_MARKET_ACCOUNT_ID of ['', ' ']) {
    await withDeployment({ FAME_MARKET_ACCOUNT_ID, GHL_LOCATION_ID: 'unrelated-legacy-location', GHL_API_TOKEN: 'test-token-not-a-live-credential' }, assertEverySyncBlocked);
  }
  await withDeployment({ GHL_LOCATION_ID: FRESH_AIR_LOCATION }, assertEverySyncBlocked);
});

test('concurrent mixed legacy calls cannot start a Fresh Air contact upsert or note', async () => {
  await withDeployment({ GHL_LOCATION_ID: FRESH_AIR_LOCATION, GHL_API_TOKEN: 'test-token-not-a-live-credential' }, async state => {
    const results = await Promise.all([
      ...EVENTS.map(event => syncBookingToGhl(booking('demo-market'), event, 'A1')),
      syncOperatorToGhl(operator('another-market')), syncOperatorToGhl(operator('demo-market')),
    ]);
    assert.deepEqual(results, Array(5).fill(false));
    assert.deepEqual(state.calls, []);
    assert.deepEqual(state.logs, []);
  });
});

test('unrelated explicitly configured legacy deployments keep operator tags, all booking tags, and notes', async () => {
  await withDeployment({ GHL_LOCATION_ID: 'unrelated-legacy-location', GHL_API_TOKEN: 'legacy-test-token-not-a-live-credential' }, async ({ calls, logs }) => {
    assert.equal(await syncOperatorToGhl(operator('legacy-market')), true);
    assert.deepEqual(calls[0].body.tags, ['bhq-signup', 'bhq-plan-starter']);
    assert.equal(calls[0].body.locationId, 'unrelated-legacy-location');
    assert.equal(calls[0].body.email, operator().email);
    for (const event of EVENTS) {
      assert.equal(await syncBookingToGhl(booking('legacy-market'), event, 'A1'), true);
      const upsert = calls.at(-2);
      const note = calls.at(-1);
      assert.equal(upsert.url, 'https://services.leadconnectorhq.com/contacts/upsert');
      assert.equal(upsert.body.locationId, 'unrelated-legacy-location');
      assert.deepEqual(upsert.body.tags, [event, 'category-arts-crafts']);
      assert.equal(upsert.body.email, booking().vendor.email);
      assert.equal(note.url, 'https://services.leadconnectorhq.com/contacts/legacy-contact/notes');
      assert.ok(note.body.body.includes(event.replace('booth-', '').toUpperCase() + ': Booth A1'));
      assert.ok(note.body.body.includes('Total $40.'));
    }
    assert.equal(calls.length, 7);
    for (const call of calls) {
      assert.equal(call.init.method, 'POST');
      assert.equal(call.init.headers.Version, '2021-07-28');
      assert.equal(call.init.headers.Authorization, 'Bearer legacy-test-token-not-a-live-credential');
    }
    assert.deepEqual(logs, []);
  });
});
