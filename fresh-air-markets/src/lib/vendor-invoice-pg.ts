import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { BillingRequest, Installment } from "./billing-plan";
import { invoicesReady } from "./invoice-table";
import { BILLABLE_STATES } from "./reservation-withdraw-pg";

type Sql = ReturnType<typeof postgres>;
type QuerySql = Sql | postgres.TransactionSql;

let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent invoice storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

/**
 * The portal's record of bookings billed through Square Invoices. Square
 * holds the money and sends the emails; this ledger holds what staff chose
 * and every payment Square reports, so the roster can say "Paid 2 of 6"
 * and the booking turns paid only when the invoice is covered.
 */

export interface InvoiceView {
  id: string;
  reservationId: string;
  plan: "full" | "monthly";
  status: "creating" | "open" | "paid" | "cancelled" | "failed";
  totalCents: number;
  quotedCents: number;
  paidCents: number;
  adjustmentReason: string;
  publicUrl: string | null;
  lastError: string | null;
  createdAt: string;
  installments: Installment[];
  /** How many scheduled payments the money received so far covers. */
  installmentsPaid: number;
}

interface InvoiceRow {
  id: string; reservation_id: string; plan: "full" | "monthly"; status: InvoiceView["status"];
  total_cents: string | number; quoted_cents: string | number; paid_cents: string | number; adjustment_reason: string;
  public_url: string | null; last_error: string | null; created_at: Date;
  square_customer_id: string | null; square_order_id: string | null; square_invoice_id: string | null; square_invoice_version: number | null;
  square_environment: "sandbox" | "production";
}

export interface InvoiceRecord extends InvoiceView {
  environment: "sandbox" | "production";
  squareCustomerId: string | null;
  squareOrderId: string | null;
  squareInvoiceId: string | null;
  squareInvoiceVersion: number | null;
}

function installmentsPaid(installments: Installment[], paidCents: number): number {
  let running = 0;
  let count = 0;
  for (const item of [...installments].sort((a, b) => a.seq - b.seq)) {
    running += item.amountCents;
    if (running <= paidCents) count += 1; else break;
  }
  return count;
}

async function readInstallments(sql: QuerySql, invoiceIds: string[]): Promise<Map<string, Installment[]>> {
  const map = new Map<string, Installment[]>();
  if (!invoiceIds.length) return map;
  const rows = await sql<{ invoice_id: string; seq: number; due_on: string; amount_cents: string | number }[]>`
    SELECT invoice_id, seq, due_on::text AS due_on, amount_cents FROM fame_invoice_installments
    WHERE invoice_id = ANY(${invoiceIds}::text[]) ORDER BY invoice_id, seq`;
  for (const row of rows) {
    const list = map.get(row.invoice_id) ?? [];
    list.push({ seq: Number(row.seq), dueOn: row.due_on, amountCents: Number(row.amount_cents) });
    map.set(row.invoice_id, list);
  }
  return map;
}

function toRecord(row: InvoiceRow, installments: Installment[]): InvoiceRecord {
  const paidCents = Number(row.paid_cents);
  return {
    id: row.id, reservationId: row.reservation_id, plan: row.plan, status: row.status,
    totalCents: Number(row.total_cents), quotedCents: Number(row.quoted_cents), paidCents,
    adjustmentReason: row.adjustment_reason, publicUrl: row.public_url, lastError: row.last_error,
    createdAt: new Date(row.created_at).toISOString(), installments, installmentsPaid: installmentsPaid(installments, paidCents),
    environment: row.square_environment, squareCustomerId: row.square_customer_id, squareOrderId: row.square_order_id,
    squareInvoiceId: row.square_invoice_id, squareInvoiceVersion: row.square_invoice_version,
  };
}

/** Browser-safe projection: no Square ids. */
export function invoiceView(record: InvoiceRecord): InvoiceView {
  const { environment: _e, squareCustomerId: _c, squareOrderId: _o, squareInvoiceId: _i, squareInvoiceVersion: _v, ...view } = record;
  return view;
}

const SELECT_INVOICE = `id, reservation_id, plan, status, total_cents, quoted_cents, paid_cents, adjustment_reason,
  public_url, last_error, created_at, square_customer_id, square_order_id, square_invoice_id, square_invoice_version, square_environment`;

export async function getInvoice(marketId: string, invoiceId: string, sql: QuerySql = configuredClient()): Promise<InvoiceRecord | null> {
  const [row] = await sql.unsafe<InvoiceRow[]>(`SELECT ${SELECT_INVOICE} FROM fame_invoices WHERE market_id = $1 AND id = $2`, [marketId, invoiceId]);
  if (!row) return null;
  return toRecord(row, (await readInstallments(sql, [row.id])).get(row.id) ?? []);
}

/** Every invoice for every booking of one application, newest first; null until billing's database update is applied. */
export async function listInvoicesForApplication(marketId: string, applicationId: string, sql: QuerySql = configuredClient()): Promise<InvoiceView[] | null> {
  if (!await invoicesReady(sql)) return null;
  const rows = await sql.unsafe<InvoiceRow[]>(`
    SELECT ${SELECT_INVOICE.split(",").map(c => `i.${c.trim()}`).join(", ")} FROM fame_invoices i
    JOIN fame_reservations r ON r.id = i.reservation_id AND r.market_id = i.market_id
    WHERE i.market_id = $1 AND r.application_id = $2
    ORDER BY i.created_at DESC`, [marketId, applicationId]);
  const installments = await readInstallments(sql, rows.map(row => row.id));
  return rows.map(row => invoiceView(toRecord(row, installments.get(row.id) ?? [])));
}

/** Bookings with a live invoice, so payment reminders can leave them to Square. */
export async function reservationsOnInvoice(marketId: string, sql: QuerySql = configuredClient()): Promise<Set<string>> {
  if (!await invoicesReady(sql)) return new Set();
  const rows = await sql<{ reservation_id: string }[]>`
    SELECT reservation_id FROM fame_invoices WHERE market_id = ${marketId} AND status IN ('creating', 'open')`;
  return new Set(rows.map(row => row.reservation_id));
}

export interface BillingTarget {
  reservationId: string; applicationId: string; state: string; quotedCents: number;
  dates: string[]; booths: number; description: string;
}

export type BeginInvoiceResult =
  | { kind: "started"; invoice: InvoiceRecord; target: BillingTarget }
  | { kind: "resume"; invoice: InvoiceRecord; target: BillingTarget }
  | { kind: "not_found" }
  | { kind: "not_billable"; state: string }
  | { kind: "already_open"; invoice: InvoiceRecord }
  | { kind: "unavailable" };

/**
 * Claims the booking for an invoice. A second click while one is being
 * created gets that one back to finish; an open invoice blocks a new one.
 */
export async function beginInvoice(input: {
  marketId: string; reservationId: string; request: BillingRequest; environment: "sandbox" | "production"; actorAccountId: string; now?: Date;
}, sql: Sql = configuredClient()): Promise<BeginInvoiceResult> {
  const now = input.now ?? new Date();
  if (!await invoicesReady(sql)) return { kind: "unavailable" };
  return sql.begin(async tx => {
    const [reservation] = await tx<{ id: string; application_id: string | null; state: string; payment_required: boolean; total_cents: string | number; final_dates: unknown; final_booth_quantity: number; checkout_description: string }[]>`
      SELECT id, application_id, state, payment_required, total_cents, final_dates, final_booth_quantity, checkout_description
      FROM fame_reservations WHERE id = ${input.reservationId} AND market_id = ${input.marketId} FOR UPDATE`;
    if (!reservation?.application_id) return { kind: "not_found" } as const;
    const target: BillingTarget = {
      reservationId: reservation.id, applicationId: reservation.application_id, state: reservation.state,
      quotedCents: Number(reservation.total_cents),
      dates: Array.isArray(reservation.final_dates) ? reservation.final_dates.filter((d): d is string => typeof d === "string").sort() : [],
      booths: Number(reservation.final_booth_quantity), description: reservation.checkout_description,
    };
    const [live] = await tx.unsafe<InvoiceRow[]>(`SELECT ${SELECT_INVOICE} FROM fame_invoices
      WHERE market_id = $1 AND reservation_id = $2 AND status IN ('creating', 'open') FOR UPDATE`, [input.marketId, input.reservationId]);
    if (live) {
      const record = toRecord(live, (await readInstallments(tx, [live.id])).get(live.id) ?? []);
      return live.status === "creating" ? { kind: "resume", invoice: record, target } as const : { kind: "already_open", invoice: record } as const;
    }
    if (!reservation.payment_required || !(BILLABLE_STATES as readonly string[]).includes(reservation.state)) {
      return { kind: "not_billable", state: reservation.payment_required ? reservation.state : "nonprofit" } as const;
    }
    const id = randomUUID();
    await tx`
      INSERT INTO fame_invoices (id, market_id, reservation_id, square_environment, plan, total_cents, quoted_cents,
        adjustment_reason, status, created_by_account_id, created_at, updated_at)
      VALUES (${id}, ${input.marketId}, ${reservation.id}, ${input.environment}, ${input.request.plan}, ${input.request.totalCents},
        ${target.quotedCents}, ${input.request.totalCents === target.quotedCents ? "" : input.request.reason}, 'creating',
        ${input.actorAccountId}, ${now}, ${now})`;
    for (const item of input.request.installments) {
      await tx`INSERT INTO fame_invoice_installments (invoice_id, seq, due_on, amount_cents) VALUES (${id}, ${item.seq}, ${item.dueOn}::date, ${item.amountCents})`;
    }
    const [row] = await tx.unsafe<InvoiceRow[]>(`SELECT ${SELECT_INVOICE} FROM fame_invoices WHERE id = $1`, [id]);
    return { kind: "started", invoice: toRecord(row, input.request.installments), target } as const;
  });
}

/** The Square draft exists; remembered so a retry publishes it instead of creating another. */
export async function recordInvoiceDraft(input: { invoiceId: string; customerId: string; orderId: string; squareInvoiceId: string; version: number; now?: Date }, sql: Sql = configuredClient()): Promise<void> {
  await sql`UPDATE fame_invoices SET square_customer_id = ${input.customerId}, square_order_id = ${input.orderId},
    square_invoice_id = ${input.squareInvoiceId}, square_invoice_version = ${input.version}, updated_at = ${input.now ?? new Date()}
    WHERE id = ${input.invoiceId} AND status = 'creating'`;
}

export async function markInvoiceOpen(input: { invoiceId: string; version: number; publicUrl: string | null; now?: Date }, sql: Sql = configuredClient()): Promise<void> {
  await sql`UPDATE fame_invoices SET status = 'open', square_invoice_version = ${input.version}, public_url = ${input.publicUrl},
    last_error = NULL, updated_at = ${input.now ?? new Date()} WHERE id = ${input.invoiceId} AND status = 'creating'`;
}

export async function markInvoiceFailed(input: { invoiceId: string; error: string; now?: Date }, sql: Sql = configuredClient()): Promise<void> {
  await sql`UPDATE fame_invoices SET status = 'failed', last_error = ${input.error.slice(0, 300)}, updated_at = ${input.now ?? new Date()}
    WHERE id = ${input.invoiceId} AND status = 'creating'`;
}

/** Staff stopped the plan. Payments already received stay recorded. */
export async function markInvoiceCancelled(input: { marketId: string; invoiceId: string; now?: Date }, sql: Sql = configuredClient()): Promise<boolean> {
  const rows = await sql`UPDATE fame_invoices SET status = 'cancelled', updated_at = ${input.now ?? new Date()}
    WHERE id = ${input.invoiceId} AND market_id = ${input.marketId} AND status IN ('creating', 'open') RETURNING id`;
  return rows.length === 1;
}

export interface InvoicePaymentEvent {
  environment: "sandbox" | "production"; orderId: string; paymentId: string; status: string; amountCents: number; currency: string;
}

/**
 * Called inside the Square webhook transaction for a payment whose order is
 * not a hosted checkout. Returns null when the order is not one of our
 * invoices either. A completed payment is recorded once; when the payments
 * cover the invoice, the invoice and its booking become paid.
 */
export async function applyInvoicePayment(tx: QuerySql, event: InvoicePaymentEvent, now: Date): Promise<
  null | { disposition: "paid" | "ignored" | "manual_review"; reason: string; invoicePaid: boolean }
> {
  if (!await invoicesReady(tx)) return null;
  const [invoice] = await tx<{ id: string; market_id: string; reservation_id: string; status: string; total_cents: string | number }[]>`
    SELECT id, market_id, reservation_id, status, total_cents FROM fame_invoices
    WHERE square_environment = ${event.environment} AND square_order_id = ${event.orderId} FOR UPDATE`;
  if (!invoice) return null;
  if (event.status !== "COMPLETED") return { disposition: "ignored", reason: "invoice_payment_not_completed", invoicePaid: false };
  if (event.currency !== "USD") return { disposition: "manual_review", reason: "invoice_payment_currency_mismatch", invoicePaid: false };
  const inserted = await tx`INSERT INTO fame_invoice_payments (square_environment, payment_id, invoice_id, amount_cents, received_at)
    VALUES (${event.environment}, ${event.paymentId}, ${invoice.id}, ${event.amountCents}, ${now})
    ON CONFLICT (square_environment, payment_id) DO NOTHING RETURNING payment_id`;
  if (!inserted.length) return { disposition: "ignored", reason: "invoice_payment_already_recorded", invoicePaid: false };
  const [sum] = await tx<{ paid: string | number }[]>`SELECT COALESCE(SUM(amount_cents), 0) AS paid FROM fame_invoice_payments WHERE invoice_id = ${invoice.id}`;
  const paid = Number(sum?.paid ?? 0);
  const covered = paid >= Number(invoice.total_cents);
  await tx`UPDATE fame_invoices SET paid_cents = ${paid}, status = CASE WHEN ${covered} AND status IN ('open', 'creating') THEN 'paid' ELSE status END,
    updated_at = ${now} WHERE id = ${invoice.id}`;
  if (covered) {
    await tx`UPDATE fame_reservations SET state = 'paid', updated_at = ${now}
      WHERE id = ${invoice.reservation_id} AND market_id = ${invoice.market_id} AND state IN ('held', 'payment_pending')`;
  }
  return { disposition: "paid", reason: covered ? "invoice_paid_in_full" : "invoice_installment_paid", invoicePaid: covered };
}

/** The booking's quoted total, for validating a custom amount before anything is written. */
export async function readBillingQuote(marketId: string, reservationId: string, sql: QuerySql = configuredClient()): Promise<number | null> {
  const [row] = await sql<{ total_cents: string | number }[]>`SELECT total_cents FROM fame_reservations WHERE id = ${reservationId} AND market_id = ${marketId}`;
  return row ? Number(row.total_cents) : null;
}

/**
 * True while a Square invoice is collecting on this booking. Payment-link
 * routes refuse then, so a vendor is never sent two ways to pay. A read
 * failure answers false: those routes fail on the same database anyway.
 */
export async function hasOpenInvoice(marketId: string, reservationId: string, sql: QuerySql = configuredClient()): Promise<boolean> {
  try {
    const [row] = await sql<{ live: boolean }[]>`SELECT EXISTS (SELECT 1 FROM fame_invoices WHERE market_id = ${marketId}
      AND reservation_id = ${reservationId} AND status IN ('creating', 'open')) AS live`;
    return Boolean(row?.live);
  } catch { return false; }
}
