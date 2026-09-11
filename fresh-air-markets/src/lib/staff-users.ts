import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { hashPassword } from "./password-hash";
import { newPasswordResetToken, passwordProblem, passwordResetTokenHash, validPasswordResetToken } from "./password-reset";

/**
 * Staff members of a market. The accounts row is the market; each person who
 * signs in is a fame_staff_users row with their own password. Owners invite
 * and remove managers; everyone else works the same screens. Invitations and
 * password resets share one single-use token table.
 */

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 2, prepare: false, connect_timeout: 5 });
  return client;
}

export type StaffRole = "owner" | "manager";
export type StaffStatus = "invited" | "active" | "removed";
export const INVITATION_TTL_DAYS = 7;
const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface StaffUser {
  id: string;
  marketId: string;
  email: string;
  name: string;
  role: StaffRole;
  status: StaffStatus;
  createdAt: string;
}

interface StaffRow { id: string; market_id: string; email: string; name: string; role: StaffRole; status: StaffStatus; password_hash: string | null; created_at: Date }

function toStaff(row: StaffRow): StaffUser {
  return { id: row.id, marketId: row.market_id, email: row.email, name: row.name, role: row.role, status: row.status, createdAt: new Date(row.created_at).toISOString() };
}

export function normalizeStaffEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email && email.length <= 254 && EMAIL.test(email) ? email : null;
}

export type StaffLogin =
  | { kind: "found"; user: StaffUser; passwordHash: string }
  | { kind: "invited"; user: StaffUser }
  | { kind: "ambiguous" }
  | { kind: "none" };

/** Who this email signs in as. Removed people never match. */
export async function findStaffLogin(email: string, sql: Sql = configuredClient()): Promise<StaffLogin> {
  const normalized = normalizeStaffEmail(email);
  if (!normalized) return { kind: "none" };
  const rows = await sql<StaffRow[]>`
    SELECT id, market_id, email, name, role, status, password_hash, created_at FROM fame_staff_users
    WHERE email = ${normalized} AND status IN ('active', 'invited') ORDER BY status, created_at`;
  const active = rows.filter(r => r.status === "active" && r.password_hash);
  if (active.length > 1) return { kind: "ambiguous" };
  if (active.length === 1) return { kind: "found", user: toStaff(active[0]), passwordHash: active[0].password_hash as string };
  const invited = rows.find(r => r.status === "invited");
  return invited ? { kind: "invited", user: toStaff(invited) } : { kind: "none" };
}

/** Role of an active staff member of this market, or null when they may no longer sign in. */
export async function staffSessionRole(userId: string, marketId: string, sql: Sql = configuredClient()): Promise<StaffRole | null> {
  const [row] = await sql<{ role: StaffRole }[]>`
    SELECT role FROM fame_staff_users WHERE id = ${userId} AND market_id = ${marketId} AND status = 'active'`;
  return row?.role ?? null;
}

/** Make sure a market that signed in with its legacy account login has an owner row. */
export async function ensureOwnerStaff(account: { id: string; email: string; ownerName: string; passwordHash: string }, sql: Sql = configuredClient()): Promise<StaffUser | null> {
  const email = normalizeStaffEmail(account.email);
  if (!email) return null;
  const [row] = await sql<StaffRow[]>`
    INSERT INTO fame_staff_users (id, market_id, email, name, role, status, password_hash)
    VALUES (${`staff-${account.id}`}, ${account.id}, ${email}, ${account.ownerName.slice(0, 120)}, 'owner', 'active', ${account.passwordHash})
    ON CONFLICT (market_id, email) DO UPDATE SET updated_at = now()
    RETURNING id, market_id, email, name, role, status, password_hash, created_at`;
  return row ? toStaff(row) : null;
}

export async function listStaff(marketId: string, sql: Sql = configuredClient()): Promise<StaffUser[]> {
  const rows = await sql<StaffRow[]>`
    SELECT id, market_id, email, name, role, status, password_hash, created_at FROM fame_staff_users
    WHERE market_id = ${marketId} AND status <> 'removed' ORDER BY role, created_at`;
  return rows.map(toStaff);
}

export type StaffInvitation =
  | { kind: "invited"; user: StaffUser; token: string; expiresAt: string }
  | { kind: "exists"; user: StaffUser }
  | { kind: "invalid"; reason: string };

/**
 * Creates (or re-invites) a manager and a 7-day single-use token. An active
 * colleague with the same email is reported, never re-invited.
 */
export async function inviteStaff(
  input: { marketId: string; email: unknown; name: unknown; invitedBy: string | null },
  sql: Sql = configuredClient(),
  now = Date.now(),
): Promise<StaffInvitation> {
  const email = normalizeStaffEmail(input.email);
  if (!email) return { kind: "invalid", reason: "Enter a valid email address." };
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
  if (!name) return { kind: "invalid", reason: "Enter the person's name." };
  const { token, tokenHash } = newPasswordResetToken();
  const expiresAt = new Date(now + INVITATION_TTL_MS);
  return sql.begin(async tx => {
    const [existing] = await tx<StaffRow[]>`
      SELECT id, market_id, email, name, role, status, password_hash, created_at FROM fame_staff_users
      WHERE market_id = ${input.marketId} AND email = ${email} FOR UPDATE`;
    if (existing?.status === "active") return { kind: "exists", user: toStaff(existing) } as StaffInvitation;
    let row: StaffRow;
    if (existing) {
      [row] = await tx<StaffRow[]>`
        UPDATE fame_staff_users SET name = ${name}, role = 'manager', status = 'invited', password_hash = NULL,
          invited_by = ${input.invitedBy}, updated_at = ${new Date(now)}
        WHERE id = ${existing.id}
        RETURNING id, market_id, email, name, role, status, password_hash, created_at`;
      await tx`UPDATE fame_password_resets SET used_at = ${new Date(now)} WHERE staff_user_id = ${existing.id} AND used_at IS NULL`;
    } else {
      [row] = await tx<StaffRow[]>`
        INSERT INTO fame_staff_users (id, market_id, email, name, role, status, invited_by, created_at, updated_at)
        VALUES (${randomUUID()}, ${input.marketId}, ${email}, ${name}, 'manager', 'invited', ${input.invitedBy}, ${new Date(now)}, ${new Date(now)})
        RETURNING id, market_id, email, name, role, status, password_hash, created_at`;
    }
    await tx`INSERT INTO fame_password_resets (id, account_id, staff_user_id, purpose, token_hash, expires_at, created_at)
      VALUES (${randomUUID()}, ${input.marketId}, ${row.id}, 'invite', ${tokenHash}, ${expiresAt}, ${new Date(now)})`;
    return { kind: "invited", user: toStaff(row), token, expiresAt: expiresAt.toISOString() } as StaffInvitation;
  }) as Promise<StaffInvitation>;
}

export type StaffRemoval = { kind: "removed"; user: StaffUser } | { kind: "not_found" } | { kind: "refused"; reason: string };

/** Ends a manager's access. Owners and the acting person cannot be removed here. */
export async function removeStaff(
  input: { marketId: string; userId: string; actorUserId: string | null },
  sql: Sql = configuredClient(),
  now = Date.now(),
): Promise<StaffRemoval> {
  if (input.actorUserId && input.actorUserId === input.userId) return { kind: "refused", reason: "You cannot remove yourself." };
  return sql.begin(async tx => {
    const [row] = await tx<StaffRow[]>`
      SELECT id, market_id, email, name, role, status, password_hash, created_at FROM fame_staff_users
      WHERE id = ${input.userId} AND market_id = ${input.marketId} AND status <> 'removed' FOR UPDATE`;
    if (!row) return { kind: "not_found" } as StaffRemoval;
    if (row.role === "owner") return { kind: "refused", reason: "The market owner cannot be removed." } as StaffRemoval;
    const [updated] = await tx<StaffRow[]>`
      UPDATE fame_staff_users SET status = 'removed', password_hash = NULL, updated_at = ${new Date(now)} WHERE id = ${row.id}
      RETURNING id, market_id, email, name, role, status, password_hash, created_at`;
    await tx`UPDATE fame_password_resets SET used_at = ${new Date(now)} WHERE staff_user_id = ${row.id} AND used_at IS NULL`;
    return { kind: "removed", user: toStaff(updated) } as StaffRemoval;
  }) as Promise<StaffRemoval>;
}

export type StaffTokenOutcome =
  | { kind: "reset" | "invited"; user: StaffUser }
  | { kind: "invalid" }
  | { kind: "expired" };

/**
 * Spends a reset or invitation token: sets the person's password, activates
 * an invited person, and keeps the legacy account password in step for the
 * owner. One transaction, so a link works exactly once.
 */
export async function consumeStaffToken(token: unknown, password: string, sql: Sql = configuredClient(), now = Date.now()): Promise<StaffTokenOutcome> {
  if (!validPasswordResetToken(token) || passwordProblem(password)) return { kind: "invalid" };
  const tokenHash = passwordResetTokenHash(token);
  const passwordHash = hashPassword(password);
  return sql.begin(async tx => {
    const [row] = await tx<{ id: string; purpose: "reset" | "invite"; expires_at: Date; used_at: Date | null; user: StaffRow | null }[]>`
      SELECT r.id, r.purpose, r.expires_at, r.used_at, row_to_json(u.*) AS user
      FROM fame_password_resets r LEFT JOIN fame_staff_users u ON u.id = r.staff_user_id
      WHERE r.token_hash = ${tokenHash} FOR UPDATE OF r`;
    if (!row || row.used_at || !row.user || row.user.status === "removed") return { kind: "invalid" } as StaffTokenOutcome;
    if (new Date(row.expires_at).getTime() <= now) return { kind: "expired" } as StaffTokenOutcome;
    const [user] = await tx<StaffRow[]>`
      UPDATE fame_staff_users SET password_hash = ${passwordHash}, status = 'active', updated_at = ${new Date(now)} WHERE id = ${row.user.id}
      RETURNING id, market_id, email, name, role, status, password_hash, created_at`;
    if (user.role === "owner") {
      await tx`UPDATE accounts SET password_hash = ${passwordHash} WHERE id = ${user.market_id} AND lower(email) = ${user.email}`;
    }
    await tx`UPDATE fame_password_resets SET used_at = ${new Date(now)} WHERE id = ${row.id}`;
    return { kind: row.purpose === "invite" ? "invited" : "reset", user: toStaff(user) } as StaffTokenOutcome;
  }) as Promise<StaffTokenOutcome>;
}
