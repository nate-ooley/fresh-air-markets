import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { signingSecret } from "./auth-secret";

export { hashPassword, verifyPassword } from "./password-hash";

export const SESSION_COOKIE = "bhq_session";
const SESSION_HOURS = 24 * 7;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function secret(): string {
  return signingSecret(process.env);
}

/* ── Sessions (HMAC-signed cookie carrying market id and staff user id) ─ */

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

/** Legacy market-only session; still issued when no staff user record exists. */
export function makeSessionToken(accountId: string): string {
  const expires = Date.now() + SESSION_HOURS * 3600_000;
  const payload = `${accountId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

/** Session for one staff member of a market. */
export function makeStaffSessionToken(marketId: string, userId: string): string {
  if (!ID.test(marketId) || !ID.test(userId)) throw new Error("Invalid session identity.");
  const expires = Date.now() + SESSION_HOURS * 3600_000;
  const payload = `${marketId}.${userId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

export interface SessionIdentity {
  marketId: string;
  /** Null for a legacy market-only session (treated as the market owner). */
  userId: string | null;
}

/** Identity for a valid, unexpired token of either format; null otherwise. */
export function verifySessionIdentity(token: string | undefined): SessionIdentity | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const sig = parts[parts.length - 1];
  // Reject malformed signatures before comparing their encoded byte buffers.
  if (!/^[a-f0-9]{64}$/.test(sig)) return null;
  const payload = parts.slice(0, -1).join(".");
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const expires = Number(parts[parts.length - 2]);
  if (!(expires > Date.now())) return null;
  const marketId = parts[0];
  if (!ID.test(marketId)) return null;
  if (parts.length === 3) return { marketId, userId: null };
  return ID.test(parts[1]) ? { marketId, userId: parts[1] } : null;
}

/** Returns the market id for a valid, unexpired token; null otherwise. */
export function verifySessionToken(token: string | undefined): string | null {
  return verifySessionIdentity(token)?.marketId ?? null;
}

export interface SessionStaff extends SessionIdentity {
  role: "owner" | "manager";
}

/**
 * The signed-in staff member, checked against the staff table so a removed
 * person stops working immediately. A legacy session counts as the owner.
 */
export async function getSessionStaff(): Promise<SessionStaff | null> {
  const store = await cookies();
  let identity: SessionIdentity | null;
  try {
    identity = verifySessionIdentity(store.get(SESSION_COOKIE)?.value);
  } catch {
    // A missing/weak AUTH_SECRET must not turn every page into a 500; treat as signed out.
    return null;
  }
  if (!identity) return null;
  if (!identity.userId) return { ...identity, role: "owner" };
  try {
    const { staffSessionRole } = await import("./staff-users");
    const role = await staffSessionRole(identity.userId, identity.marketId);
    return role ? { ...identity, role } : null;
  } catch {
    return null;
  }
}

/** Account (market) id from the request's session cookie, or null. */
export async function getSessionAccountId(): Promise<string | null> {
  return (await getSessionStaff())?.marketId ?? null;
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
