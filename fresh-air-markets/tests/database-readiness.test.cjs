const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const modulePromise = import(pathToFileURL(path.join(__dirname, '../scripts/database-readiness.mjs')));
const host = 'ep-qa-example.us-east-2.aws.neon.tech';
const env = {
  VERCEL_ENV: 'preview',
  DATABASE_URL: `postgresql://qa:fake-test-only@ep-qa-example-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`,
  DATABASE_URL_UNPOOLED: `postgresql://qa:fake-test-only@${host}/neondb?sslmode=require`,
};

test('target checks reject placeholder URLs, production, unconfirmed QA and wrong Neon branches', async () => {
  const { resolveQaTarget } = await modulePromise;
  const options = { qa: true, expectedHost: host };
  assert.equal(resolveQaTarget(env, options).host, host);
  for (const [patch, optionPatch, code] of [
    [{ DATABASE_URL: 'QA-only Neon/Postgres connection string' }, {}, 'database_url_invalid'],
    [{ VERCEL_ENV: 'production' }, {}, 'preview_qa_target_required'],
    [{}, { qa: false }, 'preview_qa_target_required'],
    [{}, { expectedHost: 'ep-other.us-east-2.aws.neon.tech' }, 'database_expected_host_mismatch'],
    [{ DATABASE_URL_UNPOOLED: env.DATABASE_URL_UNPOOLED.replace('ep-qa-example', 'ep-other') }, {}, 'database_urls_target_mismatch'],
    [{ DATABASE_URL_UNPOOLED: env.DATABASE_URL_UNPOOLED.replace('/neondb', '/otherdb') }, {}, 'database_urls_target_mismatch'],
    [{ DATABASE_URL_UNPOOLED: env.DATABASE_URL_UNPOOLED.replace('sslmode=require', 'sslmode=disable') }, {}, 'neon_tls_required'],
    [{ DATABASE_URL_UNPOOLED: env.DATABASE_URL_UNPOOLED + '&options=unsafe' }, {}, 'database_url_invalid'],
  ]) assert.throws(() => resolveQaTarget({ ...env, ...patch }, { ...options, ...optionPatch }), error => error.code === code);
});

test('production mode requires the Production environment, the same Neon pins, and is exclusive with --qa', async () => {
  const { resolveTarget, resolveQaTarget } = await modulePromise;
  const production = { ...env, VERCEL_ENV: 'production' };
  const target = resolveTarget(production, { mode: 'production', expectedHost: host });
  assert.equal(target.host, host);
  assert.equal(target.mode, 'production');
  assert.equal(resolveQaTarget(env, { qa: true, expectedHost: host }).mode, 'qa');
  for (const [patchedEnv, options, code] of [
    [env, { mode: 'production', expectedHost: host }, 'production_target_required'],
    [production, { mode: 'qa', expectedHost: host }, 'preview_qa_target_required'],
    [production, { mode: 'staging', expectedHost: host }, 'target_mode_required'],
    [production, { expectedHost: host }, 'target_mode_required'],
    [production, { mode: 'production', expectedHost: 'ep-other.us-east-2.aws.neon.tech' }, 'database_expected_host_mismatch'],
    [{ ...production, DATABASE_URL: 'QA-only Neon/Postgres connection string' }, { mode: 'production', expectedHost: host }, 'database_url_invalid'],
    [{ ...production, DATABASE_URL_UNPOOLED: env.DATABASE_URL_UNPOOLED.replace('sslmode=require', 'sslmode=disable') }, { mode: 'production', expectedHost: host }, 'neon_tls_required'],
  ]) assert.throws(() => resolveTarget(patchedEnv, options), error => error.code === code, code);
  for (const args of [['check', '--qa', '--production', `--expected-host=${host}`], ['apply', '--production', '--staging']]) {
    const result = spawnSync(process.execPath, ['scripts/database-readiness.mjs', ...args], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ...env, VERCEL_ENV: 'production' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage_plan_check_apply/);
  }
  const preview = spawnSync(process.execPath, ['scripts/database-readiness.mjs', 'check', '--production', `--expected-host=${host}`], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ...env, DATABASE_URL: 'password=DO_NOT_PRINT_PRODUCTION' },
  });
  assert.equal(preview.status, 1);
  assert.match(preview.stderr, /production_target_required/);
  assert.doesNotMatch(preview.stdout + preview.stderr, /DO_NOT_PRINT_PRODUCTION|password=/);
});

test('migration checksums ignore CRLF line endings so a Windows checkout matches recorded history', async () => {
  const { loadMigrations } = await modulePromise;
  const { mkdtemp, writeFile, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const directory = await mkdtemp(path.join(tmpdir(), 'fame-migrations-crlf-'));
  try {
    const body = 'CREATE TABLE IF NOT EXISTS crlf_probe (id TEXT PRIMARY KEY);\n';
    await writeFile(path.join(directory, '001-lf.sql'), body);
    const [lf] = await loadMigrations(pathToFileURL(directory + '/'));
    await writeFile(path.join(directory, '001-lf.sql'), body.replace(/\n/g, '\r\n'));
    const [crlf] = await loadMigrations(pathToFileURL(directory + '/'));
    assert.equal(lf.checksum, crlf.checksum);
    assert.equal(lf.sql, crlf.sql);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('SQL wrapper removal preserves function bodies and quoted semicolons while rejecting embedded commits', async () => {
  const { transactionBody } = await modulePromise;
  const body = "DO $custom$ BEGIN RAISE NOTICE 'COMMIT;'; END $custom$;\nSELECT 'quoted; value';";
  assert.equal(transactionBody('-- header\nBEGIN;\n' + body + '\nCOMMIT;').trim().replace(/\s+/g, ' '), body.replace(/\s+/g, ' '));
  for (const input of ['BEGIN; SELECT 1;', 'SELECT 1; COMMIT;', 'SELECT 1; ROLLBACK;', 'BEGIN; SELECT 1; COMMIT; SELECT 2;', "SELECT 'broken;"]) {
    assert.throws(() => transactionBody(input));
  }
});

test('all 21 checked-in migrations can run inside one transaction and contribute readiness checks', async () => {
  const { loadMigrations, expectedObjects } = await modulePromise;
  const migrations = await loadMigrations();
  assert.equal(migrations.length, 22);
  assert.match(migrations[21].name, /^022-/);
  assert.ok(migrations.every(m => /^[a-f0-9]{64}$/.test(m.checksum)));
  const objects = expectedObjects(migrations);
  for (const name of ['fame_applications', 'fame_reservation_allocations', 'fame_square_payment_link_retirements', 'fame_payment_paid_sync_outbox', 'fame_payment_email_outbox', 'fame_payment_pending_sync_outbox']) {
    assert.ok(objects.some(o => o.kind === 'table' && o.name === name));
  }
  assert.ok(objects.some(o => o.kind === 'trigger' && o.name === 'fame_application_opportunity_identity_guard'));
  assert.ok(objects.some(o => o.kind === 'trigger' && o.name === 'fame_payment_paid_sync_enqueue'));
  assert.ok(objects.some(o => o.kind === 'trigger' && o.name === 'fame_payment_email_identity_guard'));
  assert.ok(objects.some(o => o.kind === 'view' && o.name === 'fame_payment_paid_sync_eligible'));
  assert.ok(objects.some(o => o.kind === 'view' && o.name === 'fame_payment_pending_sync_eligible'));
  assert.ok(objects.some(o => o.kind === 'trigger' && o.name === 'fame_payment_pending_sync_enqueue'));
  assert.ok(objects.some(o => o.kind === 'trigger' && o.name === 'fame_payment_pending_sync_identity_guard'));
  assert.ok(objects.some(o => o.kind === 'index' && o.name === 'fame_square_payment_link_retirements_ready_idx'));
});

test('history rejects changed SQL, unknown migrations and gaps rather than silently skipping them', async () => {
  const { loadMigrations, compareHistory } = await modulePromise;
  const migrations = await loadMigrations();
  assert.equal(compareHistory(migrations, []).length, 22);
  assert.equal(compareHistory(migrations, migrations).length, 0);
  assert.throws(() => compareHistory(migrations, [{ ...migrations[0], checksum: 'changed' }]), /migration_checksum_mismatch/);
  assert.throws(() => compareHistory(migrations, [{ name: '999-unreviewed.sql', checksum: 'changed' }]), /migration_history_unknown_version/);
  assert.throws(() => compareHistory(migrations, [migrations[1]]), /migration_history_out_of_order/);
});

test('failure output never exposes invalid connection values or credentials', () => {
  const secret = 'QA-only connection password=DO_NOT_PRINT_THIS';
  const result = spawnSync(process.execPath, ['scripts/database-readiness.mjs', 'check', '--qa', `--expected-host=${host}`], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, VERCEL_ENV: 'preview', DATABASE_URL: secret },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /database_url_invalid/);
  assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_PRINT_THIS|password=/);
});
