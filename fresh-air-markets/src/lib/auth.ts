import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "bhq_session";
const SESSION_HOURS = 24 * 7;

function secret(): string {
  return process.env.AUTH_SECRET || "demo-secret-change-me";
}

/* ── Passwords (scrypt, salt:hash hex) ─────────────────── */

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/* ── Sessions (HMAC-signed cookie carrying the account id) ─ */

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function makeSessionToken(accountId: string): string {
  const expires = Date.now() + SESSION_HOURS * 3600_000;
  const payload = `${accountId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns the account id for a valid, unexpired token; null otherwise. */
export function verifySessionToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [accountId, expires, sig] = parts;
  const expected = sign(`${accountId}.${expires}`);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return Number(expires) > Date.now() ? accountId : null;
}

/** Account id from the request's session cookie, or null. */
export async function getSessionAccountId(): Promise<string | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  };
}
