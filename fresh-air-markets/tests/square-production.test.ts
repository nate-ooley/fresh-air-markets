import { test } from "node:test";
import assert from "node:assert/strict";
import {
  squarePaymentRuntimeConfig, squarePortalOrigin, validSquareCheckoutUrl,
  verifySquareIdentity, createSquareCheckout, deleteSquarePaymentLink, retrieveSquareOrderForRetirement,
} from "../src/lib/square.ts";

const env = {
  VERCEL: "1", VERCEL_ENV: "production", SQUARE_ENVIRONMENT: "production", SQUARE_ALLOW_LIVE_PAYMENTS: "true",
  SQUARE_ACCESS_TOKEN: "unit-test-token", SQUARE_MERCHANT_ID: "merchant", SQUARE_LOCATION_ID: "location",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "unit-test-key", SQUARE_WEBHOOK_URL: "https://freshairmarketsandevents.com/api/payments/square/webhook",
  FAME_VENDOR_PORTAL_ORIGIN: "https://freshairmarketsandevents.com",
};

test("production payment runtime requires every explicit gate, merchant, webhook and canonical site", () => {
  const config = squarePaymentRuntimeConfig(env);
  assert.equal(config.environment, "production");
  assert.equal(config.checkoutRedirectUrl, "https://freshairmarketsandevents.com/vendor/payment?returned=1");
  for (const key of Object.keys(env)) assert.throws(() => squarePaymentRuntimeConfig({ ...env, [key]: undefined }), key);
  for (const [key, value] of [
    ["VERCEL_ENV", "preview"], ["SQUARE_ENVIRONMENT", "sandbox"], ["SQUARE_ALLOW_LIVE_PAYMENTS", "TRUE"],
    ["FAME_VENDOR_PORTAL_ORIGIN", "https://another-market.example.com"], ["FAME_VENDOR_PORTAL_ORIGIN", "https://vercel.app.evil.invalid"],
    ["FAME_VENDOR_PORTAL_ORIGIN", "https://another-market.vercel.app"], ["SQUARE_WEBHOOK_URL", "https://attacker.invalid/webhook"],
    ["SQUARE_QA_FAULT_MODE", "checkout_429"], ["SQUARE_QA_SIGNER_SECRET", "leftover"], ["SQUARE_QA_UNKNOWN", "leftover"],
  ]) assert.throws(() => squarePaymentRuntimeConfig({ ...env, [key]: value }));
});

test("production may serve the vendor portal from the Vercel host or a market subdomain, with the webhook on the same origin", () => {
  for (const origin of ["https://farmers-market-wine.vercel.app", "https://portal.freshairmarketsandevents.com"]) {
    const hosted = { ...env, FAME_VENDOR_PORTAL_ORIGIN: origin, SQUARE_WEBHOOK_URL: `${origin}/api/payments/square/webhook` };
    assert.equal(squarePortalOrigin(hosted), origin);
    assert.equal(squarePaymentRuntimeConfig(hosted).checkoutRedirectUrl, `${origin}/vendor/payment?returned=1`);
    // The webhook may not point at a different allowed host than the portal.
    assert.throws(() => squarePaymentRuntimeConfig({ ...hosted, SQUARE_WEBHOOK_URL: env.SQUARE_WEBHOOK_URL }));
  }
});

test("Preview is Sandbox only and configured return origin cannot contain a path, query, credentials or other domain", () => {
  const preview = { ...env, VERCEL_ENV: "preview", SQUARE_ENVIRONMENT: "sandbox", SQUARE_ALLOW_LIVE_PAYMENTS: "false", FAME_VENDOR_PORTAL_ORIGIN: "https://farmers-market-qa.vercel.app" };
  assert.equal(squarePortalOrigin(preview), preview.FAME_VENDOR_PORTAL_ORIGIN);
  assert.equal(squarePaymentRuntimeConfig(preview).checkoutRedirectUrl, "https://farmers-market-qa.vercel.app/vendor/payment?returned=1");
  for (const origin of ["http://farmers-market-qa.vercel.app", "https://vercel.app.evil.invalid", "https://user@farmers-market-qa.vercel.app", "https://farmers-market-qa.vercel.app/x", "https://farmers-market-qa.vercel.app?redirect=evil", "https://farmers-market-qa.vercel.app#hash", "https://farmers-market-qa.vercel.app:444"]) {
    assert.throws(() => squarePortalOrigin({ ...preview, FAME_VENDOR_PORTAL_ORIGIN: origin }));
  }
  assert.throws(() => squarePaymentRuntimeConfig({ ...preview, SQUARE_ALLOW_LIVE_PAYMENTS: "true" }));
  assert.throws(() => squarePaymentRuntimeConfig({ ...preview, VERCEL_ENV: "production" }));
});

test("Square hosted URL validation refuses foreign hosts and production Sandbox URLs", () => {
  for (const url of ["https://square.link/u/live", "https://checkout.square.site/live"]) {
    assert.equal(validSquareCheckoutUrl(url, "production"), true);
    assert.equal(validSquareCheckoutUrl(url, "sandbox"), false);
  }
  for (const url of ["https://sandbox.square.link/u/test", "https://connect.squareupsandbox.com/v2/online-checkout/sandbox-testing-panel/loc/link"]) {
    assert.equal(validSquareCheckoutUrl(url, "sandbox"), true);
    assert.equal(validSquareCheckoutUrl(url, "production"), false);
  }
  for (const url of ["https://square.link.evil.invalid/u/x", "http://square.link/u/x", "https://user@square.link/u/x", "https://square.link:999/u/x", "https://square.link/", "https://square.link/u/x#other", "javascript:alert(1)", " https://square.link/u/x"]) {
    assert.equal(validSquareCheckoutUrl(url, "production"), false);
  }
});

test("production identity checks use the production API and reject inactive or mismatched merchant/location", async () => {
  const calls: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.method, "GET");
    return String(url).endsWith("/merchants")
      ? Response.json({ merchant: [{ id: "merchant", status: "ACTIVE" }] })
      : Response.json({ location: { id: "location", merchant_id: "merchant", status: "ACTIVE" } });
  };
  const config = squarePaymentRuntimeConfig(env);
  assert.deepEqual(await verifySquareIdentity(config, transport), { merchantId: "merchant", locationId: "location" });
  assert.deepEqual(calls, ["https://connect.squareup.com/v2/merchants", "https://connect.squareup.com/v2/locations/location"]);
  await assert.rejects(verifySquareIdentity({ ...config, merchantId: "foreign" }, transport));
  for (const location of [
    { id: "location", merchant_id: "other", status: "ACTIVE" },
    { id: "location", merchant_id: "merchant", status: "INACTIVE" },
    { id: "other", merchant_id: "merchant", status: "ACTIVE" },
  ]) await assert.rejects(verifySquareIdentity(config, async url => String(url).endsWith("/merchants")
    ? Response.json({ merchant: [{ id: "merchant", status: "ACTIVE" }] }) : Response.json({ location })));
});

test("production checkout uses immutable provider idempotency and the server-owned website return; rejects unsafe returned URLs", async () => {
  const config = squarePaymentRuntimeConfig(env);
  const now = Date.parse("2026-10-01T12:00:00Z");
  const approved = { reservationId: "reservation", revision: 1, totalCents: 14000, description: "Four market dates", paymentDeadline: "2026-10-03T12:00:00Z" };
  const bodies: any[] = [];
  const transport: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://connect.squareup.com/v2/online-checkout/payment-links");
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ payment_link: { id: "link", order_id: "order", url: "https://square.link/u/live", created_at: "2026-10-01T12:00:00Z" } });
  };
  await createSquareCheckout(config, approved, transport, now);
  await createSquareCheckout(config, approved, transport, now);
  assert.equal(bodies[0].idempotency_key, bodies[1].idempotency_key);
  assert.equal(bodies[0].checkout_options.redirect_url, "https://freshairmarketsandevents.com/vendor/payment?returned=1");
  assert.equal(bodies[0].quick_pay.price_money.amount, 14000);
  await assert.rejects(createSquareCheckout(config, approved, async () => Response.json({ payment_link: { id: "link", order_id: "order", url: "https://attacker.invalid/pay", created_at: "2026-10-01T12:00:00Z" } }), now));
});

test("production link retirement keeps exact cancellation proof and retrieves the same environment on 404 recovery", async () => {
  const config = squarePaymentRuntimeConfig(env);
  const calls: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    calls.push(String(url));
    return init?.method === "DELETE"
      ? Response.json({ id: "link", cancelled_order_id: "order" })
      : Response.json({ order: { id: "order", location_id: "location", state: "CANCELED" } });
  };
  assert.deepEqual(await deleteSquarePaymentLink(config, "link", transport), { kind: "deleted", paymentLinkId: "link", cancelledOrderId: "order" });
  assert.deepEqual(await retrieveSquareOrderForRetirement(config, "order", transport), { orderId: "order", locationId: "location", state: "CANCELED" });
  assert.deepEqual(calls, ["https://connect.squareup.com/v2/online-checkout/payment-links/link", "https://connect.squareup.com/v2/orders/order"]);
});
