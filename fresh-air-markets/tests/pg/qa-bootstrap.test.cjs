const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const postgres = require('postgres');
const { verifyPassword } = require('../../.test-build/auth.js');
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Only local disposable fresh_air_test is allowed');
const schema = `qa_bootstrap_${process.pid}`;
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
const connect = () => postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
const first = connect(), second = connect();
const credentials = {
  accountId: 'qa-c18b93d1-f7af-4b4c-a83e-5bd79b92643d', email: 'nate@autocraftstudios.com', slug: 'qa-bootstrap',
  password: 'disposable-local-test-only-password', ownerName: 'Fresh Air QA', marketName: 'Fresh Air QA',
  plan: 'starter', licenseStatus: 'trial', licenseKey: 'FAM-1234-5678-9ABC',
  createdAt: '2026-09-09T12:00:00.000Z', trialEndsAt: '2026-09-23T12:00:00.000Z',
};
let bootstrap, readiness;
before(async () => {
  bootstrap = await import(pathToFileURL(path.join(__dirname, '../../scripts/bootstrap-qa-account.mjs')));
  readiness = await import(pathToFileURL(path.join(__dirname, '../../scripts/database-readiness.mjs')));
});
beforeEach(async () => {
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
});
after(async () => {
  await first.end(); await second.end();
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test('fresh bootstrap atomically creates one usable private account and no demo/applicant rows', async () => {
  assert.deepEqual(await bootstrap.inspectQaDatabase(first), { empty: true, relationCount: 0, routineCount: 0 });
  assert.equal((await bootstrap.createQaAccount(first, credentials)).status, 'created');
  const rows = await first`SELECT * FROM accounts`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, credentials.accountId);
  assert.equal(verifyPassword(credentials.password, rows[0].password_hash), true);
  for (const table of ['booths', 'bookings', 'booking_dates']) assert.equal((await first.unsafe(`SELECT count(*)::int AS count FROM ${table}`))[0].count, 0);
  const names = await first`SELECT tablename FROM pg_tables WHERE schemaname = ${schema} ORDER BY tablename`;
  assert.deepEqual(names.map(r => r.tablename), ['accounts','booking_dates','bookings','booths']);
});

test('concurrent create and retry use one account without changing its password or attributes', async () => {
  const result = await Promise.all([bootstrap.createQaAccount(first, credentials), bootstrap.createQaAccount(second, credentials)]);
  assert.deepEqual(result.map(r => r.status).sort(), ['created', 'verified_existing']);
  const before = await first`SELECT * FROM accounts`;
  assert.equal((await bootstrap.createQaAccount(second, credentials)).status, 'verified_existing');
  assert.deepEqual(await first`SELECT * FROM accounts`, before);
  await assert.rejects(bootstrap.createQaAccount(second, { ...credentials, password: 'wrong private retry identity' }), /qa_existing_account_mismatch/);
  assert.deepEqual(await first`SELECT * FROM accounts`, before);
});

test('nonempty unrelated schema is preserved and failures roll back every base table', async () => {
  await first`CREATE TABLE existing_business_data (value TEXT)`;
  await first`INSERT INTO existing_business_data VALUES ('preserve')`;
  await assert.rejects(bootstrap.createQaAccount(first, credentials), /qa_base_schema_missing/);
  assert.equal((await first`SELECT value FROM existing_business_data`)[0].value, 'preserve');
  assert.equal((await first`SELECT to_regclass('accounts') AS name`)[0].name, null);
  await first`DROP TABLE existing_business_data`;
  await assert.rejects(bootstrap.createQaAccount(first, { ...credentials, trialEndsAt: 'not-a-timestamp' }));
  assert.deepEqual(await bootstrap.inspectQaDatabase(first), { empty: true, relationCount: 0, routineCount: 0 });
});

test('verified existing account is read-only and cannot select the demo or another identity', async () => {
  await bootstrap.createQaAccount(first, credentials);
  await first`INSERT INTO booths (id,market_id,label,x,y,w,h) VALUES ('qa-preserved-booth',${credentials.accountId},'QA',0,0,10,10)`;
  const before = await first`SELECT * FROM accounts`;
  const readonly = { begin: async (mode, fn) => {
    assert.equal(mode, 'READ ONLY');
    return first.begin(mode, fn);
  } };
  assert.equal((await bootstrap.verifyExistingQaAccount(readonly, { accountId: credentials.accountId, email: credentials.email })).status, 'verified_existing');
  await assert.rejects(bootstrap.verifyExistingQaAccount(first, { accountId: 'demo-market', email: credentials.email }));
  await assert.rejects(bootstrap.verifyExistingQaAccount(first, { accountId: credentials.accountId, email: 'lnooley@gmail.com' }), /qa_existing_account_mismatch/);
  assert.deepEqual(await first`SELECT * FROM accounts`, before);
  assert.equal((await first`SELECT count(*)::int AS count FROM booths`)[0].count, 1);
});

test('the full reviewed migration chain accepts bootstrapped schema and exact QA config', async () => {
  await bootstrap.createQaAccount(first, credentials);
  const migrations = await readiness.loadMigrations();
  const applied = await readiness.applyMigrations(first, migrations);
  assert.equal(applied.applied.length, 21);
  const config = { FAME_MARKET_ACCOUNT_ID: credentials.accountId, FAME_SEASON_ID: '2026-2027', FAME_BOOTH_CAPACITY: '30' };
  const result = await first.begin('READ ONLY', tx => readiness.inspectSchema(tx, migrations, config));
  assert.equal(result.ready, true);
  assert.equal(result.appliedCount, 21);
  const before = await first`SELECT * FROM accounts`;
  assert.equal((await bootstrap.createQaAccount(first, credentials)).status, 'verified_existing');
  assert.deepEqual(await first`SELECT * FROM accounts`, before);
});
