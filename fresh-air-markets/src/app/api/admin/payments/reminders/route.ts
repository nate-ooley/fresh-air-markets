import { NextRequest, NextResponse } from "next/server";
import postgres from "postgres";
import { getSessionAccountId } from "@/lib/auth";
import { freshAirFinalReservationConfig, reopenExpiredReservation } from "@/lib/final-reservation-pg";
import { notifyPaymentRequest } from "@/lib/notifications";
import { cleanReminderTemplate } from "@/lib/payment-reminder-template";
import { readObjectBody } from "@/lib/request-body";
import { reservationsOnInvoice } from "@/lib/vendor-invoice-pg";
import { hasPriceAdjustment } from "@/lib/vendor-balance-pg";
import { squarePaymentRuntimeConfig, squarePortalOrigin, verifySquareIdentity } from "@/lib/square";
import { dispatchSquareCheckout } from "@/lib/square-payment";
import { postgresSquarePaymentCheckoutStore } from "@/lib/square-payment-pg";
import { issueVendorPaymentInvitation, vendorPaymentAccessConfig } from "@/lib/vendor-payment-access";
import { postgresVendorPaymentAccessStore } from "@/lib/vendor-payment-access-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };

let client: ReturnType<typeof postgres> | undefined;
function db() {
  if (!process.env.DATABASE_URL) throw new Error("Storage required");
  client ??= postgres(process.env.DATABASE_URL, { max: 2, prepare: false, connect_timeout: 5 });
  return client;
}

interface Unpaid { id: string; state: string; total_cents: string | number; business: string | null; email: string | null; name: string | null }

/** Every booking that still owes money: awaiting payment, held without a link, or lapsed. */
async function unpaidBookings(marketId: string): Promise<Unpaid[]> {
  // Square sends its own reminders for bookings billed by invoice.
  const invoiced = await reservationsOnInvoice(marketId, db());
  const rows = await db()<Unpaid[]>`
    SELECT r.id, r.state, r.total_cents,
      (SELECT e.snapshot->'snapshot'->>'businessName' FROM fame_application_events e
        WHERE e.application_id = r.application_id AND e.market_id = r.market_id ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS business,
      (SELECT lower(btrim(e.snapshot->'snapshot'->>'email')) FROM fame_application_events e
        WHERE e.application_id = r.application_id AND e.market_id = r.market_id ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS email,
      (SELECT btrim(concat_ws(' ', e.snapshot->'snapshot'->>'firstName', e.snapshot->'snapshot'->>'lastName')) FROM fame_application_events e
        WHERE e.application_id = r.application_id AND e.market_id = r.market_id ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS name
    FROM fame_reservations r
    JOIN fame_reservation_finalizations f ON f.reservation_id = r.id AND f.market_id = r.market_id
    JOIN fame_applications a ON a.id = r.application_id AND a.market_id = r.market_id
    WHERE r.market_id = ${marketId} AND r.payment_required AND r.state IN ('held', 'payment_pending', 'expired')
      AND a.review_state = 'approved'
    ORDER BY r.created_at`;
  // A booking whose price was changed is billed by invoice; a reminder would resend the full-price link.
  const adjusted = new Set<string>();
  for (const row of rows) if (!invoiced.has(row.id) && await hasPriceAdjustment(marketId, row.id, db())) adjusted.add(row.id);
  return rows.filter(row => !invoiced.has(row.id) && !adjusted.has(row.id));
}

/** Reserved Saturdays and booth count per booking, for the preview. */
async function bookingDates(marketId: string, ids: string[]): Promise<Map<string, { dates: string[]; booths: number }>> {
  const result = new Map<string, { dates: string[]; booths: number }>();
  if (!ids.length) return result;
  const rows = await db()<{ reservation_id: string; market_date: string; booth_quantity: number }[]>`
    SELECT reservation_id, market_date::text AS market_date, booth_quantity FROM fame_reservation_allocations
    WHERE market_id = ${marketId} AND reservation_id = ANY(${ids}::text[]) ORDER BY market_date`;
  for (const row of rows) {
    const entry = result.get(row.reservation_id) ?? { dates: [], booths: Number(row.booth_quantity) || 1 };
    entry.dates.push(row.market_date);
    result.set(row.reservation_id, entry);
  }
  return result;
}

const testAddress = (email: string | null) => !email || /@(example\.(com|org|net)|[^@]*\.test)$/.test(email);

async function gate(request: NextRequest) {
  const marketId = await getSessionAccountId();
  if (!marketId) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }) };
  if (request.method === "POST") {
    if (request.headers.get("sec-fetch-site") === "cross-site") return { error: NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers }) };
    const origin = request.headers.get("origin");
    if (origin !== null) {
      let expected;
      try { expected = squarePortalOrigin(process.env); } catch { return { error: NextResponse.json({ error: "Payments are not configured." }, { status: 503, headers }) }; }
      if (origin !== expected) return { error: NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers }) };
    }
  }
  if (!process.env.DATABASE_URL || process.env.FAME_MARKET_ACCOUNT_ID?.trim() !== marketId) {
    return { error: NextResponse.json({ error: "Payments are not configured for this market." }, { status: 503, headers }) };
  }
  return { marketId };
}

/** Who would get a reminder. */
export async function GET(request: NextRequest) {
  const gated = await gate(request);
  if ("error" in gated) return gated.error;
  try {
    const rows = (await unpaidBookings(gated.marketId)).filter(row => !testAddress(row.email));
    const dates = await bookingDates(gated.marketId, rows.map(row => row.id));
    return NextResponse.json({ unpaid: rows.map(row => ({
      reservationId: row.id, business: row.business ?? "", name: row.name || row.email || "", email: row.email ?? "",
      state: row.state, totalCents: Number(row.total_cents), dates: dates.get(row.id)?.dates ?? [], booths: dates.get(row.id)?.booths ?? 1,
    })) }, { headers });
  } catch {
    return NextResponse.json({ error: "Unpaid bookings could not be read." }, { status: 503, headers });
  }
}

/**
 * Staff: email a payment reminder to the vendors they ticked, with the subject
 * and wording they edited (placeholders filled per vendor). A lapsed
 * hold is reopened (if its dates still have room) and a booking without a
 * live Square link gets one; every vendor receives a fresh private link and
 * earlier links for that booking stop working.
 */
export async function POST(request: NextRequest) {
  const gated = await gate(request);
  if ("error" in gated) return gated.error;
  const marketId = gated.marketId;
  const body = await readObjectBody(request);
  const ids = body?.reservationIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every(id => typeof id === "string" && id.length <= 64)) {
    return NextResponse.json({ error: "Choose at least one vendor." }, { status: 400, headers });
  }
  const template = cleanReminderTemplate(body?.subject, body?.message);
  if ("error" in template) return NextResponse.json({ error: template.error }, { status: 400, headers });
  const chosen = new Set(ids as string[]);
  let config, square, access;
  try {
    config = freshAirFinalReservationConfig(process.env);
    const setup = squarePaymentRuntimeConfig(process.env);
    const identity = await verifySquareIdentity(setup);
    square = { environment: setup.environment, accessToken: setup.accessToken, locationId: identity.locationId, merchantId: identity.merchantId, ...(setup.checkoutRedirectUrl ? { checkoutRedirectUrl: setup.checkoutRedirectUrl } : {}) };
    access = vendorPaymentAccessConfig(process.env);
  } catch {
    return NextResponse.json({ error: "Square is not reachable right now. Nothing was sent; try again." }, { status: 503, headers });
  }
  let rows: Unpaid[];
  try { rows = (await unpaidBookings(marketId)).filter(row => !testAddress(row.email) && chosen.has(row.id)); }
  catch { return NextResponse.json({ error: "Unpaid bookings could not be read." }, { status: 503, headers }); }

  const results: { reservationId: string; business: string; totalCents: number; outcome: "sent" | "skipped" | "failed"; detail: string }[] = [];
  for (const row of rows) {
    const base = { reservationId: row.id, business: row.business ?? "", totalCents: Number(row.total_cents) };
    try {
      if (row.state === "expired") {
        const reopened = await reopenExpiredReservation({ marketId, reservationId: row.id, config });
        if (reopened.kind === "unavailable") { results.push({ ...base, outcome: "skipped", detail: `No room left on ${reopened.unavailableDates.join(", ")}` }); continue; }
        if (reopened.kind === "overlap") { results.push({ ...base, outcome: "skipped", detail: "The vendor already holds these dates in another booking" }); continue; }
        if (reopened.kind === "insurance_expires") { results.push({ ...base, outcome: "skipped", detail: `Insurance expires ${reopened.expiresOn}` }); continue; }
        if (reopened.kind !== "reopened") { results.push({ ...base, outcome: "skipped", detail: "Could not be reopened" }); continue; }
      }
      const checkout = await dispatchSquareCheckout({ marketId, reservationId: row.id, square, store: postgresSquarePaymentCheckoutStore });
      if ((checkout.kind !== "created" && checkout.kind !== "existing") || checkout.order.status !== "checkout_created") {
        results.push({ ...base, outcome: "failed", detail: "The Square payment request could not be prepared" }); continue;
      }
      const link = await issueVendorPaymentInvitation({ config: access, reservationId: row.id, actorAccountId: marketId, store: postgresVendorPaymentAccessStore });
      if (link.kind !== "issued") { results.push({ ...base, outcome: "failed", detail: "The payment link could not be created" }); continue; }
      const sent = await notifyPaymentRequest({ reservationId: row.id, marketId, invitationUrl: link.invitationUrl, expiresAt: link.expiresAt, reminder: true, custom: template });
      results.push({ ...base, outcome: sent === "sent" ? "sent" : "failed", detail: sent === "sent" ? "Reminder emailed" : "The email could not be sent" });
    } catch {
      results.push({ ...base, outcome: "failed", detail: "Something went wrong for this booking" });
    }
    // Stay under the email provider's two-per-second limit.
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  // A ticked booking that was paid or withdrawn since the page loaded.
  for (const id of chosen) {
    if (!rows.some(row => row.id === id)) results.push({ reservationId: id, business: "", totalCents: 0, outcome: "skipped", detail: "No longer waiting on payment" });
  }
  return NextResponse.json({ sent: results.filter(r => r.outcome === "sent").length, results }, { headers });
}
