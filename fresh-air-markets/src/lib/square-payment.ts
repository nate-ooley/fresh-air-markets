import {
  createSquareCheckout,
  PAYMENT_WINDOW_MS,
  type ApprovedCheckout,
} from "./square";

/**
 * The checkout route receives this only after the server verifies the Sandbox
 * token and location with Square. `merchantId` is provider-returned identity,
 * never a value selected by a browser or copied from a URL.
 */
export interface VerifiedSquareSandbox {
  environment: "sandbox";
  accessToken: string;
  locationId: string;
  merchantId: string;
}

export type SquarePaymentOrderStatus =
  | "pending_checkout"
  | "processing_checkout"
  | "checkout_created"
  | "paid"
  | "expired"
  | "cancelled"
  | "manual_review"
  | "failed";

export type SquareCheckoutNotPayableReason = "nonprofit" | "terminal" | "expired" | "invalid_reservation";

/**
 * This is the durable record shared by checkout and webhook processing. It
 * intentionally has no vendor email, browser-return URL, or mutable price.
 */
export interface SquarePaymentOrder {
  id: string;
  marketId: string;
  reservationId: string;
  reservationRevision: number;
  environment: "sandbox";
  merchantId: string;
  locationId: string;
  expectedCurrency: "USD";
  expectedTotalCents: number;
  idempotencyKey: string;
  status: SquarePaymentOrderStatus;
  paymentLinkId: string | null;
  squareOrderId: string | null;
  checkoutUrl: string | null;
  paymentId: string | null;
  paymentStatus: string | null;
  paymentProviderCreatedAt: string | null;
  paymentProviderUpdatedAt: string | null;
  paymentRequestSentAt: string | null;
  paymentDueAt: string | null;
  checkoutAttempts: number;
}

export type SquareCheckoutClaim =
  | { kind: "checkout_required"; order: SquarePaymentOrder; leaseToken: string; approved: ApprovedCheckout }
  | { kind: "checkout_created"; order: SquarePaymentOrder }
  | { kind: "in_progress"; paymentOrderId: string }
  | { kind: "not_found" }
  | { kind: "not_payable"; reason: SquareCheckoutNotPayableReason };

export type SquareCheckoutFinalizeResult =
  | { kind: "completed"; order: SquarePaymentOrder }
  | { kind: "stale" };

/**
 * Postgres owns these three transitions. The first transition validates and
 * locks the committed reservation; no route body can supply a different
 * amount, date set, booth quantity, currency, revision, or vendor identity.
 */
export interface SquarePaymentCheckoutStore {
  claimCheckout(input: {
    marketId: string;
    reservationId: string;
    square: Pick<VerifiedSquareSandbox, "environment" | "merchantId" | "locationId">;
    now: Date;
    leaseSeconds: number;
  }): Promise<SquareCheckoutClaim>;
  completeCheckout(input: {
    paymentOrderId: string;
    leaseToken: string;
    checkout: {
      paymentLinkId: string;
      orderId: string;
      checkoutUrl: string;
      /** Provider creation time; anchors the immutable 48-hour window. */
      createdAt: string;
      idempotencyKey: string;
    };
    sentAt: Date;
  }): Promise<SquareCheckoutFinalizeResult>;
  failCheckout(input: {
    paymentOrderId: string;
    leaseToken: string;
    code: string;
    retryable: boolean;
    attemptedAt: Date;
  }): Promise<void>;
}

export type SquareCheckoutDispatchResult =
  | { kind: "created"; order: SquarePaymentOrder }
  | { kind: "existing"; order: SquarePaymentOrder }
  | { kind: "in_progress"; paymentOrderId: string }
  | { kind: "retry_scheduled"; paymentOrderId: string }
  | { kind: "failed"; paymentOrderId: string }
  | { kind: "not_found" }
  | { kind: "not_payable"; reason: SquareCheckoutNotPayableReason };

const RESERVATION_ID = /^[A-Za-z0-9:_-]{1,192}$/;

export function validSquareReservationId(value: unknown): value is string {
  return typeof value === "string" && RESERVATION_ID.test(value);
}

/** Only safe, provider-agnostic failure information reaches the database/API. */
export function classifySquareCheckoutFailure(error: unknown): { code: string; retryable: boolean } {
  const candidate = error as { status?: unknown; retryable?: unknown; code?: unknown } | null;
  if (candidate && typeof candidate.retryable === "boolean") {
    return {
      code: typeof candidate.code === "string" && candidate.code ? candidate.code.slice(0, 96) : "square_checkout_error",
      retryable: candidate.retryable,
    };
  }
  const status = typeof candidate?.status === "number"
    ? candidate.status
    : Number(/\((\d{3})\)/.exec(error instanceof Error ? error.message : "")?.[1]);
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) {
    return { code: `square_http_${status}`, retryable: true };
  }
  if (status >= 400 && status <= 499) return { code: `square_http_${status}`, retryable: false };
  return { code: "square_transport_error", retryable: true };
}

function providerLinkExpiredBeforePersistence(createdAt: string, now: Date): boolean {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && created + PAYMENT_WINDOW_MS <= now.valueOf();
}

/**
 * Create (or return) exactly one hosted checkout for a committed reservation
 * revision. A successful browser redirect never reaches this code and cannot
 * mark a reservation paid; webhook processing owns that separate transition.
 */
export async function dispatchSquareSandboxCheckout(input: {
  marketId: string;
  reservationId: string;
  square: VerifiedSquareSandbox;
  store: SquarePaymentCheckoutStore;
  transport?: typeof fetch;
  now?: Date;
  leaseSeconds?: number;
}): Promise<SquareCheckoutDispatchResult> {
  if (!validSquareReservationId(input.reservationId)) throw new Error("Invalid reservation ID.");
  if (!validSquareReservationId(input.marketId)) throw new Error("Invalid market ID.");
  if (input.square.environment !== "sandbox") throw new Error("Only Square Sandbox checkout is enabled.");
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("A valid server time is required.");
  const leaseSeconds = input.leaseSeconds ?? 60;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 300) {
    throw new Error("Checkout lease is invalid.");
  }
  const claim = await input.store.claimCheckout({
    marketId: input.marketId,
    reservationId: input.reservationId,
    square: input.square,
    now,
    leaseSeconds,
  });
  if (claim.kind === "checkout_created") return { kind: "existing", order: claim.order };
  if (claim.kind === "in_progress") return claim;
  if (claim.kind === "not_found") return claim;
  if (claim.kind === "not_payable") return claim;

  try {
    const checkout = await createSquareCheckout(input.square, claim.approved, input.transport, now.valueOf());
    // A process can crash after Square creates a link but before our database
    // records it. A later idempotent request can return that old link. Never
    // spin/retry it forever or grant a fresh 48-hour window: terminalize the
    // reservation for manager review without creating another provider link.
    if (providerLinkExpiredBeforePersistence(checkout.createdAt, now)) {
      await input.store.failCheckout({
        paymentOrderId: claim.order.id,
        leaseToken: claim.leaseToken,
        code: "square_link_expired_before_persistence",
        retryable: false,
        attemptedAt: now,
      });
      return { kind: "failed", paymentOrderId: claim.order.id };
    }
    const completed = await input.store.completeCheckout({
      paymentOrderId: claim.order.id,
      leaseToken: claim.leaseToken,
      checkout,
      sentAt: now,
    });
    if (completed.kind === "completed") return { kind: "created", order: completed.order };
    // A stale lease means another process has the durable result or the
    // request should retry its same stable provider idempotency key.
    return { kind: "in_progress", paymentOrderId: claim.order.id };
  } catch (error) {
    const failure = classifySquareCheckoutFailure(error);
    try {
      await input.store.failCheckout({
        paymentOrderId: claim.order.id,
        leaseToken: claim.leaseToken,
        code: failure.code,
        retryable: failure.retryable,
        attemptedAt: now,
      });
    } catch {
      // The next request safely reuses the provider idempotency key after the
      // lease expires. Do not report a checkout link that was not persisted.
      return { kind: "retry_scheduled", paymentOrderId: claim.order.id };
    }
    return failure.retryable
      ? { kind: "retry_scheduled", paymentOrderId: claim.order.id }
      : { kind: "failed", paymentOrderId: claim.order.id };
  }
}
