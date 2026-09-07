import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Server-side Square adapter. Call only after a durable reservation is approved.
 * Credentials are entered by the owner in the hosting environment, never a form.
 * This module does not mark CRM records paid or allocate inventory.
 */
export interface SquareConfig {
  environment: "sandbox" | "production";
  accessToken: string;
  locationId: string;
  merchantId: string;
  webhookSignatureKey: string;
  webhookUrl: string;
}

export function squareConfig(env: Record<string, string | undefined>): SquareConfig {
  const environment = env.SQUARE_ENVIRONMENT ?? "sandbox";
  if (environment !== "sandbox" && environment !== "production") throw new Error("Invalid Square environment.");
  if (environment === "production" && env.SQUARE_ALLOW_LIVE_PAYMENTS !== "true") {
    throw new Error("Live Square payments are disabled.");
  }
  const keys = ["SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID", "SQUARE_MERCHANT_ID", "SQUARE_WEBHOOK_SIGNATURE_KEY", "SQUARE_WEBHOOK_URL"];
  const missing = keys.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Missing Square settings: ${missing.join(", ")}`);
  const webhookUrl = env.SQUARE_WEBHOOK_URL!;
  const url = new URL(webhookUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Square webhook requires a public HTTPS URL.");
  return { environment, accessToken: env.SQUARE_ACCESS_TOKEN!, locationId: env.SQUARE_LOCATION_ID!, merchantId: env.SQUARE_MERCHANT_ID!, webhookSignatureKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY!, webhookUrl };
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

/** Retries must use the same reservation revision and immutable amount. */
export async function createSquareCheckout(config: SquareConfig, approved: ApprovedCheckout, transport: typeof fetch = fetch, now = Date.now()) {
  if (!approved.reservationId || !Number.isSafeInteger(approved.revision) || approved.revision < 1) throw new Error("A reservation and revision are required.");
  if (!Number.isSafeInteger(approved.totalCents) || approved.totalCents <= 0) throw new Error("Square requires a positive integer amount; nonprofits bypass payment.");
  if (!approved.description.trim() || approved.description.length > 255) throw new Error("A short checkout description is required.");
  if (!(Date.parse(approved.paymentDeadline) > now)) throw new Error("The payment window has expired or is invalid.");
  const idempotencyKey = createHash("sha256").update(`${config.environment}:${config.locationId}:${approved.reservationId}:${approved.revision}`).digest("hex");
  const base = config.environment === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
  const response = await transport(`${base}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.accessToken}`, "Square-Version": "2026-08-19", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ idempotency_key: idempotencyKey, quick_pay: { name: approved.description, price_money: { amount: approved.totalCents, currency: "USD" }, location_id: config.locationId }, checkout_options: { allow_tipping: false } }),
  });
  // Do not propagate provider response bodies, which can contain private data.
  if (!response.ok) throw new Error(`Square checkout failed (${response.status}); retry the same reservation revision.`);
  const data = await response.json();
  const link = data?.payment_link;
  if (!link?.id || !link?.order_id || typeof link?.url !== "string" || !link.url.startsWith("https://")) throw new Error("Square returned an incomplete checkout response.");
  return { paymentLinkId: String(link.id), orderId: String(link.order_id), checkoutUrl: link.url, idempotencyKey };
}

/** Verify exact raw bytes and the configured URL, not a caller-supplied host. */
export function verifySquareWebhook(rawBody: string, signature: string | null, config: Pick<SquareConfig, "webhookSignatureKey" | "webhookUrl">): boolean {
  if (!config.webhookSignatureKey || !config.webhookUrl || !signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = createHmac("sha256", config.webhookSignatureKey).update(config.webhookUrl + rawBody).digest("base64");
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export interface ExpectedSquarePayment { merchantId: string; locationId: string; orderId: string; totalCents: number }
/** A match is evidence only. The caller must atomically deduplicate event/payment
 * IDs and recheck reservation state before committing a paid state.
 */
export function matchCompletedSquarePayment(event: unknown, expected: ExpectedSquarePayment): { eventId: string; paymentId: string } | null {
  if (!event || typeof event !== "object" || !expected.merchantId || !expected.locationId || !expected.orderId || !Number.isSafeInteger(expected.totalCents) || expected.totalCents <= 0) return null;
  const e = event as { event_id?: unknown; merchant_id?: unknown; type?: unknown; data?: { object?: { payment?: { id?: unknown; status?: unknown; location_id?: unknown; order_id?: unknown; amount_money?: { amount?: unknown; currency?: unknown } } } } };
  const p = e.data?.object?.payment;
  if (typeof e.event_id !== "string" || !e.event_id || e.merchant_id !== expected.merchantId || !["payment.created", "payment.updated"].includes(String(e.type))) return null;
  if (!p || typeof p.id !== "string" || !p.id || p.status !== "COMPLETED" || p.location_id !== expected.locationId || p.order_id !== expected.orderId || p.amount_money?.currency !== "USD" || p.amount_money.amount !== expected.totalCents) return null;
  return { eventId: e.event_id, paymentId: p.id };
}
