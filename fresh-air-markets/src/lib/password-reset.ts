import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { hashPassword } from "./auth";

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
  email: string;
  ownerName: string;
  token: string;
  expiresAt: string;
}

/** Creates a reset for the account with this email; null when no such account exists. */
export async function requestPasswordReset(
  email: string,
  sql: Sql = configuredClient(),
  now = Date.now(),
): Promise<PasswordResetRequest | null> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL.test(normalized) || normalized.length > 254) return null;
  const [account] = await sql<{ id: string; email: string; owner_name: string }[]>`
    SELECT id, email, owner_name FROM accounts WHERE email = ${normalized}`;
  if (!account) return null;
  const { token, tokenHash } = newPasswordResetToken();
  const expiresAt = new Date(now + TTL_MS);
  await sql.begin(async tx => {
    await tx`UPDATE fame_password_resets SET used_at = ${new Date(now)} WHERE account_id = ${account.id} AND used_at IS NULL`;
    await tx`INSERT INTO fame_password_resets (id, account_id, token_hash, expires_at, created_at)
      VALUES (${randomUUID()}, ${account.id}, ${tokenHash}, ${expiresAt}, ${new Date(now)})`;
  });
  return { accountId: account.id, email: account.email, ownerName: account.owner_name, token, expiresAt: expiresAt.toISOString() };
}

export type PasswordResetOutcome =
  | { kind: "reset"; accountId: string; email: string }
  | { kind: "invalid" }
  | { kind: "expired" };

/** Spends a valid token and replaces the account password in one transaction. */
export async function consumePasswordReset(
  token: unknown,
  password: string,
  sql: Sql = configuredClient(),
  now = Date.now(),
): Promise<PasswordResetOutcome> {
  if (!validPasswordResetToken(token) || passwordProblem(password)) return { kind: "invalid" };
  const tokenHash = passwordResetTokenHash(token);
  const passwordHash = hashPassword(password);
  return sql.begin(async tx => {
    const [row] = await tx<{ id: string; account_id: string; email: string; expires_at: Date; used_at: Date | null }[]>`
      SELECT r.id, r.account_id, a.email, r.expires_at, r.used_at
      FROM fame_password_resets r JOIN accounts a ON a.id = r.account_id
      WHERE r.token_hash = ${tokenHash} FOR UPDATE OF r`;
    if (!row || row.used_at) return { kind: "invalid" } as PasswordResetOutcome;
    if (new Date(row.expires_at).getTime() <= now) return { kind: "expired" } as PasswordResetOutcome;
    await tx`UPDATE accounts SET password_hash = ${passwordHash} WHERE id = ${row.account_id}`;
    await tx`UPDATE fame_password_resets SET used_at = ${new Date(now)} WHERE id = ${row.id}`;
    return { kind: "reset", accountId: row.account_id, email: row.email } as PasswordResetOutcome;
  }) as Promise<PasswordResetOutcome>;
}
