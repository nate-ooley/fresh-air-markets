import { createHmac, timingSafeEqual } from "node:crypto";
import { signingSecret } from "./auth-secret";

/**
 * Short-lived, signed permission for one applicant to attach documents to one
 * application right after submitting it. It carries no session, grants no
 * read access, and expires on its own; staff review remains the only approval.
 */

const TTL_MS = 2 * 60 * 60 * 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sign(payload: string, env: NodeJS.ProcessEnv): string {
  return createHmac("sha256", `application-upload:${signingSecret(env)}`).update(payload).digest("base64url");
}

export function createApplicationUploadToken(
  applicationId: string, marketId: string, env: NodeJS.ProcessEnv = process.env, now = Date.now(),
): string {
  const expires = now + TTL_MS;
  const payload = Buffer.from(JSON.stringify([applicationId, marketId, expires])).toString("base64url");
  return `${payload}.${sign(payload, env)}`;
}

export function verifyApplicationUploadToken(
  token: unknown, env: NodeJS.ProcessEnv = process.env, now = Date.now(),
): { applicationId: string; marketId: string } | null {
  if (typeof token !== "string" || token.length > 512) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  let expected: string;
  try { expected = sign(payload, env); } catch { return null; }
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
