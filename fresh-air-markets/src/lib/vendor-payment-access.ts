import { createHash, randomBytes } from "node:crypto";
import { DEMO_MARKET_ID } from "./seed";
import { squarePortalOrigin } from "./square";

export const VENDOR_PAYMENT_COOKIE = "fame_vendor_payment";
export const VENDOR_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const VENDOR_INVITATION_MS = 48 * 60 * 60 * 1000;
export type VendorSquareEnvironment = "sandbox" | "production";

export interface VendorPaymentAccessConfig {
  marketId: string;
  environment: VendorSquareEnvironment;
  portalOrigin: string;
  allowCheckout: boolean;
}

/** All identities and the public link origin come from deployment configuration. */
export function vendorPaymentAccessConfig(env: NodeJS.ProcessEnv): VendorPaymentAccessConfig {
  const marketId = env.FAME_MARKET_ACCOUNT_ID?.trim();
  if (!marketId || marketId === DEMO_MARKET_ID || !/^[A-Za-z0-9:_-]{1,192}$/.test(marketId)) {
    throw new Error("Private market configuration is required");
  }
  if (env.SQUARE_ENVIRONMENT !== "sandbox" && env.SQUARE_ENVIRONMENT !== "production") {
    throw new Error("Square environment configuration is required");
  }
  const portalOrigin = squarePortalOrigin(env);
  if (env.VERCEL_ENV === "production") {
    if (env.SQUARE_ENVIRONMENT !== "production") {
      throw new Error("Production vendor payment origin or environment is invalid");
    }
    if (Object.entries(env).some(([key, value]) => key.startsWith("SQUARE_QA_") && value?.trim())) {
      throw new Error("Production vendor access cannot use Square QA controls");
    }
  } else if (env.VERCEL_ENV === "preview") {
    if (env.SQUARE_ENVIRONMENT !== "sandbox") {
      throw new Error("Preview vendor payments require an exact Vercel origin and Sandbox");
    }
  } else {
    throw new Error("Vendor payment access requires a configured deployment environment");
  }
  return { marketId, environment: env.SQUARE_ENVIRONMENT, portalOrigin,
    allowCheckout: env.SQUARE_ENVIRONMENT === "production"
      ? env.SQUARE_ALLOW_LIVE_PAYMENTS === "true" : env.SQUARE_ALLOW_LIVE_PAYMENTS === "false" };
}

export function validVendorAccessToken(value: unknown): value is string {
  // Exactly 256 bits encoded as unpadded base64url; reject noncanonical final bits.
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, "base64url").toString("base64url") === value;
}

export function createVendorAccessToken(): string { return randomBytes(32).toString("base64url"); }
export function hashVendorAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function vendorInvitationUrl(origin: string, token: string): string {
  if (!validVendorAccessToken(token)) throw new Error("Invalid vendor invitation token");
  const url = new URL("/vendor/payment", origin);
  url.hash = `token=${token}`;
  return url.toString();
}

export function vendorCookieOptions(expires?: Date) {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/api/vendor", ...(expires ? { expires } : {}) };
}

/** No GET consumes an invitation; explicit same-origin JSON POSTs prevent CSRF. */
export function sameOriginVendorPost(request: { url: string; headers: Headers }, origin: string): boolean {
  const supplied = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return supplied === origin && (!fetchSite || fetchSite === "same-origin" || fetchSite === "none");
}

/** Read at most 1 KiB; arbitrary identifiers, credentials and prices are not accepted. */
export async function readVendorAccessBody(request: Request): Promise<Record<string, unknown> | null> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export interface VendorPaymentView {
  dates: string[];
  boothsPerMarket: number;
  rateCents: number;
  totalCents: number;
  currency: "USD";
  quoteTier: "standard" | "consecutive" | "full-season" | "nonprofit";
  paymentRequired: boolean;
  paymentDueAt: string | null;
  status: "pending" | "paid" | "confirmed" | "expired" | "unavailable";
  checkoutUrl: string | null;
  environment: VendorSquareEnvironment | null;
}

export type VendorInvitationIssueResult =
  | { kind: "issued"; expiresAt: string }
  | { kind: "not_found" }
  | { kind: "not_eligible" };
export type VendorInvitationExchangeResult =
  | { kind: "exchanged"; expiresAt: string }
  | { kind: "invalid" };

export interface VendorPaymentAccessStore {
  issue(input: { config: VendorPaymentAccessConfig; reservationId: string; tokenHash: string; now: Date }): Promise<VendorInvitationIssueResult>;
  exchange(input: { config: VendorPaymentAccessConfig; invitationHash: string; sessionHash: string; now: Date }): Promise<VendorInvitationExchangeResult>;
  read(input: { config: VendorPaymentAccessConfig; sessionHash: string; now: Date }): Promise<VendorPaymentView | null>;
  revoke(input: { config: VendorPaymentAccessConfig; sessionHash: string; now: Date }): Promise<void>;
}

export async function issueVendorPaymentInvitation(input: {
  config: VendorPaymentAccessConfig; reservationId: string; actorAccountId: string;
  store: VendorPaymentAccessStore; now?: Date;
}) {
  if (input.actorAccountId !== input.config.marketId || input.config.marketId === DEMO_MARKET_ID) return { kind: "forbidden" as const };
  const token = createVendorAccessToken();
  const result = await input.store.issue({ config: input.config, reservationId: input.reservationId, tokenHash: hashVendorAccessToken(token), now: input.now || new Date() });
  return result.kind === "issued"
    ? { ...result, invitationToken: token, invitationUrl: vendorInvitationUrl(input.config.portalOrigin, token) }
    : result;
}

export async function exchangeVendorPaymentInvitation(input: {
  token: unknown; config: VendorPaymentAccessConfig; store: VendorPaymentAccessStore; now?: Date;
}) {
  if (!validVendorAccessToken(input.token)) return { kind: "invalid" as const };
  const sessionToken = createVendorAccessToken();
  const result = await input.store.exchange({ config: input.config, invitationHash: hashVendorAccessToken(input.token), sessionHash: hashVendorAccessToken(sessionToken), now: input.now || new Date() });
  return result.kind === "exchanged" ? { ...result, sessionToken } : result;
}
