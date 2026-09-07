import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifySquareCheckoutFailure, dispatchSquareSandboxCheckout } = require("../.test-build/square-payment.js") as typeof import("../src/lib/square-payment");
const { squarePaymentOrderIdempotencyKey, squarePaymentDeadlineFromProviderLink } = require("../.test-build/square-payment-pg.js") as typeof import("../src/lib/square-payment-pg");
type SquarePaymentCheckoutStore = import("../src/lib/square-payment").SquarePaymentCheckoutStore;
type SquarePaymentOrder = import("../src/lib/square-payment").SquarePaymentOrder;
type VerifiedSquareSandbox = import("../src/lib/square-payment").VerifiedSquareSandbox;

const now = new Date("2026-10-01T12:00:00.000Z");
const square: VerifiedSquareSandbox = {
  environment: "sandbox",
  accessToken: "sandbox-token",
  locationId: "sandbox-location",
  merchantId: "sandbox-merchant",
};

function order(patch: Partial<SquarePaymentOrder> = {}): SquarePaymentOrder {
  return {
    id: "payment-order",
    marketId: "market-1",
    reservationId: "reservation-1",
    reservationRevision: 3,
    environment: "sandbox",
    merchantId: "sandbox-merchant",
    locationId: "sandbox-location",
    expectedCurrency: "USD",
    expectedTotalCents: 28000,
    idempotencyKey: squarePaymentOrderIdempotencyKey({
      environment: "sandbox", locationId: "sandbox-location", reservationId: "reservation-1", reservationRevision: 3,
    }),
    status: "processing_checkout",
    paymentLinkId: null,
    squareOrderId: null,
    checkoutUrl: null,
    paymentId: null,
    paymentStatus: null,
    paymentProviderCreatedAt: null,
    paymentProviderUpdatedAt: null,
    paymentRequestSentAt: null,
    paymentDueAt: "2026-10-03T12:00:00.000Z",
    checkoutAttempts: 1,
    ...patch,
  };
}

function checkoutClaim(value = order()) {
  return {
    kind: "checkout_required" as const,
    order: value,
    leaseToken: "lease-1",
    approved: {
      reservationId: value.reservationId,
      revision: value.reservationRevision,
      totalCents: value.expectedTotalCents,
      description: "Fresh Air Market reservation reservation-1",
      paymentDeadline: value.paymentDueAt!,
    },
  };
}

function store(overrides: Partial<SquarePaymentCheckoutStore> = {}): SquarePaymentCheckoutStore {
  return {
    claimCheckout: async () => checkoutClaim(),
    completeCheckout: async ({ checkout }) => ({ kind: "completed", order: order({
      status: "checkout_created", paymentLinkId: checkout.paymentLinkId,
      squareOrderId: checkout.orderId, checkoutUrl: checkout.checkoutUrl,
      paymentRequestSentAt: now.toISOString(),
    }) }),
    failCheckout: async () => {},
    ...overrides,
  };
}

test("durable checkout sends the committed reservation amount and persists only the returned hosted link", async () => {
  let completed: unknown;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const result = await dispatchSquareSandboxCheckout({
    marketId: "market-1", reservationId: "reservation-1", square, now,
    store: store({ completeCheckout: async value => {
      completed = value;
      return { kind: "completed", order: order({
        status: "checkout_created", paymentLinkId: value.checkout.paymentLinkId,
        squareOrderId: value.checkout.orderId, checkoutUrl: value.checkout.checkoutUrl,
      }) };
    } }),
    transport: (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ payment_link: { id: "link-1", order_id: "square-order-1", url: "https://square.link/checkout", created_at: "2026-10-01T12:00:00.000Z" } });
    }) as typeof fetch,
  });
  assert.equal(result.kind, "created");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://connect.squareupsandbox.com/v2/online-checkout/payment-links");
  assert.equal((calls[0].body.quick_pay as { price_money: { amount: number; currency: string } }).price_money.amount, 28000);
  assert.equal((calls[0].body.quick_pay as { location_id: string }).location_id, "sandbox-location");
  assert.deepEqual(completed, {
    paymentOrderId: "payment-order", leaseToken: "lease-1",
    checkout: {
      paymentLinkId: "link-1", orderId: "square-order-1", checkoutUrl: "https://square.link/checkout",
      createdAt: "2026-10-01T12:00:00.000Z",
      idempotencyKey: squarePaymentOrderIdempotencyKey({
        environment: "sandbox", locationId: "sandbox-location", reservationId: "reservation-1", reservationRevision: 3,
      }),
    },
    sentAt: now,
  });
});

test("an existing hosted checkout is returned without another Square request", async () => {
  let calls = 0;
  const result = await dispatchSquareSandboxCheckout({
    marketId: "market-1", reservationId: "reservation-1", square, now,
    store: store({ claimCheckout: async () => ({ kind: "checkout_created", order: order({
      status: "checkout_created", paymentLinkId: "link-1", squareOrderId: "square-order-1", checkoutUrl: "https://square.link/checkout",
    }) }) }),
    transport: (async () => { calls++; throw new Error("must not call Square"); }) as typeof fetch,
  });
  assert.equal(result.kind, "existing");
  assert.equal(calls, 0);
});

test("transient failure releases the same durable order for a stable-key retry", async () => {
  const failures: unknown[] = [];
  const requestKeys: string[] = [];
  let attempt = 0;
  const durableStore = store({
    failCheckout: async value => { failures.push(value); },
  });
  const transport = (async (_url, init) => {
    requestKeys.push((JSON.parse(String(init?.body)) as { idempotency_key: string }).idempotency_key);
    attempt++;
    return attempt === 1
      ? new Response("provider-detail-is-not-exposed", { status: 503 })
      : Response.json({ payment_link: { id: "link-1", order_id: "square-order-1", url: "https://square.link/checkout", created_at: "2026-10-01T12:00:00.000Z" } });
  }) as typeof fetch;
  const first = await dispatchSquareSandboxCheckout({ marketId: "market-1", reservationId: "reservation-1", square, now, store: durableStore, transport });
  const second = await dispatchSquareSandboxCheckout({ marketId: "market-1", reservationId: "reservation-1", square, now, store: durableStore, transport });
  assert.equal(first.kind, "retry_scheduled");
  assert.equal(second.kind, "created");
  assert.equal(requestKeys.length, 2);
  assert.equal(requestKeys[0], requestKeys[1]);
  assert.deepEqual(failures, [{
    paymentOrderId: "payment-order", leaseToken: "lease-1", code: "square_http_503", retryable: true, attemptedAt: now,
  }]);
});

test("permanent provider failure requires review and never invents a checkout link", async () => {
  let failure: unknown;
  const result = await dispatchSquareSandboxCheckout({
    marketId: "market-1", reservationId: "reservation-1", square, now,
    store: store({ failCheckout: async value => { failure = value; } }),
    transport: (async () => new Response("private-detail", { status: 400 })) as typeof fetch,
  });
  assert.deepEqual(result, { kind: "failed", paymentOrderId: "payment-order" });
  assert.deepEqual(failure, {
    paymentOrderId: "payment-order", leaseToken: "lease-1", code: "square_http_400", retryable: false, attemptedAt: now,
  });
});

test("nonprofit, expired, cancelled/declined, and in-progress orders never create a second checkout", async () => {
  for (const claim of [
    { kind: "not_payable" as const, reason: "nonprofit" as const },
    { kind: "not_payable" as const, reason: "expired" as const },
    { kind: "not_payable" as const, reason: "terminal" as const },
    { kind: "in_progress" as const, paymentOrderId: "payment-order" },
  ]) {
    let calls = 0;
    const result = await dispatchSquareSandboxCheckout({
      marketId: "market-1", reservationId: "reservation-1", square, now,
      store: store({ claimCheckout: async () => claim }),
      transport: (async () => { calls++; throw new Error("must not call Square"); }) as typeof fetch,
    });
    assert.equal(calls, 0);
    assert.equal(result.kind, claim.kind === "not_payable" ? "not_payable" : "in_progress");
  }
});

test("failure classification distinguishes retryable provider outages from permanent failures", () => {
  assert.deepEqual(classifySquareCheckoutFailure(new Error("Square checkout failed (429)")), { code: "square_http_429", retryable: true });
  assert.deepEqual(classifySquareCheckoutFailure(new Error("Square checkout failed (400)")), { code: "square_http_400", retryable: false });
  assert.deepEqual(classifySquareCheckoutFailure(new Error("network reset")), { code: "square_transport_error", retryable: true });
});

test("the provider link creation time, not a pre-link retry time, anchors the exact 48-hour deadline", () => {
  const createdAt = new Date("2026-10-31T16:00:00.000Z");
  const deadline = squarePaymentDeadlineFromProviderLink(createdAt);
  assert.equal(deadline?.toISOString(), "2026-11-02T16:00:00.000Z");
  // A later retry/response time cannot move this provider-derived deadline.
  assert.notEqual(deadline?.toISOString(), new Date("2026-11-02T16:00:01.000Z").toISOString());
  assert.equal(squarePaymentDeadlineFromProviderLink(new Date("invalid")), null);
});

test("an idempotent recovery never reopens an already-expired provider link after local persistence failed", async () => {
  let completed = 0;
  let failed;
  const recoveredNow = new Date("2026-10-04T12:00:00.000Z");
  const recoveryOrder = order({ paymentDueAt: "2026-10-06T12:00:00.000Z" });
  const result = await dispatchSquareSandboxCheckout({
    marketId: "market-1", reservationId: "reservation-1", square, now: recoveredNow,
    store: store({
      claimCheckout: async () => checkoutClaim(recoveryOrder),
      completeCheckout: async () => { completed++; return { kind: "stale" }; },
      failCheckout: async value => { failed = value; },
    }),
    transport: (async () => Response.json({ payment_link: {
      id: "link-1", order_id: "square-order-1", url: "https://square.link/checkout",
      created_at: "2026-10-01T12:00:00.000Z",
    } })) as typeof fetch,
  });
  assert.deepEqual(result, { kind: "failed", paymentOrderId: "payment-order" });
  assert.equal(completed, 0);
  assert.deepEqual(failed, {
    paymentOrderId: "payment-order", leaseToken: "lease-1",
    code: "square_link_expired_before_persistence", retryable: false, attemptedAt: recoveredNow,
  });
});
