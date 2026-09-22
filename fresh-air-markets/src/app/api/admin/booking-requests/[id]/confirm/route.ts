import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { parseFinalReservationSelection } from "@/lib/final-reservation";
import { freshAirFinalReservationConfig, reserveFinalApplication } from "@/lib/final-reservation-pg";
import { notifyPaymentRequest } from "@/lib/notifications";
import { readInquiryBody } from "@/lib/inquiry-body";
import { squarePaymentRuntimeConfig, squarePortalOrigin, verifySquareIdentity } from "@/lib/square";
import { dispatchSquareCheckout } from "@/lib/square-payment";
import { postgresSquarePaymentCheckoutStore } from "@/lib/square-payment-pg";
import { getBookingRequest, marketToday, settleBookingRequest, vendorBookingOverview } from "@/lib/vendor-booking-pg";
import { issueVendorPaymentInvitation, vendorPaymentAccessConfig } from "@/lib/vendor-payment-access";
import { postgresVendorPaymentAccessStore } from "@/lib/vendor-payment-access-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * One request maps to one booking attempt, so a retry after a crash or a
 * double click replays the same reservation instead of writing a second one
 * (which the writer would refuse as an overlap of the vendor's own booking).
 */
function requestIdempotencyKey(requestId: string): string {
  const hex = createHash("sha256").update(`booking-request:${requestId}`).digest("hex");
  const variant = ["8", "9", "a", "b"][parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * One click for staff: turn a vendor's date request into a booking, create
 * the Square payment request and email the payment link. Each step is the
 * same code the individual buttons use; if a later step fails, the earlier
 * ones stand and the response says exactly where to continue by hand.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let expected;
    try { expected = squarePortalOrigin(process.env); } catch { return NextResponse.json({ error: "Booking requests are not configured." }, { status: 503, headers }); }
    if (origin !== expected) return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  }
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "Booking storage is not configured." }, { status: 503, headers });
  let config;
  try {
    config = freshAirFinalReservationConfig(process.env);
    if (config.marketId !== marketId) throw new Error("Market configuration mismatch.");
  } catch { return NextResponse.json({ error: "Booking requests are not configured for this market." }, { status: 503, headers }); }
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid request ID." }, { status: 400, headers });
  const decoded = await readInquiryBody(request);
  if ("status" in decoded) return NextResponse.json({ error: decoded.error }, { status: decoded.status, headers });

  let bookingRequest;
  try { bookingRequest = await getBookingRequest(marketId, id); }
  catch { return NextResponse.json({ error: "Booking requests are unavailable." }, { status: 503, headers }); }
  if (!bookingRequest) return NextResponse.json({ error: "Request not found." }, { status: 404, headers });
  if (bookingRequest.status !== "pending") return NextResponse.json({ error: `This request was already ${bookingRequest.status}.` }, { status: 409, headers });

  // Type, category and license decision come from the vendor's last booking;
  // staff may override them in the body for a vendor booking for the first time.
  let overview;
  try { overview = await vendorBookingOverview({ marketId, applicationId: bookingRequest.applicationId, config, today: marketToday() }); }
  catch { return NextResponse.json({ error: "Booking requests are unavailable." }, { status: 503, headers }); }
  if (!overview) return NextResponse.json({ error: "Application not found." }, { status: 404, headers });
  const body = decoded.body;
  // A Saturday can pass between the request and the confirmation.
  const today = marketToday();
  const passed = bookingRequest.dates.filter(date => date < today);
  if (passed.length) return NextResponse.json({ error: `${passed.join(", ")} ${passed.length === 1 ? "has" : "have"} already happened. Decline this request and ask the vendor to pick upcoming Saturdays.` }, { status: 409, headers });
  // Every Saturday of the season is the full-season rate, not 35 separate days.
  const fullSeason = config.calendarDates.every(date => bookingRequest.dates.includes(date));
  const selection = parseFinalReservationSelection({
    applicantType: typeof body.applicantType === "string" ? body.applicantType : overview.profile.applicantType,
    vendorCategory: typeof body.vendorCategory === "string" ? body.vendorCategory : overview.profile.vendorCategory,
    selectedDates: fullSeason ? [] : bookingRequest.dates,
    fullSeason,
    boothsPerMarket: bookingRequest.booths,
    foodLicenseRequired: typeof body.foodLicenseRequired === "boolean" ? body.foodLicenseRequired : overview.profile.foodLicenseRequired,
  }, requestIdempotencyKey(id));
  if (!selection) return NextResponse.json({ error: "The request could not be turned into a valid booking. Reserve the dates with the form below instead." }, { status: 400, headers });

  // 1. Reserve.
  let reserved;
  try { reserved = await reserveFinalApplication({ marketId, applicationId: bookingRequest.applicationId, actorAccountId: marketId, selection, config }); }
  catch { return NextResponse.json({ error: "The booking could not be saved right now. Nothing was changed; try again." }, { status: 503, headers }); }
  if (reserved.kind === "not_found") return NextResponse.json({ error: "Application not found." }, { status: 404, headers });
  if (reserved.kind === "not_eligible") return NextResponse.json({ error: `The application is not ready to book (${reserved.reason.replaceAll("_", " ")}). Check the approval, agreement and documents first.` }, { status: 409, headers });
  if (reserved.kind === "overlap") return NextResponse.json({ error: `The vendor already holds ${reserved.dates.join(", ")}. Decline this request and ask them to pick other dates.` }, { status: 409, headers });
  if (reserved.kind === "insurance_expires") return NextResponse.json({ error: `Their insurance certificate expires on ${reserved.expiresOn}; ${reserved.dates.join(", ")} cannot be booked until a renewed certificate is on file.` }, { status: 409, headers });
  if (reserved.kind === "unavailable") return NextResponse.json({ error: `No longer room on ${reserved.availability.filter(a => !a.available).map(a => a.date).join(", ")}. Decline this request and ask the vendor to pick other dates.` }, { status: 409, headers });
  if (reserved.kind === "invalid_selection" || reserved.kind === "conflict") return NextResponse.json({ error: "The request could not be turned into a valid booking. Reserve the dates with the form below instead." }, { status: 400, headers });
  // "duplicate" is a retry of this same request: carry on with the booking it already made.
  const reservation = reserved.reservation;
  // The request became a booking; later steps only add the payment link.
  await settleBookingRequest({ marketId, requestId: id, status: "confirmed", reservationId: reservation.id, actorAccountId: marketId }).catch(() => null);

  let paymentOrder: { id: string; checkoutUrl: string | null; paymentDueAt: string | null; status: string } | null = null;
  const partial = (step: string, error: string, status = 503) => NextResponse.json({
    error: `${error} The booking itself was saved; continue from "${step}" below.`,
    reservation: paymentOrder ? { ...reservation, state: "payment_pending" } : reservation,
    paymentOrder, step,
  }, { status, headers });

  // A nonprofit booking has nothing to pay; it is confirmed as soon as it is saved.
  if (!reservation.paymentRequired) {
    return NextResponse.json({ reservation, paymentOrder: null, vendorNotification: "not_sent" }, { status: 201, headers });
  }

  // 2. Square payment request.
  let square;
  try {
    const setup = squarePaymentRuntimeConfig(process.env);
    const identity = await verifySquareIdentity(setup);
    square = { environment: setup.environment, accessToken: setup.accessToken, locationId: identity.locationId, merchantId: identity.merchantId, ...(setup.checkoutRedirectUrl ? { checkoutRedirectUrl: setup.checkoutRedirectUrl } : {}) };
  } catch { return partial("Create payment request", "Square is not reachable right now."); }
  let checkout;
  try { checkout = await dispatchSquareCheckout({ marketId, reservationId: reservation.id, square, store: postgresSquarePaymentCheckoutStore }); }
  catch { return partial("Create payment request", "The Square payment request could not be created."); }
  if (checkout.kind !== "created" && checkout.kind !== "existing") return partial("Create payment request", "The Square payment request is still being prepared.");
  if (checkout.order.status !== "checkout_created") return partial("Create payment request", "The Square payment request needs attention.");
  paymentOrder = { id: checkout.order.id, checkoutUrl: checkout.order.checkoutUrl, paymentDueAt: checkout.order.paymentDueAt, status: checkout.order.status };

  // 3. Private link + email.
  let access;
  try { access = await issueVendorPaymentInvitation({ config: vendorPaymentAccessConfig(process.env), reservationId: reservation.id, actorAccountId: marketId, store: postgresVendorPaymentAccessStore }); }
  catch { return partial("Email the payment link", "The payment link could not be created."); }
  if (access.kind !== "issued") return partial("Email the payment link", "The payment link could not be created.");
  const vendorNotification = await notifyPaymentRequest({ reservationId: reservation.id, marketId, invitationUrl: access.invitationUrl, expiresAt: access.expiresAt });
  return NextResponse.json({
    reservation: { ...reservation, state: "payment_pending" },
    paymentOrder,
    vendorNotification,
  }, { status: 201, headers });
}
