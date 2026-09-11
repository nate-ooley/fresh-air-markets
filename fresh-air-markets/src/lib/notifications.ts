import postgres from "postgres";
import { applicantContact, emailConfigured, sendEmail, sendStaffEmail, type SendEmailResult } from "./email";
import {
  applicationApprovedEmail, applicationChangesRequestedEmail, applicationDeclinedEmail, applicationReceivedEmail,
  paymentReceivedEmail, paymentRequestEmail, passwordResetEmail, staffContactMessageEmail, staffInvitationEmail, staffNewApplicationEmail, staffPaymentReceivedEmail,
} from "./email-templates";

/**
 * Event-to-email glue for the portal. Each function is best-effort: it looks
 * up what it needs, sends, and reports "sent" | "failed" | "not_sent". It never
 * throws into the request that triggered it and never blocks the database
 * change that already committed.
 */

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 2, prepare: false, connect_timeout: 5 });
  return client;
}

export type NotificationOutcome = "sent" | "failed" | "not_sent";

function outcome(result: SendEmailResult): NotificationOutcome {
  return result.status === "sent" ? "sent" : result.status === "failed" ? "failed" : "not_sent";
}

export function portalOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FAME_VENDOR_PORTAL_ORIGIN?.trim();
  if (configured) { try { return new URL(configured).origin; } catch { /* fall through */ } }
  return "https://farmers-market-wine.vercel.app";
}

export async function notifyApplicationReceived(input: {
  applicationId: string; marketId: string; email: string; name: string; businessName: string; type: "Vendor" | "Non-Profit Organization";
}, sql?: Sql): Promise<NotificationOutcome> {
  if (!emailConfigured()) return "not_sent";
  const deps = { sql };
  const vendor = applicationReceivedEmail({ name: input.name, businessName: input.businessName });
  const result = await sendEmail({ kind: "application_received", to: input.email, marketId: input.marketId, referenceId: input.applicationId, ...vendor }, deps);
  const staff = staffNewApplicationEmail({ ...input, origin: portalOrigin() });
  await sendStaffEmail({ kind: "staff_new_application", marketId: input.marketId, referenceId: input.applicationId, ...staff }, deps);
  return outcome(result);
}

/** True when the vendor already attached at least one current document (uploaded during or after applying). */
async function hasCurrentDocument(applicationId: string, marketId: string, sql: Sql): Promise<boolean> {
  try {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM fame_application_documents
      WHERE application_id = ${applicationId} AND market_id = ${marketId} AND is_current`;
    return (row?.n ?? 0) > 0;
  } catch { return false; }
}

export async function notifyApplicationDecision(input: {
  applicationId: string; marketId: string; action: "approve" | "request_changes" | "decline"; reason: string;
}, sql?: Sql): Promise<NotificationOutcome> {
  if (!emailConfigured()) return "not_sent";
  try {
    const db = sql ?? configuredClient();
    const contact = await applicantContact(input.applicationId, input.marketId, db);
    if (!contact) return "not_sent";
    const documentsOnFile = input.action === "approve" && await hasCurrentDocument(input.applicationId, input.marketId, db);
    const content = input.action === "approve" ? applicationApprovedEmail({ ...contact, documentsOnFile })
      : input.action === "request_changes" ? applicationChangesRequestedEmail({ name: contact.name, reason: input.reason })
      : applicationDeclinedEmail({ name: contact.name, reason: input.reason });
    const kind = input.action === "approve" ? "application_approved" : input.action === "request_changes" ? "application_changes_requested" : "application_declined";
    return outcome(await sendEmail({ kind, to: contact.email, marketId: input.marketId, referenceId: input.applicationId, ...content }, { sql: db }));
  } catch { return "failed"; }
}

export async function notifyPaymentRequest(input: {
  reservationId: string; marketId: string; invitationUrl: string; expiresAt: string;
}, sql?: Sql): Promise<NotificationOutcome> {
  if (!emailConfigured()) return "not_sent";
  try {
    const db = sql ?? configuredClient();
    const [reservation] = await db<{ application_id: string | null; total_cents: string | number; payment_due_at: Date | null }[]>`
      SELECT application_id, total_cents, payment_due_at FROM fame_reservations WHERE id = ${input.reservationId} AND market_id = ${input.marketId}`;
    if (!reservation?.application_id) return "not_sent";
    const contact = await applicantContact(reservation.application_id, input.marketId, db);
    if (!contact) return "not_sent";
    const allocations = await db<{ market_date: string; booth_quantity: number }[]>`
      SELECT market_date::text AS market_date, booth_quantity FROM fame_reservation_allocations
      WHERE reservation_id = ${input.reservationId} AND market_id = ${input.marketId} ORDER BY market_date`;
    const dueAt = reservation.payment_due_at ? new Date(reservation.payment_due_at).toISOString() : input.expiresAt;
    const content = paymentRequestEmail({
      name: contact.name, totalCents: Number(reservation.total_cents), dueAt,
      dates: allocations.map(a => a.market_date), booths: allocations[0]?.booth_quantity ?? 1, link: input.invitationUrl,
    });
    return outcome(await sendEmail({ kind: "payment_request", to: contact.email, marketId: input.marketId, referenceId: input.reservationId, ...content }, { sql: db }));
  } catch { return "failed"; }
}

export async function notifyPaymentReceived(input: { squareOrderId: string; marketId: string }, sql?: Sql): Promise<NotificationOutcome> {
  if (!emailConfigured()) return "not_sent";
  try {
    const db = sql ?? configuredClient();
    const [order] = await db<{ reservation_id: string; expected_total_cents: string | number }[]>`
      SELECT reservation_id, expected_total_cents FROM fame_payment_orders
      WHERE square_order_id = ${input.squareOrderId} AND market_id = ${input.marketId} AND status = 'paid'
      ORDER BY updated_at DESC LIMIT 1`;
    if (!order) return "not_sent";
    const [reservation] = await db<{ application_id: string | null }[]>`
      SELECT application_id FROM fame_reservations WHERE id = ${order.reservation_id} AND market_id = ${input.marketId}`;
    if (!reservation?.application_id) return "not_sent";
    const contact = await applicantContact(reservation.application_id, input.marketId, db);
    if (!contact) return "not_sent";
    const totalCents = Number(order.expected_total_cents);
    const result = await sendEmail({ kind: "payment_received", to: contact.email, marketId: input.marketId, referenceId: order.reservation_id,
      ...paymentReceivedEmail({ name: contact.name, totalCents }) }, { sql: db });
    await sendStaffEmail({ kind: "staff_payment_received", marketId: input.marketId, referenceId: order.reservation_id,
      ...staffPaymentReceivedEmail({ ...contact, totalCents, applicationId: reservation.application_id, origin: portalOrigin() }) }, { sql: db });
    return outcome(result);
  } catch { return "failed"; }
}

export async function notifyContactMessage(input: {
  marketId: string; messageId: string; name: string; email: string; phone: string; topic: string; message: string;
}, sql?: Sql): Promise<NotificationOutcome> {
  if (!emailConfigured()) return "not_sent";
  const content = staffContactMessageEmail({ ...input, origin: portalOrigin() });
  return outcome(await sendStaffEmail({ kind: "staff_contact_message", marketId: input.marketId, referenceId: input.messageId, ...content }, { sql }));
}

/** Staff password reset link; the token inside `link` is never logged. */
export async function notifyPasswordReset(input: {
  marketId: string; email: string; name: string; link: string; minutes: number;
}, sql?: Sql): Promise<NotificationOutcome> {
  if (!emailConfigured()) return "not_sent";
  const content = passwordResetEmail({ name: input.name, link: input.link, minutes: input.minutes });
  return outcome(await sendEmail({ kind: "staff_password_reset", to: input.email, marketId: input.marketId, referenceId: "", ...content }, { sql }));
}

/** Invitation to join a market's staff; the token inside `link` is never logged. */
export async function notifyStaffInvitation(input: {
  marketId: string; email: string; name: string; marketName: string; link: string; days: number;
}, sql?: Sql): Promise<NotificationOutcome> {
  if (!emailConfigured()) return "not_sent";
  const content = staffInvitationEmail({ name: input.name, marketName: input.marketName, link: input.link, days: input.days });
  return outcome(await sendEmail({ kind: "staff_invitation", to: input.email, marketId: input.marketId, referenceId: "", ...content }, { sql }));
}
