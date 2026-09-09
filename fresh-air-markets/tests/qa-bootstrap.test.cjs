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
  const statements = [...original.matchAll(/await sql`(\s*CREATE TABLE IF NOT EXISTS (?:accounts|booths|bookings|booking_dates) \([\s\S]*?)`;/g)].map(m => normalize(m[1]));
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
