import { NextRequest, NextResponse } from "next/server";
import { verifyApplicationLinkToken } from "@/lib/application-upload-token";
import { freshAirFinalReservationConfig } from "@/lib/final-reservation-pg";
import { consumeInquiryLimit, inquiryClient } from "@/lib/inquiry-rate-limit";
import { notifyBookingRequest } from "@/lib/notifications";
import { readObjectBody } from "@/lib/request-body";
import { createBookingRequest, marketToday, vendorBookingOverview } from "@/lib/vendor-booking-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const EXPIRED = "This link has expired or is not valid. Reply to one of our emails or call us and we'll send a fresh one.";

/**
 * "Book more dates" for one vendor, allowed only with the signed link from
 * their payment emails. The token grants no session and never exposes
 * documents, payment or other vendors; it reads this vendor's own bookings
 * and which Saturdays still have room for them.
 */
function grantFor(token: unknown, marketId: string) {
  const grant = verifyApplicationLinkToken("booking", token);
  return grant && grant.marketId === marketId ? grant : null;
}

function configOrNull() {
  try {
    const config = freshAirFinalReservationConfig(process.env);
    return process.env.DATABASE_URL ? config : null;
  } catch { return null; }
}

/**
 * Both reads and requests are POSTs with the token in the body: a 120-day
 * bearer token must never sit in a query string where request logs keep it.
 */
export async function POST(request: NextRequest) {
  const config = configOrNull();
  if (!config) return NextResponse.json({ error: "Booking is not available right now." }, { status: 503, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  try {
    const decision = await consumeInquiryLimit("ip", inquiryClient(request.headers));
    if (!decision.allowed) return NextResponse.json({ error: "Too many requests. Please wait a few minutes." }, { status: 429, headers: { ...headers, "Retry-After": String(decision.retryAfterSeconds) } });
  } catch { return NextResponse.json({ error: "Booking is not available right now." }, { status: 503, headers }); }
  const body = await readObjectBody(request);
  if (!body) return NextResponse.json({ error: "A JSON object body is required." }, { status: 400, headers });
  const grant = grantFor(body.token, config.marketId);
  if (!grant) return NextResponse.json({ error: EXPIRED }, { status: 401, headers });
  if (body.view === true) {
    try {
      const overview = await vendorBookingOverview({ marketId: config.marketId, applicationId: grant.applicationId, config, today: marketToday() });
      if (!overview) return NextResponse.json({ error: EXPIRED }, { status: 401, headers });
      // The vendor sees their own name, bookings and calendar; never internal IDs beyond the request.
      const { applicationId: _omit, email: _email, ...visible } = overview;
      return NextResponse.json(visible, { headers });
    } catch {
      return NextResponse.json({ error: "Booking is not available right now. Try again in a few minutes." }, { status: 503, headers });
    }
  }
  let result;
  try {
    result = await createBookingRequest({ marketId: config.marketId, applicationId: grant.applicationId, dates: body.dates, booths: body.booths, note: body.note, config, today: marketToday() });
  } catch { return NextResponse.json({ error: "Your request could not be saved. Try again in a few minutes." }, { status: 503, headers }); }
  if (result.kind === "not_found") return NextResponse.json({ error: EXPIRED }, { status: 401, headers });
  if (result.kind === "not_eligible") return NextResponse.json({ error: "Your application isn't ready for more dates yet. Reply to one of our emails and we'll sort it out.", reasons: result.reasons }, { status: 409, headers });
  if (result.kind === "already_pending") return NextResponse.json({ error: "You already have a date request waiting for market staff. We'll email you when it's confirmed.", request: result.request }, { status: 409, headers });
  if (result.kind === "invalid") return NextResponse.json({ error: result.problems.join(" "), problems: result.problems }, { status: 400, headers });
  const vendorNotification = await notifyBookingRequest({ applicationId: grant.applicationId, marketId: config.marketId, requestId: result.request.id, dates: result.request.dates, booths: result.request.booths, note: result.request.vendorNote });
  return NextResponse.json({ request: result.request, vendorNotification }, { status: 201, headers });
}
