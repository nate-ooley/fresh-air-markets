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
const production = {
  accountId: 'fame-2b7f1a5c-4d3e-4a1b-9c8d-7e6f5a4b3c2d', email: 'owner@example.com', slug: 'fresh-air-markets',
  password: 'disposable-local-test-only-owner-password', ownerName: 'Fresh Air Markets & Events', marketName: 'Fresh Air Markets & Events',
  plan: 'pro', licenseStatus: 'active', licenseKey: 'FAM-ABCD-EF01-2345',
  createdAt: '2026-09-10T12:00:00.000Z', trialEndsAt: '2027-09-10T12:00:00.000Z',
};
const demoHash = require('../../.test-build/auth.js').hashPassword('sunrise-demo');
async function seedDemo(sql) {
  await sql`INSERT INTO accounts (id,email,password_hash,owner_name,market_name,slug,plan,license_key,license_status,trial_ends_at)
    VALUES ('demo-market','demo@freshairmarkets.app',${demoHash},'Demo Operator','Sunrise Farmers Market','sunrise-market','pro','FAM-DEMO-DEMO-DEMO','active',now())`;
  await sql`INSERT INTO booths (id,market_id,label,x,y,w,h) VALUES ('demo-a1','demo-market','A1',0,0,10,10)`;
  await sql`INSERT INTO bookings (id,booth_id,market_id,vendor_name,business_name,email) VALUES ('demo-1','demo-a1','demo-market','Rosa','Sunrise Farms','rosa@sunrisefarms.example')`;
  await sql`INSERT INTO booking_dates (booking_id,date) VALUES ('demo-1','2026-10-03')`;
}
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
  assert.equal(applied.applied.length, migrations.length);
  const config = { FAME_MARKET_ACCOUNT_ID: credentials.accountId, FAME_SEASON_ID: '2026-2027', FAME_BOOTH_CAPACITY: '30' };
  const result = await first.begin('READ ONLY', tx => readiness.inspectSchema(tx, migrations, config));
  assert.equal(result.ready, true);
  assert.equal(result.appliedCount, migrations.length);
  const before = await first`SELECT * FROM accounts`;
  assert.equal((await bootstrap.createQaAccount(first, credentials)).status, 'verified_existing');
  assert.deepEqual(await first`SELECT * FROM accounts`, before);
});

test('production manager creates base tables on an empty schema and is a read-only verification on retry', async () => {
  assert.equal((await bootstrap.createProductionManager(first, production)).status, 'created');
  const rows = await first`SELECT * FROM accounts`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, production.accountId);
  assert.equal(rows[0].plan, 'pro');
  assert.equal(rows[0].license_status, 'active');
  assert.equal(verifyPassword(production.password, rows[0].password_hash), true);
  const names = await first`SELECT tablename FROM pg_tables WHERE schemaname = ${schema} ORDER BY tablename`;
  assert.deepEqual(names.map(r => r.tablename), ['accounts','booking_dates','bookings','booths']);
  const results = await Promise.all([bootstrap.createProductionManager(first, production), bootstrap.createProductionManager(second, production)]);
  assert.deepEqual(results.map(r => r.status), ['verified_existing', 'verified_existing']);
  assert.deepEqual(await first`SELECT * FROM accounts`, rows);
  await assert.rejects(bootstrap.createProductionManager(second, { ...production, password: 'wrong' }), /qa_existing_account_mismatch/);
  await assert.rejects(bootstrap.createProductionManager(second, { ...production, accountId: 'fame-ffffffff-ffff-4fff-8fff-ffffffffffff' }), /production_identity_conflict/);
  assert.equal((await bootstrap.verifyExistingProductionAccount(first, { accountId: production.accountId, email: production.email })).status, 'verified_existing');
  await assert.rejects(bootstrap.verifyExistingProductionAccount(first, { accountId: production.accountId, email: 'other@example.com' }), /qa_existing_account_mismatch/);
  await assert.rejects(bootstrap.createProductionManager(first, { ...production, accountId: 'qa-c18b93d1-f7af-4b4c-a83e-5bd79b92643d' }), /production_identity_invalid/);
});

test('production manager adopts portal-created base tables, reports a seeded demo, and removal deletes only the demo', async () => {
  for (const statement of bootstrap.BASE_SCHEMA) await first.unsafe(statement);
  await seedDemo(first);
  await first`INSERT INTO accounts (id,email,password_hash,owner_name,market_name,slug,plan,license_key,license_status,trial_ends_at)
    VALUES ('other-market','other@example.com','00:00','Other','Other Market','other-market','starter','FAM-0000-0000-0000','trial',now())`;
  await first`INSERT INTO booths (id,market_id,label,x,y,w,h) VALUES ('other-b1','other-market','B1',0,0,10,10)`;
  const created = await bootstrap.createProductionManager(first, production);
  assert.equal(created.status, 'created');
  assert.equal(created.demoAccountPresent, true);
  assert.equal((await first`SELECT count(*)::int AS count FROM accounts`)[0].count, 3);
  await assert.rejects(bootstrap.createProductionManager(second, { ...production, accountId: 'fame-ffffffff-ffff-4fff-8fff-ffffffffffff', email: 'demo@freshairmarkets.app' }), /production_identity_conflict/);
  const removed = await bootstrap.removeDemoTenant(first);
  assert.deepEqual(removed, { status: 'demo_removed', removed: { accounts: 1, booths: 1, bookings: 1 } });
  assert.deepEqual((await first`SELECT id FROM accounts ORDER BY id`).map(r => r.id), [production.accountId, 'other-market']);
  assert.deepEqual((await first`SELECT id FROM booths`).map(r => r.id), ['other-b1']);
  assert.equal((await first`SELECT count(*)::int AS count FROM booking_dates`)[0].count, 0);
  assert.deepEqual(await bootstrap.removeDemoTenant(first), { status: 'demo_absent', removed: { accounts: 0, booths: 0, bookings: 0 } });
  await first`INSERT INTO accounts (id,email,password_hash,owner_name,market_name,slug,plan,license_key,license_status,trial_ends_at)
    VALUES ('demo-market','real-person@example.com','00:00','Real','Real Market','sunrise-market','pro','FAM-X','active',now())`;
  await assert.rejects(bootstrap.removeDemoTenant(first), /demo_identity_not_recognized/);
  assert.equal((await first`SELECT count(*)::int AS count FROM accounts`)[0].count, 3);
});

test('production manager schema accepts the complete migration chain and production readiness flags a leftover demo', async () => {
  await bootstrap.createProductionManager(first, production);
  const migrations = await readiness.loadMigrations();
  assert.equal((await readiness.applyMigrations(first, migrations)).applied.length, migrations.length);
  const config = { FAME_MARKET_ACCOUNT_ID: production.accountId, FAME_SEASON_ID: '2026-2027', FAME_BOOTH_CAPACITY: '120' };
  const ready = await first.begin('READ ONLY', tx => readiness.inspectSchema(tx, migrations, config, { production: true }));
  assert.equal(ready.ready, true);
  await seedDemo(first);
  const flagged = await first.begin('READ ONLY', tx => readiness.inspectSchema(tx, migrations, config, { production: true }));
  assert.equal(flagged.ready, false);
  assert.deepEqual(flagged.blockers, ['demo_account_present']);
  const qaView = await first.begin('READ ONLY', tx => readiness.inspectSchema(tx, migrations, config));
  assert.equal(qaView.ready, true);
  assert.deepEqual(await bootstrap.removeDemoTenant(first), { status: 'demo_removed', removed: { accounts: 1, booths: 1, bookings: 1 } });
  assert.equal((await first`SELECT count(*)::int AS count FROM fame_schema_migrations`)[0].count, migrations.length);
});

test('readiness check names a missing base schema explicitly', async () => {
  const migrations = await readiness.loadMigrations();
  const report = await first.begin('READ ONLY', tx => readiness.inspectSchema(tx, migrations, {}));
  assert.ok(report.blockers.includes('base_portal_schema_required'));
  assert.ok(report.blockers.includes('market_account_id_missing'));
});
