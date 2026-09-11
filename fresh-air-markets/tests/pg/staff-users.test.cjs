const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');
const { findStaffLogin, staffSessionRole, ensureOwnerStaff, listStaff, inviteStaff, removeStaff, consumeStaffToken } = require('../../.test-build/staff-users.js');
const { requestPasswordReset, consumePasswordReset } = require('../../.test-build/password-reset.js');
const { hashPassword, verifyPassword } = require('../../.test-build/password-hash.js');

const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = `qa_staff_users_${process.pid}`;
const admin = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
const sql = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
const NOW = Date.parse('2026-09-11T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const marketId = 'fame-qa-market';
const ownerHash = hashPassword('owner-password-123');

async function runMigrations() {
  const migration = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
  try {
    for (const file of ['025-password-resets.sql', '026-staff-users.sql']) {
      await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations', file), 'utf8'));
    }
  } finally { await migration.end(); }
}

before(async () => {
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
});
beforeEach(async () => {
  await sql`DROP TABLE IF EXISTS fame_password_resets, fame_staff_users, accounts CASCADE`;
  await sql`CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, owner_name TEXT NOT NULL)`;
  await sql`INSERT INTO accounts (id, email, password_hash, owner_name) VALUES (${marketId}, 'Owner@Example.com', ${ownerHash}, 'Nathan')`;
  await runMigrations();
});
after(async () => { await sql.end(); await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });

test('the migration carries the existing account login over as an active owner who can sign in', async () => {
  const staff = await listStaff(marketId, sql);
  assert.equal(staff.length, 1);
  assert.equal(staff[0].id, `staff-${marketId}`);
  assert.deepEqual([staff[0].email, staff[0].role, staff[0].status, staff[0].name], ['owner@example.com', 'owner', 'active', 'Nathan']);
  const login = await findStaffLogin('OWNER@example.com', sql);
  assert.equal(login.kind, 'found');
  assert.equal(verifyPassword('owner-password-123', login.passwordHash), true);
  assert.equal(await staffSessionRole(staff[0].id, marketId, sql), 'owner');
  assert.equal(await staffSessionRole(staff[0].id, 'other-market', sql), null);
  assert.equal((await findStaffLogin('nobody@example.com', sql)).kind, 'none');
  // ensureOwnerStaff is idempotent for a market that already has its owner row.
  const again = await ensureOwnerStaff({ id: marketId, email: 'owner@example.com', ownerName: 'Nathan', passwordHash: ownerHash }, sql);
  assert.equal(again.id, staff[0].id);
  assert.equal((await listStaff(marketId, sql)).length, 1);
});

test('invite → accept → sign in → remove, with the token single-use and the removed person locked out', async () => {
  const owner = (await listStaff(marketId, sql))[0];
  const invalid = await inviteStaff({ marketId, email: 'not-an-email', name: 'X', invitedBy: owner.id }, sql, NOW);
  assert.equal(invalid.kind, 'invalid');
  const invitation = await inviteStaff({ marketId, email: ' Thomas@Example.com ', name: 'Thomas', invitedBy: owner.id }, sql, NOW);
  assert.equal(invitation.kind, 'invited');
  assert.deepEqual([invitation.user.email, invitation.user.role, invitation.user.status], ['thomas@example.com', 'manager', 'invited']);
  assert.equal(invitation.expiresAt, new Date(NOW + 7 * DAY).toISOString());
  assert.equal((await findStaffLogin('thomas@example.com', sql)).kind, 'invited');
  assert.equal(await staffSessionRole(invitation.user.id, marketId, sql), null);

  assert.deepEqual(await consumeStaffToken(invitation.token, 'short', sql, NOW), { kind: 'invalid' });
  assert.equal((await consumeStaffToken(invitation.token, 'thomas-password-1', sql, NOW + 8 * DAY)).kind, 'expired');
  const accepted = await consumeStaffToken(invitation.token, 'thomas-password-1', sql, NOW + DAY);
  assert.equal(accepted.kind, 'invited');
  assert.equal(accepted.user.status, 'active');
  assert.deepEqual(await consumeStaffToken(invitation.token, 'another-password-1', sql, NOW + DAY), { kind: 'invalid' });
  const login = await findStaffLogin('thomas@example.com', sql);
  assert.equal(login.kind, 'found');
  assert.equal(verifyPassword('thomas-password-1', login.passwordHash), true);
  assert.equal(await staffSessionRole(login.user.id, marketId, sql), 'manager');
  // The legacy account password is untouched by a manager's password.
  assert.equal(verifyPassword('owner-password-123', (await sql`SELECT password_hash FROM accounts WHERE id = ${marketId}`)[0].password_hash), true);

  assert.equal((await inviteStaff({ marketId, email: 'thomas@example.com', name: 'Thomas', invitedBy: owner.id }, sql, NOW)).kind, 'exists');
  assert.deepEqual(await removeStaff({ marketId, userId: owner.id, actorUserId: owner.id }, sql), { kind: 'refused', reason: 'You cannot remove yourself.' });
  assert.equal((await removeStaff({ marketId, userId: owner.id, actorUserId: login.user.id }, sql)).kind, 'refused');
  assert.equal((await removeStaff({ marketId: 'other-market', userId: login.user.id, actorUserId: owner.id }, sql)).kind, 'not_found');
  const removed = await removeStaff({ marketId, userId: login.user.id, actorUserId: owner.id }, sql);
  assert.equal(removed.kind, 'removed');
  assert.equal(await staffSessionRole(login.user.id, marketId, sql), null);
  assert.equal((await findStaffLogin('thomas@example.com', sql)).kind, 'none');
  assert.deepEqual((await listStaff(marketId, sql)).map(s => s.email), ['owner@example.com']);
  // Re-inviting a removed person reuses the row and issues a fresh token.
  const again = await inviteStaff({ marketId, email: 'thomas@example.com', name: 'Thomas B', invitedBy: owner.id }, sql, NOW + 2 * DAY);
  assert.equal(again.kind, 'invited');
  assert.equal(again.user.id, login.user.id);
  assert.equal((await consumeStaffToken(again.token, 'thomas-password-2', sql, NOW + 3 * DAY)).kind, 'invited');
});

test('password reset targets the staff member and keeps the owner account password in step', async () => {
  const owner = (await listStaff(marketId, sql))[0];
  assert.equal(await requestPasswordReset('nobody@example.com', sql, NOW), null);
  const reset = await requestPasswordReset('owner@example.com', sql, NOW);
  assert.equal(reset.userId, owner.id);
  assert.equal(reset.ownerName, 'Nathan');
  const outcome = await consumePasswordReset(reset.token, 'owner-password-456', sql, NOW + 60_000);
  assert.deepEqual(outcome, { kind: 'reset', accountId: marketId, email: 'owner@example.com' });
  assert.equal(verifyPassword('owner-password-456', (await findStaffLogin('owner@example.com', sql)).passwordHash), true);
  assert.equal(verifyPassword('owner-password-456', (await sql`SELECT password_hash FROM accounts WHERE id = ${marketId}`)[0].password_hash), true);
  assert.deepEqual(await consumePasswordReset(reset.token, 'owner-password-789', sql, NOW + 60_000), { kind: 'invalid' });
  const late = await requestPasswordReset('owner@example.com', sql, NOW);
  assert.deepEqual(await consumePasswordReset(late.token, 'owner-password-789', sql, NOW + 31 * 60_000), { kind: 'expired' });
  // An invited (not yet active) person cannot request a reset.
  const invitation = await inviteStaff({ marketId, email: 'new@example.com', name: 'New', invitedBy: owner.id }, sql, NOW);
  assert.equal(invitation.kind, 'invited');
  assert.equal(await requestPasswordReset('new@example.com', sql, NOW), null);
});
