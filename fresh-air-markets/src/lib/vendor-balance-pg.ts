import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { invoicesReady } from "./invoice-table";

type Sql = ReturnType<typeof postgres>;
type QuerySql = Sql | postgres.TransactionSql;

let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent balance storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

/**
 * A vendor's rolling balance across all their bookings: what each live
 * booking charges, less discounts, credits and payments (hosted checkout or
 * Square invoice). Withdrawn and lapsed bookings charge nothing; a credit
 * used on a booking that is later withdrawn goes back to the vendor.
 */

/** Bookings that hold their dates, so they count toward what the vendor owes. */
const COUNTED_STATES = ["held", "payment_pending", "paid", "confirmed", "manual_review"];
/** Bookings whose price staff may still change: nothing paid in full yet. */
const ADJUSTABLE_STATES = ["held", "payment_pending"];
/** A credit above this is almost certainly a typing mistake. */
export const MAX_CREDIT_CENTS = 500_000;

export interface BookingBalance {
  reservationId: string;
  dates: string[];
  state: string;
  createdAt: string;
  chargeCents: number;
  discountCents: number;
  creditAppliedCents: number;
  paidCents: number;
  /** What is still owed on this booking (never below zero). */
  balanceCents: number;
}

export interface LedgerLine {
  at: string;
  kind: "charge" | "discount" | "credit" | "credit_applied" | "payment";
  label: string;
  /** Positive adds to what the vendor owes; negative takes it off. Credit used on a booking is 0: it was counted when given. */
  amountCents: number;
  runningCents: number;
  adjustmentId?: string;
  /** A payment staff recorded from outside the portal (e.g. the Square app); undoable. */
  manualPaymentId?: string;
  reservationId?: string;
  voidable?: boolean;
}

export interface VendorBalance {
  bookings: BookingBalance[];
  lines: LedgerLine[];
  creditAvailableCents: number;
  totals: { chargedCents: number; discountCents: number; creditCents: number; paidCents: number; owedCents: number };
}

interface ReservationRow { id: string; state: string; total_cents: string | number; final_dates: unknown; created_at: Date }
interface AdjustmentRow { id: string; reservation_id: string | null; kind: "discount" | "credit" | "credit_applied"; amount_cents: string | number; percent: string | null; reason: string; created_at: Date }
interface PaymentRow { reservation_id: string; amount_cents: string | number; at: Date; source: "checkout" | "invoice" | "manual"; id?: string; note?: string }

async function manualPaymentsReady(sql: QuerySql): Promise<boolean> {
  const [row] = await sql<{ present: boolean }[]>`SELECT to_regclass('fame_manual_payments') IS NOT NULL AS present`;
  return Boolean(row?.present);
}

async function adjustmentsReady(sql: QuerySql): Promise<boolean> {
  const [row] = await sql<{ present: boolean }[]>`SELECT to_regclass('fame_vendor_adjustments') IS NOT NULL AS present`;
  return Boolean(row?.present);
}

const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
function bookingLabel(dates: string[]): string {
  if (!dates.length) return "booking";
  return dates.length === 1 ? `booking for ${shortDate(dates[0])}` : `booking for ${dates.length} Saturdays (${shortDate(dates[0])}–${shortDate(dates[dates.length - 1])})`;
}

export async function vendorBalance(marketId: string, applicationId: string, sql: QuerySql = configuredClient()): Promise<VendorBalance> {
  const reservations = await sql<ReservationRow[]>`
    SELECT id, state, total_cents, final_dates, created_at FROM fame_reservations
    WHERE market_id = ${marketId} AND application_id = ${applicationId} ORDER BY created_at, id`;
  const ids = reservations.map(row => row.id);
  const adjustments = await adjustmentsReady(sql) ? await sql<AdjustmentRow[]>`
    SELECT id, reservation_id, kind, amount_cents, percent::text AS percent, reason, created_at FROM fame_vendor_adjustments
    WHERE market_id = ${marketId} AND application_id = ${applicationId} AND voided_at IS NULL ORDER BY created_at, id` : [];
  const payments: PaymentRow[] = ids.length ? [...await sql<PaymentRow[]>`
    SELECT reservation_id, expected_total_cents AS amount_cents, updated_at AS at, 'checkout' AS source FROM fame_payment_orders
    WHERE market_id = ${marketId} AND reservation_id = ANY(${ids}::text[]) AND status = 'paid'`,
  ...(await invoicesReady(sql) ? await sql<PaymentRow[]>`
    SELECT i.reservation_id, p.amount_cents, p.received_at AS at, 'invoice' AS source FROM fame_invoice_payments p
    JOIN fame_invoices i ON i.id = p.invoice_id WHERE i.market_id = ${marketId} AND i.reservation_id = ANY(${ids}::text[])` : []),
  ...(await manualPaymentsReady(sql) ? await sql<PaymentRow[]>`
    SELECT reservation_id, amount_cents, (paid_on::timestamp + interval '12 hours') AS at, 'manual' AS source, id, note FROM fame_manual_payments
    WHERE market_id = ${marketId} AND reservation_id = ANY(${ids}::text[]) AND voided_at IS NULL` : [])] : [];

  const counted = new Set(reservations.filter(row => COUNTED_STATES.includes(row.state)).map(row => row.id));
  const datesOf = (row: ReservationRow) => Array.isArray(row.final_dates) ? row.final_dates.filter((d): d is string => typeof d === "string").sort() : [];
  const bookings: BookingBalance[] = reservations.filter(row => counted.has(row.id)).map(row => {
    const sum = (kind: AdjustmentRow["kind"]) => adjustments.filter(a => a.reservation_id === row.id && a.kind === kind).reduce((n, a) => n + Number(a.amount_cents), 0);
    const paid = payments.filter(p => p.reservation_id === row.id).reduce((n, p) => n + Number(p.amount_cents), 0);
    const charge = Number(row.total_cents);
    const discount = sum("discount");
    const creditApplied = sum("credit_applied");
    return {
      reservationId: row.id, dates: datesOf(row), state: row.state, createdAt: new Date(row.created_at).toISOString(),
      chargeCents: charge, discountCents: discount, creditAppliedCents: creditApplied, paidCents: paid,
      balanceCents: Math.max(0, charge - discount - creditApplied - paid),
    };
  });

  const creditGiven = adjustments.filter(a => a.kind === "credit").reduce((n, a) => n + Number(a.amount_cents), 0);
  const creditUsed = adjustments.filter(a => a.kind === "credit_applied" && a.reservation_id && counted.has(a.reservation_id)).reduce((n, a) => n + Number(a.amount_cents), 0);
  const byId = new Map(reservations.map(row => [row.id, row]));
  const events: Omit<LedgerLine, "runningCents">[] = [];
  for (const booking of bookings) {
    if (booking.chargeCents > 0) events.push({ at: booking.createdAt, kind: "charge", label: `Charge: ${bookingLabel(booking.dates)}`, amountCents: booking.chargeCents, reservationId: booking.reservationId });
  }
  for (const a of adjustments) {
    const row = a.reservation_id ? byId.get(a.reservation_id) : null;
    if (a.reservation_id && !counted.has(a.reservation_id)) continue;
    const on = row ? ` on ${bookingLabel(datesOf(row))}` : "";
    const at = new Date(a.created_at).toISOString();
    if (a.kind === "discount") events.push({ at, kind: "discount", label: `Discount${a.percent ? ` (${Number(a.percent)}%)` : ""}${on}: ${a.reason}`, amountCents: -Number(a.amount_cents), adjustmentId: a.id, reservationId: a.reservation_id ?? undefined });
    if (a.kind === "credit") events.push({ at, kind: "credit", label: `Credit: ${a.reason}`, amountCents: -Number(a.amount_cents), adjustmentId: a.id });
    if (a.kind === "credit_applied") events.push({ at, kind: "credit_applied", label: `Credit of ${(Number(a.amount_cents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} used${on}`, amountCents: 0, adjustmentId: a.id, reservationId: a.reservation_id ?? undefined });
  }
  for (const p of payments) {
    const row = byId.get(p.reservation_id);
    events.push({
      at: new Date(p.at).toISOString(), kind: "payment",
      label: `Payment${p.source === "invoice" ? " (Square invoice)" : p.source === "manual" ? " taken in Square" : ""}${row ? ` for ${bookingLabel(datesOf(row))}` : ""}${p.note ? `: ${p.note}` : ""}`,
      amountCents: -Number(p.amount_cents), reservationId: p.reservation_id, ...(p.source === "manual" && p.id ? { manualPaymentId: p.id } : {}),
    });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  let running = 0;
  const adjustable = new Set(bookings.filter(b => ADJUSTABLE_STATES.includes(b.state)).map(b => b.reservationId));
  const lines = events.map(event => {
    running += event.amountCents;
    const voidable = event.kind === "credit" ? creditGiven - creditUsed >= -event.amountCents
      : (event.kind === "discount" || event.kind === "credit_applied") && Boolean(event.reservationId && adjustable.has(event.reservationId));
    return { ...event, runningCents: running, ...(event.adjustmentId ? { voidable } : event.manualPaymentId ? { voidable: true } : {}) };
  });
  const chargedCents = bookings.reduce((n, b) => n + b.chargeCents, 0);
  const discountCents = bookings.reduce((n, b) => n + b.discountCents, 0);
  const paidCents = bookings.reduce((n, b) => n + b.paidCents, 0);
  return {
    bookings, lines, creditAvailableCents: Math.max(0, creditGiven - creditUsed),
    totals: { chargedCents, discountCents, creditCents: creditGiven, paidCents, owedCents: chargedCents - discountCents - creditGiven - paidCents },
  };
}

/** One booking's position, for billing it. Null when the booking doesn't exist or doesn't count. */
export async function bookingBalanceDue(marketId: string, reservationId: string, sql: QuerySql = configuredClient()): Promise<(BookingBalance & { applicationId: string; creditAvailableCents: number }) | null> {
  const [row] = await sql<{ application_id: string | null }[]>`SELECT application_id FROM fame_reservations WHERE id = ${reservationId} AND market_id = ${marketId}`;
  if (!row?.application_id) return null;
  const balance = await vendorBalance(marketId, row.application_id, sql);
  const booking = balance.bookings.find(b => b.reservationId === reservationId);
  return booking ? { ...booking, applicationId: row.application_id, creditAvailableCents: balance.creditAvailableCents } : null;
}

/**
 * True when staff changed what this booking owes (discount, credit, or a
 * payment taken in Square); the full-price payment link must not be used then.
 */
export async function hasPriceAdjustment(marketId: string, reservationId: string, sql: QuerySql = configuredClient()): Promise<boolean> {
  try {
    if (await adjustmentsReady(sql)) {
      const [row] = await sql<{ adjusted: boolean }[]>`SELECT EXISTS (SELECT 1 FROM fame_vendor_adjustments WHERE market_id = ${marketId}
        AND reservation_id = ${reservationId} AND kind IN ('discount', 'credit_applied') AND voided_at IS NULL) AS adjusted`;
      if (row?.adjusted) return true;
    }
    if (await manualPaymentsReady(sql)) {
      const [row] = await sql<{ paid: boolean }[]>`SELECT EXISTS (SELECT 1 FROM fame_manual_payments WHERE market_id = ${marketId}
        AND reservation_id = ${reservationId} AND voided_at IS NULL) AS paid`;
      if (row?.paid) return true;
    }
    return false;
  } catch { return false; }
}

export type ManualPaymentResult =
  | { kind: "saved"; paymentId: string; amountCents: number; bookingPaid: boolean }
  | { kind: "not_found" }
  | { kind: "not_allowed"; reason: string }
  | { kind: "invalid"; error: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Records a payment staff took outside the portal (e.g. a payment request
 * sent from the Square app). When payments cover what the booking owes, the
 * booking becomes paid.
 */
export async function recordManualPayment(input: {
  marketId: string; reservationId: string; amountCents: unknown; paidOn: unknown; note: unknown; today: string; actorAccountId: string; now?: Date;
}, sql: Sql = configuredClient()): Promise<ManualPaymentResult> {
  const amount = Number(input.amountCents);
  if (!Number.isSafeInteger(amount) || amount < 1) return { kind: "invalid", error: "Enter the amount the vendor paid." };
  const paidOn = typeof input.paidOn === "string" ? input.paidOn : "";
  if (!DATE.test(paidOn) || new Date(`${paidOn}T12:00:00Z`).toISOString().slice(0, 10) !== paidOn) return { kind: "invalid", error: "Enter the date the vendor paid." };
  if (paidOn > input.today) return { kind: "invalid", error: "The payment date can't be in the future." };
  if (paidOn < "2026-01-01") return { kind: "invalid", error: "That payment date is before this season." };
  const note = typeof input.note === "string" ? input.note.replace(/\s+/g, " ").trim() : "";
  if (note.length > 300) return { kind: "invalid", error: "Keep the note under 300 characters." };
  return sql.begin(async tx => {
    const [row] = await tx<{ application_id: string | null; state: string; payment_required: boolean }[]>`
      SELECT application_id, state, payment_required FROM fame_reservations WHERE id = ${input.reservationId} AND market_id = ${input.marketId} FOR UPDATE`;
    if (!row?.application_id) return { kind: "not_found" } as const;
    if (!row.payment_required) return { kind: "not_allowed", reason: "Nonprofit bookings have nothing to pay." } as const;
    if (!ADJUSTABLE_STATES.includes(row.state)) return { kind: "not_allowed", reason: row.state === "paid" || row.state === "confirmed" ? "This booking is already paid." : `This booking is ${row.state.replace("_", " ")}.` } as const;
    if (await liveInvoice(tx, input.marketId, input.reservationId)) return { kind: "not_allowed", reason: "This booking has an open invoice from the portal. Cancel it first so the vendor isn't billed twice." } as const;
    const owed = (await bookingBalanceDue(input.marketId, input.reservationId, tx))?.balanceCents ?? 0;
    if (amount > owed) return { kind: "invalid", error: `That's more than the ${(owed / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} still owed on this booking.` } as const;
    const covered = amount === owed;
    const id = randomUUID();
    const now = input.now ?? new Date();
    await tx`INSERT INTO fame_manual_payments (id, market_id, application_id, reservation_id, amount_cents, paid_on, note, marked_booking_paid, created_by_account_id, created_at)
      VALUES (${id}, ${input.marketId}, ${row.application_id}, ${input.reservationId}, ${amount}, ${paidOn}::date, ${note}, ${covered}, ${input.actorAccountId}, ${now})`;
    if (covered) {
      await tx`UPDATE fame_reservations SET state = 'paid', payment_due_at = NULL, updated_at = ${now} WHERE id = ${input.reservationId} AND market_id = ${input.marketId}`;
    }
    return { kind: "saved", paymentId: id, amountCents: amount, bookingPaid: covered } as const;
  });
}

/** Undo a mistaken recorded payment. If it was what marked the booking paid, the booking goes back to awaiting payment. */
export async function voidManualPayment(input: { marketId: string; paymentId: string; now?: Date }, sql: Sql = configuredClient()): Promise<{ kind: "voided"; bookingReopened: boolean } | { kind: "not_found" }> {
  return sql.begin(async tx => {
    const [row] = await tx<{ reservation_id: string }[]>`
      SELECT reservation_id FROM fame_manual_payments WHERE id = ${input.paymentId} AND market_id = ${input.marketId} AND voided_at IS NULL FOR UPDATE`;
    if (!row) return { kind: "not_found" } as const;
    const now = input.now ?? new Date();
    await tx`UPDATE fame_manual_payments SET voided_at = ${now} WHERE id = ${input.paymentId}`;
    const [booking] = await tx<{ state: string }[]>`SELECT state FROM fame_reservations WHERE id = ${row.reservation_id} AND market_id = ${input.marketId} FOR UPDATE`;
    const still = await bookingBalanceDue(input.marketId, row.reservation_id, tx);
    // Only reopen bookings this ledger marked paid; a booking paid through the portal's own checkout stays paid.
    const [checkout] = await tx<{ paid: boolean }[]>`SELECT EXISTS (SELECT 1 FROM fame_payment_orders WHERE market_id = ${input.marketId}
      AND reservation_id = ${row.reservation_id} AND status = 'paid') AS paid`;
    if (booking?.state === "paid" && still && still.balanceCents > 0 && !checkout?.paid) {
      await tx`UPDATE fame_reservations SET state = 'payment_pending', updated_at = ${now} WHERE id = ${row.reservation_id} AND market_id = ${input.marketId}`;
      return { kind: "voided", bookingReopened: true } as const;
    }
    return { kind: "voided", bookingReopened: false } as const;
  });
}

async function liveInvoice(tx: QuerySql, marketId: string, reservationId: string): Promise<boolean> {
  if (!await invoicesReady(tx)) return false;
  const [row] = await tx<{ live: boolean }[]>`SELECT EXISTS (SELECT 1 FROM fame_invoices WHERE market_id = ${marketId}
    AND reservation_id = ${reservationId} AND status IN ('creating', 'open')) AS live`;
  return Boolean(row?.live);
}

export type AdjustResult =
  | { kind: "saved"; adjustmentId: string; amountCents: number }
  | { kind: "not_found" }
  | { kind: "not_adjustable"; reason: string }
  | { kind: "invalid"; error: string };

function cleanReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.replace(/\s+/g, " ").trim();
  return reason && reason.length <= 300 ? reason : null;
}

/** Lowers an unpaid booking's price by an amount or a percent of its booking price. */
export async function addDiscount(input: {
  marketId: string; reservationId: string; amountCents?: unknown; percent?: unknown; reason: unknown; actorAccountId: string; now?: Date;
}, sql: Sql = configuredClient()): Promise<AdjustResult> {
  const reason = cleanReason(input.reason);
  if (!reason) return { kind: "invalid", error: "Say why (up to 300 characters); it's kept on record." };
  const percent = input.percent === undefined || input.percent === null || input.percent === "" ? null : Number(input.percent);
  if (percent !== null && (!Number.isFinite(percent) || percent <= 0 || percent > 100 || Math.round(percent * 100) !== percent * 100)) return { kind: "invalid", error: "A percent discount must be between 0.01 and 100." };
  return sql.begin(async tx => {
    const [row] = await tx<{ application_id: string | null; state: string; total_cents: string | number }[]>`
      SELECT application_id, state, total_cents FROM fame_reservations WHERE id = ${input.reservationId} AND market_id = ${input.marketId} FOR UPDATE`;
    if (!row?.application_id) return { kind: "not_found" } as const;
    if (!ADJUSTABLE_STATES.includes(row.state)) return { kind: "not_adjustable", reason: row.state === "paid" || row.state === "confirmed" ? "This booking is already paid. Give the vendor a credit instead." : `This booking is ${row.state.replace("_", " ")}.` } as const;
    if (await liveInvoice(tx, input.marketId, input.reservationId)) return { kind: "not_adjustable", reason: "This booking is on a Square invoice. Use \"Change amount\" on the invoice instead." } as const;
    const due = (await bookingBalanceDue(input.marketId, input.reservationId, tx))?.balanceCents ?? 0;
    const amount = percent !== null ? Math.round(Number(row.total_cents) * percent / 100) : Number(input.amountCents);
    if (!Number.isSafeInteger(amount) || amount < 1) return { kind: "invalid", error: "Enter a discount of at least $0.01." } as const;
    if (amount > due) return { kind: "invalid", error: `That's more than the ${(due / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} still owed on this booking.` } as const;
    const id = randomUUID();
    await tx`INSERT INTO fame_vendor_adjustments (id, market_id, application_id, reservation_id, kind, amount_cents, percent, reason, created_by_account_id, created_at)
      VALUES (${id}, ${input.marketId}, ${row.application_id}, ${input.reservationId}, 'discount', ${amount}, ${percent}, ${reason}, ${input.actorAccountId}, ${input.now ?? new Date()})`;
    return { kind: "saved", adjustmentId: id, amountCents: amount } as const;
  });
}

/** A credit on the vendor's balance (e.g. a rain-out), used later on any unpaid booking. */
export async function addCredit(input: { marketId: string; applicationId: string; amountCents: unknown; reason: unknown; actorAccountId: string; now?: Date }, sql: Sql = configuredClient()): Promise<AdjustResult> {
  const reason = cleanReason(input.reason);
  if (!reason) return { kind: "invalid", error: "Say why (up to 300 characters); it's kept on record." };
  const amount = Number(input.amountCents);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_CREDIT_CENTS) return { kind: "invalid", error: "Enter a credit between $0.01 and $5,000." };
  const [app] = await sql<{ id: string }[]>`SELECT id FROM fame_applications WHERE id = ${input.applicationId} AND market_id = ${input.marketId}`;
  if (!app) return { kind: "not_found" };
  const id = randomUUID();
  await sql`INSERT INTO fame_vendor_adjustments (id, market_id, application_id, reservation_id, kind, amount_cents, reason, created_by_account_id, created_at)
    VALUES (${id}, ${input.marketId}, ${input.applicationId}, NULL, 'credit', ${amount}, ${reason}, ${input.actorAccountId}, ${input.now ?? new Date()})`;
  return { kind: "saved", adjustmentId: id, amountCents: amount };
}

/** Uses up to `amountCents` of the vendor's available credit on one unpaid booking. */
export async function applyCredit(input: { marketId: string; reservationId: string; amountCents: number; actorAccountId: string; now?: Date }, sql: Sql = configuredClient()): Promise<AdjustResult> {
  return sql.begin(async tx => {
    const [row] = await tx<{ application_id: string | null; state: string }[]>`
      SELECT application_id, state FROM fame_reservations WHERE id = ${input.reservationId} AND market_id = ${input.marketId} FOR UPDATE`;
    if (!row?.application_id) return { kind: "not_found" } as const;
    if (!ADJUSTABLE_STATES.includes(row.state)) return { kind: "not_adjustable", reason: `This booking is ${row.state.replace("_", " ")}.` } as const;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`fame-vendor-credit:${input.marketId}:${row.application_id}`}, 0))`;
    const booking = await bookingBalanceDue(input.marketId, input.reservationId, tx);
    if (!booking) return { kind: "not_found" } as const;
    const amount = Math.min(Math.floor(input.amountCents), booking.creditAvailableCents, booking.balanceCents);
    if (!Number.isSafeInteger(amount) || amount < 1) return { kind: "invalid", error: "There's no credit available to use on this booking." } as const;
    const id = randomUUID();
    await tx`INSERT INTO fame_vendor_adjustments (id, market_id, application_id, reservation_id, kind, amount_cents, reason, created_by_account_id, created_at)
      VALUES (${id}, ${input.marketId}, ${row.application_id}, ${input.reservationId}, 'credit_applied', ${amount}, 'Credit from the vendor balance', ${input.actorAccountId}, ${input.now ?? new Date()})`;
    return { kind: "saved", adjustmentId: id, amountCents: amount } as const;
  });
}

/** Undo a mistaken discount, credit or credit use. Kept on record as voided. */
export async function voidAdjustment(input: { marketId: string; adjustmentId: string; now?: Date }, sql: Sql = configuredClient()): Promise<{ kind: "voided" } | { kind: "not_found" } | { kind: "not_voidable"; reason: string }> {
  return sql.begin(async tx => {
    const [row] = await tx<{ application_id: string; reservation_id: string | null; kind: string; amount_cents: string | number }[]>`
      SELECT application_id, reservation_id, kind, amount_cents FROM fame_vendor_adjustments
      WHERE id = ${input.adjustmentId} AND market_id = ${input.marketId} AND voided_at IS NULL FOR UPDATE`;
    if (!row) return { kind: "not_found" } as const;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`fame-vendor-credit:${input.marketId}:${row.application_id}`}, 0))`;
    if (row.reservation_id) {
      const [booking] = await tx<{ state: string }[]>`SELECT state FROM fame_reservations WHERE id = ${row.reservation_id} AND market_id = ${input.marketId}`;
      if (!booking || !ADJUSTABLE_STATES.includes(booking.state)) return { kind: "not_voidable", reason: "That booking is no longer unpaid, so its price can't change." } as const;
      if (await liveInvoice(tx, input.marketId, row.reservation_id)) return { kind: "not_voidable", reason: "That booking is on a Square invoice. Cancel or change the invoice first." } as const;
    } else {
      const balance = await vendorBalance(input.marketId, row.application_id, tx);
      if (balance.creditAvailableCents < Number(row.amount_cents)) return { kind: "not_voidable", reason: "Part of this credit has been used on a booking. Undo that first." } as const;
    }
    await tx`UPDATE fame_vendor_adjustments SET voided_at = ${input.now ?? new Date()} WHERE id = ${input.adjustmentId}`;
    return { kind: "voided" } as const;
  });
}

export interface MarketBalanceRow { applicationId: string; business: string; chargedCents: number; paidCents: number; owedCents: number; creditAvailableCents: number }

/** Every vendor with a booking: what they owe or hold in credit, largest balance first. */
export async function marketBalances(marketId: string, sql: QuerySql = configuredClient()): Promise<MarketBalanceRow[]> {
  const apps = await sql<{ application_id: string; business: string | null }[]>`
    SELECT DISTINCT r.application_id,
      (SELECT e.snapshot->'snapshot'->>'businessName' FROM fame_application_events e
        WHERE e.application_id = r.application_id AND e.market_id = r.market_id ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS business
    FROM fame_reservations r WHERE r.market_id = ${marketId} AND r.application_id IS NOT NULL`;
  const rows: MarketBalanceRow[] = [];
  for (const app of apps) {
    const balance = await vendorBalance(marketId, app.application_id, sql);
    if (!balance.bookings.length && !balance.totals.creditCents) continue;
    rows.push({ applicationId: app.application_id, business: app.business ?? "", chargedCents: balance.totals.chargedCents, paidCents: balance.totals.paidCents, owedCents: balance.totals.owedCents, creditAvailableCents: balance.creditAvailableCents });
  }
  return rows.sort((a, b) => b.owedCents - a.owedCents);
}
