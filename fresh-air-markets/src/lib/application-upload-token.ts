import { createHmac, timingSafeEqual } from "node:crypto";
import { signingSecret } from "./auth-secret";

/**
 * Short-lived, signed permission for one applicant to attach documents to one
 * application right after submitting it. It carries no session, grants no
 * read access, and expires on its own; staff review remains the only approval.
 */

const TTL_MS = 2 * 60 * 60 * 1000;
/** Emailed upload links last longer than the post-submit one: vendors read email days later. */
export const EMAILED_UPLOAD_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Each link purpose signs with its own key, so an upload link can never act as a booking link. */
export type ApplicationLinkPurpose = "upload" | "booking";
const KEY_PREFIX: Record<ApplicationLinkPurpose, string> = { upload: "application-upload", booking: "application-booking" };
/** "Book more dates" links live in payment emails the vendor keeps for a while. */
export const BOOKING_LINK_TTL_MS = 120 * 24 * 60 * 60 * 1000;

function sign(payload: string, env: NodeJS.ProcessEnv, purpose: ApplicationLinkPurpose = "upload"): string {
  return createHmac("sha256", `${KEY_PREFIX[purpose]}:${signingSecret(env)}`).update(payload).digest("base64url");
}

export function createApplicationLinkToken(
  purpose: ApplicationLinkPurpose, applicationId: string, marketId: string,
  env: NodeJS.ProcessEnv = process.env, now = Date.now(), ttlMs = TTL_MS,
): string {
  const expires = now + ttlMs;
  const payload = Buffer.from(JSON.stringify([applicationId, marketId, expires])).toString("base64url");
  return `${payload}.${sign(payload, env, purpose)}`;
}

export function createApplicationUploadToken(
  applicationId: string, marketId: string, env: NodeJS.ProcessEnv = process.env, now = Date.now(), ttlMs = TTL_MS,
): string {
  return createApplicationLinkToken("upload", applicationId, marketId, env, now, ttlMs);
}

export function verifyApplicationLinkToken(
  purpose: ApplicationLinkPurpose, token: unknown, env: NodeJS.ProcessEnv = process.env, now = Date.now(),
): { applicationId: string; marketId: string } | null {
  if (typeof token !== "string" || token.length > 512) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  let expected: string;
  try { expected = sign(payload, env, purpose); } catch { return null; }
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!Array.isArray(decoded) || decoded.length !== 3) return null;
  const [applicationId, marketId, expires] = decoded;
  if (typeof applicationId !== "string" || !ID.test(applicationId) || typeof marketId !== "string" || !marketId
    || typeof expires !== "number" || !Number.isFinite(expires) || expires < now) return null;
  return { applicationId, marketId };
}

export function verifyApplicationUploadToken(
  token: unknown, env: NodeJS.ProcessEnv = process.env, now = Date.now(),
): { applicationId: string; marketId: string } | null {
  return verifyApplicationLinkToken("upload", token, env, now);
}
