const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const postgres = require('postgres');
const { PgStore } = require('../../.test-build/store-pg.js');
const { InquiryConflict } = require('../../.test-build/inquiry-idempotency.js');
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test');
const admin = postgres(url.toString(), { max: 1 });
const connect = () => postgres(url.toString(), { max: 10, prepare: false, connection: { search_path: 'qa_inquiry_receipts', statement_timeout: 15000 } });
const first = connect(), second = connect();
const a = new PgStore(first), b = new PgStore(second);
const market = 'qa-receipts';
const booth = (id, marketId = market) => ({ id, marketId, label: id, zone: 'QA', x: 0, y: 0, w: 40, h: 40, pricePerDay: 40, active: true });
const input = id => ({ boothId: id, name: 'QA Nate', businessName: 'QA receipts only', email: 'nate@autocraftstudios.com', phone: '', category: 'Produce', dates: ['2026-10-03', '2026-10-10'], message: 'No CRM or email in database tests' });
before(async () => {
  await admin`CREATE SCHEMA qa_inquiry_receipts`;
  await a.listBookings(market); await b.listBookings(market);
});
after(async () => {
  await first.end(); await second.end();
  await admin`DROP SCHEMA qa_inquiry_receipts CASCADE`; await admin.end();
});

test('100 identical submissions across two pools create one booking and one receipt', async () => {
  await a.createBooth(booth('race'));
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) =>
    (i % 2 ? a : b).createInquiry(market, input('race'), 80, 'race-key')));
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  assert.equal(results.filter(r => !r.replayed).length, 1);
  assert.equal((await first`SELECT * FROM inquiry_requests WHERE request_key = 'race-key'`).length, 1);
  assert.equal((await first`SELECT * FROM bookings WHERE booth_id = 'race'`).length, 1);
  assert.equal((await first`SELECT * FROM booking_dates WHERE booking_id = ${results[0].id}`).length, 2);
});

test('same key with changed vendor, dates, booth or message conflicts without mutation', async () => {
  await a.createBooth(booth('conflict'));
  const original = await a.createInquiry(market, input('conflict'), 80, 'conflict-key');
  for (const patch of [{ email: 'lnooley@gmail.com' }, { dates: ['2026-10-17'] }, { boothId: 'other' }, { message: 'changed' }]) {
    await assert.rejects(b.createInquiry(market, { ...input('conflict'), ...patch }, 1, 'conflict-key'), InquiryConflict);
  }
  assert.equal((await b.getInquiryReplay(market, input('conflict'), 'conflict-key')).id, original.id);
  assert.equal((await a.getBooking(market, original.id)).totalPrice, 80);
  assert.equal((await first`SELECT * FROM bookings WHERE booth_id = 'conflict'`).length, 1);
});

test('receipt key is market-scoped and cannot expose another market application', async () => {
  await a.createBooth(booth('own'));
  await a.createBooth(booth('other', 'qa-other'));
  const own = await a.createInquiry(market, input('own'), 80, 'shared-key');
  assert.equal(await b.getInquiryReplay('qa-other', input('own'), 'shared-key'), null);
  await assert.rejects(b.createInquiry('qa-other', input('own'), 80, 'shared-key'));
  const other = await b.createInquiry('qa-other', input('other'), 80, 'shared-key');
  assert.notEqual(other.id, own.id);
  assert.equal((await b.getInquiryReplay('qa-other', input('other'), 'shared-key')).id, other.id);
});

test('failure writing receipt rolls back booking/dates and permits exact retry', async () => {
  await a.createBooth(booth('rollback'));
  await first.unsafe(`CREATE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.request_key = 'rollback-key' THEN RAISE EXCEPTION 'injected receipt failure'; END IF;
    RETURN NEW; END $$`);
  await first.unsafe('CREATE TRIGGER fail_receipt BEFORE INSERT ON inquiry_requests FOR EACH ROW EXECUTE FUNCTION fail_receipt()');
  await assert.rejects(a.createInquiry(market, input('rollback'), 80, 'rollback-key'));
  assert.equal((await first`SELECT * FROM bookings WHERE booth_id = 'rollback'`).length, 0);
  assert.equal((await first`SELECT * FROM inquiry_requests WHERE request_key = 'rollback-key'`).length, 0);
  await first.unsafe('DROP TRIGGER fail_receipt ON inquiry_requests');
  const retried = await b.createInquiry(market, input('rollback'), 80, 'rollback-key');
  assert.equal(retried.replayed, false);
  assert.equal(retried.dates.length, 2);
});

test('reconnection/retry preserves approved then cancelled state and original quote after booth edits', async () => {
  await a.createBooth(booth('history'));
  const original = await a.createInquiry(market, input('history'), 80, 'history-key');
  await a.approveBooking(market, original.id);
  await a.updateBooth(market, 'history', { pricePerDay: 999 });
  await a.deleteBooth(market, 'history');
  const fresh = connect(), reopened = new PgStore(fresh);
  try {
    const replay = await reopened.createInquiry(market, { ...input('history'), dates: [...input('history').dates].reverse() }, 1998, 'history-key');
    assert.equal(replay.id, original.id); assert.equal(replay.status, 'approved');
    assert.equal(replay.totalPrice, 80); assert.equal(replay.replayed, true);
    await a.setBookingStatus(market, original.id, 'cancelled');
    assert.equal((await reopened.createInquiry(market, input('history'), 1998, 'history-key')).status, 'cancelled');
    assert.equal((await first`SELECT * FROM bookings WHERE booth_id = 'history'`).length, 1);
  } finally { await fresh.end(); }
});
