import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

/**
 * Staff password reset. A request creates one random token whose SHA-256 is
 * stored with a 30-minute expiry; the token itself only ever travels inside
 * the email link. Using the token replaces the account password and spends
 * the row, so a link works exactly once. Requests for unknown emails return
 * null so the route can answer identically either way.
 */

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 2, prepare: false, connect_timeout: 5 });
  return client;
}

export const PASSWORD_RESET_TTL_MINUTES = 30;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;
const TTL_MS = PASSWORD_RESET_TTL_MINUTES * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function newPasswordResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: passwordResetTokenHash(token) };
}

export function passwordResetTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function validPasswordResetToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN.test(token);
}

/** A human-readable reason the password is not acceptable, or null when it is. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "Enter a new password.";
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (!password.trim()) return "Enter a new password.";
  return null;
}

export interface PasswordResetRequest {
  accountId: string;
  userId: string;
  email: string;
  ownerName: string;
  token: string;
  expiresAt: string;
}

/** Creates a reset for the active staff member with this email; null when there is none. */
export async function requestPasswordReset(
  email: string,
  sql: Sql = configuredClient(),
  now = Date.now(),
): Promise<PasswordResetRequest | null> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL.test(normalized) || normalized.length > 254) return null;
  const rows = await sql<{ id: string; market_id: string; email: string; name: string }[]>`
    SELECT id, market_id, email, name FROM fame_staff_users
    WHERE email = ${normalized} AND status = 'active' AND password_hash IS NOT NULL ORDER BY created_at`;
  if (rows.length !== 1) return null;
  const [user] = rows;
  const { token, tokenHash } = newPasswordResetToken();
  const expiresAt = new Date(now + TTL_MS);
  await sql.begin(async tx => {
    await tx`UPDATE fame_password_resets SET used_at = ${new Date(now)} WHERE staff_user_id = ${user.id} AND purpose = 'reset' AND used_at IS NULL`;
    await tx`INSERT INTO fame_password_resets (id, account_id, staff_user_id, purpose, token_hash, expires_at, created_at)
      VALUES (${randomUUID()}, ${user.market_id}, ${user.id}, 'reset', ${tokenHash}, ${expiresAt}, ${new Date(now)})`;
  });
  return { accountId: user.market_id, userId: user.id, email: user.email, ownerName: user.name, token, expiresAt: expiresAt.toISOString() };
}

export type PasswordResetOutcome =
  | { kind: "reset" | "invited"; accountId: string; email: string }
  | { kind: "invalid" }
  | { kind: "expired" };

/** Spends a reset or invitation token and sets the person's password. */
export async function consumePasswordReset(
  token: unknown,
  password: string,
  sql: Sql = configuredClient(),
  now = Date.now(),
): Promise<PasswordResetOutcome> {
  const { consumeStaffToken } = await import("./staff-users");
  const outcome = await consumeStaffToken(token, password, sql, now);
  if (outcome.kind === "invalid" || outcome.kind === "expired") return outcome;
  return { kind: outcome.kind, accountId: outcome.user.marketId, email: outcome.user.email };
}
