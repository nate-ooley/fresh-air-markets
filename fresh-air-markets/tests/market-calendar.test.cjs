const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const { marketWeekends, marketBookableDates } = require('../.test-build/market-calendar.js');
const { upcomingWeekends } = require('../.test-build/dates.js');
const env = { FAME_MARKET_ACCOUNT_ID: 'qa-fresh-air', FAME_SEASON_ID: '2026-2027' };
const beforeSeason = new Date('2026-09-07T12:00:00Z');

test('configured Fresh Air calendar exposes all 35 unique Saturdays including May 29', () => {
  const groups = marketWeekends('qa-fresh-air', env, beforeSeason);
  const dates = [...marketBookableDates('qa-fresh-air', env, beforeSeason)];
  assert.equal(groups.length, 35);
  assert.equal(dates.length, 35);
  assert.equal(dates[0], '2026-10-03');
  assert.equal(dates.at(-1), '2027-05-29');
  assert.ok(dates.every(d => new Date(d + 'T12:00:00Z').getUTCDay() === 6));
  assert.ok(groups.every(g => g.dates.length === 1 && g.label.includes('Sat')));
  groups[0].dates[0].date = 'corrupted';
  assert.equal(marketWeekends('qa-fresh-air', env, beforeSeason)[0].dates[0].date, '2026-10-03');
});

test('calendar configuration is scoped to exact account identity and unsupported seasons fail closed', () => {
  assert.deepEqual(marketWeekends('qa-other', env, beforeSeason), upcomingWeekends(beforeSeason));
  assert.deepEqual(marketWeekends('qa-fresh-air', {}, beforeSeason), upcomingWeekends(beforeSeason));
  for (const season of ['', '2027-2028', undefined]) {
    assert.equal(marketBookableDates('qa-fresh-air', { ...env, FAME_SEASON_ID: season }, beforeSeason).size, 0);
  }
});

test('public dates close at the New York day boundary while admin retains historical season dates', () => {
  // UTC has changed to Sunday, but it is still Saturday evening in Florida.
  assert.equal(marketBookableDates('qa-fresh-air', env, new Date('2027-05-30T03:59:59Z')).has('2027-05-29'), true);
  assert.equal(marketBookableDates('qa-fresh-air', env, new Date('2027-05-30T04:00:00Z')).size, 0);
  assert.equal(marketBookableDates('qa-fresh-air', env, new Date('2027-06-01T12:00:00Z'), true).size, 35);
  assert.equal(marketBookableDates('qa-fresh-air', env, new Date('2026-11-08T04:59:59Z')).has('2026-11-07'), true);
  assert.equal(marketBookableDates('qa-fresh-air', env, new Date('2026-11-08T05:00:00Z')).has('2026-11-07'), false);
});

function loadRoute(relative, clock = beforeSeason) {
  const calls = { availability: [], writes: [], sync: [] };
  const account = { id: 'qa-fresh-air', marketName: 'QA Fresh Air', passwordHash: 'never-return-this' };
  const store = {
    getAccountBySlug: async () => account,
    getAccountById: async () => account,
    getInquiryReplay: async () => null,
    getBooth: async () => ({ id: 'qa-booth', label: 'QA', pricePerDay: 40 }),
    boothsWithAvailability: async (...args) => { calls.availability.push(args); return [{ id: 'qa-booth', bookedDates: [] }]; },
    listBookings: async () => [],
    createInquiry: async (marketId, input, total) => { calls.writes.push({ marketId, input, total }); return { id: 'qa-booking', ...input }; },
  };
  const filename = path.resolve(__dirname, '../src/app/api', relative, 'route.ts');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = id => {
    if (id === '@/lib/store') return { getStore: async () => store };
    if (id === '@/lib/auth') return { getSessionAccountId: async () => account.id };
    if (id === '@/lib/market-calendar') return { marketBookableDates: (id, _env, _date, includePast) => marketBookableDates(id, env, clock, includePast) };
    if (id === '@/lib/inquiry-rate-limit') return { inquiryClient: () => 'qa-client', consumeInquiryLimit: async () => ({ allowed: true }) };
    if (id === '@/lib/ghl') return { syncBookingToGhl: async (...args) => { calls.sync.push(args); return true; } };
    if (id.startsWith('@/lib/')) return require('../.test-build/' + id.slice(6) + '.js');
    return require(id);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return { route: mod.exports, calls };
}

test('public availability and authenticated admin overview use the same configured season', async () => {
  for (const relative of ['m/[slug]/booths', 'admin/overview']) {
    const { route, calls } = loadRoute(relative);
    const response = await route.GET(new NextRequest('https://unit-test.invalid/?dates=2026-10-03,2027-05-27,2027-05-29'), { params: Promise.resolve({ slug: 'qa' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.availability[0], ['qa-fresh-air', ['2026-10-03', '2027-05-29'], relative.startsWith('admin/')]);
    assert.equal((await response.text()).includes('never-return-this'), false);
  }
  const admin = loadRoute('admin/overview', new Date('2027-06-01T12:00:00Z'));
  await admin.route.GET(new NextRequest('https://unit-test.invalid/?dates=2026-10-03'));
  assert.deepEqual(admin.calls.availability[0][1], ['2026-10-03']);
});

test('inquiry accepts final Saturday and rejects incorrect Thursday, Friday, Sunday and past days before writes', async () => {
  const body = { name: 'QA Vendor', businessName: 'QA Calendar', email: 'nate@autocraftstudios.com', phone: '', category: 'Produce', boothId: 'qa-booth', dates: ['2027-05-29'] };
  const request = dates => new NextRequest('https://unit-test.invalid/', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': '11111111-1111-4111-8111-111111111111' }, body: JSON.stringify({ ...body, dates }) });
  const good = loadRoute('m/[slug]/inquiries');
  assert.equal((await good.route.POST(request(body.dates), { params: Promise.resolve({ slug: 'qa' }) })).status, 201);
  assert.deepEqual(good.calls.writes[0].input.dates, ['2027-05-29']);
  assert.equal(good.calls.writes[0].marketId, 'qa-fresh-air');
  assert.equal(good.calls.sync.length, 1);
  for (const dates of [['2027-05-27'], ['2027-05-28'], ['2027-05-30'], ['2026-10-03', '2027-05-27']]) {
    const bad = loadRoute('m/[slug]/inquiries');
    assert.equal((await bad.route.POST(request(dates), { params: Promise.resolve({ slug: 'qa' }) })).status, 400);
    assert.equal(bad.calls.writes.length, 0);
    assert.equal(bad.calls.sync.length, 0);
  }
  const expired = loadRoute('m/[slug]/inquiries', new Date('2027-05-30T04:00:00Z'));
  assert.equal((await expired.route.POST(request(body.dates), { params: Promise.resolve({ slug: 'qa' }) })).status, 400);
  assert.equal(expired.calls.writes.length, 0);
});
