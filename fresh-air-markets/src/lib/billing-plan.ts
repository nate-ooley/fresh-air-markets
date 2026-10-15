/**
 * Pure rules for billing a booking through a Square invoice: one payment, or
 * a monthly plan. Browser-safe so the staff preview and the server agree.
 */

export const MIN_INSTALLMENTS = 2;
export const MAX_INSTALLMENTS = 12;
/** A custom amount may discount freely but never exceed this multiple of the quote. */
export const MAX_ADJUSTMENT_FACTOR = 10;

export type BillingPlanKind = "full" | "monthly";
export interface Installment { seq: number; dueOn: string; amountCents: number }

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

/** Same day of the month, clamped to the month's last day (Jan 31 → Feb 28). */
export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1, 12));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

/** Splits a total into equal monthly payments to the cent; the last payment absorbs the rounding. */
export function monthlySchedule(totalCents: number, count: number, firstDueOn: string): Installment[] {
  const base = Math.floor(totalCents / count);
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    dueOn: addMonths(firstDueOn, index),
    amountCents: index === count - 1 ? totalCents - base * (count - 1) : base,
  }));
}

export interface BillingRequest {
  plan: BillingPlanKind;
  totalCents: number;
  installments: Installment[];
  /** Required when the amount differs from the booking's quoted total. */
  reason: string;
}

/**
 * Validates what staff asked for against the booking's quote and today's
 * date. Returns the schedule to send, or a staff-readable problem.
 */
export function planBilling(input: {
  plan: unknown; installments?: unknown; firstDueOn: unknown; totalCents: unknown; reason?: unknown;
  quotedCents: number; today: string;
}): BillingRequest | { error: string } {
  if (input.plan !== "full" && input.plan !== "monthly") return { error: "Choose pay in full or a monthly plan." };
  if (typeof input.firstDueOn !== "string" || !validDate(input.firstDueOn)) return { error: "Pick a valid first due date." };
  if (input.firstDueOn < input.today) return { error: "The first due date can't be in the past." };
  const total = input.totalCents;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 100) return { error: "The amount must be at least $1.00." };
  if (total > input.quotedCents * MAX_ADJUSTMENT_FACTOR) return { error: "That amount is far above the booking price. Check it and try again." };
  const reason = typeof input.reason === "string" ? input.reason.replace(/\s+/g, " ").trim() : "";
  if (total !== input.quotedCents && !reason) return { error: "Say why the amount differs from the booking price (it's kept on record)." };
  if (reason.length > 300) return { error: "Keep the reason under 300 characters." };
  if (input.plan === "full") {
    return { plan: "full", totalCents: total, reason, installments: [{ seq: 1, dueOn: input.firstDueOn, amountCents: total }] };
  }
  const count = input.installments;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < MIN_INSTALLMENTS || count > MAX_INSTALLMENTS) {
    return { error: `A monthly plan has ${MIN_INSTALLMENTS} to ${MAX_INSTALLMENTS} payments.` };
  }
  if (Math.floor(total / count) < 100) return { error: "Each monthly payment must be at least $1.00." };
  return { plan: "monthly", totalCents: total, reason, installments: monthlySchedule(total, count, input.firstDueOn) };
}
