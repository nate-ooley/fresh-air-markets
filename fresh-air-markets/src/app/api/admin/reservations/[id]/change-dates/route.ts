import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { parseFinalReservationSelection } from "@/lib/final-reservation";
import { DATE_CHANGE_NOTE_PREFIX, freshAirFinalReservationConfig, planDateChange, reserveFinalApplication } from "@/lib/final-reservation-pg";
import { readInquiryBody } from "@/lib/inquiry-body";
import { notifyBookingDatesChanged } from "@/lib/notifications";
import { withdrawReservation } from "@/lib/reservation-withdraw-pg";
import { squareLinkCanceller } from "@/lib/square-link-cancel";
import { squarePaymentRuntimeConfig, squarePortalOrigin, verifySquareIdentity } from "@/lib/square";
import { dispatchSquareCheckout, validSquareReservationId } from "@/lib/square-payment";
import { postgresSquarePaymentCheckoutStore } from "@/lib/square-payment-pg";
import { marketToday } from "@/lib/vendor-booking-pg";
import { issueVendorPaymentInvitation, vendorPaymentAccessConfig } from "@/lib/vendor-payment-access";
import { postgresVendorPaymentAccessStore } from "@/lib/vendor-payment-access-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };

/** Same booking + same new dates = same key, so a retry replays instead of booking twice. */
function changeKey(purpose: string, reservationId: string, dates: string[], booths: number): string {
  const hex = createHash("sha256").update(`${purpose}:${reservationId}:${dates.join(",")}:${booths}`).digest("hex");
  const variant = ["8", "9", "a", "b"][parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const label = (dates: string[]) => dates.map(date => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })).join(", ");

/**
 * Staff move an unpaid booking to other Saturdays in one step. The new dates
 * are checked first (counting this booking's own dates as free); only then is
 * the old booking withdrawn (its Square link cancelled with proof) and the new
 * one reserved, priced, given a Square payment request and emailed to the
 * vendor as a single "your dates have changed" message.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let expected;
    try { expected = squarePortalOrigin(process.env); } catch { return NextResponse.json({ error: "Reservations are not configured." }, { status: 503, headers }); }
    if (origin !== expected) return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  }
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "Reservation storage is not configured." }, { status: 503, headers });
  let config;
  try {
    config = freshAirFinalReservationConfig(process.env);
    if (config.marketId !== marketId) throw new Error("Market configuration mismatch.");
  } catch { return NextResponse.json({ error: "Reservations are not configured for this market." }, { status: 503, headers }); }
  const { id } = await params;
  if (!validSquareReservationId(id)) return NextResponse.json({ error: "Invalid reservation ID." }, { status: 400, headers });
  const decoded = await readInquiryBody(request);
  if ("status" in decoded) return NextResponse.json({ error: decoded.error }, { status: decoded.status, headers });
  const body = decoded.body;
  const dates = body.dates;
  const booths = body.booths;
  if (!Array.isArray(dates) || !dates.length || dates.length > config.calendarDates.length || !dates.every(date => typeof date === "string")) {
    return NextResponse.json({ error: "Pick at least one Saturday." }, { status: 400, headers });
  }
  if (typeof booths !== "number" || !Number.isSafeInteger(booths) || booths < 1 || booths > 10) {
    return NextResponse.json({ error: "Booths per Saturday must be between 1 and 10." }, { status: 400, headers });
  }
  const staffNote = typeof body.note === "string" ? body.note.trim() : "";
  if (staffNote.length > 500) return NextResponse.json({ error: "Keep the note to the vendor under 500 characters." }, { status: 400, headers });
  const wanted = [...new Set(dates as string[])].sort();

  // 1. Check the new dates without touching anything.
  let plan;
  try { plan = await planDateChange({ marketId, reservationId: id, dates: wanted, booths, today: marketToday(), config }); }
  catch { return NextResponse.json({ error: "The booking could not be checked right now. Nothing was changed; try again." }, { status: 503, headers }); }
  if (plan.kind === "not_found") return NextResponse.json({ error: "Reservation not found." }, { status: 404, headers });
  if (plan.kind === "not_changeable") {
    return NextResponse.json({ error: plan.state === "paid" || plan.state === "confirmed"
      ? "This booking is paid, so its dates can't be changed here yet. Refund it in Square first, or add a new booking for extra dates."
      : plan.state === "price_adjusted"
        ? "This booking has a discount or credit on it. Undo that on the balance first, change the dates, then discount the new booking."
      : plan.state === "on_billing_plan"
        ? "This booking is being billed by a Square invoice. Cancel the invoice first, then change the dates."
      : plan.state === "manual_review"
        ? "This booking needs a manager's look in Square first (a payment may have arrived that could not be matched)."
        : `This booking is already ${plan.state.replace("_", " ")}.` }, { status: 409, headers });
  }
  if (plan.kind === "same_dates") return NextResponse.json({ error: "Those are already the booking's dates. Nothing to change." }, { status: 409, headers });
  if (plan.kind === "past_dates") return NextResponse.json({ error: `${label(plan.dates)} ${plan.dates.length === 1 ? "has" : "have"} already happened. Pick upcoming Saturdays.` }, { status: 409, headers });
  if (plan.kind === "past_dates_removed") return NextResponse.json({ error: `${label(plan.dates)} already happened and stay on this booking and its bill. Keep ${plan.dates.length === 1 ? "it" : "them"} ticked.` }, { status: 409, headers });
  if (plan.kind === "overlap") return NextResponse.json({ error: `The vendor already has ${label(plan.dates)} in another booking.` }, { status: 409, headers });
  if (plan.kind === "insurance_expires") return NextResponse.json({ error: `Their insurance certificate expires ${plan.expiresOn}; ${label(plan.dates)} can't be booked until a renewed certificate is approved.` }, { status: 409, headers });
  if (plan.kind === "unavailable") return NextResponse.json({ error: `No room left on ${label(plan.dates)}. Nothing was changed.` }, { status: 409, headers });
  if (plan.kind === "invalid_selection") return NextResponse.json({ error: "Those dates can't be booked together. Check the Saturdays and booth count." }, { status: 400, headers });

  // 2. Withdraw the old booking (Square link cancelled with proof). Skipped when a retry finds it already withdrawn by this change.
  if (!plan.resuming) {
    const note = `${DATE_CHANGE_NOTE_PREFIX} to ${label(plan.quote.dates)}.${staffNote ? ` ${staffNote}` : ""}`;
    let withdrawn;
    try { withdrawn = await withdrawReservation({ marketId, reservationId: id, note, cancelLink: squareLinkCanceller(process.env) }); }
    catch { return NextResponse.json({ error: "The old booking could not be released right now. Nothing was changed; try again." }, { status: 503, headers }); }
    if (withdrawn.kind === "link_closing" || withdrawn.kind === "checkout_in_progress") return NextResponse.json({ error: "Square is working on this booking's payment link right now. Try again in a minute. Nothing was changed." }, { status: 409, headers });
    if (withdrawn.kind === "cancellation_unproven") return NextResponse.json({ error: `Square could not confirm that the old payment link was cancelled; the vendor may already have paid. Check order ${withdrawn.squareOrderId} in Square. Nothing was changed.` }, { status: 409, headers });
    if (withdrawn.kind === "square_unavailable") return NextResponse.json({ error: "Square did not confirm that the old payment link was cancelled. Nothing was changed; try again." }, { status: 503, headers });
    if (withdrawn.kind !== "withdrawn") return NextResponse.json({ error: "The booking changed while you were editing it. Reload the page and try again." }, { status: 409, headers });
  }

  // 3. Reserve the new dates with the same type, category and license decision.
  const selectionFor = (selected: string[], count: number, fullSeason: boolean, key: string) => parseFinalReservationSelection({
    ...plan.profile, selectedDates: fullSeason ? [] : selected, fullSeason, boothsPerMarket: count,
  }, key);
  const selection = selectionFor(plan.quote.dates, plan.quote.booths, plan.quote.fullSeason, changeKey("change-dates", id, plan.quote.dates, plan.quote.booths));
  let reserved;
  try { reserved = selection ? await reserveFinalApplication({ marketId, applicationId: plan.applicationId, actorAccountId: marketId, selection, config }) : null; }
  catch { reserved = null; }
  if (!reserved || (reserved.kind !== "created" && reserved.kind !== "duplicate")) {
    // Someone took a date between the check and the write. Put the old dates back.
    const current = plan.current;
    const restore = selectionFor(current.dates, current.booths, current.fullSeason, changeKey("restore-dates", id, current.dates, current.booths));
    let restored = null;
    try { restored = restore ? await reserveFinalApplication({ marketId, applicationId: plan.applicationId, actorAccountId: marketId, selection: restore, config }) : null; }
    catch { restored = null; }
    const back = restored && (restored.kind === "created" || restored.kind === "duplicate");
    return NextResponse.json({
      error: back
        ? "Another booking took one of those Saturdays a moment ago. The vendor's original dates were put back; send them a payment link from the booking card if needed."
        : "Another booking took one of those Saturdays a moment ago, and the original dates could not be put back. Use \"Add dates\" to rebook this vendor.",
      restored: back,
    }, { status: 409, headers });
  }
  const reservation = reserved.reservation;
  const partial = (step: string, error: string, paymentOrder: unknown = null) => NextResponse.json({
    error: `${error} The new dates are booked; continue from "${step}" on the new booking card.`,
    reservation, paymentOrder, step,
  }, { status: 503, headers });
  if (!reservation.paymentRequired) return NextResponse.json({ reservation, paymentOrder: null, vendorNotification: "not_sent" }, { status: 201, headers });

  // 4. Square payment request, private link, one email.
  let square;
  try {
    const setup = squarePaymentRuntimeConfig(process.env);
    const identity = await verifySquareIdentity(setup);
    square = { environment: setup.environment, accessToken: setup.accessToken, locationId: identity.locationId, merchantId: identity.merchantId, ...(setup.checkoutRedirectUrl ? { checkoutRedirectUrl: setup.checkoutRedirectUrl } : {}) };
  } catch { return partial("Create payment request", "Square is not reachable right now."); }
  let checkout;
  try { checkout = await dispatchSquareCheckout({ marketId, reservationId: reservation.id, square, store: postgresSquarePaymentCheckoutStore }); }
  catch { return partial("Create payment request", "The Square payment request could not be created."); }
  if ((checkout.kind !== "created" && checkout.kind !== "existing") || checkout.order.status !== "checkout_created") return partial("Create payment request", "The Square payment request is still being prepared.");
  const paymentOrder = { id: checkout.order.id, checkoutUrl: checkout.order.checkoutUrl, paymentDueAt: checkout.order.paymentDueAt, status: checkout.order.status };
  let access;
  try { access = await issueVendorPaymentInvitation({ config: vendorPaymentAccessConfig(process.env), reservationId: reservation.id, actorAccountId: marketId, store: postgresVendorPaymentAccessStore }); }
  catch { return partial("Email the payment link", "The payment link could not be created.", paymentOrder); }
  if (access.kind !== "issued") return partial("Email the payment link", "The payment link could not be created.", paymentOrder);
  const vendorNotification = await notifyBookingDatesChanged({ oldReservationId: id, newReservationId: reservation.id, marketId, invitationUrl: access.invitationUrl, note: staffNote || undefined });
  return NextResponse.json({ reservation: { ...reservation, state: "payment_pending" }, paymentOrder, vendorNotification }, { status: 201, headers });
}
