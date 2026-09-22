import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { notifyBookingRequestDeclined } from "@/lib/notifications";
import { readInquiryBody } from "@/lib/inquiry-body";
import { squarePortalOrigin } from "@/lib/square";
import { getBookingRequest, settleBookingRequest } from "@/lib/vendor-booking-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Staff decline a vendor's date request with a note that is emailed to them. */
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
  if (!process.env.DATABASE_URL || process.env.FAME_MARKET_ACCOUNT_ID?.trim() !== marketId) return NextResponse.json({ error: "Booking requests are not configured for this market." }, { status: 503, headers });
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid request ID." }, { status: 400, headers });
  const decoded = await readInquiryBody(request);
  if ("status" in decoded) return NextResponse.json({ error: decoded.error }, { status: decoded.status, headers });
  const note = typeof decoded.body.note === "string" ? decoded.body.note.trim() : "";
  if (!note || note.length > 1000) return NextResponse.json({ error: "Add a short note for the vendor saying why (up to 1,000 characters)." }, { status: 400, headers });
  try {
    const result = await settleBookingRequest({ marketId, requestId: id, status: "declined", staffNote: note, actorAccountId: marketId });
    if (result.kind === "not_found") return NextResponse.json({ error: "Request not found." }, { status: 404, headers });
    if (result.kind === "not_pending") return NextResponse.json({ error: `This request was already ${result.status}.` }, { status: 409, headers });
    const vendorNotification = await notifyBookingRequestDeclined({ applicationId: result.request.applicationId, marketId, requestId: id, dates: result.request.dates, note });
    return NextResponse.json({ request: result.request, vendorNotification }, { headers });
  } catch {
    const existing = await getBookingRequest(marketId, id).catch(() => null);
    return NextResponse.json({ error: existing ? "The request could not be declined right now." : "Booking requests are unavailable." }, { status: 503, headers });
  }
}
