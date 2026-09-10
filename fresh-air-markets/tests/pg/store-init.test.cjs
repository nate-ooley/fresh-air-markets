const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const postgres = require('postgres');
const { PgStore } = require('../../.test-build/store-pg.js');

const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = `qa_store_init_${process.pid}`;
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
const connect = () => postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
const first = connect(), second = connect(), third = connect();
before(async () => { await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.unsafe(`CREATE SCHEMA ${schema}`); });
after(async () => {
  await first.end(); await second.end(); await third.end();
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test('production initialization creates the base schema, seeds no demo tenant, and rejects nothing on warm restarts', async () => {
  process.env.VERCEL_ENV = 'production';
  const a = new PgStore(first), b = new PgStore(second);
  // Concurrent cold starts must serialize rather than race CREATE TABLE.
  await Promise.all([a.listBookings('fame-market'), b.listBookings('fame-market')]);
  const names = await admin`SELECT tablename FROM pg_tables WHERE schemaname = ${schema} ORDER BY tablename`;
  assert.deepEqual(names.map(r => r.tablename), ['accounts', 'booking_dates', 'bookings', 'booths', 'inquiry_requests']);
  assert.equal((await first`SELECT count(*)::int AS count FROM accounts`)[0].count, 0);
  assert.equal(await a.getAccountBySlug('sunrise-market'), null);
  assert.equal(await a.getAccountByEmail('demo@freshairmarkets.app'), null);
  // A warm schema is adopted without DDL: hold an exclusive lock on bookings and
  // prove a fresh instance still initializes instead of queuing behind it.
  await first.begin(async tx => {
    await tx`LOCK TABLE bookings IN ACCESS EXCLUSIVE MODE`;
    const c = new PgStore(third);
    const result = await Promise.race([
      c.getAccountBySlug('anything').then(() => 'initialized'),
      new Promise(resolve => setTimeout(() => resolve('blocked'), 3000)),
    ]);
    assert.equal(result, 'initialized');
  });
  assert.equal((await first`SELECT count(*)::int AS count FROM accounts`)[0].count, 0);
});

test('outside production the demo tenant is seeded exactly once even under concurrent cold starts', async () => {
  delete process.env.VERCEL_ENV;
  await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`); await admin.unsafe(`CREATE SCHEMA ${schema}`);
  // Fresh connections get a fresh initializer; they are closed so the test process can exit.
  const c1 = connect(), c2 = connect();
  try {
    const a = new PgStore(c1), b = new PgStore(c2);
    await Promise.all([a.listBookings('demo-market'), b.listBookings('demo-market')]);
    assert.equal((await first`SELECT count(*)::int AS count FROM accounts`)[0].count, 1);
    assert.equal((await a.getAccountBySlug('sunrise-market')).email, 'demo@freshairmarkets.app');
    assert.equal((await first`SELECT count(*)::int AS count FROM booths WHERE market_id = 'demo-market'`)[0].count, 30);
    assert.equal((await first`SELECT count(*)::int AS count FROM bookings WHERE market_id = 'demo-market'`)[0].count, 4);
  } finally { await c1.end(); await c2.end(); }
});
