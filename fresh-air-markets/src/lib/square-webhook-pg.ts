import postgres from "postgres";
import type { SquareEnvironment } from "./square";
import {
  getSquarePaymentOrderForWebhook,
  type SquarePaymentWebhookTarget,
} from "./square-payment-pg";
import type { SquarePaymentWebhookEvent, SquareWebhookPersistResult } from "./square-webhook";

type Sql = ReturnType<typeof postgres>;
type QuerySql = Sql | postgres.TransactionSql;
let client: Sql | undefined;

function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent Square webhook storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

export interface SquareWebhookPersistenceConfig {
  environment: SquareEnvironment;
  /** Required production identity; obtained from deployment settings and checkout verification. */
  merchantId?: string;
  locationId?: string;
  now?: Date;
  /** A route can supply this only from the Preview-only QA support gate. */
  qaRollbackEventId?: string | null;
}

type ReconciliationDecision =
  | { kind: "paid"; providerTime: Date }
  | { kind: "ignored"; providerTime: Date; reason: string }
  | { kind: "manual_review"; reason: string };

function validDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed : null;
}

/** The latest provider timestamp is the only safe ordering signal for retries. */
function providerTime(event: SquarePaymentWebhookEvent): Date | null {
  return validDate(event.payment.updatedAt)
    ?? validDate(event.payment.createdAt)
    ?? validDate(event.occurredAt);
}

function dueTime(target: SquarePaymentWebhookTarget): Date | null {
  const orderDue = validDate(target.paymentDueAt);
  const reservationDue = validDate(target.reservationPaymentDueAt);
  if (!orderDue || !reservationDue || orderDue.valueOf() !== reservationDue.valueOf()) return null;
  return orderDue;
}

function providerStateMatches(target: SquarePaymentWebhookTarget, event: SquarePaymentWebhookEvent): boolean {
  // A non-completed attempt never binds the final payment ID: Square can make
  // another valid attempt for the same hosted order. A completed order always
  // has its exact payment ID persisted by the paid transition.
  return target.paymentStatus === event.payment.status
    && (target.paymentId === null || target.paymentId === event.payment.id);
}

/**
 * Make a monotonic decision only from an exact, locked payment order. The
 * caller records every signed event, even when it returns ignored/manual review.
 */
export function reconcileSquarePaymentWebhook(
  target: SquarePaymentWebhookTarget,
  event: SquarePaymentWebhookEvent,
): ReconciliationDecision {
  if (target.expectedCurrency !== event.payment.currency || target.expectedTotalCents !== event.payment.amountCents) {
    return { kind: "manual_review", reason: "payment_amount_or_currency_mismatch" };
  }
  if (target.paymentId && target.paymentId !== event.payment.id) {
    return { kind: "manual_review", reason: "payment_id_mismatch" };
  }

  const observed = providerTime(event);
  if (!observed) return { kind: "manual_review", reason: "missing_provider_timestamp" };
  const prior = validDate(target.paymentProviderUpdatedAt);
  if (prior && observed.valueOf() < prior.valueOf()) {
    return { kind: "ignored", providerTime: observed, reason: "stale_provider_event" };
  }
  if (prior && observed.valueOf() === prior.valueOf()) {
    return providerStateMatches(target, event)
      ? { kind: "ignored", providerTime: observed, reason: "same_provider_state" }
      : { kind: "manual_review", reason: "conflicting_provider_timestamp" };
  }

  if (target.orderStatus === "paid") {
    return providerStateMatches(target, event) && event.payment.status === "COMPLETED"
      ? { kind: "ignored", providerTime: observed, reason: "already_paid" }
      : { kind: "manual_review", reason: "payment_after_terminal_state" };
  }
  if (target.orderStatus !== "checkout_created" || target.reservationState !== "payment_pending") {
    return { kind: "manual_review", reason: "payment_order_or_reservation_not_payable" };
  }

  // Non-completed updates are audit data only. They cannot create a paid
  // reservation, but keeping their newest status protects against an older
  // webhook arriving later and looking current.
  if (event.payment.status !== "COMPLETED") {
    return { kind: "ignored", providerTime: observed, reason: "payment_not_completed" };
  }

  const due = dueTime(target);
  if (!due) return { kind: "manual_review", reason: "payment_deadline_missing_or_mismatched" };
  // A completion exactly at the persisted deadline is eligible if the hold
  // still exists. A later provider timestamp must be reconciled manually.
  if (observed.valueOf() > due.valueOf()) {
    return { kind: "manual_review", reason: "payment_completed_after_deadline" };
  }
  return { kind: "paid", providerTime: observed };
}

type ReceiptClaim = "new" | Extract<SquareWebhookPersistResult, { kind: "duplicate" | "conflict" }>;

async function claimReceipt(
  tx: QuerySql,
  event: SquarePaymentWebhookEvent,
  environment: SquareEnvironment,
  now: Date,
): Promise<ReceiptClaim> {
  const inserted = await tx`
    INSERT INTO fame_square_webhook_events
      (square_environment, event_id, event_type, merchant_id, location_id,
       square_order_id, payment_id, payment_status, amount_cents, currency,
       occurred_at, payment_created_at, payment_updated_at, raw_body_sha256,
       disposition)
    VALUES
      (${environment}, ${event.eventId}, ${event.eventType}, ${event.merchantId},
       ${event.payment.locationId}, ${event.payment.orderId}, ${event.payment.id},
       ${event.payment.status}, ${event.payment.amountCents}, ${event.payment.currency},
       ${event.occurredAt}, ${event.payment.createdAt}, ${event.payment.updatedAt},
       ${event.rawBodySha256}, 'ignored')
    ON CONFLICT (square_environment, event_id) DO NOTHING
    RETURNING event_id`;
  if (inserted.length) return "new";
  const [prior] = await tx<{ raw_body_sha256: string }[]>`
    SELECT raw_body_sha256
    FROM fame_square_webhook_events
    WHERE square_environment = ${environment} AND event_id = ${event.eventId}`;
  if (prior?.raw_body_sha256 === event.rawBodySha256) return { kind: "duplicate" };

  // An event ID is Square's replay key. A different signed payload under an
  // already-received key is evidence for an operator, not a second event we
  // can safely apply. Keep the original digest (the payload that won the
  // insert race) and mark that receipt for review before acknowledging the
  // conflicting delivery. This prevents an endless provider retry loop while
  // retaining the anomaly durably.
  await tx`
    UPDATE fame_square_webhook_events
    SET disposition = 'manual_review',
        manual_review_reason = 'event_id_reused_with_different_payload',
        reconciled_at = ${now}
    WHERE square_environment = ${environment} AND event_id = ${event.eventId}`;
  return { kind: "conflict" };
}

async function writeReceiptOutcome(
  tx: QuerySql,
  event: SquarePaymentWebhookEvent,
  environment: SquareEnvironment,
  input: { paymentOrderId: string | null; disposition: "paid" | "ignored" | "manual_review"; reason: string | null; now: Date },
): Promise<void> {
  await tx`
    UPDATE fame_square_webhook_events
    SET payment_order_id = ${input.paymentOrderId},
        disposition = ${input.disposition},
        manual_review_reason = ${input.reason},
        reconciled_at = ${input.now}
    WHERE square_environment = ${environment} AND event_id = ${event.eventId}`;
}

/**
 * Freeze a still-held reservation for an operator; do not release capacity.
 *
 * `getSquarePaymentOrderForWebhook()` holds the payment order and reservation
 * before calling this helper. Keep that lock order when an expiry-pending
 * hold is involved, then cancel its retirement work item. A signed delivery
 * that arrives after the deadline claim is payment evidence, so automatic
 * link retirement/capacity release must stop for an operator decision.
 */
async function placeInManualReview(
  tx: QuerySql,
  target: SquarePaymentWebhookTarget,
  reason: string,
  now: Date,
): Promise<void> {
  // Paid/expired/cancelled rows keep their terminal truth. The event receipt
  // still becomes manual-review evidence, instead of reviving or overwriting it.
  // An expiry-pending order is deliberately not terminal: fence it and its
  // pending/leased link deletion so no capacity can be released automatically.
  const cancelRetirement = target.orderStatus === "expiry_pending";
  const [order] = await tx<{ reservation_id: string; market_id: string }[]>`
    UPDATE fame_payment_orders
    SET status = 'manual_review',
        last_error_code = ${reason},
        locked_until = NULL,
        lease_token = NULL,
        updated_at = ${now}
    WHERE id = ${target.id}
      AND status IN ('pending_checkout', 'processing_checkout', 'checkout_created', 'expiry_pending')
    RETURNING reservation_id, market_id`;
  if (!order) return;
  const [reservation] = await tx`
    UPDATE fame_reservations
    SET state = 'manual_review', updated_at = ${now}
    WHERE id = ${order.reservation_id}
      AND market_id = ${order.market_id}
      AND state IN ('held', 'payment_pending')
    RETURNING id`;
  if (!reservation) throw new Error("Reservation changed before webhook manual review.");
  if (!cancelRetirement) return;
  // This is intentionally after the order/reservation locks above, matching
  // the retirement worker. It cancels an in-flight lease as well as a pending
  // item; a DELETE that already returned can only finalize if it obtains the
  // same locks before this transaction, otherwise it becomes operator review.
  await tx`
    UPDATE fame_square_payment_link_retirements
    SET status = 'manual_review',
        locked_until = NULL,
        lease_token = NULL,
        next_attempt_at = NULL,
        last_error_code = ${reason},
        updated_at = ${now}
    WHERE payment_order_id = ${target.id}
      AND status IN ('pending', 'processing')`;
}

async function recordNonCompletedProviderState(
  tx: QuerySql,
  target: SquarePaymentWebhookTarget,
  event: SquarePaymentWebhookEvent,
  observed: Date,
  now: Date,
): Promise<void> {
  const [updated] = await tx`
    UPDATE fame_payment_orders
    SET payment_status = ${event.payment.status},
        payment_provider_updated_at = ${observed},
        updated_at = ${now}
    WHERE id = ${target.id}
      AND status = 'checkout_created'
    RETURNING id`;
  if (!updated) throw new Error("Square payment status changed before reconciliation.");
}

async function markExactPaymentPaid(
  tx: QuerySql,
  target: SquarePaymentWebhookTarget,
  event: SquarePaymentWebhookEvent,
  observed: Date,
  now: Date,
): Promise<void> {
  const [order] = await tx`
    UPDATE fame_payment_orders
    SET status = 'paid',
        payment_id = ${event.payment.id},
        payment_status = 'COMPLETED',
        payment_provider_created_at = COALESCE(payment_provider_created_at, ${event.payment.createdAt}),
        payment_provider_updated_at = ${observed},
        payment_received_at = ${observed},
        last_error_code = NULL,
        locked_until = NULL,
        lease_token = NULL,
        updated_at = ${now}
    WHERE id = ${target.id}
      AND status = 'checkout_created'
      AND (payment_id IS NULL OR payment_id = ${event.payment.id})
    RETURNING reservation_id, market_id`;
  if (!order) throw new Error("Square payment order changed before completion.");
  const [reservation] = await tx`
    UPDATE fame_reservations
    SET state = 'paid', updated_at = ${now}
    WHERE id = ${order.reservation_id}
      AND market_id = ${order.market_id}
      AND state = 'payment_pending'
    RETURNING id`;
  // Roll back the payment-order update rather than leaving a paid order for a
  // released/reassigned reservation. A retry will re-read the current state.
  if (!reservation) throw new Error("Reservation changed before payment completion.");
}

/**
 * Atomic Square receipt, exact identity lookup, and reservation payment state
 * transition. It never searches contacts, browser redirects, or the newest
 * payment. A thrown error rolls back the receipt so Square can replay it.
 */
export async function persistSquarePaymentWebhook(
  event: SquarePaymentWebhookEvent,
  config: SquareWebhookPersistenceConfig,
  sql: Sql = configuredClient(),
): Promise<SquareWebhookPersistResult> {
  if (!["sandbox", "production"].includes(config.environment)) throw new Error("Invalid Square environment.");
  if (config.environment === "production" && (!config.merchantId || !config.locationId || config.qaRollbackEventId)) {
    throw new Error("Production webhook requires a pinned identity and forbids QA rollback.");
  }
  const now = config.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("A valid server time is required.");
  return sql.begin(async tx => {
    const claim = await claimReceipt(tx, event, config.environment, now);
    if (claim !== "new") return claim;

    if ((config.merchantId && event.merchantId !== config.merchantId)
      || (config.locationId && event.payment.locationId !== config.locationId)) {
      await writeReceiptOutcome(tx, event, config.environment, {
        paymentOrderId: null, disposition: "manual_review", reason: "configured_square_identity_mismatch", now,
      });
      return { kind: "manual_review" };
    }
    const target = await getSquarePaymentOrderForWebhook({
      environment: config.environment,
      merchantId: event.merchantId,
      locationId: event.payment.locationId,
      orderId: event.payment.orderId,
    }, tx);
    if (!target) {
      await writeReceiptOutcome(tx, event, config.environment, {
        paymentOrderId: null, disposition: "manual_review", reason: "payment_order_identity_mismatch", now,
      });
      return { kind: "manual_review" };
    }

    // The payment-order schema fences a completed Square payment ID to one
    // merchant/order. Detect the impossible cross-order reuse explicitly so
    // it becomes a durable operator case instead of a unique-index exception
    // that would make Square retry forever.
    if (event.payment.status === "COMPLETED") {
      const [otherPayment] = await tx<{ id: string }[]>`
        SELECT id
        FROM fame_payment_orders
        WHERE square_environment = ${config.environment}
          AND square_merchant_id = ${event.merchantId}
          AND payment_id = ${event.payment.id}
          AND id <> ${target.id}
        FOR UPDATE`;
      if (otherPayment) {
        const reason = "payment_id_bound_to_other_order";
        await placeInManualReview(tx, target, reason, now);
        await writeReceiptOutcome(tx, event, config.environment, {
          paymentOrderId: target.id, disposition: "manual_review", reason, now,
        });
        return { kind: "manual_review" };
      }
    }

    const decision = reconcileSquarePaymentWebhook(target, event);
    if (decision.kind === "manual_review") {
      await placeInManualReview(tx, target, decision.reason, now);
      await writeReceiptOutcome(tx, event, config.environment, {
        paymentOrderId: target.id, disposition: "manual_review", reason: decision.reason, now,
      });
      return { kind: "manual_review" };
    }
    if (decision.kind === "ignored") {
      if (decision.reason === "payment_not_completed") {
        await recordNonCompletedProviderState(tx, target, event, decision.providerTime, now);
      }
      await writeReceiptOutcome(tx, event, config.environment, {
        paymentOrderId: target.id, disposition: "ignored", reason: null, now,
      });
      return { kind: "ignored" };
    }

    await markExactPaymentPaid(tx, target, event, decision.providerTime, now);
    // This deliberate throw is reachable only through the server-side
    // Preview/Sandbox QA configuration and an authenticated local QA signer.
    // It happens inside the transaction after both domain updates so the
    // rollback test proves there is no partially paid reservation or receipt.
    if (config.qaRollbackEventId === event.eventId) {
      throw new Error("QA Square webhook transaction rollback.");
    }
    await writeReceiptOutcome(tx, event, config.environment, {
      paymentOrderId: target.id, disposition: "paid", reason: null, now,
    });
    return { kind: "paid" };
  });
}
