const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const applicationId = '11111111-1111-4111-8111-111111111111';
const idempotencyKey = '22222222-2222-4222-8222-222222222222';
const parsedSelection = {
  applicantType: 'Vendor', vendorCategory: 'Arts & Crafts', selectedDates: ['2026-10-03'],
  fullSeason: false, boothsPerMarket: 1, foodLicenseRequired: false, idempotencyKey,
};

function loadRoute({ authenticated = true, configured = true, parser, reserve, bodyReader, read } = {}) {
  const filename = path.resolve(__dirname, '../src/app/api/admin/applications/[id]/reserve/route.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => {
    if (id === '@/lib/auth') return { getSessionAccountId: async () => authenticated ? 'qa-market' : null };
    if (id === '@/lib/final-reservation') return {
      validFinalReservationApplicationId: value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
      parseFinalReservationSelection: parser || (() => parsedSelection),
    };
    if (id === '@/lib/final-reservation-pg') return {
      freshAirFinalReservationConfig: () => {
        if (!configured) throw new Error('not configured');
        return { marketId: 'qa-market', seasonId: '2026-2027', boothCapacity: 12, calendarDates: [], quoteVersion: 'qa-v1' };
      },
      getFinalApplicationReservation: read || (async () => ({ reservation: null })),
      reserveFinalApplication: reserve || (async () => ({ kind: 'not_found' })),
    };
    if (id === '@/lib/inquiry-body') return {
      readInquiryBody: bodyReader || (async request => ({ body: JSON.parse(await request.text()) })),
    };
    return require(id);
  };
  mod._compile(compiled, filename);
  return mod.exports;
}

function request(body = {}) {
  return new NextRequest('https://unit-test.invalid/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
}

async function withDatabase(fn) {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://qa/unused';
  try { await fn(); }
  finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
}

test('reserve route requires a manager session before reading input or storage', async () => {
  let reads = 0;
  let writes = 0;
  const route = loadRoute({
    authenticated: false,
    bodyReader: async () => { reads++; return { body: {} }; },
    reserve: async () => { writes++; throw new Error('must not run'); },
  });
  const response = await route.POST(request(), { params: Promise.resolve({ id: applicationId }) });
  assert.equal(response.status, 401);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('reserve route fails closed for missing storage, invalid path/body/retry, and missing capacity configuration', async () => {
  let reads = 0;
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const response = await loadRoute({ bodyReader: async () => { reads++; return { body: {} }; } })
      .POST(request(), { params: Promise.resolve({ id: applicationId }) });
    assert.equal(response.status, 503);
    assert.equal(reads, 0);
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
  await withDatabase(async () => {
    assert.equal((await loadRoute().POST(request(), { params: Promise.resolve({ id: '../other' }) })).status, 400);
    assert.equal((await loadRoute({ parser: () => null }).POST(request(), { params: Promise.resolve({ id: applicationId }) })).status, 400);
    assert.equal((await loadRoute({ configured: false }).POST(request(), { params: Promise.resolve({ id: applicationId }) })).status, 503);
  });
});

test('reserve route binds only the signed-in market and application path, never browser identity or price fields', async () => {
  await withDatabase(async () => {
    let parseInput;
    let writeInput;
    const route = loadRoute({
      parser: (body, key) => { parseInput = { body, key }; return parsedSelection; },
      reserve: async input => {
        writeInput = input;
        return { kind: 'created', reservation: {
          id: 'reservation-1', state: 'held', paymentRequired: true, totalCents: 4000,
          finalDates: ['2026-10-03'], finalBoothQuantity: 1, quoteVersion: 'qa-v1',
        } };
      },
    });
    const body = { applicationId: 'attacker-app', marketId: 'attacker-market', totalCents: 1, squareToken: 'attacker-token' };
    const response = await route.POST(request(body), { params: Promise.resolve({ id: applicationId }) });
    assert.equal(response.status, 201);
    assert.deepEqual(parseInput, { body, key: idempotencyKey });
    assert.deepEqual(writeInput, {
      marketId: 'qa-market', applicationId, actorAccountId: 'qa-market',
      selection: parsedSelection,
      config: { marketId: 'qa-market', seasonId: '2026-2027', boothCapacity: 12, calendarDates: [], quoteVersion: 'qa-v1' },
    });
    assert.deepEqual(await response.json(), { reservation: {
      id: 'reservation-1', state: 'held', paymentRequired: true, totalCents: 4000,
      finalDates: ['2026-10-03'], finalBoothQuantity: 1, quoteVersion: 'qa-v1',
    }, duplicate: false });
  });
});

test('reserve route maps immutable replay, eligibility, capacity and persistence outcomes without payment work', async () => {
  await withDatabase(async () => {
    const cases = [
      [{ kind: 'duplicate', reservation: { id: 'reservation-1', state: 'paid', paymentRequired: true, totalCents: 4000, finalDates: ['2026-10-03'], finalBoothQuantity: 1, quoteVersion: 'qa-v1' } }, 200],
      [{ kind: 'not_found' }, 404],
      [{ kind: 'conflict' }, 409],
      [{ kind: 'invalid_selection' }, 400],
      [{ kind: 'not_eligible', reason: 'insurance_not_approved' }, 409],
      [{ kind: 'unavailable', availability: [{ date: '2026-10-03', available: false, reasons: ['Not enough booth spaces'] }] }, 409],
    ];
    for (const [result, status] of cases) {
      const response = await loadRoute({ reserve: async () => result })
        .POST(request(), { params: Promise.resolve({ id: applicationId }) });
      assert.equal(response.status, status);
      assert.equal((await response.json()).paymentOrder, undefined);
    }
  });
});


test('reservation reload reads only the session market and exact application without creating a hold', async () => {
  await withDatabase(async () => {
    let captured;
    const route = loadRoute({ read: async (...args) => { captured = args; return { reservation: null }; }, reserve: async () => { throw new Error('must not mutate'); } });
    const response = await route.GET(request(), { params: Promise.resolve({ id: applicationId }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(captured, ['qa-market', applicationId]);
    assert.deepEqual(await response.json(), { reservation: null });
  });
});

test('reservation reload rejects anonymous, invalid, foreign and unavailable storage safely', async () => {
  await withDatabase(async () => {
    const ctx = { params: Promise.resolve({ id: applicationId }) };
    assert.equal((await loadRoute({ authenticated: false }).GET(request(), ctx)).status, 401);
    assert.equal((await loadRoute().GET(request(), { params: Promise.resolve({ id: '../bad' }) })).status, 400);
    assert.equal((await loadRoute({ read: async () => null }).GET(request(), ctx)).status, 404);
    const failure = await loadRoute({ read: async () => { throw new Error('private connection secret'); } }).GET(request(), ctx);
    assert.equal(failure.status, 503);
    assert.doesNotMatch(await failure.text(), /private connection/);
  });
});
