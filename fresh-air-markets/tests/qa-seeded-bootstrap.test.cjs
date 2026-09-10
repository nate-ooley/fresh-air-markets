const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { seededRows } = require('./qa-seeded-bootstrap-fixture.cjs');
const mod = import(pathToFileURL(path.join(__dirname, '../scripts/bootstrap-qa-account.mjs')));
const env = { VERCEL_ENV: 'preview', DATABASE_URL: 'postgresql://qa:local-test-only@ep-qa.neon.tech/neondb?sslmode=require',
  AUTH_SECRET: 'isolated-test-only-private-auth-value', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ALLOW_LIVE_PAYMENTS: 'false',
  FAME_SEASON_ID: '2026-2027', GHL_PAYMENT_EMAIL_ENABLED: 'false', GHL_PAYMENT_QA_ROUTING_VERIFIED: 'false' };
const args = ['add-to-seeded-qa', '--qa', '--expected-host=ep-qa.neon.tech', '--email=nate@autocraftstudios.com',
  '--slug=qa-fresh-air', '--qa-capacity=30', '--credentials-file=/private/qa-manager.json'];

test('seeded addition is explicit and inherits every private QA creation guard', async () => {
  const { parseOptions, validateConfig } = await mod;
  const options = parseOptions(args);
  assert.equal(validateConfig(env, options).host, 'ep-qa.neon.tech');
  for (const patch of [{ VERCEL_ENV: 'production' }, { SQUARE_ALLOW_LIVE_PAYMENTS: 'true' }, { SQUARE_ENVIRONMENT: 'production' },
    { GHL_PAYMENT_QA_ROUTING_VERIFIED: 'true' }, { GHL_PAYMENT_EMAIL_ENABLED: 'true' }, { AUTH_SECRET: 'short' },
    { FAME_BOOTH_CAPACITY: '31' }, { FAME_SEASON_ID: '2027-2028' }]) assert.throws(() => validateConfig({ ...env, ...patch }, options));
  for (const changed of [args.map(a => a.replace('nate@autocraftstudios.com', 'real-vendor@example.com')),
    args.map(a => a.replace('--slug=qa-fresh-air', '--slug=sunrise-market')), args.concat('--account-id=demo-market'),
    args.concat('--password=forbidden'), args.filter(a => !a.startsWith('--credentials-file='))]) assert.throws(() => parseOptions(changed));
  const inspect = parseOptions(['inspect-seeded-qa', '--qa', '--expected-host=ep-qa.neon.tech']);
  assert.equal(validateConfig({ ...env, AUTH_SECRET: '', FAME_SEASON_ID: '' }, inspect).host, 'ep-qa.neon.tech');
  assert.throws(() => parseOptions(['inspect-seeded-qa', '--qa', '--email=nate@autocraftstudios.com']));
});

test('recognizes real portal fixture across creation weekdays without a fixed sample count', async () => {
  const { validateSeededRows } = await mod;
  const counts = new Set();
  for (const from of ['2026-09-09T12:00:00Z', '2026-09-11T12:00:00Z', '2026-09-12T12:00:00Z', '2026-09-13T12:00:00Z']) {
    const rows = seededRows(from);
    const before = structuredClone(rows);
    const result = validateSeededRows(rows);
    counts.add(result.bookingDateCount);
    assert.equal(result.recognizedSeed, true);
    assert.deepEqual(rows, before);
  }
  assert.equal(counts.size, 3);
});

test('known seed subsets are allowed without inventing missing booths or bookings', async () => {
  const { validateSeededRows } = await mod;
  const rows = seededRows('2026-09-09T12:00:00Z');
  rows.bookings = rows.bookings.slice(0, 1);
  rows.dates = rows.dates.filter(d => d.booking_id === rows.bookings[0].id);
  rows.booths = rows.booths.filter(b => b.id === rows.bookings[0].booth_id);
  assert.deepEqual(validateSeededRows(rows), { recognizedSeed: true, accountCount: 1, boothCount: 1,
    bookingCount: 1, bookingDateCount: 3, inquiryCount: 0 });
});

test('refuses another tenant, changed demo identity/password, inquiry receipts and real vendor data', async () => {
  const { validateSeededRows } = await mod;
  const mutations = [r => r.accounts.push({ ...r.accounts[0], id: 'other-market' }),
    r => { r.accounts[0].email = 'nate@autocraftstudios.com'; }, r => { r.accounts[0].password_hash = 'not-the-seed'; },
    r => { r.inquiryCount = 1; }, r => { r.bookings[0].email = 'nate@autocraftstudios.com'; },
    r => { r.bookings[0].vendor_name = 'Actual applicant'; }, r => { r.bookings[0].message = 'Real application'; },
    r => { r.bookings[0].market_id = 'another-market'; }, r => { r.booths[0].market_id = 'another-market'; },
    r => { r.booths[0].id = 'custom-booth'; }, r => { r.booths[0].price_per_day = 120; },
    r => { r.booths[0].x = 77; }, r => { r.bookings[0].id = 'real-booking'; }];
  for (const mutate of mutations) {
    const rows = seededRows('2026-09-09T12:00:00Z'); mutate(rows);
    const before = structuredClone(rows);
    assert.throws(() => validateSeededRows(rows), /qa_seed_data_not_recognized/);
    assert.deepEqual(rows, before);
  }
});

test('refuses altered totals/dates, duplicates and orphaned references', async () => {
  const { validateSeededRows } = await mod;
  for (const mutate of [r => { r.bookings[0].total_price = 1; }, r => { r.bookings[0].created_at = 'invalid'; },
    r => { r.dates[0].date = '2027-05-29'; }, r => r.dates.pop(), r => r.dates.push({ ...r.dates[0] }),
    r => r.dates.push({ booking_id: 'unknown', date: '2026-09-11' }), r => r.booths.shift(),
    r => r.booths.push({ ...r.booths[0] }), r => r.bookings.push({ ...r.bookings[0] })]) {
    const rows = seededRows('2026-09-09T12:00:00Z'); mutate(rows);
    assert.throws(() => validateSeededRows(rows), /qa_seed_data_not_recognized/);
  }
});
