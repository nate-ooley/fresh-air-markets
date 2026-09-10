const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, realpath, readFile, writeFile, chmod, stat, symlink, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const mod = import(pathToFileURL(path.join(__dirname, '../scripts/bootstrap-qa-account.mjs')));
const host = 'ep-qa-bootstrap.us-east-2.aws.neon.tech';
const env = {
  VERCEL_ENV: 'preview', DATABASE_URL: `postgresql://qa:fake-local-test-value@${host}/neondb?sslmode=require`,
  SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ALLOW_LIVE_PAYMENTS: 'false', AUTH_SECRET: 'isolated-unit-test-only-secret-value',
  FAME_SEASON_ID: '2026-2027', GHL_LOCATION_ID: 'aooAnUXF0COePorBo7wL',
  GHL_PAYMENT_SYNC_ENABLED: 'false', GHL_PAYMENT_EMAIL_ENABLED: 'false', GHL_PAYMENT_QA_ROUTING_VERIFIED: 'false',
};
const args = filename => ['create', '--qa', `--expected-host=${host}`, '--email=nate@autocraftstudios.com',
  '--slug=qa-fresh-air', '--qa-capacity=30', `--credentials-file=${filename}`];
const normalize = sql => sql.replace(/\s+/g, ' ').trim();
async function temporary(fn) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fame-bootstrap-unit-')));
  await chmod(directory, 0o700);
  try { return await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('QA bootstrap uses exactly the portal base schema without demo seed code', async () => {
  const { BASE_SCHEMA } = await mod;
  const original = await readFile(path.join(__dirname, '../src/lib/store-pg.ts'), 'utf8');
  // The portal keeps its base DDL in the BASE_TABLE_DDL record of store-pg.ts.
  const statements = [...original.matchAll(/\b(?:accounts|booths|bookings|booking_dates): `(\s*CREATE TABLE IF NOT EXISTS (?:accounts|booths|bookings|booking_dates) \([\s\S]*?)`,/g)].map(m => normalize(m[1]));
  assert.equal(statements.length, 4);
  assert.deepEqual(BASE_SCHEMA.map(normalize), statements);
  const source = await readFile(path.join(__dirname, '../scripts/bootstrap-qa-account.mjs'), 'utf8');
  assert.doesNotMatch(source, /^import[^;]*(?:seed|store-pg|ghl|square)/m);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});

test('commands require explicit QA identity/capacity and reject ambiguous or password arguments', async () => {
  const { parseOptions } = await mod;
  assert.equal(parseOptions(args('/private/qa-manager.json'))['qa-capacity'], '30');
  for (const input of [
    args('relative.json'), args('/private/qa.json').concat('--qa'), args('/private/qa.json').concat('--password=never-in-argv'),
    args('/private/qa.json').map(s => s.replace('--qa-capacity=30', '--qa-capacity=0')),
    args('/private/qa.json').map(s => s.replace('--qa-capacity=30', '--qa-capacity=10000')),
    args('/private/qa.json').map(s => s.replace('nate@autocraftstudios.com', 'live-admin@example.com')),
    args('/private/qa.json').map(s => s.replace('--slug=qa-fresh-air', '--slug=fresh-air')),
    ['verify-existing', '--qa', `--expected-host=${host}`, '--email=nate@autocraftstudios.com', '--account-id=demo-market', '--qa-capacity=30'],
  ]) assert.throws(() => parseOptions(input));
});

test('target and every outbound worker gate fail closed before provisioning', async () => {
  const { parseOptions, validateConfig } = await mod;
  const options = parseOptions(args('/private/qa-manager.json'));
  assert.equal(validateConfig(env, options).host, host);
  const rejected = [
    { VERCEL_ENV: 'production' }, { DATABASE_URL: 'QA-only Neon/Postgres connection string' },
    { DATABASE_URL: env.DATABASE_URL.replace('sslmode=require', 'sslmode=disable') },
    { SQUARE_ENVIRONMENT: 'production' }, { SQUARE_ALLOW_LIVE_PAYMENTS: 'true' },
    { GHL_PAYMENT_SYNC_ENABLED: 'true' }, { GHL_PAYMENT_EMAIL_ENABLED: 'true' },
    { GHL_PAYMENT_QA_ROUTING_VERIFIED: 'true' }, { FAME_PAYMENT_SCHEDULER_ENABLED: 'true' },
    { GHL_FUTURE_WORKER_ENABLED: 'true' }, { GHL_PAYMENT_DELIVERY_MODE: 'production' },
    { AUTH_SECRET: 'short' }, { FAME_SEASON_ID: '2027-2028' }, { FAME_BOOTH_CAPACITY: '40' },
    { GHL_LOCATION_ID: 'other-business' },
  ];
  for (const patch of rejected) assert.throws(() => validateConfig({ ...env, ...patch }, options));
  assert.throws(() => validateConfig(env, { ...options, qa: false }));
  assert.throws(() => validateConfig(env, { ...options, 'expected-host': 'ep-other.neon.tech' }));
  const existing = parseOptions(['verify-existing', '--qa', `--expected-host=${host}`, '--email=nate@autocraftstudios.com', '--account-id=observed-qa-id', '--qa-capacity=30']);
  assert.throws(() => validateConfig(env, existing), /qa_account_mapping_conflict/);
  assert.equal(validateConfig({ ...env, FAME_MARKET_ACCOUNT_ID: 'observed-qa-id' }, existing).host, host);
});

test('generated bootstrap password hashes are accepted by the actual portal verifier', async () => {
  const { hashQaPassword } = await mod;
  // npm test compiles this exact auth module via the existing store-pg entry.
  const { verifyPassword } = require('../.test-build/auth.js');
  const hash = hashQaPassword('isolated test password, never an operational credential');
  assert.match(hash, /^[a-f0-9]{32}:[a-f0-9]{64}$/);
  assert.equal(verifyPassword('isolated test password, never an operational credential', hash), true);
  assert.equal(verifyPassword('wrong password', hash), false);
});

test('private credentials are created once and reused only for the same target and identity', async () => temporary(async directory => {
  const { parseOptions, validateConfig, credentialFile } = await mod;
  const filename = path.join(directory, 'qa-manager.json');
  const options = parseOptions(args(filename));
  const target = validateConfig(env, options);
  assert.equal(await credentialFile(filename, options, target, { allowCreate: false }), null);
  const first = await credentialFile(filename, options, target);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.match(first.accountId, /^qa-/);
  assert.equal(first.password.length, 43);
  const bytes = await readFile(filename, 'utf8');
  assert.deepEqual(await credentialFile(filename, options, target), first);
  assert.equal(await readFile(filename, 'utf8'), bytes);
  await assert.rejects(credentialFile(filename, { ...options, slug: 'qa-other' }, target), /qa_credentials_file_mismatch/);
  await assert.rejects(credentialFile(filename, options, { ...target, targetKey: 'different' }), /qa_credentials_file_mismatch/);
}));

test('credential file refuses overwrite, loose permissions, symlinks and nonprivate directories', async () => temporary(async directory => {
  const { parseOptions, validateConfig, credentialFile } = await mod;
  const filename = path.join(directory, 'qa-manager.json');
  const options = parseOptions(args(filename));
  const target = validateConfig(env, options);
  await writeFile(filename, 'unrelated private file', { mode: 0o600 });
  await assert.rejects(credentialFile(filename, options, target), /qa_credentials_file_invalid/);
  assert.equal(await readFile(filename, 'utf8'), 'unrelated private file');
  await chmod(filename, 0o644);
  await assert.rejects(credentialFile(filename, options, target), /qa_credentials_path_unsafe/);
  const linked = path.join(directory, 'symlink.json');
  await symlink(filename, linked);
  await assert.rejects(credentialFile(linked, { ...options, 'credentials-file': linked }, target), /qa_credentials_path_unsafe/);
  const fifo = path.join(directory, 'pipe');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  await assert.rejects(credentialFile(fifo, { ...options, 'credentials-file': fifo }, target), /qa_credentials_path_unsafe/);
  await chmod(directory, 0o755);
  await assert.rejects(credentialFile(path.join(directory, 'new.json'), options, target), /qa_credentials_path_unsafe/);
}));

test('malformed secret configuration and unexpected failures never print credentials', () => {
  const marker = 'DO_NOT_PRINT_BOOTSTRAP_SECRET';
  const result = spawnSync(process.execPath, ['scripts/bootstrap-qa-account.mjs', 'inspect', '--qa', `--expected-host=${host}`], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, ...env, DATABASE_URL: `QA-only password=${marker}`, AUTH_SECRET: marker },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /database_url_invalid/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(marker + '|password=|QA-only'));
});

const productionHost = 'ep-production-example.us-east-2.aws.neon.tech';
const productionEnv = {
  VERCEL_ENV: 'production', DATABASE_URL: `postgresql://owner:fake-local-test-value@${productionHost}/neondb?sslmode=require`,
  AUTH_SECRET: 'isolated-unit-test-only-secret-value', FAME_SEASON_ID: '2026-2027', GHL_LOCATION_ID: 'aooAnUXF0COePorBo7wL',
  SQUARE_ENVIRONMENT: 'production', SQUARE_ALLOW_LIVE_PAYMENTS: 'true',
};
const productionArgs = filename => ['create-production-manager', '--production', `--expected-host=${productionHost}`,
  '--email=owner@example.com', '--slug=fresh-air-markets', '--market-name=Fresh Air Markets & Events', `--credentials-file=${filename}`];

test('production manager command accepts an owner identity and rejects QA-only or ambiguous arguments', async () => {
  const { parseOptions } = await mod;
  const options = parseOptions(productionArgs('/private/manager.json'));
  assert.equal(options.production, true);
  assert.equal(options.slug, 'fresh-air-markets');
  assert.equal(parseOptions(['verify-existing', '--production', `--expected-host=${productionHost}`, '--email=owner@example.com', '--account-id=fame-observed']).production, true);
  assert.equal(parseOptions(['remove-demo-tenant', '--production', `--expected-host=${productionHost}`]).command, 'remove-demo-tenant');
  for (const input of [
    productionArgs('relative.json'), productionArgs('/private/m.json').concat('--production'), productionArgs('/private/m.json').concat('--qa'),
    productionArgs('/private/m.json').concat('--qa-capacity=30'), productionArgs('/private/m.json').concat('--password=never'),
    productionArgs('/private/m.json').map(s => s.replace('--slug=fresh-air-markets', '--slug=qa-fresh-air')),
    productionArgs('/private/m.json').map(s => s.replace('--slug=fresh-air-markets', '--slug=sunrise-market')),
    productionArgs('/private/m.json').map(s => s.replace('--slug=fresh-air-markets', '--slug=Fresh Air')),
    productionArgs('/private/m.json').map(s => s.replace('--email=owner@example.com', '--email=not-an-email')),
    productionArgs('/private/m.json').map(s => s.replace('--email=owner@example.com', '--email=Owner@Example.com')),
    productionArgs('/private/m.json').filter(s => !s.startsWith('--email=')),
    ['create-production-manager', `--expected-host=${productionHost}`, '--email=owner@example.com', '--slug=fresh-air-markets', '--credentials-file=/private/m.json'],
    ['create', '--production', `--expected-host=${productionHost}`, '--email=owner@example.com', '--slug=fresh-air-markets', '--credentials-file=/private/m.json'],
    ['verify-existing', '--production', `--expected-host=${productionHost}`, '--email=owner@example.com', '--account-id=demo-market'],
    ['remove-demo-tenant', '--production', `--expected-host=${productionHost}`, '--email=owner@example.com'],
    ['remove-demo-tenant', '--qa', `--expected-host=${productionHost}`],
    args('/private/qa.json').concat('--market-name=Not for QA'),
  ]) assert.throws(() => parseOptions(input), undefined, JSON.stringify(input));
});

test('production config requires Production variables, a private secret and no QA fault controls', async () => {
  const { parseOptions, validateConfig } = await mod;
  const options = parseOptions(productionArgs('/private/manager.json'));
  const target = validateConfig(productionEnv, options);
  assert.equal(target.host, productionHost);
  assert.equal(target.mode, 'production');
  assert.match(target.targetKey, /^[a-f0-9]{64}$/);
  for (const [patch, code] of [
    [{ VERCEL_ENV: 'preview' }, 'production_target_required'],
    [{ DATABASE_URL: 'QA-only Neon/Postgres connection string' }, 'database_url_invalid'],
    [{ DATABASE_URL: productionEnv.DATABASE_URL.replace('sslmode=require', 'sslmode=disable') }, 'neon_tls_required'],
    [{ AUTH_SECRET: 'short' }, 'production_private_auth_secret_required'],
    [{ AUTH_SECRET: undefined }, 'production_private_auth_secret_required'],
    [{ FAME_SEASON_ID: '2027-2028' }, 'production_season_invalid'],
    [{ SQUARE_QA_FAULT_MODE: 'checkout' }, 'production_qa_controls_must_be_absent'],
    [{ GHL_LOCATION_ID: 'other-business' }, 'qa_location_mismatch'],
  ]) assert.throws(() => validateConfig({ ...productionEnv, ...patch }, options), error => error.code === code, code);
  assert.throws(() => validateConfig(productionEnv, { ...options, 'expected-host': 'ep-other.neon.tech' }));
  // Preview/QA variables must never satisfy a production command.
  assert.throws(() => validateConfig(env, options), error => error.code === 'production_target_required');
  const existing = parseOptions(['verify-existing', '--production', `--expected-host=${productionHost}`, '--email=owner@example.com', '--account-id=fame-observed']);
  assert.throws(() => validateConfig(productionEnv, existing), /qa_account_mapping_conflict/);
  assert.equal(validateConfig({ ...productionEnv, FAME_MARKET_ACCOUNT_ID: 'fame-observed' }, existing).host, productionHost);
  const removal = parseOptions(['remove-demo-tenant', '--production', `--expected-host=${productionHost}`]);
  assert.equal(validateConfig({ ...productionEnv, AUTH_SECRET: undefined, FAME_SEASON_ID: undefined }, removal).host, productionHost);
});

test('production credentials use the owner identity, an active plan and a distinct private file purpose', async () => temporary(async directory => {
  const { parseOptions, validateConfig, credentialFile } = await mod;
  const filename = path.join(directory, 'manager.json');
  const options = parseOptions(productionArgs(filename));
  const target = validateConfig(productionEnv, options);
  assert.equal(await credentialFile(filename, options, target, { allowCreate: false }), null);
  const created = await credentialFile(filename, options, target);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.match(created.accountId, /^fame-/);
  assert.equal(created.purpose, 'fresh-air-production-manager-v1');
  assert.equal(created.email, 'owner@example.com');
  assert.equal(created.marketName, 'Fresh Air Markets & Events');
  assert.equal(created.plan, 'pro');
  assert.equal(created.licenseStatus, 'active');
  assert.equal(created.password.length, 43);
  assert.deepEqual(await credentialFile(filename, options, target), created);
  await assert.rejects(credentialFile(filename, { ...options, 'market-name': 'Other Market' }, target), /qa_credentials_file_mismatch/);
  // A QA credential file can never be replayed as a production identity, or vice versa.
  const qaOptions = parseOptions(args(filename));
  await assert.rejects(credentialFile(filename, qaOptions, { ...validateConfig(env, qaOptions), targetKey: target.targetKey }), /qa_credentials_file_mismatch/);
}));
