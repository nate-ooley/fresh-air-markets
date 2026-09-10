import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  classifySquareCheckoutFailure,
  dispatchSquarePaymentLinkRetirement,
  dispatchSquareSandboxCheckout,
} = require("../.test-build/square-payment.js") as typeof import("../src/lib/square-payment");
const { squarePaymentOrderIdempotencyKey, squarePaymentDeadlineFromProviderLink } = require("../.test-build/square-payment-pg.js") as typeof import("../src/lib/square-payment-pg");
type SquarePaymentCheckoutStore = import("../src/lib/square-payment").SquarePaymentCheckoutStore;
type SquarePaymentLinkRetirementStore = import("../src/lib/square-payment").SquarePaymentLinkRetirementStore;
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

function retirementStore(overrides: Partial<SquarePaymentLinkRetirementStore> = {}): SquarePaymentLinkRetirementStore {
  return {
    claimPaymentLinkRetirement: async () => ({
      kind: "retirement_required",
      leaseToken: "retirement-lease-1",
      retirement: {
        paymentOrderId: "payment-order",
        marketId: "market-1",
        environment: "sandbox",
        merchantId: "sandbox-merchant",
        locationId: "sandbox-location",
        paymentLinkId: "link-1",
        squareOrderId: "square-order-1",
        attempt: 1,
      },
    }),
    completePaymentLinkRetirement: async () => ({ kind: "retired" }),
    failPaymentLinkRetirement: async () => {},
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
      return Response.json({ payment_link: { id: "link-1", order_id: "square-order-1", url: "https://sandbox.square.link/checkout", created_at: "2026-10-01T12:00:00.000Z" } });
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
      paymentLinkId: "link-1", orderId: "square-order-1", checkoutUrl: "https://sandbox.square.link/checkout",
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
      status: "checkout_created", paymentLinkId: "link-1", squareOrderId: "square-order-1", checkoutUrl: "https://sandbox.square.link/checkout",
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
      : Response.json({ payment_link: { id: "link-1", order_id: "square-order-1", url: "https://sandbox.square.link/checkout", created_at: "2026-10-01T12:00:00.000Z" } });
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

test("an invalid provider checkout timestamp is permanently quarantined instead of retried", async () => {
  let failure: unknown;
  const result = await dispatchSquareSandboxCheckout({
    marketId: "market-1", reservationId: "reservation-1", square, now,
    store: store({ failCheckout: async value => { failure = value; } }),
    transport: (async () => Response.json({ payment_link: {
      id: "link-1", order_id: "square-order-1", url: "https://sandbox.square.link/checkout",
      created_at: "2026-02-30T12:00:00Z",
    } })) as typeof fetch,
  });
  assert.deepEqual(result, { kind: "failed", paymentOrderId: "payment-order" });
  assert.deepEqual(failure, {
    paymentOrderId: "payment-order", leaseToken: "lease-1",
    code: "square_provider_created_at_invalid", retryable: false, attemptedAt: now,
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
      id: "link-1", order_id: "square-order-1", url: "https://sandbox.square.link/checkout",
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

test("an expired Sandbox hold retires its one hosted link with a durable lease", async () => {
  let completed: unknown;
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const result = await dispatchSquarePaymentLinkRetirement({
    marketId: "market-1",
    square,
    now,
    store: retirementStore({
      completePaymentLinkRetirement: async value => {
        completed = value;
        return { kind: "retired" };
      },
    }),
    transport: (async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ id: "link-1", cancelled_order_id: "square-order-1" });
    }) as typeof fetch,
  });
  assert.deepEqual(result, { kind: "retired", paymentOrderId: "payment-order" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://connect.squareupsandbox.com/v2/online-checkout/payment-links/link-1");
  assert.equal(calls[0].init?.method, "DELETE");
  assert.deepEqual(completed, {
    paymentOrderId: "payment-order",
    leaseToken: "retirement-lease-1",
    cancelledOrderId: "square-order-1",
    retiredAt: now,
  });
});

test("a missing link releases capacity only after exact canceled-order recovery; provider failures remain retryable", async () => {
  let completed = 0;
  let failure: unknown;
  const missing = await dispatchSquarePaymentLinkRetirement({
    marketId: "market-1",
    square,
    now,
    store: retirementStore({
      completePaymentLinkRetirement: async () => { completed++; return { kind: "retired" }; },
    }),
    transport: (async url => String(url).includes("/payment-links/")
      ? new Response(null, { status: 404 })
      : Response.json({ order: { id: "square-order-1", location_id: "sandbox-location", state: "CANCELED" } })) as typeof fetch,
  });
  assert.deepEqual(missing, { kind: "retired", paymentOrderId: "payment-order" });
  assert.equal(completed, 1);

  const retry = await dispatchSquarePaymentLinkRetirement({
    marketId: "market-1",
    square,
    now,
    store: retirementStore({ failPaymentLinkRetirement: async value => { failure = value; } }),
    transport: (async () => new Response("private-detail", { status: 503 })) as typeof fetch,
  });
  assert.deepEqual(retry, { kind: "retry_scheduled", paymentOrderId: "payment-order" });
  assert.deepEqual(failure, {
    paymentOrderId: "payment-order",
    leaseToken: "retirement-lease-1",
    code: "square_http_503",
    retryable: true,
    attemptedAt: now,
  });
});

test("retirement retry delay begins after a slow provider failure, so one scheduler loop cannot immediately reclaim it", async () => {
  const claimAt = new Date("2026-10-03T12:00:00.000Z");
  const providerReturnedAt = new Date("2026-10-03T12:00:15.001Z");
  let clockCalls = 0;
  let claimInput: unknown;
  let failure: unknown;
  const result = await dispatchSquarePaymentLinkRetirement({
    marketId: "market-1",
    paymentOrderId: "qa-payment-order-1",
    square,
    clock: () => (++clockCalls === 1 ? claimAt : providerReturnedAt),
    store: retirementStore({
      claimPaymentLinkRetirement: async input => {
        claimInput = input;
        return {
          kind: "retirement_required",
          leaseToken: "retirement-lease-1",
          retirement: {
            paymentOrderId: "qa-payment-order-1", marketId: "market-1", environment: "sandbox",
            merchantId: "sandbox-merchant", locationId: "sandbox-location", paymentLinkId: "link-1",
            squareOrderId: "square-order-1", attempt: 1,
          },
        };
      },
      failPaymentLinkRetirement: async value => { failure = value; },
    }),
    transport: (async () => { throw new Error("slow provider timeout"); }) as typeof fetch,
  });
  assert.deepEqual(result, { kind: "retry_scheduled", paymentOrderId: "qa-payment-order-1" });
  assert.deepEqual(claimInput, {
    marketId: "market-1", paymentOrderId: "qa-payment-order-1", square, now: claimAt, leaseSeconds: 60,
  });
  assert.deepEqual(failure, {
    paymentOrderId: "qa-payment-order-1", leaseToken: "retirement-lease-1",
    code: "square_transport_error", retryable: true, attemptedAt: providerReturnedAt,
  });
});

test("missing or mismatched Square cancellation proof enters review and never finalizes retirement", async () => {
  const failures: unknown[] = [];
  const missingProof = await dispatchSquarePaymentLinkRetirement({
    marketId: "market-1",
    square,
    now,
    store: retirementStore({
      failPaymentLinkRetirement: async value => { failures.push(value); },
      completePaymentLinkRetirement: async () => { throw new Error("must not finalize"); },
    }),
    transport: (async () => Response.json({ id: "link-1" })) as typeof fetch,
  });
  assert.deepEqual(missingProof, { kind: "manual_review", paymentOrderId: "payment-order" });
  const mismatchedProof = await dispatchSquarePaymentLinkRetirement({
    marketId: "market-1",
    square,
    now,
    store: retirementStore({
      failPaymentLinkRetirement: async value => { failures.push(value); },
      completePaymentLinkRetirement: async () => { throw new Error("must not finalize"); },
    }),
    transport: (async () => Response.json({ id: "other-link", cancelled_order_id: "square-order-1" })) as typeof fetch,
  });
  assert.deepEqual(mismatchedProof, { kind: "manual_review", paymentOrderId: "payment-order" });
  const unproven404 = await dispatchSquarePaymentLinkRetirement({
    marketId: "market-1",
    square,
    now,
    store: retirementStore({
      failPaymentLinkRetirement: async value => { failures.push(value); },
      completePaymentLinkRetirement: async () => { throw new Error("must not finalize"); },
    }),
    transport: (async url => String(url).includes("/payment-links/")
      ? new Response(null, { status: 404 })
      : Response.json({ order: { id: "square-order-1", location_id: "sandbox-location", state: "OPEN" } })) as typeof fetch,
  });
  assert.deepEqual(unproven404, { kind: "manual_review", paymentOrderId: "payment-order" });
  assert.deepEqual(failures, [
    {
      paymentOrderId: "payment-order", leaseToken: "retirement-lease-1",
      code: "square_retirement_cancelled_order_missing", retryable: false, attemptedAt: now,
    },
    {
      paymentOrderId: "payment-order", leaseToken: "retirement-lease-1",
      code: "square_retirement_link_id_mismatch", retryable: false, attemptedAt: now,
    },
    {
      paymentOrderId: "payment-order", leaseToken: "retirement-lease-1",
      code: "square_retirement_missing_link_unproven", retryable: false, attemptedAt: now,
    },
  ]);
});

test("a foreign durable retirement is held for review without a provider request", async () => {
  let calls = 0;
  let failure: unknown;
  const result = await dispatchSquarePaymentLinkRetirement({
    marketId: "market-1",
    square,
    now,
    store: retirementStore({
      claimPaymentLinkRetirement: async () => ({
        kind: "retirement_required",
        leaseToken: "retirement-lease-1",
        retirement: {
          paymentOrderId: "payment-order",
          marketId: "market-1",
          environment: "sandbox",
          merchantId: "other-merchant",
          locationId: "sandbox-location",
          paymentLinkId: "link-1",
          squareOrderId: "square-order-1",
          attempt: 1,
        },
      }),
      failPaymentLinkRetirement: async value => { failure = value; },
    }),
    transport: (async () => { calls++; throw new Error("must not call Square"); }) as typeof fetch,
  });
  assert.deepEqual(result, { kind: "manual_review", paymentOrderId: "payment-order" });
  assert.equal(calls, 0);
  assert.deepEqual(failure, {
    paymentOrderId: "payment-order",
    leaseToken: "retirement-lease-1",
    code: "square_retirement_identity_mismatch",
    retryable: false,
    attemptedAt: now,
  });
});
