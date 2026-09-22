import { NextRequest, NextResponse } from "next/server";
import { validApplicationId } from "@/lib/application-review";
import { getSessionAccountId } from "@/lib/auth";
import { readInquiryBody } from "@/lib/inquiry-body";
import { notifyApplicationWithdrawn } from "@/lib/notifications";
import { applicationBookingSummary, withdrawApplication, withdrawReservation } from "@/lib/reservation-withdraw-pg";
import { squareLinkCanceller } from "@/lib/square-link-cancel";
import { squarePortalOrigin } from "@/lib/square";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/**
 * Manager withdraws a vendor's application for the season at their request.
 * Unpaid bookings are withdrawn first (Square links cancelled, dates
 * released); a paid booking blocks this until it is refunded in Square.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let expected;
    try { expected = squarePortalOrigin(process.env); } catch { return NextResponse.json({ error: "Applications are not configured." }, { status: 503, headers }); }
    if (origin !== expected) return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  }
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "Application storage is not configured." }, { status: 503, headers });
  if (process.env.FAME_MARKET_ACCOUNT_ID?.trim() !== marketId) return NextResponse.json({ error: "Applications are not configured for this market." }, { status: 503, headers });
  const { id } = await params;
  if (!validApplicationId(id)) return NextResponse.json({ error: "Invalid application ID." }, { status: 400, headers });
  const decoded = await readInquiryBody(request);
  if ("status" in decoded) return NextResponse.json({ error: decoded.error }, { status: decoded.status, headers });
  const note = typeof decoded.body.note === "string" ? decoded.body.note.trim() : "";
  if (!note || note.length > 500) return NextResponse.json({ error: "Add a short note saying why the application is being withdrawn (up to 500 characters)." }, { status: 400, headers });

  const cancelLink = squareLinkCanceller(process.env);
  const BLOCKED = "This vendor has a booking that is paid or waiting on a manager's look in Square. Settle that booking first; until then the application stays active.";

  try {
    const bookings = await applicationBookingSummary(marketId, id);
    if (bookings.blocking > 0) return NextResponse.json({ error: BLOCKED }, { status: 409, headers });
    for (const reservationId of bookings.unpaid) {
      const result = await withdrawReservation({ marketId, reservationId, note, cancelLink });
      if (result.kind === "link_closing") return NextResponse.json({ error: "A payment window on this vendor's booking is closing right now. Try again in a few minutes." }, { status: 409, headers });
      if (result.kind === "checkout_in_progress") return NextResponse.json({ error: "A payment request is being created for this vendor right now. Try again in a minute." }, { status: 409, headers });
      if (result.kind === "cancellation_unproven") return NextResponse.json({ error: `Square could not confirm that a payment link was cancelled; the vendor may already have paid. Check order ${result.squareOrderId} in Square before trying again. Nothing was changed.` }, { status: 409, headers });
      if (result.kind === "square_unavailable") return NextResponse.json({ error: "Square did not confirm that the payment link was cancelled. Nothing was changed; try again." }, { status: 503, headers });
      if (result.kind === "not_withdrawable" && result.state !== "cancelled" && result.state !== "declined" && result.state !== "expired") {
        return NextResponse.json({ error: BLOCKED }, { status: 409, headers });
      }
    }
    const result = await withdrawApplication({ marketId, applicationId: id, actorAccountId: marketId, note });
    if (result.kind === "not_found") return NextResponse.json({ error: "Application not found." }, { status: 404, headers });
    if (result.kind === "already_withdrawn") return NextResponse.json({ error: "This application was already withdrawn." }, { status: 409, headers });
    if (result.kind === "declined") return NextResponse.json({ error: "This application was declined; there is nothing to withdraw." }, { status: 409, headers });
    if (result.kind === "has_live_booking") return NextResponse.json({ error: "This vendor still has a live booking. Withdraw or refund it first." }, { status: 409, headers });
    const vendorNotification = await notifyApplicationWithdrawn({ applicationId: id, marketId, note });
    return NextResponse.json({ application: { id: result.applicationId, reviewState: "withdrawn" }, bookingsWithdrawn: bookings.unpaid.length, vendorNotification }, { status: 200, headers });
  } catch {
    return NextResponse.json({ error: "The application could not be withdrawn right now." }, { status: 503, headers });
  }
}
