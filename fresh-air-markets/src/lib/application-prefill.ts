import { createHmac, timingSafeEqual } from "node:crypto";
import { signingSecret } from "./auth-secret";

/**
 * Signed, pre-filled application links. Staff send a vendor a link whose
 * fragment carries their known details (from an older system or a phone
 * call); the form fills itself in and the vendor still chooses booths, signs
 * the agreement and submits. The token grants nothing and stores nothing; it
 * only saves typing and records where the invitation came from.
 */

const TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ApplicationPrefill {
  marketId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  businessName: string;
  vendorCategory: string;
  fullSeason: boolean;
  dates: string[];
  /** Where the details came from, e.g. "highlevel". Recorded on the application. */
  invitedFrom: string;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Normalizes staff-supplied vendor details; null when there is no usable email. */
export function normalizeApplicationPrefill(input: Record<string, unknown>, marketId: string, invitedFrom: string): ApplicationPrefill | null {
  const email = text(input.email, 254).toLowerCase();
  if (!EMAIL.test(email)) return null;
  const dates = Array.isArray(input.dates) ? [...new Set(input.dates.filter((d): d is string => typeof d === "string" && DATE.test(d)))].sort() : [];
  return {
    marketId,
    firstName: text(input.firstName, 100),
    lastName: text(input.lastName, 100),
    email,
    phone: text(input.phone, 40),
    businessName: text(input.businessName, 200),
    vendorCategory: text(input.vendorCategory, 200),
    fullSeason: input.fullSeason === true,
    dates,
    invitedFrom: text(invitedFrom, 40) || "staff",
  };
}

function sign(payload: string, env: NodeJS.ProcessEnv): string {
  return createHmac("sha256", `application-prefill:${signingSecret(env)}`).update(payload).digest("base64url");
}

export function createApplicationPrefillToken(prefill: ApplicationPrefill, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...prefill, expires: now + TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload, env)}`;
}

export function verifyApplicationPrefillToken(token: unknown, env: NodeJS.ProcessEnv = process.env, now = Date.now()): ApplicationPrefill | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  let expected: string;
  try { expected = sign(payload, env); } catch { return null; }
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!decoded || typeof decoded !== "object") return null;
  const value = decoded as Record<string, unknown>;
  if (typeof value.expires !== "number" || !Number.isFinite(value.expires) || value.expires < now) return null;
  const marketId = text(value.marketId, 128);
  if (!marketId) return null;
  return normalizeApplicationPrefill(value, marketId, text(value.invitedFrom, 40));
}
