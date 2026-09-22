import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { readInquiryBody } from "@/lib/inquiry-body";
import { notifyBookingWithdrawn } from "@/lib/notifications";
import { withdrawReservation } from "@/lib/reservation-withdraw-pg";
import { squareLinkCanceller } from "@/lib/square-link-cancel";
import { validSquareReservationId } from "@/lib/square-payment";
import { squarePortalOrigin } from "@/lib/square";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/**
 * Manager withdraws an unpaid booking at the vendor's request. The Square
 * link is cancelled, the dates are released and the vendor is emailed.
 * Paid bookings cannot be withdrawn here; refunds happen in Square.
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
  if (process.env.FAME_MARKET_ACCOUNT_ID?.trim() !== marketId) return NextResponse.json({ error: "Reservations are not configured for this market." }, { status: 503, headers });
  const { id } = await params;
  if (!validSquareReservationId(id)) return NextResponse.json({ error: "Invalid reservation ID." }, { status: 400, headers });
  const decoded = await readInquiryBody(request);
  if ("status" in decoded) return NextResponse.json({ error: decoded.error }, { status: decoded.status, headers });
  const note = typeof decoded.body.note === "string" ? decoded.body.note.trim() : "";
  if (!note || note.length > 500) return NextResponse.json({ error: "Add a short note saying why the booking is being withdrawn (up to 500 characters)." }, { status: 400, headers });

  // Square is optional only when there is no live link to cancel; the
  // withdraw transaction refuses to proceed without it otherwise.
  const cancelLink = squareLinkCanceller(process.env);

  let result;
  try { result = await withdrawReservation({ marketId, reservationId: id, note, cancelLink }); }
  catch { return NextResponse.json({ error: "The booking could not be withdrawn right now." }, { status: 503, headers }); }
  if (result.kind === "not_found") return NextResponse.json({ error: "Reservation not found." }, { status: 404, headers });
  if (result.kind === "not_withdrawable") {
    return NextResponse.json({ error: result.state === "paid" || result.state === "confirmed"
      ? "This booking is paid. Refund it in Square first; the dates stay reserved until then."
      : result.state === "manual_review"
        ? "This booking needs a manager's look first (a payment may have arrived that could not be matched). Check it in Square, then reopen or refund it."
        : `This booking is already ${result.state.replace("_", " ")}.` }, { status: 409, headers });
  }
  if (result.kind === "link_closing") return NextResponse.json({ error: "The payment window on this booking is closing right now. Try again in a few minutes. If this keeps happening, the payment request needs a manager's look in Square." }, { status: 409, headers });
  if (result.kind === "checkout_in_progress") return NextResponse.json({ error: "A payment request is being created for this booking right now. Try again in a minute." }, { status: 409, headers });
  if (result.kind === "cancellation_unproven") return NextResponse.json({ error: `Square could not confirm that this payment link was cancelled; the vendor may already have paid. Check order ${result.squareOrderId} in Square before trying again. Nothing was changed.` }, { status: 409, headers });
  if (result.kind === "square_unavailable") return NextResponse.json({ error: "Square did not confirm that the payment link was cancelled. Nothing was changed; try again." }, { status: 503, headers });
  const vendorNotification = await notifyBookingWithdrawn({ reservationId: id, marketId, note });
  return NextResponse.json({ reservation: { id: result.reservationId, state: "cancelled" }, linksCancelled: result.linksCancelled, vendorNotification }, { status: 200, headers });
}
