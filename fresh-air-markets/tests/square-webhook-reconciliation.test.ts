import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { reconcileSquarePaymentWebhook } = require("../.test-build/square-webhook-pg.js") as typeof import("../src/lib/square-webhook-pg");
type SquarePaymentWebhookTarget = import("../src/lib/square-payment-pg").SquarePaymentWebhookTarget;
type SquarePaymentWebhookEvent = import("../src/lib/square-webhook").SquarePaymentWebhookEvent;

function target(patch: Partial<SquarePaymentWebhookTarget> = {}): SquarePaymentWebhookTarget {
  return {
    id: "payment-order-1",
    marketId: "market-1",
    reservationId: "reservation-1",
    reservationRevision: 1,
    environment: "sandbox",
    merchantId: "merchant-1",
    locationId: "location-1",
    expectedCurrency: "USD",
    expectedTotalCents: 28000,
    idempotencyKey: "idempotency-1",
    status: "checkout_created",
    paymentLinkId: "link-1",
    squareOrderId: "order-1",
    checkoutUrl: "https://square.link/qa",
    paymentId: null,
    paymentStatus: null,
    paymentProviderCreatedAt: null,
    paymentProviderUpdatedAt: null,
    paymentRequestSentAt: "2026-10-01T12:00:00.000Z",
    paymentDueAt: "2026-10-03T12:00:00.000Z",
    checkoutAttempts: 1,
    orderStatus: "checkout_created",
    reservationState: "payment_pending",
    reservationPaymentDueAt: "2026-10-03T12:00:00.000Z",
    ...patch,
  };
}

function event(patch: Partial<SquarePaymentWebhookEvent> & { payment?: Partial<SquarePaymentWebhookEvent["payment"]> } = {}): SquarePaymentWebhookEvent {
  const payment = {
    id: "payment-1",
    status: "COMPLETED",
    locationId: "location-1",
    orderId: "order-1",
    amountCents: 28000,
    currency: "USD",
    createdAt: "2026-10-01T12:01:00.000Z",
    updatedAt: "2026-10-01T12:02:00.000Z",
    ...patch.payment,
  };
  return {
    eventId: "event-1",
    eventType: "payment.updated",
    merchantId: "merchant-1",
    occurredAt: "2026-10-01T12:02:00.000Z",
    rawBodySha256: "a".repeat(64),
    ...patch,
    payment,
  };
}

test("an exact completed payment before the stored deadline qualifies for the paid transition", () => {
  const decision = reconcileSquarePaymentWebhook(target(), event());
  assert.equal(decision.kind, "paid");
  if (decision.kind === "paid") assert.equal(decision.providerTime.toISOString(), "2026-10-01T12:02:00.000Z");
});

test("a stale out-of-order event cannot regress the newest provider state", () => {
  const decision = reconcileSquarePaymentWebhook(target({
    paymentStatus: "APPROVED",
    paymentProviderUpdatedAt: "2026-10-01T12:03:00.000Z",
  }), event({ payment: { id: "old-payment", updatedAt: "2026-10-01T12:02:00.000Z" } }));
  assert.deepEqual(decision.kind, "ignored");
  if (decision.kind === "ignored") assert.equal(decision.reason, "stale_provider_event");
});

test("a wrong amount or a completion after the deadline enters manual review", () => {
  const wrongAmount = reconcileSquarePaymentWebhook(target(), event({ payment: { amountCents: 27999 } }));
  assert.deepEqual(wrongAmount, { kind: "manual_review", reason: "payment_amount_or_currency_mismatch" });
  const late = reconcileSquarePaymentWebhook(target(), event({ payment: { updatedAt: "2026-10-03T12:00:00.001Z" } }));
  assert.deepEqual(late, { kind: "manual_review", reason: "payment_completed_after_deadline" });
});

test("a failed attempt does not bind its payment ID, so a later successful retry can qualify", () => {
  const afterFailedAttempt = target({
    paymentId: null,
    paymentStatus: "FAILED",
    paymentProviderUpdatedAt: "2026-10-01T12:03:00.000Z",
  });
  const laterCompletion = reconcileSquarePaymentWebhook(afterFailedAttempt, event({
    payment: { id: "different-successful-payment", updatedAt: "2026-10-01T12:04:00.000Z" },
  }));
  assert.equal(laterCompletion.kind, "paid");
});

test("a completed order or released reservation cannot be revived by an incoming payment", () => {
  const terminal = reconcileSquarePaymentWebhook(target({
    status: "paid", orderStatus: "paid", paymentId: "payment-1", paymentStatus: "COMPLETED",
    paymentProviderUpdatedAt: "2026-10-01T12:01:00.000Z",
  }), event({ payment: { id: "other-payment", updatedAt: "2026-10-01T12:02:00.000Z" } }));
  assert.deepEqual(terminal, { kind: "manual_review", reason: "payment_id_mismatch" });
  const released = reconcileSquarePaymentWebhook(target({ reservationState: "expired" }), event());
  assert.deepEqual(released, { kind: "manual_review", reason: "payment_order_or_reservation_not_payable" });
});
