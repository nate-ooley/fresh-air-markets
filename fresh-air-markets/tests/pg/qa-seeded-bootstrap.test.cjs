const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const postgres = require('postgres');
const { verifyPassword } = require('../../.test-build/auth.js');
const { seededRows } = require('../qa-seeded-bootstrap-fixture.cjs');
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Only local disposable fresh_air_test is allowed');
const schema = `qa_seeded_bootstrap_${process.pid}`;
const admin = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
const connect = () => postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
const first = connect(), second = connect();
const credentials = { accountId: 'qa-a9991fe5-0b1e-45b3-9bdc-0adcc1fefacd', email: 'nate@autocraftstudios.com', slug: 'qa-fresh-air',
  password: 'disposable-local-test-only-password', ownerName: 'Fresh Air QA', marketName: 'Fresh Air QA',
  plan: 'starter', licenseStatus: 'trial', licenseKey: 'FAM-1234-5678-9ABC',
  createdAt: '2026-09-10T12:00:00.000Z', trialEndsAt: '2026-09-24T12:00:00.000Z' };
let bootstrap, readiness, inquirySchema;
before(async () => {
  bootstrap = await import(pathToFileURL(path.join(__dirname, '../../scripts/bootstrap-qa-account.mjs')));
  readiness = await import(pathToFileURL(path.join(__dirname, '../../scripts/database-readiness.mjs')));
  inquirySchema = await readFile(path.join(__dirname, '../../docs/migrations/003-inquiry-idempotency.sql'), 'utf8');
});
async function resetSeed() {
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  for (const statement of bootstrap.BASE_SCHEMA) await first.unsafe(statement);
  await first.unsafe(inquirySchema);
  const rows = seededRows('2026-09-09T12:00:00Z');
  await first`INSERT INTO accounts ${first(rows.accounts)}`;
  await first`INSERT INTO booths ${first(rows.booths)}`;
  await first`INSERT INTO bookings ${first(rows.bookings)}`;
  await first`INSERT INTO booking_dates ${first(rows.dates)}`;
}
beforeEach(resetSeed);
after(async () => {
  await first.end(); await second.end();
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});
async function snapshot() {
  const rows = { accounts: await first`SELECT * FROM accounts ORDER BY id`, booths: await first`SELECT * FROM booths ORDER BY id`,
    bookings: await first`SELECT * FROM bookings ORDER BY id`, dates: await first`SELECT * FROM booking_dates ORDER BY booking_id,date`,
    inquiries: await first`SELECT * FROM inquiry_requests ORDER BY market_id,request_key` };
  return Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, Array.from(value)]));
}

test('seeded inspection is read-only and ordinary empty-only create still refuses seeded data', async () => {
  const before = await snapshot();
  const readonly = { begin: (mode, fn) => { assert.equal(mode, 'READ ONLY'); return first.begin(mode, fn); } };
  assert.equal((await bootstrap.inspectSeededQaDatabase(readonly)).recognizedSeed, true);
  await assert.rejects(bootstrap.createQaAccount(first, credentials), /qa_existing_account_mismatch/);
  assert.deepEqual(await snapshot(), before);
});

test('adds one usable private QA account and preserves every seeded row byte-for-byte', async () => {
  const before = await snapshot();
  assert.deepEqual(await bootstrap.addQaAccountToSeededDatabase(first, credentials), { status: 'created', accountId: credentials.accountId });
  const after = await snapshot();
  const qa = after.accounts.find(a => a.id === credentials.accountId);
  assert.equal(after.accounts.length, 2);
  assert.equal(verifyPassword(credentials.password, qa.password_hash), true);
  assert.equal(qa.email, credentials.email);
  after.accounts = after.accounts.filter(a => a.id !== credentials.accountId);
  assert.deepEqual(after, before);
  assert.equal((await first`SELECT count(*)::int AS count FROM booths WHERE market_id = ${credentials.accountId}`)[0].count, 0);
});

test('same-identity concurrent runs and retry create once without password reset', async () => {
  const results = await Promise.all([bootstrap.addQaAccountToSeededDatabase(first, credentials), bootstrap.addQaAccountToSeededDatabase(second, credentials)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['created', 'verified_existing']);
  const before = await snapshot();
  assert.equal((await bootstrap.addQaAccountToSeededDatabase(first, credentials)).status, 'verified_existing');
  await assert.rejects(bootstrap.addQaAccountToSeededDatabase(first, { ...credentials, password: 'wrong retry password' }), /qa_existing_account_mismatch/);
  assert.deepEqual(await snapshot(), before);
});

test('competing different identities cannot provision a second QA tenant', async () => {
  const other = { ...credentials, accountId: 'qa-bbbb1fe5-0b1e-45b3-9bdc-0adcc1fefacd', email: 'lnooley@gmail.com', slug: 'qa-second' };
  const results = await Promise.allSettled([bootstrap.addQaAccountToSeededDatabase(first, credentials), bootstrap.addQaAccountToSeededDatabase(second, other)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /qa_seed_data_not_recognized/);
  assert.equal((await first`SELECT count(*)::int AS count FROM accounts`)[0].count, 2);
});

test('additional tenant, real applicant values and inquiry receipts are rejected without changes', async () => {
  const alterations = [
    async () => first`INSERT INTO accounts (id,email,password_hash,market_name,slug,license_key,trial_ends_at)
      VALUES ('real-market','real-admin@example.com','untouched','Existing Market','existing-market','preserve',now())`,
    async () => first`UPDATE bookings SET email = 'nate@autocraftstudios.com' WHERE id = 'demo-1'`,
    async () => first`INSERT INTO inquiry_requests (market_id,request_key,payload_hash,booking_id) VALUES ('demo-market','existing-request','preserve','demo-1')`,
  ];
  for (const alter of alterations) {
    await resetSeed(); await alter();
    const before = await snapshot();
    await assert.rejects(bootstrap.addQaAccountToSeededDatabase(first, credentials), /qa_seed_data_not_recognized/);
    assert.deepEqual(await snapshot(), before);
  }
});

test('existing QA email or slug is never adopted or overwritten', async () => {
  for (const conflicting of [credentials.email, credentials.slug]) {
    await resetSeed();
    await first`INSERT INTO accounts (id,email,password_hash,market_name,slug,license_key,trial_ends_at)
      VALUES ('existing-private',${conflicting === credentials.email ? credentials.email : 'other@example.com'},
        'preserve-password','Existing',${conflicting === credentials.slug ? credentials.slug : 'existing-private'},'preserve',now())`;
    const before = await snapshot();
    await assert.rejects(bootstrap.addQaAccountToSeededDatabase(first, credentials), /qa_seed_data_not_recognized/);
    assert.deepEqual(await snapshot(), before);
  }
});

test('schema incompatibilities, hooks and hidden rows fail before inserting an account', async () => {
  const alterations = [
    'CREATE TABLE unexpected_business_data (value TEXT)',
    'ALTER TABLE accounts ADD COLUMN unexpected TEXT',
    'ALTER TABLE accounts ALTER COLUMN email DROP NOT NULL',
    'ALTER TABLE accounts DROP CONSTRAINT accounts_email_key',
    'ALTER TABLE accounts ADD CONSTRAINT extra_check CHECK (length(email) > 0)',
    'ALTER TABLE accounts ENABLE ROW LEVEL SECURITY',
    'CREATE RULE ignore_insert AS ON INSERT TO accounts DO INSTEAD NOTHING',
    'CREATE TRIGGER extra_hook BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION pg_catalog.suppress_redundant_updates_trigger()',
    'ALTER TABLE bookings DISABLE TRIGGER ALL',
    'CREATE INDEX extra_expression_index ON accounts (lower(email))',
    `CREATE DOMAIN ${schema}.text AS pg_catalog.text; ALTER TABLE accounts ALTER COLUMN owner_name TYPE ${schema}.text`,
    'CREATE TABLE inherited_accounts () INHERITS (accounts)',
  ];
  for (const alteration of alterations) {
    await resetSeed(); await first.unsafe(alteration);
    const before = await first`SELECT id,email,password_hash FROM accounts ORDER BY id`;
    await assert.rejects(bootstrap.addQaAccountToSeededDatabase(first, credentials), /qa_seed_schema_not_recognized/);
    assert.deepEqual(await first`SELECT id,email,password_hash FROM accounts ORDER BY id`, before);
  }
});

test('failed account insert rolls back while retaining the original seed', async () => {
  const before = await snapshot();
  await assert.rejects(bootstrap.addQaAccountToSeededDatabase(first, { ...credentials, trialEndsAt: 'invalid timestamp' }));
  assert.deepEqual(await snapshot(), before);
});

test('all21 migrations accept preserved seed plus new QA tenant; subsequent retries are verification only', async () => {
  const before = await snapshot();
  await bootstrap.addQaAccountToSeededDatabase(first, credentials);
  const migrations = await readiness.loadMigrations();
  assert.equal((await readiness.applyMigrations(first, migrations)).applied.length, 21);
  const env = { FAME_MARKET_ACCOUNT_ID: credentials.accountId, FAME_SEASON_ID: '2026-2027', FAME_BOOTH_CAPACITY: '30' };
  const report = await first.begin('READ ONLY', tx => readiness.inspectSchema(tx, migrations, env));
  assert.equal(report.ready, true);
  assert.equal(report.appliedCount, 21);
  const after = await snapshot();
  after.accounts = after.accounts.filter(a => a.id !== credentials.accountId);
  assert.deepEqual(after, before);
  assert.equal((await bootstrap.addQaAccountToSeededDatabase(first, credentials)).status, 'verified_existing');
  assert.equal((await first`SELECT count(*)::int AS count FROM accounts`)[0].count, 2);
});
