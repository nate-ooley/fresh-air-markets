import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  squareCheckoutConfig,
  squareConfig,
  squareSandboxSetupConfig,
  verifySquareSandboxSetup,
  createSquareCheckout,
  verifySquareWebhook,
  matchCompletedSquarePayment,
  paymentDeadline,
} from "../src/lib/square.ts";

const settings = { SQUARE_ACCESS_TOKEN: "test-token", SQUARE_LOCATION_ID: "test-location", SQUARE_MERCHANT_ID: "test-merchant", SQUARE_WEBHOOK_SIGNATURE_KEY: "test-key", SQUARE_WEBHOOK_URL: "https://unit-test.invalid/api/payments/square/webhook" };
const sandboxSettings = { SQUARE_ENVIRONMENT: "sandbox", SQUARE_ALLOW_LIVE_PAYMENTS: "false", SQUARE_ACCESS_TOKEN: "sandbox-token", SQUARE_LOCATION_ID: "sandbox-location" };
const config = squareConfig(settings);
const approved = { reservationId: "qa-reservation", revision: 1, totalCents: 28000, description: "Four market dates, two booths", paymentDeadline: "2026-10-03T12:00:00Z" };
const now = Date.parse("2026-10-01T12:00:00Z");

test("Square splits checkout, webhook, and setup configuration while blocking accidental live mode", () => {
  assert.equal(config.environment, "sandbox");
  for (const key of ["SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID", "SQUARE_WEBHOOK_SIGNATURE_KEY", "SQUARE_WEBHOOK_URL"]) assert.throws(() => squareConfig({ ...settings, [key]: "" }));
  assert.equal(squareConfig({ ...settings, SQUARE_MERCHANT_ID: "" }).merchantId, undefined);
  assert.deepEqual(squareCheckoutConfig(sandboxSettings), { environment: "sandbox", accessToken: "sandbox-token", locationId: "sandbox-location", merchantId: undefined });
  assert.deepEqual(squareSandboxSetupConfig(sandboxSettings), { environment: "sandbox", accessToken: "sandbox-token", locationId: "sandbox-location", merchantId: undefined });
  for (const key of ["SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID"]) {
    assert.throws(() => squareSandboxSetupConfig({ ...sandboxSettings, [key]: "" }));
  }
  assert.throws(() => squareConfig({ ...settings, SQUARE_ENVIRONMENT: "production" }));
  assert.throws(() => squareConfig({ ...settings, SQUARE_ENVIRONMENT: "invalid" }));
  assert.throws(() => squareConfig({ ...settings, SQUARE_WEBHOOK_URL: "http://unit-test.invalid" }));
  assert.throws(() => squareSandboxSetupConfig({ ...sandboxSettings, SQUARE_ENVIRONMENT: "production", SQUARE_ALLOW_LIVE_PAYMENTS: "true" }));
  assert.throws(() => squareSandboxSetupConfig({ ...sandboxSettings, SQUARE_ALLOW_LIVE_PAYMENTS: "true" }));
  assert.equal(squareConfig({ ...settings, SQUARE_ENVIRONMENT: "production", SQUARE_ALLOW_LIVE_PAYMENTS: "true" }).environment, "production");
});

test("Sandbox setup retrieves the selected merchant and fences the configured active location", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const transport = (async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v2/merchants")) return Response.json({ merchant: [{ id: "merchant-1", status: "ACTIVE" }] });
    if (String(url).endsWith("/v2/locations/sandbox-location")) return Response.json({ location: { id: "sandbox-location", merchant_id: "merchant-1", status: "ACTIVE" } });
    throw new Error("Unexpected URL");
  }) as typeof fetch;
  const identity = await verifySquareSandboxSetup(squareSandboxSetupConfig(sandboxSettings), transport);
  assert.deepEqual(identity, { merchantId: "merchant-1", locationId: "sandbox-location" });
  assert.deepEqual(calls.map(call => call.url), [
    "https://connect.squareupsandbox.com/v2/merchants",
    "https://connect.squareupsandbox.com/v2/locations/sandbox-location",
  ]);
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer sandbox-token");
  assert.equal((calls[0].init?.headers as Record<string, string>)["Square-Version"], "2026-08-19");
});

test("Sandbox identity verification stays read-only and consistent across five concurrent checks", async () => {
  const calls: { url: string; method: string | undefined }[] = [];
  const transport = (async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    if (String(url).endsWith("/v2/merchants")) return Response.json({ merchant: [{ id: "merchant-1", status: "ACTIVE" }] });
    if (String(url).endsWith("/v2/locations/sandbox-location")) return Response.json({ location: { id: "sandbox-location", merchant_id: "merchant-1", status: "ACTIVE" } });
    throw new Error("Unexpected URL");
  }) as typeof fetch;

  const identities = await Promise.all(Array.from({ length: 5 }, () => verifySquareSandboxSetup(squareSandboxSetupConfig(sandboxSettings), transport)));
  assert.deepEqual(identities, Array.from({ length: 5 }, () => ({ merchantId: "merchant-1", locationId: "sandbox-location" })));
  assert.equal(calls.length, 10);
  assert.deepEqual(new Set(calls.map(call => call.method)), new Set(["GET"]));
  assert.deepEqual(new Set(calls.map(call => call.url)), new Set([
    "https://connect.squareupsandbox.com/v2/merchants",
    "https://connect.squareupsandbox.com/v2/locations/sandbox-location",
  ]));
});

test("Sandbox setup rejects a mismatched merchant, invalid merchant list, inactive or foreign location, malformed payload, and provider-detail leakage", async () => {
  const validMerchant = (async () => Response.json({ merchant: [{ id: "merchant-1", status: "ACTIVE" }] })) as typeof fetch;
  await assert.rejects(verifySquareSandboxSetup(squareSandboxSetupConfig({ ...sandboxSettings, SQUARE_MERCHANT_ID: "other-merchant" }), validMerchant));

  for (const location of [
    { id: "sandbox-location", merchant_id: "other-merchant", status: "ACTIVE" },
    { id: "sandbox-location", merchant_id: "merchant-1", status: "INACTIVE" },
    { id: "other-location", merchant_id: "merchant-1", status: "ACTIVE" },
  ]) {
    let calls = 0;
    const transport = (async () => {
      calls++;
      return calls === 1
        ? Response.json({ merchant: [{ id: "merchant-1", status: "ACTIVE" }] })
        : Response.json({ location });
    }) as typeof fetch;
    await assert.rejects(verifySquareSandboxSetup(squareSandboxSetupConfig(sandboxSettings), transport));
  }

  for (const merchantPayload of [
    { merchant: [] },
    { merchant: [{ id: "merchant-1", status: "ACTIVE" }, { id: "merchant-2", status: "ACTIVE" }] },
    { merchant: [{ id: "merchant-1", status: "INACTIVE" }] },
    { merchant: { id: "merchant-1", status: "ACTIVE" } },
  ]) {
    const malformed = (async () => Response.json(merchantPayload)) as typeof fetch;
    await assert.rejects(verifySquareSandboxSetup(squareSandboxSetupConfig(sandboxSettings), malformed));
  }

  const privateDetail = (async () => new Response("private-provider-detail", { status: 401 })) as typeof fetch;
  await assert.rejects(
    verifySquareSandboxSetup(squareSandboxSetupConfig(sandboxSettings), privateDetail),
    error => !String(error).includes("private-provider-detail") && String(error).includes("401"),
  );
});

test("checkout contract sends exact cents, correct location, stable retry key, and no tipping", async () => {
  const calls: { url: string; body: Record<string, any>; headers: Record<string, string> }[] = [];
  const transport = (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
    return Response.json({ payment_link: { id: "link", order_id: "order", url: "https://square.link/qa", created_at: "2026-10-01T12:00:00.000Z" } });
  }) as typeof fetch;
  const first = await createSquareCheckout(config, approved, transport, now);
  const retry = await createSquareCheckout(config, approved, transport, now);
  const revision = await createSquareCheckout(config, { ...approved, revision: 2 }, transport, now);
  assert.equal(calls[0].url, "https://connect.squareupsandbox.com/v2/online-checkout/payment-links");
  assert.equal(calls[0].body.quick_pay.price_money.amount, 28000);
  assert.equal(calls[0].body.quick_pay.price_money.currency, "USD");
  assert.equal(calls[0].body.quick_pay.location_id, "test-location");
  assert.equal(calls[0].body.checkout_options.allow_tipping, false);
  assert.equal(first.idempotencyKey, retry.idempotencyKey);
  assert.notEqual(first.idempotencyKey, revision.idempotencyKey);
});

test("zero-dollar, invalid amount, missing reservation and expired checkout never call Square", async () => {
  let calls = 0;
  const transport = (async () => { calls++; throw new Error("Unexpected network call"); }) as typeof fetch;
  for (const totalCents of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(createSquareCheckout(config, { ...approved, totalCents }, transport, now));
  for (const patch of [{ reservationId: "" }, { revision: 0 }, { paymentDeadline: "invalid" }, { paymentDeadline: new Date(now).toISOString() }]) await assert.rejects(createSquareCheckout(config, { ...approved, ...patch }, transport, now));
  assert.equal(calls, 0);
});

test("Square provider failures and incomplete responses do not report success or leak response bodies", async () => {
  for (const status of [400, 401, 429, 500]) {
    const transport = (async () => new Response("private-provider-detail", { status })) as typeof fetch;
    await assert.rejects(createSquareCheckout(config, approved, transport, now), error => !String(error).includes("private-provider-detail") && String(error).includes(String(status)));
  }
  for (const body of [null, {}, { payment_link: { id: "x" } }]) {
    await assert.rejects(createSquareCheckout(config, approved, (async () => Response.json(body)) as typeof fetch, now));
  }
});

test("Square signature requires exact URL and raw body; malformed and Unicode signatures fail safely", () => {
  const raw = '{"event_id":"qa-event"}';
  const signature = createHmac("sha256", config.webhookSignatureKey).update(config.webhookUrl + raw).digest("base64");
  assert.equal(verifySquareWebhook(raw, signature, config), true);
  assert.equal(verifySquareWebhook(new TextEncoder().encode(raw), signature, config), true);
  assert.equal(verifySquareWebhook(raw + " ", signature, config), false);
  assert.equal(verifySquareWebhook(raw, signature, { ...config, webhookUrl: config.webhookUrl + "/" }), false);
  for (const invalid of [null, "", "é".repeat(44), "A".repeat(43) + "="]) assert.equal(verifySquareWebhook(raw, invalid, config), false);
});

test("Square official signature sample matches independently supplied expected value", () => {
  assert.equal(verifySquareWebhook('{"hello":"world"}', "2kRE5qRU2tR+tBGlDwMEw2avJ7QM4ikPYD/PJ3bd9Og=", { webhookUrl: "https://example.com/webhook", webhookSignatureKey: "asdf1234" }), true);
});

test("only a completed payment for the exact merchant, location, order and amount qualifies", () => {
  const expected = { merchantId: "m", locationId: "l", orderId: "o", totalCents: 28000 };
  const payment = { id: "p", status: "COMPLETED", location_id: "l", order_id: "o", amount_money: { amount: 28000, currency: "USD" } };
  const event = { event_id: "e", type: "payment.updated", merchant_id: "m", data: { type: "payment", id: "event-payment", object: { payment } } };
  assert.deepEqual(matchCompletedSquarePayment(event, expected), { eventId: "e", paymentId: "p" });
  for (const patch of [{ status: "FAILED" }, { status: "CANCELED" }, { status: "APPROVED" }, { location_id: "other" }, { order_id: "other" }, { amount_money: { amount: 27999, currency: "USD" } }, { amount_money: { amount: 28000, currency: "CAD" } }]) {
    assert.equal(matchCompletedSquarePayment({ ...event, data: { ...event.data, object: { payment: { ...payment, ...patch } } } }, expected), null);
  }
  for (const invalid of [null, [], {}, { ...event, merchant_id: "other" }, { ...event, event_id: "" }, { ...event, type: "refund.updated" }, { ...event, data: { ...event.data, type: "refund" } }]) assert.equal(matchCompletedSquarePayment(invalid, expected), null);
});

test("48-hour deadline uses elapsed hours across daylight-saving changes", () => {
  assert.equal(paymentDeadline("2026-10-31T12:00:00-04:00"), "2026-11-02T16:00:00.000Z");
  assert.equal(paymentDeadline("2027-03-13T12:00:00-05:00"), "2027-03-15T17:00:00.000Z");
  assert.throws(() => paymentDeadline("invalid"));
});
