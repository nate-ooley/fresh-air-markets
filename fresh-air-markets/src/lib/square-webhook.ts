import { createHash } from "node:crypto";
import { verifySquareWebhook, type SquareConfig } from "./square";

/** Square signs the exact notification URL followed by the raw JSON bytes.
 * Keep this boundary deliberately small: it authenticates and parses a
 * provider event, while the database adapter owns all payment state changes.
 */
export const MAX_SQUARE_WEBHOOK_BYTES = 128 * 1024;

const SQUARE_ID = /^[A-Za-z0-9._:-]{1,255}$/;
const CURRENCY = /^[A-Z]{3}$/;
const PAYMENT_STATUS = /^[A-Z_]{1,64}$/;

export interface SquarePaymentWebhookEvent {
  eventId: string;
  eventType: "payment.created" | "payment.updated";
  merchantId: string;
  /** Square's event timestamp, if it supplied one. It is evidence only. */
  occurredAt: string | null;
  rawBodySha256: string;
  payment: {
    id: string;
    status: string;
    locationId: string;
    orderId: string;
    amountCents: number;
    currency: string;
    createdAt: string | null;
    updatedAt: string | null;
  };
}

export type SquareWebhookPersistResult =
  | { kind: "paid" }
  | { kind: "duplicate" }
  | { kind: "conflict" }
  | { kind: "ignored" }
  | { kind: "manual_review" };

export type SquareWebhookPersist = (event: SquarePaymentWebhookEvent) => Promise<SquareWebhookPersistResult>;

function validId(value: unknown): value is string {
  return typeof value === "string" && SQUARE_ID.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsePaymentEvent(value: unknown, rawBodySha256: string): SquarePaymentWebhookEvent | null {
  const body = asObject(value);
  if (!body || (body.type !== "payment.created" && body.type !== "payment.updated")
    || !validId(body.event_id) || !validId(body.merchant_id)) return null;

  const data = asObject(body.data);
  const object = data && asObject(data.object);
  const payment = object && asObject(object.payment);
  const amount = payment && asObject(payment.amount_money);
  if (!payment || !amount
    || !validId(payment.id)
    || !validId(payment.location_id)
    || !validId(payment.order_id)
    || typeof payment.status !== "string" || !PAYMENT_STATUS.test(payment.status)
    || typeof amount.amount !== "number" || !Number.isSafeInteger(amount.amount) || amount.amount < 0
    || typeof amount.currency !== "string" || !CURRENCY.test(amount.currency)
    || (body.created_at !== undefined && !validTimestamp(body.created_at))
    || (payment.created_at !== undefined && !validTimestamp(payment.created_at))
    || (payment.updated_at !== undefined && !validTimestamp(payment.updated_at))) return null;

  return {
    eventId: body.event_id,
    eventType: body.type,
    merchantId: body.merchant_id,
    occurredAt: typeof body.created_at === "string" ? body.created_at : null,
    rawBodySha256,
    payment: {
      id: payment.id,
      status: payment.status,
      locationId: payment.location_id,
      orderId: payment.order_id,
      amountCents: amount.amount,
      currency: amount.currency,
      createdAt: typeof payment.created_at === "string" ? payment.created_at : null,
      updatedAt: typeof payment.updated_at === "string" ? payment.updated_at : null,
    },
  };
}

type RawWebhookBody =
  | { kind: "ok"; bytes: Uint8Array; text: string }
  | { kind: "too_large" }
  | { kind: "invalid" };

/** Read a bounded raw body once. Parsing happens only after HMAC validation. */
async function readRawWebhookBody(request: Request): Promise<RawWebhookBody> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_SQUARE_WEBHOOK_BYTES) return { kind: "too_large" };
  const reader = request.body?.getReader();
  if (!reader) return { kind: "invalid" };
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_SQUARE_WEBHOOK_BYTES) {
        await reader.cancel().catch(() => {});
        return { kind: "too_large" };
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    return { kind: "ok", bytes, text: bytes.toString("utf8") };
  } catch {
    await reader.cancel().catch(() => {});
    return { kind: "invalid" };
  } finally {
    reader.releaseLock();
  }
}

function responseFor(result: SquareWebhookPersistResult): Response {
  switch (result.kind) {
    case "paid": return Response.json({ status: "paid" });
    case "duplicate": return Response.json({ status: "duplicate" });
    // A duplicate Square event with altered raw content must be inspected. It
    // is not a successful replay and no payment state was mutated, but it was
    // durably recorded; acknowledge it so Square does not retry forever.
    case "conflict": return Response.json({ status: "manual_review" }, { status: 202 });
    case "ignored": return Response.json({ status: "ignored" });
    case "manual_review": return Response.json({ status: "manual_review" }, { status: 202 });
  }
}

/**
 * Authenticate a Square payment webhook before decoding JSON, then hand the
 * compact parsed event to an atomic durable receipt/payment-state adapter.
 * A persistence failure is deliberately a 503 so Square can replay the exact
 * event. Mismatches are acknowledged after the adapter records them for
 * manual review; retrying cannot safely repair an identity mismatch.
 */
export async function handleSquarePaymentWebhook(
  request: Request,
  config: Pick<SquareConfig, "webhookSignatureKey" | "webhookUrl">,
  persist: SquareWebhookPersist,
): Promise<Response> {
  const raw = await readRawWebhookBody(request);
  if (raw.kind === "too_large") return Response.json({ error: "Square webhook is too large." }, { status: 413 });
  if (raw.kind === "invalid") return Response.json({ error: "A Square webhook body is required." }, { status: 400 });

  // Do not call JSON.parse before this check. Re-serializing JSON changes the
  // bytes that Square signed and would make signature validation meaningless.
  if (!verifySquareWebhook(raw.bytes, request.headers.get("x-square-hmacsha256-signature"), config)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw.text);
  } catch {
    return Response.json({ error: "A JSON object is required." }, { status: 400 });
  }
  const event = parsePaymentEvent(decoded, createHash("sha256").update(raw.bytes).digest("hex"));
  if (!event) return Response.json({ error: "Invalid Square payment event." }, { status: 400 });

  try {
    return responseFor(await persist(event));
  } catch {
    // A source retry must reuse the same signed event. Provider/database
    // diagnostics can contain private identities, so never disclose them.
    return Response.json({ error: "Square payment processing is unavailable; retry the same event." }, { status: 503 });
  }
}

/** Exposed for focused contract tests; routes use the verified handler above. */
export const __test__ = { parsePaymentEvent };
