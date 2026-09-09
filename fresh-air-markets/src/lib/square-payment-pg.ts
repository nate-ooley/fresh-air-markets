import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { PAYMENT_WINDOW_MS, type ApprovedCheckout, type SquareEnvironment } from "./square";
import {
  type SquareCheckoutClaim,
  type SquareCheckoutFinalizeResult,
  type SquarePaymentCheckoutStore,
  type SquarePaymentLinkRetirement,
  type SquarePaymentLinkRetirementClaim,
  type SquarePaymentLinkRetirementFinalizeResult,
  type SquarePaymentLinkRetirementStore,
  type SquarePaymentOrder,
  type SquarePaymentOrderStatus,
  type VerifiedSquareIdentity,
} from "./square-payment";

type Sql = ReturnType<typeof postgres>;
type QuerySql = Sql | postgres.TransactionSql;
let client: Sql | undefined;

function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent Square payment storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

interface ReservationRow {
  id: string;
  market_id: string;
  revision: number;
  state: string;
  payment_required: boolean;
  currency: string;
  total_cents: number | string;
  checkout_description: string;
  payment_request_sent_at: Date | null;
  payment_due_at: Date | null;
}

interface PaymentOrderRow {
  id: string;
  market_id: string;
  reservation_id: string;
  reservation_revision: number;
  square_environment: SquareEnvironment;
  square_merchant_id: string;
  square_location_id: string;
  expected_currency: "USD";
  expected_total_cents: number | string;
  idempotency_key: string;
  status: SquarePaymentOrderStatus;
  square_payment_link_id: string | null;
  square_order_id: string | null;
  checkout_url: string | null;
  payment_id: string | null;
  payment_status: string | null;
  payment_provider_created_at: Date | null;
  payment_provider_updated_at: Date | null;
  payment_request_sent_at: Date | null;
  payment_due_at: Date | null;
  checkout_attempts: number;
  lease_token: string | null;
}

interface PaymentLinkRetirementRow {
  payment_order_id: string;
  market_id: string;
  square_environment: SquareEnvironment;
  square_merchant_id: string;
  square_location_id: string;
  square_payment_link_id: string;
  square_order_id: string;
  status: "pending" | "processing" | "retired" | "manual_review";
  attempt_count: number | string;
  locked_until: Date | null;
  lease_token: string | null;
}

interface PaymentLinkRetirementCandidateRow extends PaymentLinkRetirementRow {
  parent_market_id: string;
  parent_square_environment: SquareEnvironment;
  parent_square_merchant_id: string;
  parent_square_location_id: string;
  parent_square_payment_link_id: string | null;
  parent_square_order_id: string | null;
}

interface ExpiringPaymentRow {
  payment_order_id: string;
  reservation_id: string;
  market_id: string;
  payment_due_at: Date | null;
  reservation_due_at: Date | null;
  square_environment: SquareEnvironment;
  square_merchant_id: string;
  square_location_id: string;
  square_payment_link_id: string | null;
  square_order_id: string | null;
}

/** Aggregate-only result for the internal scheduler; it never exposes vendors. */
export interface SquarePaymentExpiryResult {
  /** Holds fenced at the deadline and queued for provider link deletion. */
  expiryPending: number;
  manualReview: number;
}

export interface SquarePaymentWebhookTarget extends SquarePaymentOrder {
  /** Named explicitly for event-state transition code. */
  orderStatus: SquarePaymentOrderStatus;
  reservationState: string;
  reservationPaymentDueAt: string | null;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toPaymentOrder(row: PaymentOrderRow): SquarePaymentOrder {
  const expectedTotalCents = Number(row.expected_total_cents);
  if (!Number.isSafeInteger(expectedTotalCents) || expectedTotalCents <= 0) {
    throw new Error("Stored Square payment order has an invalid amount.");
  }
  return {
    id: row.id,
    marketId: row.market_id,
    reservationId: row.reservation_id,
    reservationRevision: Number(row.reservation_revision),
    environment: row.square_environment,
    merchantId: row.square_merchant_id,
    locationId: row.square_location_id,
    expectedCurrency: row.expected_currency,
    expectedTotalCents,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    paymentLinkId: row.square_payment_link_id,
    squareOrderId: row.square_order_id,
    checkoutUrl: row.checkout_url,
    paymentId: row.payment_id,
    paymentStatus: row.payment_status,
    paymentProviderCreatedAt: iso(row.payment_provider_created_at),
    paymentProviderUpdatedAt: iso(row.payment_provider_updated_at),
    paymentRequestSentAt: iso(row.payment_request_sent_at),
    paymentDueAt: iso(row.payment_due_at),
    checkoutAttempts: Number(row.checkout_attempts),
  };
}

function dueDate(now: Date): Date {
  return new Date(now.valueOf() + PAYMENT_WINDOW_MS);
}

/** The provider's immutable payment-link creation time anchors the hold. */
export function squarePaymentDeadlineFromProviderLink(createdAt: Date): Date | null {
  const deadline = new Date(createdAt.valueOf() + PAYMENT_WINDOW_MS);
  return Number.isFinite(deadline.valueOf()) ? deadline : null;
}

/** Must remain byte-for-byte compatible with createSquareCheckout(). */
export function squarePaymentOrderIdempotencyKey(input: {
  environment: SquareEnvironment;
  locationId: string;
  reservationId: string;
  reservationRevision: number;
}): string {
  return createHash("sha256")
    .update(`${input.environment}:${input.locationId}:${input.reservationId}:${input.reservationRevision}`)
    .digest("hex");
}

function validDueDate(value: Date | null, now: Date): value is Date {
  return value instanceof Date && Number.isFinite(value.valueOf()) && value.valueOf() > now.valueOf();
}

function approvedCheckout(reservation: ReservationRow, paymentDueAt: Date): ApprovedCheckout | null {
  const totalCents = Number(reservation.total_cents);
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0
    || !Number.isSafeInteger(Number(reservation.revision)) || Number(reservation.revision) < 1
    || reservation.currency !== "USD"
    || !reservation.checkout_description.trim()
    || reservation.checkout_description.length > 255) return null;
  return {
    reservationId: reservation.id,
    revision: Number(reservation.revision),
    totalCents,
    description: reservation.checkout_description,
    paymentDeadline: paymentDueAt.toISOString(),
  };
}

function terminalReservation(state: string): boolean {
  return ["paid", "confirmed", "cancelled", "declined", "manual_review"].includes(state);
}

function terminalOrder(status: SquarePaymentOrderStatus): boolean {
  return ["paid", "expiry_pending", "expired", "cancelled", "manual_review", "failed"].includes(status);
}

function claimResultForExisting(
  order: SquarePaymentOrder,
  reservation: ReservationRow,
  now: Date,
): Exclude<SquareCheckoutClaim, { kind: "checkout_required" }> | null {
  if (terminalOrder(order.status)) {
    return order.status === "expired" ? { kind: "not_payable", reason: "expired" } : { kind: "not_payable", reason: "terminal" };
  }
  if (order.status === "checkout_created") {
    const due = order.paymentDueAt ? new Date(order.paymentDueAt) : reservation.payment_due_at;
    if (!validDueDate(due, now)) return { kind: "not_payable", reason: "expired" };
    return { kind: "checkout_created", order };
  }
  return null;
}

/**
 * Atomically locks a final reservation and leases its one provider call. It
 * stores a stable order before touching Square, so a retry after a timeout
 * uses exactly the same provider idempotency key. The payment window is not
 * stored until Square returns a usable link with its creation timestamp.
 */
export async function claimSquarePaymentCheckout(input: {
  marketId: string;
  reservationId: string;
  square: Pick<VerifiedSquareIdentity, "environment" | "merchantId" | "locationId">;
  now: Date;
  leaseSeconds: number;
}, sql: Sql = configuredClient()): Promise<SquareCheckoutClaim> {
  return sql.begin(async tx => {
    const [reservation] = await tx<ReservationRow[]>`
      SELECT r.id, r.market_id, r.revision, r.state, r.payment_required, r.currency,
             r.total_cents, r.checkout_description, r.payment_request_sent_at,
             r.payment_due_at
      FROM fame_reservations r
      -- Only the atomic CHECK→RESERVE writer may make a row payable. This
      -- prevents a manually seeded or legacy booking record from acquiring a
      -- hosted checkout before its final dates, quantity, eligibility and
      -- quote have been frozen in the companion audit row.
      JOIN fame_reservation_finalizations f
        ON f.reservation_id = r.id AND f.market_id = r.market_id
      WHERE r.id = ${input.reservationId} AND r.market_id = ${input.marketId}
      FOR UPDATE OF r`;
    if (!reservation) return { kind: "not_found" };
    if (!reservation.payment_required) return { kind: "not_payable", reason: "nonprofit" };
    if (terminalReservation(reservation.state)) {
      return { kind: "not_payable", reason: reservation.state === "expired" ? "expired" : "terminal" };
    }
    const existingRows = await tx<PaymentOrderRow[]>`
      SELECT id, market_id, reservation_id, reservation_revision,
             square_environment, square_merchant_id, square_location_id,
             expected_currency, expected_total_cents, idempotency_key, status,
             square_payment_link_id, square_order_id, checkout_url, payment_id,
             payment_status, payment_provider_created_at, payment_provider_updated_at,
             payment_request_sent_at, payment_due_at,
             checkout_attempts, lease_token
      FROM fame_payment_orders
      WHERE reservation_id = ${reservation.id} AND reservation_revision = ${reservation.revision}
      FOR UPDATE`;
    const existing = existingRows[0] ? toPaymentOrder(existingRows[0]) : null;
    if (existing) {
      if (existing.environment !== input.square.environment
        || existing.merchantId !== input.square.merchantId
        || existing.locationId !== input.square.locationId) {
        // Never silently attach a payment order to a different Square identity.
        return { kind: "not_payable", reason: "invalid_reservation" };
      }
      const resolved = claimResultForExisting(existing, reservation, input.now);
      if (resolved) return resolved;
      const lockedUntil = await tx<{ locked_until: Date | null }[]>`
        SELECT locked_until FROM fame_payment_orders WHERE id = ${existing.id}`;
      if (existing.status === "processing_checkout" && lockedUntil[0]?.locked_until
        && lockedUntil[0].locked_until.valueOf() > input.now.valueOf()) {
        return { kind: "in_progress", paymentOrderId: existing.id };
      }
      const existingDue = existing.paymentDueAt ? new Date(existing.paymentDueAt) : reservation.payment_due_at;
      if (existingDue && !validDueDate(existingDue, input.now)) return { kind: "not_payable", reason: "expired" };
      // A failed pre-link attempt has no durable payment window yet. The
      // provisional value satisfies Square's request validation only; final
      // persistence anchors the real window to payment_link.created_at.
      const due = existingDue ?? dueDate(input.now);
      const leaseToken = randomUUID();
      const [claimed] = await tx<PaymentOrderRow[]>`
        UPDATE fame_payment_orders
        SET status = 'processing_checkout',
            checkout_attempts = checkout_attempts + 1,
            locked_until = ${new Date(input.now.valueOf() + input.leaseSeconds * 1000)},
            lease_token = ${leaseToken},
            last_error_code = NULL,
            updated_at = ${input.now}
        WHERE id = ${existing.id}
          AND status IN ('pending_checkout', 'processing_checkout')
        RETURNING id, market_id, reservation_id, reservation_revision,
                  square_environment, square_merchant_id, square_location_id,
                  expected_currency, expected_total_cents, idempotency_key, status,
                  square_payment_link_id, square_order_id, checkout_url, payment_id,
                  payment_status, payment_provider_created_at, payment_provider_updated_at,
                  payment_request_sent_at, payment_due_at,
                  checkout_attempts, lease_token`;
      if (!claimed) return { kind: "in_progress", paymentOrderId: existing.id };
      const approved = approvedCheckout(reservation, due);
      if (!approved) throw new Error("Committed reservation has invalid checkout data.");
      return { kind: "checkout_required", order: toPaymentOrder(claimed), leaseToken, approved };
    }

    if (reservation.state !== "held" && reservation.state !== "payment_pending") {
      return { kind: "not_payable", reason: "invalid_reservation" };
    }
    if (reservation.payment_due_at && !validDueDate(reservation.payment_due_at, input.now)) {
      return { kind: "not_payable", reason: "expired" };
    }
    const provisionalDueAt = reservation.payment_due_at ?? dueDate(input.now);
    const approved = approvedCheckout(reservation, provisionalDueAt);
    if (!approved) return { kind: "not_payable", reason: "invalid_reservation" };
    const id = randomUUID();
    const leaseToken = randomUUID();
    const idempotencyKey = squarePaymentOrderIdempotencyKey({
      environment: input.square.environment,
      locationId: input.square.locationId,
      reservationId: reservation.id,
      reservationRevision: Number(reservation.revision),
    });
    const [created] = await tx<PaymentOrderRow[]>`
      INSERT INTO fame_payment_orders
        (id, market_id, reservation_id, reservation_revision, square_environment,
         square_merchant_id, square_location_id, expected_currency,
         expected_total_cents, idempotency_key, status,
         checkout_attempts, locked_until, lease_token, created_at, updated_at)
      VALUES
        (${id}, ${reservation.market_id}, ${reservation.id}, ${reservation.revision},
         ${input.square.environment}, ${input.square.merchantId}, ${input.square.locationId},
         'USD', ${approved.totalCents}, ${idempotencyKey}, 'processing_checkout',
         1, ${new Date(input.now.valueOf() + input.leaseSeconds * 1000)},
         ${leaseToken}, ${input.now}, ${input.now})
      RETURNING id, market_id, reservation_id, reservation_revision,
                square_environment, square_merchant_id, square_location_id,
                expected_currency, expected_total_cents, idempotency_key, status,
                square_payment_link_id, square_order_id, checkout_url, payment_id,
                payment_status, payment_provider_created_at, payment_provider_updated_at,
                payment_request_sent_at, payment_due_at,
                checkout_attempts, lease_token`;
    if (!created) throw new Error("Square payment order write failed.");
    return { kind: "checkout_required", order: toPaymentOrder(created), leaseToken, approved };
  });
}

/** Persist Square's hosted-link response only while the caller owns its lease. */
export async function completeSquarePaymentCheckout(input: {
  paymentOrderId: string;
  leaseToken: string;
  checkout: {
    paymentLinkId: string;
    orderId: string;
    checkoutUrl: string;
    createdAt: string;
    idempotencyKey: string;
  };
  sentAt: Date;
}, sql: Sql = configuredClient()): Promise<SquareCheckoutFinalizeResult> {
  const providerCreatedAt = new Date(input.checkout.createdAt);
  const providerDeadline = squarePaymentDeadlineFromProviderLink(providerCreatedAt);
  if (!input.paymentOrderId || !input.leaseToken || !input.checkout.paymentLinkId
    || !input.checkout.orderId || !/^https:\/\//.test(input.checkout.checkoutUrl)
    || !Number.isFinite(providerCreatedAt.valueOf()) || !providerDeadline
    // Five minutes permits benign clock skew but rejects a malformed/future
    // timestamp instead of granting an unbounded payment window.
    || providerCreatedAt.valueOf() > input.sentAt.valueOf() + 5 * 60 * 1000
    || providerDeadline.valueOf() <= input.sentAt.valueOf()) return { kind: "stale" };
  return sql.begin(async tx => {
    const [order] = await tx<PaymentOrderRow[]>`
      SELECT id, market_id, reservation_id, reservation_revision,
             square_environment, square_merchant_id, square_location_id,
             expected_currency, expected_total_cents, idempotency_key, status,
             square_payment_link_id, square_order_id, checkout_url, payment_id,
             payment_status, payment_provider_created_at, payment_provider_updated_at,
             payment_request_sent_at, payment_due_at,
             checkout_attempts, lease_token
      FROM fame_payment_orders WHERE id = ${input.paymentOrderId} FOR UPDATE`;
    if (!order || order.status !== "processing_checkout" || order.lease_token !== input.leaseToken
      || order.idempotency_key !== input.checkout.idempotencyKey) return { kind: "stale" };
    const storedDeadline = order.payment_due_at;
    if (storedDeadline && storedDeadline.valueOf() !== providerDeadline.valueOf()) return { kind: "stale" };
    const [updated] = await tx<PaymentOrderRow[]>`
      UPDATE fame_payment_orders
      SET status = 'checkout_created',
          square_payment_link_id = ${input.checkout.paymentLinkId},
          square_order_id = ${input.checkout.orderId},
          checkout_url = ${input.checkout.checkoutUrl},
          payment_request_sent_at = COALESCE(payment_request_sent_at, ${providerCreatedAt}),
          payment_due_at = COALESCE(payment_due_at, ${providerDeadline}),
          locked_until = NULL,
          lease_token = NULL,
          last_error_code = NULL,
          updated_at = ${input.sentAt}
      WHERE id = ${input.paymentOrderId}
        AND status = 'processing_checkout'
        AND lease_token = ${input.leaseToken}
      RETURNING id, market_id, reservation_id, reservation_revision,
                square_environment, square_merchant_id, square_location_id,
                expected_currency, expected_total_cents, idempotency_key, status,
                square_payment_link_id, square_order_id, checkout_url, payment_id,
                payment_status, payment_provider_created_at, payment_provider_updated_at,
                payment_request_sent_at, payment_due_at,
                checkout_attempts, lease_token`;
    if (!updated) return { kind: "stale" };
    const [reservation] = await tx`
      UPDATE fame_reservations
      SET state = 'payment_pending',
          payment_request_sent_at = COALESCE(payment_request_sent_at, ${providerCreatedAt}),
          payment_due_at = COALESCE(payment_due_at, ${providerDeadline}),
          updated_at = ${input.sentAt}
      WHERE id = ${order.reservation_id}
        AND market_id = ${order.market_id}
        AND state IN ('held', 'payment_pending')
        AND (payment_due_at IS NULL OR payment_due_at = ${providerDeadline})
      RETURNING id`;
    // Roll back the just-written link instead of splitting its deadline from
    // the final reservation record when a concurrent state change intervenes.
    if (!reservation) throw new Error("Reservation changed before checkout persistence.");
    return { kind: "completed", order: toPaymentOrder(updated) };
  });
}

/**
 * A transport/5xx failure releases the order for a stable-key retry without
 * extending the deadline. A permanent provider failure stops automatic retry
 * and puts the reservation in manual review; it never silently frees capacity.
 */
export async function failSquarePaymentCheckout(input: {
  paymentOrderId: string;
  leaseToken: string;
  code: string;
  retryable: boolean;
  attemptedAt: Date;
}, sql: Sql = configuredClient()): Promise<void> {
  const safeCode = input.code.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 96) || "square_checkout_error";
  await sql.begin(async tx => {
    const [order] = await tx<{ reservation_id: string; market_id: string }[]>`
      UPDATE fame_payment_orders
      SET status = ${input.retryable ? "pending_checkout" : "failed"},
          locked_until = NULL,
          lease_token = NULL,
          last_error_code = ${safeCode},
          failed_at = ${input.retryable ? null : input.attemptedAt},
          updated_at = ${input.attemptedAt}
      WHERE id = ${input.paymentOrderId}
        AND status = 'processing_checkout'
        AND lease_token = ${input.leaseToken}
      RETURNING reservation_id, market_id`;
    if (!order || input.retryable) return;
    await tx`
      UPDATE fame_reservations
      SET state = 'manual_review', updated_at = ${input.attemptedAt}
      WHERE id = ${order.reservation_id} AND market_id = ${order.market_id}
        AND state IN ('held', 'payment_pending')`;
  });
}

function validSchedulerLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 100;
}

const SCHEDULER_PAYMENT_ORDER_ID = /^[A-Za-z0-9:_-]{1,192}$/;

function validSchedulerPaymentOrderId(value: string | undefined): boolean {
  return value === undefined || SCHEDULER_PAYMENT_ORDER_ID.test(value);
}

// A failed DELETE must not be reclaimed by the next loop iteration of the
// same scheduler invocation. Keep the retry time durable so concurrent workers
// and later invocations observe one shared, bounded exponential schedule.
const RETIREMENT_RETRY_INITIAL_DELAY_MS = 15_000;
const RETIREMENT_RETRY_MAX_DELAY_MS = 15 * 60_000;

function retirementRetryAt(attemptedAt: Date, attemptCount: number): Date {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new Error("Stored payment-link retirement attempt is invalid.");
  }
  const exponent = Math.min(attemptCount - 1, 6);
  const delay = Math.min(
    RETIREMENT_RETRY_INITIAL_DELAY_MS * 2 ** exponent,
    RETIREMENT_RETRY_MAX_DELAY_MS,
  );
  return new Date(attemptedAt.valueOf() + delay);
}

/**
 * Atomically claims usable hosted-checkout holds at their persisted deadline.
 *
 * Allocation rows are immutable audit data under migration 013, so this does
 * not delete them. The payment order moves to `expiry_pending`, while the
 * reservation remains `payment_pending` and continues consuming capacity until
 * Square has confirmed that the hosted link is deleted. Each claim writes one
 * durable retirement work item. A provider outage therefore cannot leave a
 * live payment link racing a capacity release.
 */
export async function expireDueSquarePaymentHolds(input: {
  marketId: string;
  /** Older QA callers default to Sandbox; every deployed route supplies this. */
  environment?: SquareEnvironment;
  /** QA fault runs can fence exactly one durable payment order. */
  paymentOrderId?: string;
  now: Date;
  limit: number;
}, sql: Sql = configuredClient()): Promise<SquarePaymentExpiryResult> {
  if (!input.marketId || !validSchedulerPaymentOrderId(input.paymentOrderId)
    || !Number.isFinite(input.now.valueOf()) || !validSchedulerLimit(input.limit)) {
    throw new Error("Square payment expiry input is invalid.");
  }
  const environment = input.environment ?? "sandbox";
  if (!["sandbox", "production"].includes(environment)) throw new Error("Invalid Square environment.");
  const paymentOrderId = input.paymentOrderId ?? null;
  return sql.begin(async tx => {
    // Lock in the same payment-order/reservation relationship that webhook
    // reconciliation uses. Whichever transaction wins the row lock decides:
    // a valid payment can become paid first, otherwise expiration wins and a
    // delayed event is retained by L19 for manual review without reclaiming
    // inventory.
    const candidates = await tx<ExpiringPaymentRow[]>`
      SELECT p.id AS payment_order_id, p.reservation_id, p.market_id,
             p.payment_due_at, r.payment_due_at AS reservation_due_at,
             p.square_environment, p.square_merchant_id, p.square_location_id,
             p.square_payment_link_id, p.square_order_id
      FROM fame_payment_orders p
      JOIN fame_reservations r
        ON r.id = p.reservation_id AND r.market_id = p.market_id
      WHERE p.status = 'checkout_created'
        AND p.square_environment = ${environment}
        AND p.market_id = ${input.marketId}
        AND (${paymentOrderId}::text IS NULL OR p.id = ${paymentOrderId})
        AND r.state = 'payment_pending'
        -- A missing or divergent persisted deadline is unsafe even when both
        -- values would otherwise be in the future. Fence it immediately for
        -- review instead of leaving a live link with an unknowable deadline.
        AND (
          p.payment_due_at IS NULL
          OR r.payment_due_at IS NULL
          OR p.payment_due_at IS DISTINCT FROM r.payment_due_at
          OR p.payment_due_at <= ${input.now}
        )
      ORDER BY p.payment_due_at ASC NULLS FIRST, p.id ASC
      LIMIT ${input.limit}
      FOR UPDATE OF p, r SKIP LOCKED`;
    let expiryPending = 0;
    let manualReview = 0;
    for (const candidate of candidates) {
      const matchingDeadlines = candidate.payment_due_at
        && candidate.reservation_due_at
        && candidate.payment_due_at.valueOf() === candidate.reservation_due_at.valueOf();
      if (!matchingDeadlines || !candidate.square_payment_link_id || !candidate.square_order_id) {
        // Never release an ambiguously timed/corrupt hold. Preserve its
        // allocation for a manager and make the mismatch durable, rather than
        // accidentally allowing double allocation after an unknown payment.
        const [order] = await tx`
          UPDATE fame_payment_orders
          SET status = 'manual_review',
              locked_until = NULL,
              lease_token = NULL,
              last_error_code = ${!matchingDeadlines
                ? "payment_deadline_missing_or_mismatched"
                : "payment_link_or_order_missing_at_expiry"},
              updated_at = ${input.now}
          WHERE id = ${candidate.payment_order_id} AND status = 'checkout_created'
          RETURNING reservation_id, market_id`;
        if (!order) throw new Error("Square payment order changed before expiry review.");
        const [reservation] = await tx`
          UPDATE fame_reservations
          SET state = 'manual_review', updated_at = ${input.now}
          WHERE id = ${order.reservation_id}
            AND market_id = ${order.market_id}
            AND state = 'payment_pending'
          RETURNING id`;
        if (!reservation) throw new Error("Reservation changed before expiry review.");
        manualReview++;
        continue;
      }

      const [order] = await tx`
        UPDATE fame_payment_orders
        SET status = 'expiry_pending',
            locked_until = NULL,
            lease_token = NULL,
            last_error_code = 'payment_expiry_pending',
            updated_at = ${input.now}
        WHERE id = ${candidate.payment_order_id}
          AND status = 'checkout_created'
          AND payment_due_at = ${candidate.payment_due_at}
        RETURNING id`;
      if (!order) throw new Error("Square payment order changed before expiry claim.");
      await tx`
        INSERT INTO fame_square_payment_link_retirements
          (payment_order_id, market_id, square_environment, square_merchant_id,
           square_location_id, square_payment_link_id, square_order_id,
           status, next_attempt_at, created_at, updated_at)
        VALUES
          (${candidate.payment_order_id}, ${candidate.market_id}, ${candidate.square_environment},
           ${candidate.square_merchant_id}, ${candidate.square_location_id},
           ${candidate.square_payment_link_id}, ${candidate.square_order_id},
           'pending', ${input.now}, ${input.now}, ${input.now})
        ON CONFLICT (payment_order_id) DO NOTHING`;
      expiryPending++;
    }
    return { expiryPending, manualReview };
  });
}

function retirementFromRow(row: PaymentLinkRetirementRow): SquarePaymentLinkRetirement {
  const attempt = Number(row.attempt_count);
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("Stored payment-link retirement is invalid.");
  return {
    paymentOrderId: row.payment_order_id,
    marketId: row.market_id,
    environment: row.square_environment,
    merchantId: row.square_merchant_id,
    locationId: row.square_location_id,
    paymentLinkId: row.square_payment_link_id,
    squareOrderId: row.square_order_id,
    attempt,
  };
}

/** Claim one due link retirement only in the configured provider environment. */
export async function claimSquarePaymentLinkRetirement(input: {
  marketId: string;
  /** QA fault runs can claim only this known durable payment order. */
  paymentOrderId?: string;
  square: Pick<VerifiedSquareIdentity, "environment" | "merchantId" | "locationId">;
  now: Date;
  leaseSeconds: number;
}, sql: Sql = configuredClient()): Promise<SquarePaymentLinkRetirementClaim> {
  if (!input.marketId || !validSchedulerPaymentOrderId(input.paymentOrderId)
    || !Number.isFinite(input.now.valueOf())
    || !Number.isSafeInteger(input.leaseSeconds)
    || input.leaseSeconds < 10
    || input.leaseSeconds > 300) throw new Error("Square payment-link retirement claim is invalid.");
  const paymentOrderId = input.paymentOrderId ?? null;
  return sql.begin(async tx => {
    const [row] = await tx<PaymentLinkRetirementCandidateRow[]>`
      SELECT q.payment_order_id, q.market_id, q.square_environment,
             q.square_merchant_id, q.square_location_id, q.square_payment_link_id, q.square_order_id,
             q.status, q.attempt_count, q.locked_until, q.lease_token,
             p.market_id AS parent_market_id,
             p.square_environment AS parent_square_environment,
             p.square_merchant_id AS parent_square_merchant_id,
             p.square_location_id AS parent_square_location_id,
             p.square_payment_link_id AS parent_square_payment_link_id,
             p.square_order_id AS parent_square_order_id
      FROM fame_square_payment_link_retirements q
      JOIN fame_payment_orders p ON p.id = q.payment_order_id
      JOIN fame_reservations r ON r.id = p.reservation_id AND r.market_id = p.market_id
      WHERE q.status IN ('pending', 'processing')
        AND p.square_environment = ${input.square.environment}
        AND p.market_id = ${input.marketId}
        AND (${paymentOrderId}::text IS NULL OR q.payment_order_id = ${paymentOrderId})
        AND (
          (q.status = 'pending' AND q.next_attempt_at <= ${input.now})
          OR (q.status = 'processing' AND q.locked_until <= ${input.now})
        )
        AND p.status = 'expiry_pending'
        AND r.state = 'payment_pending'
      ORDER BY q.created_at ASC, q.payment_order_id ASC
      LIMIT 1
      -- Take the payment/reservation locks first. Webhook reconciliation uses
      -- that same pair before it fences a retirement row, so a signed event
      -- cannot deadlock with this worker while it preserves capacity.
      FOR UPDATE OF p, r SKIP LOCKED`;
    if (!row) return { kind: "no_work" };
    const parentMatches = row.market_id === row.parent_market_id
      && row.square_environment === row.parent_square_environment
      && row.square_merchant_id === row.parent_square_merchant_id
      && row.square_location_id === row.parent_square_location_id
      && row.square_payment_link_id === row.parent_square_payment_link_id
      && row.square_order_id === row.parent_square_order_id;
    const configuredIdentityMatches = row.square_environment === input.square.environment
      && row.square_merchant_id === input.square.merchantId
      && row.square_location_id === input.square.locationId;
    if (!parentMatches || !configuredIdentityMatches) {
      const reason = parentMatches
        ? "square_retirement_identity_mismatch"
        : "square_retirement_parent_mapping_mismatch";
      const [retirement] = await tx`
        UPDATE fame_square_payment_link_retirements
        SET status = 'manual_review', locked_until = NULL, lease_token = NULL,
            next_attempt_at = NULL,
            last_error_code = ${reason}, updated_at = ${input.now}
        WHERE payment_order_id = ${row.payment_order_id}
          AND status IN ('pending', 'processing')
          AND (
            (status = 'pending' AND next_attempt_at <= ${input.now})
            OR (status = 'processing' AND locked_until <= ${input.now})
          )
        RETURNING payment_order_id`;
      if (!retirement) return { kind: "in_progress", paymentOrderId: row.payment_order_id };
      const [order] = await tx`
        UPDATE fame_payment_orders
        SET status = 'manual_review', locked_until = NULL, lease_token = NULL,
            last_error_code = ${reason}, updated_at = ${input.now}
        WHERE id = ${row.payment_order_id} AND status = 'expiry_pending'
        RETURNING reservation_id, market_id`;
      if (!order) throw new Error("Square payment order changed before retirement review.");
      const [reservation] = await tx`
        UPDATE fame_reservations
        SET state = 'manual_review', updated_at = ${input.now}
        WHERE id = ${order.reservation_id} AND market_id = ${order.market_id}
          AND state = 'payment_pending'
        RETURNING id`;
      if (!reservation) throw new Error("Reservation changed before retirement review.");
      return { kind: "manual_review", paymentOrderId: row.payment_order_id };
    }
    const leaseToken = randomUUID();
    const [claimed] = await tx<PaymentLinkRetirementRow[]>`
      UPDATE fame_square_payment_link_retirements
      SET status = 'processing',
          attempt_count = attempt_count + 1,
          locked_until = ${new Date(input.now.valueOf() + input.leaseSeconds * 1000)},
          lease_token = ${leaseToken},
          next_attempt_at = NULL,
          last_error_code = NULL,
          updated_at = ${input.now}
      WHERE payment_order_id = ${row.payment_order_id}
        AND status IN ('pending', 'processing')
        AND (
          (status = 'pending' AND next_attempt_at <= ${input.now})
          OR (status = 'processing' AND locked_until <= ${input.now})
        )
      RETURNING payment_order_id, market_id, square_environment,
                square_merchant_id, square_location_id, square_payment_link_id, square_order_id,
                status, attempt_count, locked_until, lease_token`;
    if (!claimed) return { kind: "in_progress", paymentOrderId: row.payment_order_id };
    return { kind: "retirement_required", retirement: retirementFromRow(claimed), leaseToken };
  });
}

/**
 * Finalize expiration only after the provider proves the exact stored Square
 * order was canceled. This is the sole point at which capacity is released.
 */
export async function completeSquarePaymentLinkRetirement(input: {
  paymentOrderId: string;
  leaseToken: string;
  cancelledOrderId: string;
  retiredAt: Date;
}, sql: Sql = configuredClient()): Promise<SquarePaymentLinkRetirementFinalizeResult> {
  if (!input.paymentOrderId || !input.leaseToken || !input.cancelledOrderId || !Number.isFinite(input.retiredAt.valueOf())) {
    throw new Error("Square payment-link retirement completion is invalid.");
  }
  return sql.begin(async tx => {
    // Match the webhook's lock order: payment order + reservation first, then
    // the retirement row. A signed event that sees an expiry-pending order can
    // therefore fence it for an operator without racing a capacity release.
    const [payment] = await tx<{
      reservation_id: string;
      market_id: string;
      order_status: string;
      reservation_state: string;
      square_environment: string;
      square_merchant_id: string;
      square_location_id: string;
      square_payment_link_id: string | null;
      square_order_id: string | null;
    }[]>`
      SELECT p.reservation_id, p.market_id, p.status AS order_status,
             r.state AS reservation_state, p.square_environment,
             p.square_merchant_id, p.square_location_id,
             p.square_payment_link_id, p.square_order_id
      FROM fame_payment_orders p
      JOIN fame_reservations r
        ON r.id = p.reservation_id AND r.market_id = p.market_id
      WHERE p.id = ${input.paymentOrderId}
      FOR UPDATE OF p, r`;
    if (!payment) return { kind: "stale" };
    const [retirement] = await tx<PaymentLinkRetirementRow[]>`
      SELECT payment_order_id, market_id, square_environment,
             square_merchant_id, square_location_id, square_payment_link_id, square_order_id,
             status, attempt_count, locked_until, lease_token
      FROM fame_square_payment_link_retirements
      WHERE payment_order_id = ${input.paymentOrderId}
        AND status = 'processing'
        AND lease_token = ${input.leaseToken}
      FOR UPDATE`;
    if (!retirement) return { kind: "stale" };
    const parentMatches = retirement.market_id === payment.market_id
      && retirement.square_environment === payment.square_environment
      && retirement.square_merchant_id === payment.square_merchant_id
      && retirement.square_location_id === payment.square_location_id
      && retirement.square_payment_link_id === payment.square_payment_link_id
      && retirement.square_order_id === payment.square_order_id;
    if (!parentMatches) {
      await tx`
        UPDATE fame_square_payment_link_retirements
        SET status = 'manual_review', locked_until = NULL, lease_token = NULL,
            next_attempt_at = NULL,
            last_error_code = 'square_retirement_parent_mapping_mismatch',
            updated_at = ${input.retiredAt}
        WHERE payment_order_id = ${input.paymentOrderId}
          AND status = 'processing' AND lease_token = ${input.leaseToken}`;
      await tx`
        UPDATE fame_payment_orders
        SET status = 'manual_review', locked_until = NULL, lease_token = NULL,
            last_error_code = 'square_retirement_parent_mapping_mismatch',
            updated_at = ${input.retiredAt}
        WHERE id = ${input.paymentOrderId} AND status = 'expiry_pending'`;
      await tx`
        UPDATE fame_reservations
        SET state = 'manual_review', updated_at = ${input.retiredAt}
        WHERE id = ${payment.reservation_id} AND market_id = ${payment.market_id}
          AND state = 'payment_pending'`;
      return { kind: "manual_review" };
    }
    if (retirement.square_order_id !== input.cancelledOrderId) {
      await tx`
        UPDATE fame_square_payment_link_retirements
        SET status = 'manual_review', locked_until = NULL, lease_token = NULL,
            next_attempt_at = NULL,
            last_error_code = 'square_retirement_cancelled_order_mismatch',
            updated_at = ${input.retiredAt}
        WHERE payment_order_id = ${input.paymentOrderId}
          AND status = 'processing' AND lease_token = ${input.leaseToken}`;
      return { kind: "manual_review" };
    }
    if (payment.order_status !== "expiry_pending") {
      await tx`
        UPDATE fame_square_payment_link_retirements
        SET status = 'manual_review', locked_until = NULL, lease_token = NULL,
            next_attempt_at = NULL,
            last_error_code = 'payment_state_changed_before_retirement',
            updated_at = ${input.retiredAt}
        WHERE payment_order_id = ${input.paymentOrderId}
          AND status = 'processing' AND lease_token = ${input.leaseToken}`;
      return { kind: "manual_review" };
    }
    if (payment.reservation_state !== "payment_pending") {
      await tx`
        UPDATE fame_square_payment_link_retirements
        SET status = 'manual_review', locked_until = NULL, lease_token = NULL,
            next_attempt_at = NULL,
            last_error_code = 'reservation_state_changed_before_retirement',
            updated_at = ${input.retiredAt}
        WHERE payment_order_id = ${input.paymentOrderId}
          AND status = 'processing' AND lease_token = ${input.leaseToken}`;
      return { kind: "manual_review" };
    }
    const [reservation] = await tx`
      UPDATE fame_reservations
      SET state = 'expired', updated_at = ${input.retiredAt}
      WHERE id = ${payment.reservation_id}
        AND market_id = ${payment.market_id}
        AND state = 'payment_pending'
      RETURNING id`;
    if (!reservation) throw new Error("Reservation changed before retirement completion.");
    const [expired] = await tx`
      UPDATE fame_payment_orders
      SET status = 'expired',
          locked_until = NULL,
          lease_token = NULL,
          last_error_code = 'payment_window_expired',
          updated_at = ${input.retiredAt}
      WHERE id = ${input.paymentOrderId}
        AND status = 'expiry_pending'
      RETURNING id`;
    // Roll back the reservation expiration if a concurrent lifecycle actor
    // intervened after its row lock. The hosted link is already gone, but the
    // durable retirement becomes an operator case instead of silently
    // releasing capacity under inconsistent payment state.
    if (!expired) throw new Error("Payment order changed before retirement completion.");
    const [retired] = await tx`
      UPDATE fame_square_payment_link_retirements
      SET status = 'retired',
          locked_until = NULL,
          lease_token = NULL,
          next_attempt_at = NULL,
          last_error_code = NULL,
          retired_square_order_id = ${input.cancelledOrderId},
          retired_at = ${input.retiredAt},
          updated_at = ${input.retiredAt}
      WHERE payment_order_id = ${input.paymentOrderId}
        AND status = 'processing'
        AND lease_token = ${input.leaseToken}
      RETURNING payment_order_id`;
    if (!retired) throw new Error("Payment-link retirement changed before completion.");
    return { kind: "retired" };
  });
}

/** Release a failed provider-delete lease without releasing the held allocation. */
export async function failSquarePaymentLinkRetirement(input: {
  paymentOrderId: string;
  leaseToken: string;
  code: string;
  retryable: boolean;
  attemptedAt: Date;
}, sql: Sql = configuredClient()): Promise<void> {
  if (!input.paymentOrderId || !input.leaseToken || !Number.isFinite(input.attemptedAt.valueOf())) {
    throw new Error("Square payment-link retirement failure input is invalid.");
  }
  const safeCode = input.code.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 96) || "square_link_retirement_error";
  await sql.begin(async tx => {
    const [retirement] = await tx<{ attempt_count: number | string }[]>`
      SELECT attempt_count
      FROM fame_square_payment_link_retirements
      WHERE payment_order_id = ${input.paymentOrderId}
        AND status = 'processing'
        AND lease_token = ${input.leaseToken}
      FOR UPDATE`;
    if (!retirement) return;
    const attemptCount = Number(retirement.attempt_count);
    const nextAttemptAt = input.retryable ? retirementRetryAt(input.attemptedAt, attemptCount) : null;
    await tx`
      UPDATE fame_square_payment_link_retirements
      SET status = ${input.retryable ? "pending" : "manual_review"},
          locked_until = NULL,
          lease_token = NULL,
          next_attempt_at = ${nextAttemptAt},
          last_error_code = ${safeCode},
          updated_at = ${input.attemptedAt}
      WHERE payment_order_id = ${input.paymentOrderId}
        AND status = 'processing'
        AND lease_token = ${input.leaseToken}`;
  });
}

/**
 * L19 passes its transaction here before writing a signed webhook receipt. It
 * can then atomically dedupe the event, inspect the exact provider identity,
 * and transition this row without a contact/name/search fallback.
 */
export async function getSquarePaymentOrderForWebhook(input: {
  environment: SquareEnvironment;
  merchantId: string;
  locationId: string;
  orderId: string;
}, sql: QuerySql = configuredClient()): Promise<SquarePaymentWebhookTarget | null> {
  const [row] = await sql<(PaymentOrderRow & { reservation_state: string; reservation_payment_due_at: Date | null })[]>`
    SELECT p.id, p.market_id, p.reservation_id, p.reservation_revision,
           p.square_environment, p.square_merchant_id, p.square_location_id,
           p.expected_currency, p.expected_total_cents, p.idempotency_key,
           p.status, p.square_payment_link_id, p.square_order_id, p.checkout_url,
           p.payment_id, p.payment_status, p.payment_provider_created_at,
           p.payment_provider_updated_at, p.payment_request_sent_at,
           p.payment_due_at, p.checkout_attempts, p.lease_token,
           r.state AS reservation_state, r.payment_due_at AS reservation_payment_due_at
    FROM fame_payment_orders p
    JOIN fame_reservations r ON r.id = p.reservation_id AND r.market_id = p.market_id
    WHERE p.square_environment = ${input.environment}
      AND p.square_merchant_id = ${input.merchantId}
      AND p.square_location_id = ${input.locationId}
      AND p.square_order_id = ${input.orderId}
    FOR UPDATE`;
  if (!row) return null;
  const order = toPaymentOrder(row);
  return {
    ...order,
    orderStatus: order.status,
    reservationState: row.reservation_state,
    reservationPaymentDueAt: iso(row.reservation_payment_due_at),
  };
}

/** Concrete adapter used by the authenticated checkout route. */
export const postgresSquarePaymentCheckoutStore: SquarePaymentCheckoutStore = {
  claimCheckout: claimSquarePaymentCheckout,
  completeCheckout: completeSquarePaymentCheckout,
  failCheckout: failSquarePaymentCheckout,
};

/** Concrete adapter used only by the trusted expiry scheduler. */
export const postgresSquarePaymentLinkRetirementStore: SquarePaymentLinkRetirementStore = {
  claimPaymentLinkRetirement: claimSquarePaymentLinkRetirement,
  completePaymentLinkRetirement: completeSquarePaymentLinkRetirement,
  failPaymentLinkRetirement: failSquarePaymentLinkRetirement,
};
