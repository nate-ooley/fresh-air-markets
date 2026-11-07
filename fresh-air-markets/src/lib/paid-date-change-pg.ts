import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { invoicesReady } from "./invoice-table";
import { bookingBalanceDue } from "./vendor-balance-pg";

type Sql = ReturnType<typeof postgres>;
type QuerySql = Sql | postgres.TransactionSql;

let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent reservation storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

/**
 * Changing the Saturdays on a booking the vendor already paid for. Booking
 * rows are immutable audit records, so the paid booking is retired and a new
 * one is reserved; what the vendor paid moves onto the new booking as a
 * credit, so nothing is refunded in Square and nothing new is owed.
 */

/** Bookings that are settled: their dates move by retiring them and carrying the payment over. */
export const PAID_BOOKING_STATES = ["paid", "confirmed"] as const;

async function tableReady(sql: QuerySql, name: string): Promise<boolean> {
  const [row] = await sql<{ present: boolean }[]>`SELECT to_regclass(${name}) IS NOT NULL AS present`;
  return Boolean(row?.present);
}

/** Money on a booking: payments of every kind plus vendor credit used on it. Counts it whatever the booking's state. */
export async function moneyOnBooking(marketId: string, reservationId: string, sql: QuerySql = configuredClient()): Promise<{ paidCents: number; creditAppliedCents: number }> {
  const [checkout] = await sql<{ cents: string | number }[]>`SELECT COALESCE(SUM(expected_total_cents), 0) AS cents FROM fame_payment_orders
    WHERE market_id = ${marketId} AND reservation_id = ${reservationId} AND status = 'paid'`;
  let paid = Number(checkout?.cents ?? 0);
  if (await invoicesReady(sql)) {
    const [row] = await sql<{ cents: string | number }[]>`SELECT COALESCE(SUM(p.amount_cents), 0) AS cents FROM fame_invoice_payments p
      JOIN fame_invoices i ON i.id = p.invoice_id WHERE i.market_id = ${marketId} AND i.reservation_id = ${reservationId}`;
    paid += Number(row?.cents ?? 0);
  }
  if (await tableReady(sql, "fame_manual_payments")) {
    const [row] = await sql<{ cents: string | number }[]>`SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM fame_manual_payments
      WHERE market_id = ${marketId} AND reservation_id = ${reservationId} AND voided_at IS NULL`;
    paid += Number(row?.cents ?? 0);
  }
  let creditApplied = 0;
  if (await tableReady(sql, "fame_vendor_adjustments")) {
    const [row] = await sql<{ cents: string | number }[]>`SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM fame_vendor_adjustments
      WHERE market_id = ${marketId} AND reservation_id = ${reservationId} AND kind = 'credit_applied' AND voided_at IS NULL`;
    creditApplied = Number(row?.cents ?? 0);
  }
  return { paidCents: paid, creditAppliedCents: creditApplied };
}

/** Releases a paid booking's dates so the new ones can be reserved. Its payments stay on record. */
export async function retirePaidBooking(input: { marketId: string; reservationId: string; note: string; now?: Date }, sql: Sql = configuredClient()): Promise<{ kind: "retired" } | { kind: "not_changeable"; state: string }> {
  const now = input.now ?? new Date();
  return sql.begin(async tx => {
    const [row] = await tx<{ state: string }[]>`SELECT state FROM fame_reservations WHERE id = ${input.reservationId} AND market_id = ${input.marketId} FOR UPDATE`;
    if (!row) return { kind: "not_changeable", state: "missing" } as const;
    if (!(PAID_BOOKING_STATES as readonly string[]).includes(row.state)) return { kind: "not_changeable", state: row.state } as const;
    await tx`UPDATE fame_reservations SET state = 'cancelled', withdrawn_at = ${now}, withdrawal_note = ${input.note.trim().slice(0, 500) || null}, updated_at = ${now}
      WHERE id = ${input.reservationId} AND market_id = ${input.marketId}`;
    return { kind: "retired" } as const;
  }) as Promise<{ kind: "retired" } | { kind: "not_changeable"; state: string }>;
}

/** Puts a retired paid booking back exactly as it was, when the new dates could not be reserved. */
export async function restorePaidBooking(input: { marketId: string; reservationId: string; state: string; now?: Date }, sql: Sql = configuredClient()): Promise<boolean> {
  if (!(PAID_BOOKING_STATES as readonly string[]).includes(input.state)) return false;
  const rows = await sql<{ id: string }[]>`UPDATE fame_reservations SET state = ${input.state}, withdrawn_at = NULL, withdrawal_note = NULL, updated_at = ${input.now ?? new Date()}
    WHERE id = ${input.reservationId} AND market_id = ${input.marketId} AND state = 'cancelled' RETURNING id`;
  return rows.length === 1;
}

/**
 * Moves what was paid on the retired booking onto the new one: a credit for
 * the amount paid, then the vendor's available credit is used on the new
 * booking, which becomes paid when covered. Safe to run twice.
 */
export async function carryPaymentToBooking(input: {
  marketId: string; oldReservationId: string; newReservationId: string; paidCents: number; label: string; actorAccountId: string; now?: Date;
}, sql: Sql = configuredClient()): Promise<{ kind: "carried"; bookingPaid: boolean; leftoverCreditCents: number } | { kind: "not_found" }> {
  const now = input.now ?? new Date();
  return sql.begin(async tx => {
    const [row] = await tx<{ application_id: string | null; state: string }[]>`
      SELECT application_id, state FROM fame_reservations WHERE id = ${input.newReservationId} AND market_id = ${input.marketId} FOR UPDATE`;
    if (!row?.application_id) return { kind: "not_found" } as const;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`fame-vendor-credit:${input.marketId}:${row.application_id}`}, 0))`;
    const marker = `[moved from booking ${input.oldReservationId}]`;
    const [already] = await tx<{ any: boolean }[]>`SELECT EXISTS (SELECT 1 FROM fame_vendor_adjustments WHERE market_id = ${input.marketId}
      AND application_id = ${row.application_id} AND kind = 'credit' AND voided_at IS NULL AND reason LIKE ${`%${marker}`}) AS any`;
    if (!already?.any && input.paidCents > 0) {
      await tx`INSERT INTO fame_vendor_adjustments (id, market_id, application_id, reservation_id, kind, amount_cents, reason, created_by_account_id, created_at)
        VALUES (${randomUUID()}, ${input.marketId}, ${row.application_id}, NULL, 'credit', ${input.paidCents},
          ${`Paid for ${input.label}; moved to the new dates ${marker}`.slice(0, 300)}, ${input.actorAccountId}, ${now})`;
    }
    let booking = await bookingBalanceDue(input.marketId, input.newReservationId, tx);
    if (!booking) return { kind: "not_found" } as const;
    if (["held", "payment_pending"].includes(row.state)) {
      const amount = Math.min(booking.creditAvailableCents, booking.balanceCents);
      if (amount > 0) {
        await tx`INSERT INTO fame_vendor_adjustments (id, market_id, application_id, reservation_id, kind, amount_cents, reason, created_by_account_id, created_at)
          VALUES (${randomUUID()}, ${input.marketId}, ${row.application_id}, ${input.newReservationId}, 'credit_applied', ${amount}, 'Payment moved from the earlier dates', ${input.actorAccountId}, ${now})`;
        booking = await bookingBalanceDue(input.marketId, input.newReservationId, tx);
        if (!booking) return { kind: "not_found" } as const;
      }
      if (booking.balanceCents === 0) {
        await tx`UPDATE fame_reservations SET state = 'paid', payment_due_at = NULL, updated_at = ${now} WHERE id = ${input.newReservationId} AND market_id = ${input.marketId}`;
      }
    }
    return { kind: "carried", bookingPaid: booking.balanceCents === 0, leftoverCreditCents: booking.creditAvailableCents } as const;
  }) as Promise<{ kind: "carried"; bookingPaid: boolean; leftoverCreditCents: number } | { kind: "not_found" }>;
}
