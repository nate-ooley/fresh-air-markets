import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import type { SquarePaymentLinkRetirementResult } from "./square";

type Sql = ReturnType<typeof postgres>;
type QuerySql = Sql | postgres.TransactionSql;

let client: Sql | undefined;

function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent reservation storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

/** Bookings a manager may withdraw: nothing has been paid yet. */
const WITHDRAWABLE_STATES = ["held", "payment_pending", "expired", "manual_review"] as const;
/** Payment orders that could still turn into a payment. */
const LIVE_ORDER_STATES = ["pending_checkout", "processing_checkout", "checkout_created"] as const;

export type WithdrawReservationResult =
  | { kind: "withdrawn"; reservationId: string; linksCancelled: number }
  | { kind: "not_found" }
  | { kind: "not_withdrawable"; state: string }
  | { kind: "link_closing" }
  | { kind: "square_unavailable" };

export interface WithdrawReservationInput {
  marketId: string;
  reservationId: string;
  /** Short manager note, e.g. "Vendor emailed 9/20: only wants spring dates." */
  note: string;
  now?: Date;
  /** Deletes a hosted Square link; omitted when Square is not configured. */
  deleteLink?: (paymentLinkId: string) => Promise<SquarePaymentLinkRetirementResult>;
}

interface LockedReservation {
  id: string;
  state: string;
}

interface LiveOrderRow {
  id: string;
  status: string;
  square_payment_link_id: string | null;
}

async function lockReservation(tx: QuerySql, marketId: string, reservationId: string): Promise<LockedReservation | null> {
  const [row] = await tx<LockedReservation[]>`
    SELECT r.id, r.state
    FROM fame_reservations r
    JOIN fame_reservation_finalizations f ON f.reservation_id = r.id AND f.market_id = r.market_id
    WHERE r.id = ${reservationId} AND r.market_id = ${marketId}
    FOR UPDATE OF r`;
  return row ?? null;
}

async function liveOrders(tx: QuerySql, marketId: string, reservationId: string): Promise<LiveOrderRow[]> {
  return tx<LiveOrderRow[]>`
    SELECT id, status, square_payment_link_id
    FROM fame_payment_orders
    WHERE reservation_id = ${reservationId} AND market_id = ${marketId}
      AND status IN ('pending_checkout', 'processing_checkout', 'checkout_created', 'expiry_pending')
    ORDER BY created_at
    FOR UPDATE`;
}

/**
 * Withdraws an unpaid booking at the vendor's request. The Square link is
 * deleted before anything is written, so a vendor can never pay for dates
 * the market has already released. Allocation rows stay as audit evidence;
 * capacity and the roster ignore a cancelled booking.
 */
export async function withdrawReservation(
  input: WithdrawReservationInput,
  sql: Sql = configuredClient(),
): Promise<WithdrawReservationResult> {
  const now = input.now ?? new Date();
  const note = input.note.trim().slice(0, 500);
  // Pass 1: read what has to be cancelled at Square. No writes yet.
  const plan = await sql.begin(async tx => {
    const reservation = await lockReservation(tx, input.marketId, input.reservationId);
    if (!reservation) return { kind: "not_found" } as const;
    if (!(WITHDRAWABLE_STATES as readonly string[]).includes(reservation.state)) {
      return { kind: "not_withdrawable", state: reservation.state } as const;
    }
    const orders = await liveOrders(tx, input.marketId, reservation.id);
    // The expiry worker is deleting this link right now; let it finish.
    if (orders.some(order => order.status === "expiry_pending")) return { kind: "link_closing" } as const;
    return { kind: "plan", orders } as const;
  });
  if (plan.kind !== "plan") return plan;

  const links = plan.orders.filter(order => order.square_payment_link_id);
  if (links.length && !input.deleteLink) return { kind: "square_unavailable" };
  for (const order of links) {
    try {
      // "not_found" means the link is already gone, which is what we want.
      await input.deleteLink!(order.square_payment_link_id!);
    } catch {
      return { kind: "square_unavailable" };
    }
  }

  // Pass 2: the links are dead; record the withdrawal.
  return sql.begin(async tx => {
    const reservation = await lockReservation(tx, input.marketId, input.reservationId);
    if (!reservation) return { kind: "not_found" } as const;
    if (!(WITHDRAWABLE_STATES as readonly string[]).includes(reservation.state)) {
      return { kind: "not_withdrawable", state: reservation.state } as const;
    }
    const cancelled = await tx<{ id: string }[]>`
      UPDATE fame_payment_orders
      SET status = 'cancelled', locked_until = NULL, lease_token = NULL,
          last_error_code = 'withdrawn_by_manager', updated_at = ${now}
      WHERE reservation_id = ${reservation.id} AND market_id = ${input.marketId}
        AND status IN ${tx([...LIVE_ORDER_STATES])}
      RETURNING id`;
    await tx`
      UPDATE fame_reservations
      SET state = 'cancelled', withdrawn_at = ${now}, withdrawal_note = ${note || null},
          payment_due_at = NULL, updated_at = ${now}
      WHERE id = ${reservation.id} AND market_id = ${input.marketId}`;
    await tx`UPDATE fame_vendor_payment_sessions SET revoked_at = ${now}
      WHERE market_id = ${input.marketId} AND reservation_id = ${reservation.id} AND revoked_at IS NULL`;
    await tx`UPDATE fame_vendor_payment_invitations SET revoked_at = ${now}
      WHERE market_id = ${input.marketId} AND reservation_id = ${reservation.id} AND revoked_at IS NULL`;
    await tx`UPDATE fame_payment_email_outbox
      SET state = 'cancelled', invitation_ciphertext = NULL, safe_error = 'reservation_withdrawn',
          lease_id = NULL, lease_expires_at = NULL, updated_at = ${now}
      WHERE market_id = ${input.marketId} AND reservation_id = ${reservation.id}
        AND state IN ('pending', 'preparing')`;
    return { kind: "withdrawn", reservationId: reservation.id, linksCancelled: cancelled.length } as const;
  });
}

/** Live (unpaid or paid) bookings that block withdrawing a whole application. */
export async function applicationBookingSummary(
  marketId: string,
  applicationId: string,
  sql: Sql = configuredClient(),
): Promise<{ paidOrConfirmed: number; unpaid: string[] }> {
  const rows = await sql<{ id: string; state: string }[]>`
    SELECT r.id, r.state
    FROM fame_reservations r
    JOIN fame_reservation_finalizations f ON f.reservation_id = r.id AND f.market_id = r.market_id
    WHERE r.market_id = ${marketId} AND r.application_id = ${applicationId}`;
  return {
    paidOrConfirmed: rows.filter(row => row.state === "paid" || row.state === "confirmed").length,
    unpaid: rows.filter(row => (WITHDRAWABLE_STATES as readonly string[]).includes(row.state)).map(row => row.id),
  };
}

export type WithdrawApplicationResult =
  | { kind: "withdrawn"; applicationId: string; fromState: string }
  | { kind: "not_found" }
  | { kind: "already_withdrawn" }
  | { kind: "declined" }
  | { kind: "has_live_booking"; states: string[] };

/**
 * Takes an application off the season's working list at the vendor's
 * request. Every unpaid booking must already be withdrawn (the route does
 * that first); a paid booking blocks withdrawal until it is refunded in
 * Square. The decision is recorded as a review event with no CRM delivery.
 */
export async function withdrawApplication(
  input: { marketId: string; applicationId: string; actorAccountId: string; note: string; now?: Date },
  sql: Sql = configuredClient(),
): Promise<WithdrawApplicationResult> {
  const now = input.now ?? new Date();
  const note = input.note.trim().slice(0, 2000);
  return sql.begin(async tx => {
    const [application] = await tx<{ id: string; review_state: string }[]>`
      SELECT id, review_state FROM fame_applications
      WHERE id = ${input.applicationId} AND market_id = ${input.marketId}
      FOR UPDATE`;
    if (!application) return { kind: "not_found" } as const;
    if (application.review_state === "withdrawn") return { kind: "already_withdrawn" } as const;
    if (application.review_state === "declined") return { kind: "declined" } as const;
    const live = await tx<{ state: string }[]>`
      SELECT r.state FROM fame_reservations r
      JOIN fame_reservation_finalizations f ON f.reservation_id = r.id AND f.market_id = r.market_id
      WHERE r.market_id = ${input.marketId} AND r.application_id = ${application.id}
        AND r.state IN ('held', 'payment_pending', 'paid', 'confirmed', 'manual_review', 'expired')`;
    if (live.length) return { kind: "has_live_booking", states: live.map(row => row.state) } as const;
    const [latest] = await tx<{ event_id: string }[]>`
      SELECT event_id FROM fame_application_events
      WHERE application_id = ${application.id} AND market_id = ${input.marketId}
      ORDER BY created_at DESC, event_id DESC LIMIT 1`;
    await tx`
      UPDATE fame_applications
      SET review_state = 'withdrawn', review_revision = review_revision + 1,
          reviewed_at = ${now}, reviewed_by_account_id = ${input.actorAccountId}
      WHERE id = ${application.id} AND market_id = ${input.marketId}`;
    const eventId = randomUUID();
    await tx`
      INSERT INTO fame_application_review_events
        (id, application_id, market_id, source_event_id, actor_account_id, idempotency_key,
         payload_hash, from_state, to_state, reason, outbox_id, created_at)
      VALUES
        (${eventId}, ${application.id}, ${input.marketId}, ${latest?.event_id ?? "withdrawn"}, ${input.actorAccountId},
         ${randomUUID()}, ${createHash("sha256").update(JSON.stringify([application.id, "withdraw", note])).digest("hex")},
         ${application.review_state}, 'withdrawn', ${note}, NULL, ${now})`;
    return { kind: "withdrawn", applicationId: application.id, fromState: application.review_state } as const;
  });
}
