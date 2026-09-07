import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { handleSquarePaymentWebhook } = require("../.test-build/square-webhook.js") as typeof import("../src/lib/square-webhook");
type SquarePaymentWebhookEvent = import("../src/lib/square-webhook").SquarePaymentWebhookEvent;

const config = {
  webhookSignatureKey: "qa-square-webhook-key",
  webhookUrl: "https://unit-test.invalid/api/payments/square/webhook",
};

function body(patch: Record<string, unknown> = {}) {
  return JSON.stringify({
    event_id: "qa-square-event-1",
    type: "payment.updated",
    merchant_id: "qa-merchant",
    created_at: "2026-09-07T18:00:00.000Z",
    data: { type: "payment", id: "qa-payment-data-1", object: { payment: {
      id: "qa-payment-1",
      status: "COMPLETED",
      location_id: "qa-location",
      order_id: "qa-order-1",
      amount_money: { amount: 28000, currency: "USD" },
      created_at: "2026-09-07T17:59:00.000Z",
      updated_at: "2026-09-07T18:00:00.000Z",
    } } },
    ...patch,
  });
}

function request(raw: string | Uint8Array, signature = createHmac("sha256", config.webhookSignatureKey).update(config.webhookUrl).update(raw).digest("base64")) {
  return new Request(config.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-square-hmacsha256-signature": signature },
    body: raw,
  });
}

test("a valid signed completed payment is handed to atomic persistence with the exact raw payload digest", async () => {
  let received: SquarePaymentWebhookEvent | undefined;
  const raw = body();
  const response = await handleSquarePaymentWebhook(request(raw), config, async event => {
    received = event;
    return { kind: "paid" };
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "paid" });
  assert.deepEqual(received && {
    eventId: received.eventId,
    eventType: received.eventType,
    merchantId: received.merchantId,
    orderId: received.payment.orderId,
    paymentId: received.payment.id,
    amountCents: received.payment.amountCents,
    currency: received.payment.currency,
    rawBodySha256: received.rawBodySha256,
  }, {
    eventId: "qa-square-event-1",
    eventType: "payment.updated",
    merchantId: "qa-merchant",
    orderId: "qa-order-1",
    paymentId: "qa-payment-1",
    amountCents: 28000,
    currency: "USD",
    rawBodySha256: createHash("sha256").update(raw).digest("hex"),
  });
});

test("signature validation happens before JSON parsing or persistence", async () => {
  let writes = 0;
  // Malformed JSON would return 400 after validation. A bad signature must
  // instead return 401, proving the unauthenticated body was never decoded.
  const response = await handleSquarePaymentWebhook(request("{not-json", "A".repeat(43) + "="), config, async () => {
    writes++;
    return { kind: "paid" };
  });
  assert.equal(response.status, 401);
  assert.equal(writes, 0);
});

test("duplicate receipts are acknowledged while a conflicting or mismatched event is held for review", async () => {
  const raw = body();
  const duplicate = await handleSquarePaymentWebhook(request(raw), config, async () => ({ kind: "duplicate" }));
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { status: "duplicate" });

  const mismatch = await handleSquarePaymentWebhook(request(raw), config, async () => ({ kind: "manual_review" }));
  assert.equal(mismatch.status, 202);
  assert.deepEqual(await mismatch.json(), { status: "manual_review" });

  const conflict = await handleSquarePaymentWebhook(request(raw), config, async () => ({ kind: "conflict" }));
  assert.equal(conflict.status, 202);
  assert.deepEqual(await conflict.json(), { status: "manual_review" });
});

test("a non-ASCII JSON value verifies the original UTF-8 bytes without reserializing the body", async () => {
  const raw = Buffer.from(body({ ignored_display_note: "café 🍅" }), "utf8");
  let digest = "";
  const response = await handleSquarePaymentWebhook(request(raw), config, async event => {
    digest = event.rawBodySha256;
    return { kind: "paid" };
  });
  assert.equal(response.status, 200);
  assert.equal(digest, createHash("sha256").update(raw).digest("hex"));
});

test("a transient durable-store failure asks Square to replay the same event without exposing details", async () => {
  const response = await handleSquarePaymentWebhook(request(body()), config, async () => {
    throw new Error("postgres://private-password@private-host diagnostic");
  });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error, "Square payment processing is unavailable; retry the same event.");
  assert.equal(JSON.stringify(payload).includes("private-password"), false);
});

test("malformed, oversized, and non-payment events never reach persistence", async () => {
  let writes = 0;
  const persist = async () => { writes++; return { kind: "paid" } as const; };
  const malformed = await handleSquarePaymentWebhook(request(body({ event_id: "not valid spaces" })), config, persist);
  assert.equal(malformed.status, 400);

  const unrelated = await handleSquarePaymentWebhook(request(JSON.stringify({
    event_id: "qa-unrelated-1", type: "refund.updated", merchant_id: "qa-merchant", data: {},
  })), config, persist);
  assert.equal(unrelated.status, 400);

  const hugeRaw = "x".repeat(128 * 1024 + 1);
  const huge = await handleSquarePaymentWebhook(request(hugeRaw), config, persist);
  assert.equal(huge.status, 413);
  assert.equal(writes, 0);
});

test("only Square's payment envelope and valid RFC 3339 timestamps can reach persistence", async () => {
  let writes = 0;
  const persist = async () => { writes++; return { kind: "paid" } as const; };
  const wrongEnvelope = JSON.parse(body()) as Record<string, any>;
  wrongEnvelope.data.type = "refund";
  const normalizedImpossibleDate = JSON.parse(body()) as Record<string, any>;
  normalizedImpossibleDate.data.object.payment.updated_at = "2026-02-30T12:00:00Z";
  const timezoneLessDate = JSON.parse(body()) as Record<string, any>;
  timezoneLessDate.created_at = "2026-10-01T12:00:00";
  const invalidOffset = JSON.parse(body()) as Record<string, any>;
  invalidOffset.data.object.payment.updated_at = "2026-10-01T12:00:00+24:00";
  for (const malformed of [wrongEnvelope, normalizedImpossibleDate, timezoneLessDate, invalidOffset]) {
    const response = await handleSquarePaymentWebhook(request(JSON.stringify(malformed)), config, persist);
    assert.equal(response.status, 400);
  }
  assert.equal(writes, 0);
});
