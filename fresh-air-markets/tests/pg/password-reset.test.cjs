const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');
const { requestPasswordReset, consumePasswordReset, passwordResetTokenHash } = require('../../.test-build/password-reset.js');
const { verifyPassword, hashPassword } = require('../../.test-build/auth.js');

const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = `qa_password_reset_${process.pid}`;
const admin = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
const sql = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
const NOW = Date.parse('2026-09-11T12:00:00Z');
const accountId = 'fame-qa-market';

before(async () => {
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await sql`CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, owner_name TEXT NOT NULL)`;
  const migration = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
  try {
    await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations/025-password-resets.sql'), 'utf8'));
  } finally { await migration.end(); }
});
beforeEach(async () => {
  await sql`TRUNCATE fame_password_resets`;
  await sql`DELETE FROM accounts`;
  await sql`INSERT INTO accounts (id, email, password_hash, owner_name) VALUES (${accountId}, 'staff@example.com', ${hashPassword('old-password-123')}, 'Thomas')`;
});
after(async () => { await sql.end(); await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });

test('a request stores only the token hash with a 30-minute expiry and unknown emails create nothing', async () => {
  assert.equal(await requestPasswordReset('nobody@example.com', sql, NOW), null);
  assert.equal(await requestPasswordReset('not an email', sql, NOW), null);
  assert.equal((await sql`SELECT count(*)::int AS n FROM fame_password_resets`)[0].n, 0);
  const reset = await requestPasswordReset('  Staff@Example.com ', sql, NOW);
  assert.equal(reset.accountId, accountId);
  assert.equal(reset.ownerName, 'Thomas');
  assert.equal(reset.expiresAt, new Date(NOW + 30 * 60 * 1000).toISOString());
  const [row] = await sql`SELECT token_hash, used_at FROM fame_password_resets`;
  assert.equal(row.token_hash, passwordResetTokenHash(reset.token));
  assert.equal(row.used_at, null);
  assert.equal(JSON.stringify(row).includes(reset.token), false);
});

test('a valid token changes the password exactly once; reuse, expiry and wrong tokens leave the password alone', async () => {
  const reset = await requestPasswordReset('staff@example.com', sql, NOW);
  assert.deepEqual(await consumePasswordReset(reset.token, 'brand-new-password', sql, NOW + 29 * 60 * 1000), { kind: 'reset', accountId, email: 'staff@example.com' });
  let [account] = await sql`SELECT password_hash FROM accounts WHERE id = ${accountId}`;
  assert.equal(verifyPassword('brand-new-password', account.password_hash), true);
  assert.equal(verifyPassword('old-password-123', account.password_hash), false);
  assert.deepEqual(await consumePasswordReset(reset.token, 'another-password-1', sql, NOW + 29 * 60 * 1000), { kind: 'invalid' });
  [account] = await sql`SELECT password_hash FROM accounts WHERE id = ${accountId}`;
  assert.equal(verifyPassword('brand-new-password', account.password_hash), true);

  const late = await requestPasswordReset('staff@example.com', sql, NOW);
  assert.deepEqual(await consumePasswordReset(late.token, 'another-password-1', sql, NOW + 30 * 60 * 1000), { kind: 'expired' });
  assert.deepEqual(await consumePasswordReset('B'.repeat(43), 'another-password-1', sql, NOW), { kind: 'invalid' });
  assert.deepEqual(await consumePasswordReset(late.token, 'short', sql, NOW), { kind: 'invalid' });
  [account] = await sql`SELECT password_hash FROM accounts WHERE id = ${accountId}`;
  assert.equal(verifyPassword('brand-new-password', account.password_hash), true);
});

test('a newer request supersedes earlier unused links for the same account', async () => {
  const first = await requestPasswordReset('staff@example.com', sql, NOW);
  const second = await requestPasswordReset('staff@example.com', sql, NOW + 1000);
  assert.deepEqual(await consumePasswordReset(first.token, 'brand-new-password', sql, NOW + 2000), { kind: 'invalid' });
  assert.equal((await consumePasswordReset(second.token, 'brand-new-password', sql, NOW + 2000)).kind, 'reset');
});
