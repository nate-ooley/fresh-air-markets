import {
  createSquareCheckout,
  deleteSquarePaymentLink,
  PAYMENT_WINDOW_MS,
  retrieveSquareOrderForRetirement,
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
  | "expiry_pending"
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

/**
 * At the deadline the order is fenced as `expiry_pending` before Square is
 * called. This independent lease keeps the external DELETE retryable without
 * reopening the hold or re-allocating its booths before retirement confirms.
 */
export interface SquarePaymentLinkRetirement {
  paymentOrderId: string;
  marketId: string;
  environment: "sandbox";
  merchantId: string;
  locationId: string;
  paymentLinkId: string;
  /** Exact Square order that must be cancelled before capacity can release. */
  squareOrderId: string;
  attempt: number;
}

export type SquarePaymentLinkRetirementClaim =
  | { kind: "retirement_required"; retirement: SquarePaymentLinkRetirement; leaseToken: string }
  | { kind: "no_work" }
  | { kind: "in_progress"; paymentOrderId: string }
  | { kind: "manual_review"; paymentOrderId: string };

export type SquarePaymentLinkRetirementFinalizeResult =
  | { kind: "retired" }
  | { kind: "manual_review" }
  | { kind: "stale" };

export interface SquarePaymentLinkRetirementStore {
  claimPaymentLinkRetirement(input: {
    marketId: string;
    square: Pick<VerifiedSquareSandbox, "environment" | "merchantId" | "locationId">;
    now: Date;
    leaseSeconds: number;
  }): Promise<SquarePaymentLinkRetirementClaim>;
  completePaymentLinkRetirement(input: {
    paymentOrderId: string;
    leaseToken: string;
    /** Provider-confirmed cancelled order ID, fenced to the durable order. */
    cancelledOrderId: string;
    retiredAt: Date;
  }): Promise<SquarePaymentLinkRetirementFinalizeResult>;
  failPaymentLinkRetirement(input: {
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

export type SquarePaymentLinkRetirementDispatchResult =
  | { kind: "retired"; paymentOrderId: string }
  | { kind: "already_retired"; paymentOrderId: string }
  | { kind: "in_progress"; paymentOrderId: string }
  | { kind: "retry_scheduled"; paymentOrderId: string }
  | { kind: "manual_review"; paymentOrderId: string }
  | { kind: "no_work" };

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

/**
 * Retire one already-expired Square Sandbox hosted link. The database lease
 * and the provider's DELETE endpoint are deliberately separate: an outage
 * leaves a durable pending retirement that a later scheduler run can retry.
 * The reservation stays payment-pending and keeps its capacity until the
 * provider confirms the link is gone; completion then expires both records
 * atomically.
 */
export async function dispatchSquarePaymentLinkRetirement(input: {
  /** The one configured portal market this scheduler is permitted to touch. */
  marketId: string;
  square: VerifiedSquareSandbox;
  store: SquarePaymentLinkRetirementStore;
  transport?: typeof fetch;
  now?: Date;
  leaseSeconds?: number;
}): Promise<SquarePaymentLinkRetirementDispatchResult> {
  if (input.square.environment !== "sandbox") throw new Error("Only Square Sandbox payment-link retirement is enabled.");
  if (!validSquareReservationId(input.marketId)) throw new Error("Invalid market ID.");
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("A valid server time is required.");
  const leaseSeconds = input.leaseSeconds ?? 60;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 300) {
    throw new Error("Payment-link retirement lease is invalid.");
  }
  const claim = await input.store.claimPaymentLinkRetirement({
    marketId: input.marketId,
    square: input.square,
    now,
    leaseSeconds,
  });
  if (claim.kind === "no_work") return claim;
  if (claim.kind === "in_progress") return claim;
  if (claim.kind === "manual_review") return claim;
  // The durable row is identity-fenced at creation and is rechecked when it
  // is claimed. Do not let an unrelated configured Square location delete it.
  if (claim.retirement.environment !== input.square.environment
    || claim.retirement.merchantId !== input.square.merchantId
    || claim.retirement.locationId !== input.square.locationId) {
    await input.store.failPaymentLinkRetirement({
      paymentOrderId: claim.retirement.paymentOrderId,
      leaseToken: claim.leaseToken,
      code: "square_retirement_identity_mismatch",
      retryable: false,
      attemptedAt: now,
    });
    return { kind: "manual_review", paymentOrderId: claim.retirement.paymentOrderId };
  }
  try {
    const deletion = await deleteSquarePaymentLink(input.square, claim.retirement.paymentLinkId, input.transport);
    let cancelledOrderId: string | null = null;
    let proofFailure: string | null = null;
    if (deletion.kind === "deleted") {
      if (deletion.paymentLinkId !== claim.retirement.paymentLinkId) {
        proofFailure = "square_retirement_link_id_mismatch";
      } else if (deletion.cancelledOrderId !== claim.retirement.squareOrderId) {
        proofFailure = deletion.cancelledOrderId
          ? "square_retirement_cancelled_order_mismatch"
          : "square_retirement_cancelled_order_missing";
      } else {
        cancelledOrderId = deletion.cancelledOrderId;
      }
    } else {
      // Retry after a process crash can see a missing link. Recover only when
      // Square's exact stored order is demonstrably CANCELED at this location;
      // OPEN, COMPLETED, absent, or malformed state remains operator review.
      const recovered = await retrieveSquareOrderForRetirement(input.square, claim.retirement.squareOrderId, input.transport);
      if (recovered.orderId === claim.retirement.squareOrderId
        && recovered.locationId === input.square.locationId
        && recovered.state === "CANCELED") {
        cancelledOrderId = recovered.orderId;
      } else {
        proofFailure = "square_retirement_missing_link_unproven";
      }
    }
    if (!cancelledOrderId) {
      await input.store.failPaymentLinkRetirement({
        paymentOrderId: claim.retirement.paymentOrderId,
        leaseToken: claim.leaseToken,
        code: proofFailure ?? "square_retirement_cancellation_unproven",
        retryable: false,
        attemptedAt: now,
      });
      return { kind: "manual_review", paymentOrderId: claim.retirement.paymentOrderId };
    }
    const completed = await input.store.completePaymentLinkRetirement({
      paymentOrderId: claim.retirement.paymentOrderId,
      leaseToken: claim.leaseToken,
      cancelledOrderId,
      retiredAt: now,
    });
    if (completed.kind === "retired") return { kind: "retired", paymentOrderId: claim.retirement.paymentOrderId };
    if (completed.kind === "manual_review") return { kind: "manual_review", paymentOrderId: claim.retirement.paymentOrderId };
    return { kind: "in_progress", paymentOrderId: claim.retirement.paymentOrderId };
  } catch (error) {
    const failure = classifySquareCheckoutFailure(error);
    try {
      await input.store.failPaymentLinkRetirement({
        paymentOrderId: claim.retirement.paymentOrderId,
        leaseToken: claim.leaseToken,
        code: failure.code,
        retryable: failure.retryable,
        attemptedAt: now,
      });
    } catch {
      return { kind: "retry_scheduled", paymentOrderId: claim.retirement.paymentOrderId };
    }
    return failure.retryable
      ? { kind: "retry_scheduled", paymentOrderId: claim.retirement.paymentOrderId }
      : { kind: "manual_review", paymentOrderId: claim.retirement.paymentOrderId };
  }
}
