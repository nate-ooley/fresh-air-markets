import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SQUARE_API_VERSION = "2026-08-19";
const SQUARE_SANDBOX_API_BASE = "https://connect.squareupsandbox.com";
const SQUARE_PRODUCTION_API_BASE = "https://connect.squareup.com";

/** Server-side Square adapter. Call only after a durable reservation is approved.
 * Credentials are entered by the owner in the hosting environment, never a form.
 * This module does not mark CRM records paid or allocate inventory.
 */
export interface SquareCheckoutConfig {
  environment: "sandbox" | "production";
  accessToken: string;
  locationId: string;
  /** Optional operator-entered guard. The verified merchant is stored with an order. */
  merchantId?: string;
}

export interface SquareWebhookConfig {
  webhookSignatureKey: string;
  webhookUrl: string;
}

export type SquareConfig = SquareCheckoutConfig & SquareWebhookConfig;

function requiredSquareValue(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing Square setting: ${key}`);
  return value;
}

/**
 * Checkout credentials intentionally do not require a webhook or merchant ID.
 * This permits a read-only Sandbox identity check before either exists.
 */
export function squareCheckoutConfig(env: Record<string, string | undefined>): SquareCheckoutConfig {
  const environment = env.SQUARE_ENVIRONMENT ?? "sandbox";
  if (environment !== "sandbox" && environment !== "production") throw new Error("Invalid Square environment.");
  if (environment === "production" && env.SQUARE_ALLOW_LIVE_PAYMENTS !== "true") {
    throw new Error("Live Square payments are disabled.");
  }
  if (environment === "sandbox" && env.SQUARE_ALLOW_LIVE_PAYMENTS === "true") {
    throw new Error("Live Square payments cannot be enabled for Sandbox.");
  }
  const merchantId = env.SQUARE_MERCHANT_ID?.trim() || undefined;
  return {
    environment,
    accessToken: requiredSquareValue(env, "SQUARE_ACCESS_TOKEN"),
    locationId: requiredSquareValue(env, "SQUARE_LOCATION_ID"),
    merchantId,
  };
}

export function squareWebhookConfig(env: Record<string, string | undefined>): SquareWebhookConfig {
  const webhookSignatureKey = requiredSquareValue(env, "SQUARE_WEBHOOK_SIGNATURE_KEY");
  const webhookUrl = requiredSquareValue(env, "SQUARE_WEBHOOK_URL");
  const url = new URL(webhookUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Square webhook requires a public HTTPS URL.");
  return { webhookSignatureKey, webhookUrl };
}

/** Full configuration for a process that creates checkout and verifies webhooks. */
export function squareConfig(env: Record<string, string | undefined>): SquareConfig {
  return { ...squareCheckoutConfig(env), ...squareWebhookConfig(env) };
}

/** Initial Sandbox configuration deliberately excludes webhook values. */
export interface SquareSandboxSetupConfig extends SquareCheckoutConfig {
  environment: "sandbox";
}

export function squareSandboxSetupConfig(env: Record<string, string | undefined>): SquareSandboxSetupConfig {
  const config = squareCheckoutConfig(env);
  if (config.environment !== "sandbox") throw new Error("Square setup verification requires Sandbox.");
  return { ...config, environment: "sandbox" };
}

export interface SquareSandboxIdentity {
  merchantId: string;
  locationId: string;
}

function asNonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

async function getSquareSandboxJson(config: SquareSandboxSetupConfig, path: string, transport: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await transport(`${SQUARE_SANDBOX_API_BASE}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Square-Version": SQUARE_API_VERSION,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("Square sandbox verification request failed.");
  }
  // Do not parse or echo non-2xx responses because Square can include private data.
  if (!response.ok) throw new Error(`Square sandbox verification failed (${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new Error("Square sandbox verification returned malformed JSON.");
  }
}

/**
 * Makes only two read-only Sandbox calls. It retrieves the merchant selected by
 * the access token and fences the configured location to that merchant. A
 * nonblank SQUARE_MERCHANT_ID is an optional mismatch guard, never a requirement.
 */
export async function verifySquareSandboxSetup(config: SquareSandboxSetupConfig, transport: typeof fetch = fetch): Promise<SquareSandboxIdentity> {
  // Square's ListMerchants endpoint returns the merchant selected by the
  // access token as a one-element `merchant` array. Do not use an undocumented
  // `/me` path or accept an ambiguous multi-merchant response.
  const merchantPayload = asObject(await getSquareSandboxJson(config, "/v2/merchants", transport));
  const merchants = asArray(merchantPayload?.merchant);
  const merchant = merchants?.length === 1 ? asObject(merchants[0]) : null;
  const merchantId = asNonBlankString(merchant?.id);
  if (!merchantId || merchant?.status !== "ACTIVE") throw new Error("Square sandbox merchant identity is invalid or inactive.");
  if (config.merchantId && config.merchantId !== merchantId) throw new Error("Configured Square merchant does not match the Sandbox access token.");

  const locationPayload = asObject(await getSquareSandboxJson(config, `/v2/locations/${encodeURIComponent(config.locationId)}`, transport));
  const location = asObject(locationPayload?.location);
  if (!location || location.id !== config.locationId || location.merchant_id !== merchantId || location.status !== "ACTIVE") {
    throw new Error("Configured Square location is invalid, inactive, or owned by another merchant.");
  }
  return { merchantId, locationId: config.locationId };
}

export const PAYMENT_WINDOW_MS = 48 * 60 * 60 * 1000;
export function paymentDeadline(paymentRequestSentAt: string): string {
  const timestamp = Date.parse(paymentRequestSentAt);
  if (!Number.isFinite(timestamp)) throw new Error("A valid payment-request timestamp is required.");
  return new Date(timestamp + PAYMENT_WINDOW_MS).toISOString();
}

export interface ApprovedCheckout {
  reservationId: string;
  revision: number;
  totalCents: number;
  description: string;
  paymentDeadline: string;
}

function canonicalProviderTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** Retries must use the same reservation revision and immutable amount. */
export async function createSquareCheckout(config: Pick<SquareCheckoutConfig, "environment" | "accessToken" | "locationId">, approved: ApprovedCheckout, transport: typeof fetch = fetch, now = Date.now()) {
  if (!approved.reservationId || !Number.isSafeInteger(approved.revision) || approved.revision < 1) throw new Error("A reservation and revision are required.");
  if (!Number.isSafeInteger(approved.totalCents) || approved.totalCents <= 0) throw new Error("Square requires a positive integer amount; nonprofits bypass payment.");
  if (!approved.description.trim() || approved.description.length > 255) throw new Error("A short checkout description is required.");
  if (!(Date.parse(approved.paymentDeadline) > now)) throw new Error("The payment window has expired or is invalid.");
  const idempotencyKey = createHash("sha256").update(`${config.environment}:${config.locationId}:${approved.reservationId}:${approved.revision}`).digest("hex");
  const base = config.environment === "sandbox" ? SQUARE_SANDBOX_API_BASE : SQUARE_PRODUCTION_API_BASE;
  const response = await transport(`${base}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.accessToken}`, "Square-Version": SQUARE_API_VERSION, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ idempotency_key: idempotencyKey, quick_pay: { name: approved.description, price_money: { amount: approved.totalCents, currency: "USD" }, location_id: config.locationId }, checkout_options: { allow_tipping: false } }),
  });
  // Do not propagate provider response bodies, which can contain private data.
  if (!response.ok) throw new Error(`Square checkout failed (${response.status}); retry the same reservation revision.`);
  const data = await response.json();
  const link = data?.payment_link;
  const createdAt = canonicalProviderTimestamp(link?.created_at);
  if (!link?.id || !link?.order_id || typeof link?.url !== "string" || !link.url.startsWith("https://") || !createdAt) {
    throw new Error("Square returned an incomplete checkout response.");
  }
  return { paymentLinkId: String(link.id), orderId: String(link.order_id), checkoutUrl: link.url, createdAt, idempotencyKey };
}

export type SquarePaymentLinkRetirementResult =
  | { kind: "deleted"; paymentLinkId: string | null; cancelledOrderId: string | null }
  | { kind: "not_found" };

/** Minimal, non-sensitive evidence used only to recover a post-DELETE crash. */
export interface SquareOrderRetirementRecovery {
  orderId: string | null;
  locationId: string | null;
  state: string | null;
}

/**
 * Deletes a hosted payment link after its locally recorded hold has expired.
 *
 * The caller must first durably fence the reservation/order as expiry-pending
 * and own a retirement lease. The caller must require the response's exact
 * link and cancelled-order IDs before it finalizes capacity. A 404 is not by
 * itself proof of cancellation; it is returned for recovery reconciliation.
 * This adapter deliberately returns no provider response body.
 */
export async function deleteSquarePaymentLink(
  config: Pick<SquareCheckoutConfig, "environment" | "accessToken">,
  paymentLinkId: string,
  transport: typeof fetch = fetch,
): Promise<SquarePaymentLinkRetirementResult> {
  if (config.environment !== "sandbox") throw new Error("Only Square Sandbox payment-link retirement is enabled.");
  if (typeof paymentLinkId !== "string" || !/^[A-Za-z0-9._:-]{1,255}$/.test(paymentLinkId)) {
    throw new Error("Square payment-link ID is invalid.");
  }
  let response: Response;
  try {
    response = await transport(`${SQUARE_SANDBOX_API_BASE}/v2/online-checkout/payment-links/${encodeURIComponent(paymentLinkId)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Square-Version": SQUARE_API_VERSION,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("Square payment-link retirement request failed.");
  }
  // A crash after a successful provider delete can make a retry see 404. It
  // is not sufficient proof that the exact stored order was cancelled: the
  // caller must reconcile that case through RetrieveOrder before releasing
  // capacity.
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) throw new Error(`Square payment-link retirement failed (${response.status}).`);
  try {
    const payload = asObject(await response.json());
    return {
      kind: "deleted",
      paymentLinkId: asNonBlankString(payload?.id),
      cancelledOrderId: asNonBlankString(payload?.cancelled_order_id),
    };
  } catch {
    // A 2xx response without parseable IDs is not cancellation proof.
    return { kind: "deleted", paymentLinkId: null, cancelledOrderId: null };
  }
}

/**
 * Reconciles the exact durable order after a retry sees a missing link. Only a
 * matching `CANCELED` order can prove that a prior delete retired the hold.
 */
export async function retrieveSquareOrderForRetirement(
  config: Pick<SquareCheckoutConfig, "environment" | "accessToken">,
  squareOrderId: string,
  transport: typeof fetch = fetch,
): Promise<SquareOrderRetirementRecovery> {
  if (config.environment !== "sandbox") throw new Error("Only Square Sandbox retirement recovery is enabled.");
  if (typeof squareOrderId !== "string" || !/^[A-Za-z0-9._:-]{1,255}$/.test(squareOrderId)) {
    throw new Error("Square order ID is invalid.");
  }
  let response: Response;
  try {
    response = await transport(`${SQUARE_SANDBOX_API_BASE}/v2/orders/${encodeURIComponent(squareOrderId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Square-Version": SQUARE_API_VERSION,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("Square retirement recovery request failed.");
  }
  if (!response.ok) throw new Error(`Square retirement recovery failed (${response.status}).`);
  try {
    const payload = asObject(await response.json());
    const order = asObject(payload?.order);
    return {
      orderId: asNonBlankString(order?.id),
      locationId: asNonBlankString(order?.location_id),
      state: asNonBlankString(order?.state),
    };
  } catch {
    throw new Error("Square retirement recovery returned malformed JSON.");
  }
}

/** Verify exact raw bytes and the configured URL, not a caller-supplied host. */
export function verifySquareWebhook(rawBody: string | Uint8Array, signature: string | null, config: SquareWebhookConfig): boolean {
  if (!config.webhookSignatureKey || !config.webhookUrl || !signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const hmac = createHmac("sha256", config.webhookSignatureKey);
  hmac.update(config.webhookUrl);
  hmac.update(rawBody);
  const expected = hmac.digest("base64");
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export interface ExpectedSquarePayment { merchantId: string; locationId: string; orderId: string; totalCents: number }
/** A match is evidence only. The caller must atomically deduplicate event/payment
 * IDs and recheck reservation state before committing a paid state.
 */
export function matchCompletedSquarePayment(event: unknown, expected: ExpectedSquarePayment): { eventId: string; paymentId: string } | null {
  if (!event || typeof event !== "object" || !expected.merchantId || !expected.locationId || !expected.orderId || !Number.isSafeInteger(expected.totalCents) || expected.totalCents <= 0) return null;
  const e = event as { event_id?: unknown; merchant_id?: unknown; type?: unknown; data?: { type?: unknown; object?: { payment?: { id?: unknown; status?: unknown; location_id?: unknown; order_id?: unknown; amount_money?: { amount?: unknown; currency?: unknown } } } } };
  const p = e.data?.object?.payment;
  if (typeof e.event_id !== "string" || !e.event_id || e.merchant_id !== expected.merchantId || !["payment.created", "payment.updated"].includes(String(e.type)) || e.data?.type !== "payment") return null;
  if (!p || typeof p.id !== "string" || !p.id || p.status !== "COMPLETED" || p.location_id !== expected.locationId || p.order_id !== expected.orderId || p.amount_money?.currency !== "USD" || p.amount_money.amount !== expected.totalCents) return null;
  return { eventId: e.event_id, paymentId: p.id };
}
