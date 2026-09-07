const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const postgres = require('postgres');
const { PgStore } = require('../../.test-build/store-pg.js');

const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const admin = postgres(url.toString(), { max: 1 });
const connect = () => postgres(url.toString(), { max: 10, prepare: false, connection: { search_path: 'qa_booking_store', statement_timeout: 15000 } });
const first = connect();
const second = connect();
const a = new PgStore(first);
const b = new PgStore(second);
const market = 'qa-booking-market';
const vendor = { name: 'FAME QA Only', businessName: 'QA Database Tests', email: 'nate@autocraftstudios.com', phone: '', category: 'Produce', message: 'Disposable database; no CRM or messages' };
const booth = id => ({ id, marketId: market, label: id, zone: 'QA', x: 0, y: 0, w: 40, h: 40, pricePerDay: 40, active: true });
const inquiry = (store, id, dates = ['2026-10-03'], email = vendor.email) => store.createInquiry(market, { ...vendor, email, boothId: id, dates }, dates.length * 40);
before(async () => {
  await admin`CREATE SCHEMA qa_booking_store`;
  // Exercise the actual full schema initialization, not a hand-written replica.
  await a.listBookings(market);
  await b.listBookings(market);
});
after(async () => {
  await first.end(); await second.end();
  await admin`DROP SCHEMA qa_booking_store CASCADE`;
  await admin.end();
});

test('twenty competing PostgreSQL approvals have one winner; concurrent replay is idempotent', async () => {
  await a.createBooth(booth('qa-race'));
  const requests = await Promise.all(Array.from({ length: 20 }, (_, i) => inquiry(i % 2 ? a : b, 'qa-race', ['2026-10-03'], i % 2 ? vendor.email : 'lnooley@gmail.com')));
  const results = await Promise.all(requests.map((request, i) => (i % 2 ? a : b).approveBooking(market, request.id)));
  assert.equal(results.filter(x => x.ok).length, 1);
  assert.equal(results.filter(x => !x.ok && x.conflicts.length === 1).length, 19);
  const winner = results.find(x => x.ok).booking;
  const repeats = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).approveBooking(market, winner.id)));
  assert.ok(repeats.every(x => x.ok && x.alreadyApproved));
  assert.equal((await a.listBookings(market)).filter(x => x.boothId === 'qa-race' && x.status === 'approved').length, 1);
  const publicBooth = (await a.boothsWithAvailability(market, ['2026-10-03'], false)).find(x => x.id === 'qa-race');
  assert.equal(publicBooth.status, 'rented');
  assert.equal('occupants' in publicBooth, false);
});

test('partial-date conflict allocates nothing; cancellation releases capacity and late approval stays blocked', async () => {
  await a.createBooth(booth('qa-partial'));
  const existing = await inquiry(a, 'qa-partial');
  await a.approveBooking(market, existing.id);
  const request = await inquiry(b, 'qa-partial', ['2026-10-03', '2026-10-10']);
  assert.equal((await b.approveBooking(market, request.id)).ok, false);
  assert.equal((await a.getBooking(market, request.id)).status, 'pending');
  assert.equal((await a.boothsWithAvailability(market, ['2026-10-10'], false)).find(x => x.id === 'qa-partial').status, 'available');
  await a.setBookingStatus(market, existing.id, 'cancelled');
  assert.equal((await b.approveBooking(market, request.id)).ok, true);
  assert.equal((await b.approveBooking(market, existing.id)).ok, false);
  await a.setBookingStatus(market, request.id, 'rejected');
  assert.equal((await b.approveBooking(market, request.id)).ok, false);
});

test('another market cannot create against, read, approve, cancel or edit an owned booth booking', async () => {
  await a.createBooth(booth('qa-owner'));
  const request = await inquiry(a, 'qa-owner');
  assert.equal(await b.getBooking('qa-other-market', request.id), null);
  assert.equal((await b.approveBooking('qa-other-market', request.id)).ok, false);
  assert.equal(await b.setBookingStatus('qa-other-market', request.id, 'cancelled'), null);
  assert.equal(await b.getBooth('qa-other-market', 'qa-owner'), null);
  assert.equal(await b.updateBooth('qa-other-market', 'qa-owner', { pricePerDay: 1 }), null);
  await assert.rejects(b.createInquiry('qa-other-market', { ...vendor, boothId: 'qa-owner', dates: ['2026-10-03'] }, 40));
  assert.equal((await a.getBooking(market, request.id)).status, 'pending');
  assert.equal((await b.listBookings('qa-other-market')).length, 0);
});

test('failure after inserting one date rolls back booking and dates, allowing a clean corrected retry', async () => {
  await a.createBooth(booth('qa-rollback'));
  await assert.rejects(inquiry(a, 'qa-rollback', ['2026-10-03', 'invalid-date']));
  const rows = await first`SELECT b.id FROM bookings b WHERE b.booth_id = 'qa-rollback'`;
  assert.equal(rows.length, 0);
  const orphans = await first`SELECT d.booking_id FROM booking_dates d LEFT JOIN bookings b ON b.id = d.booking_id WHERE b.id IS NULL`;
  assert.equal(orphans.length, 0);
  const retried = await inquiry(b, 'qa-rollback', ['2026-10-03', '2026-10-10']);
  assert.deepEqual(retried.dates, ['2026-10-03', '2026-10-10']);
  assert.equal((await a.approveBooking(market, retried.id)).ok, true);
});

test('new database connections retain committed approval and reject an inactive booth', async () => {
  await a.createBooth(booth('qa-reconnect'));
  const request = await inquiry(a, 'qa-reconnect');
  await a.approveBooking(market, request.id);
  await a.createBooth(booth('qa-removed'));
  const removed = await inquiry(a, 'qa-removed');
  await a.deleteBooth(market, 'qa-removed');
  const fresh = connect();
  const reopened = new PgStore(fresh);
  try {
    assert.equal((await reopened.getBooking(market, request.id)).status, 'approved');
    assert.deepEqual((await reopened.getBooking(market, request.id)).dates, request.dates);
    assert.equal((await reopened.approveBooking(market, request.id)).alreadyApproved, true);
    assert.equal((await reopened.approveBooking(market, removed.id)).ok, false);
    await assert.rejects(inquiry(reopened, 'qa-removed'));
  } finally { await fresh.end(); }
});
