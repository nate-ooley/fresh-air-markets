const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const postgres = require('postgres');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const modulePromise = import(pathToFileURL(path.join(__dirname, '../scripts/database-readiness.mjs')));
const configured = process.env.DATABASE_TEST_URL;
if (!configured) {
  test('database migration integration tests require disposable local PostgreSQL', { skip: 'Set DATABASE_TEST_URL for npm run test:pg' }, () => {});
} else {
  const url = new URL(configured);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Only local disposable fresh_air_test is allowed');
  const schema = `qa_database_readiness_${process.pid}`;
  const admin = postgres(configured, { max: 1, prepare: false, onnotice: () => {} });
  const connect = () => postgres(configured, { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
  const first = connect();
  const second = connect();
  const config = { FAME_MARKET_ACCOUNT_ID: 'qa-market', FAME_SEASON_ID: '2026-2027', FAME_BOOTH_CAPACITY: '30' };
  let migrations, applyMigrations, inspectSchema;
  before(async () => {
    ({ applyMigrations, inspectSchema } = await modulePromise);
    migrations = await (await modulePromise).loadMigrations();
  });
  beforeEach(async () => {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    await first.unsafe(`CREATE TABLE accounts (id TEXT PRIMARY KEY);
      CREATE TABLE booths (id TEXT PRIMARY KEY);
      CREATE TABLE bookings (id TEXT PRIMARY KEY);
      CREATE TABLE booking_dates (booking_id TEXT REFERENCES bookings(id));
      INSERT INTO accounts (id) VALUES ('qa-market');
      INSERT INTO bookings (id) VALUES ('existing-applicant-booking');`);
  });
  after(async () => {
    await first.end(); await second.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  test('read-only check detects unmigrated schema without initializing or writing it', async () => {
    const report = await first.begin('READ ONLY', tx => inspectSchema(tx, migrations, config));
    assert.equal(report.ready, false);
    assert.equal(report.pending.length, 19);
    const [row] = await first`SELECT to_regclass('fame_schema_migrations') AS table_name`;
    assert.equal(row.table_name, null);
  });
  test('all migrations apply, preserve existing records, and second run is a no-op', async () => {
    const result = await applyMigrations(first, migrations);
    assert.equal(result.applied.length, 19);
    assert.deepEqual(await applyMigrations(first, migrations), { applied: [], alreadyAppliedCount: 19 });
    const report = await first.begin('READ ONLY', tx => inspectSchema(tx, migrations, config));
    assert.equal(report.ready, true);
    assert.equal(report.appliedCount, 19);
    assert.equal((await first`SELECT id FROM bookings`)[0].id, 'existing-applicant-booking');
  });
  test('mid-sequence SQL failure rolls back the full schema upgrade and migration history', async () => {
    const broken = migrations.map((m, index) => index === 4 ? { ...m, sql: m.sql + '\nSELECT deliberately_missing_migration_function();' } : m);
    await assert.rejects(applyMigrations(first, broken));
    const [row] = await first`SELECT to_regclass('fame_applications') AS application_table,
      to_regclass('fame_schema_migrations') AS migration_table`;
    assert.equal(row.application_table, null);
    assert.equal(row.migration_table, null);
    assert.equal((await first`SELECT count(*)::int AS count FROM bookings`)[0].count, 1);
  });
  test('concurrent runners serialize and record every migration once', async () => {
    const results = await Promise.all([applyMigrations(first, migrations), applyMigrations(second, migrations)]);
    assert.deepEqual(results.map(r => r.applied.length).sort((a, b) => a - b), [0, 19]);
    assert.equal((await first`SELECT count(*)::int AS count FROM fame_schema_migrations`)[0].count, 19);
  });
  test('readiness rejects disabled identity guard, wrong tenant and wrong season despite applied history', async () => {
    await applyMigrations(first, migrations);
    await first`ALTER TABLE fame_applications DISABLE TRIGGER fame_application_opportunity_identity_guard`;
    const report = await first.begin('READ ONLY', tx => inspectSchema(tx, migrations, { ...config, FAME_MARKET_ACCOUNT_ID: 'unrelated-market', FAME_SEASON_ID: '2027-2028' }));
    assert.equal(report.ready, false);
    assert.ok(report.blockers.includes('configured_market_account_not_found'));
    assert.ok(report.blockers.includes('season_id_invalid'));
    assert.ok(report.missingObjects.some(o => o.name === 'fame_application_opportunity_identity_guard'));
  });
  test('readiness detects disabled deferred payment enqueue and missing reconciliation view', async () => {
    await applyMigrations(first, migrations);
    await first`ALTER TABLE fame_payment_orders DISABLE TRIGGER fame_payment_paid_sync_enqueue`;
    await first`DROP VIEW fame_payment_paid_sync_eligible`;
    const report = await first.begin('READ ONLY', tx => inspectSchema(tx, migrations, config));
    assert.equal(report.ready, false);
    assert.ok(report.missingObjects.some(o => o.kind === 'trigger' && o.name === 'fame_payment_paid_sync_enqueue'));
    assert.ok(report.missingObjects.some(o => o.kind === 'view' && o.name === 'fame_payment_paid_sync_eligible'));
  });
}
