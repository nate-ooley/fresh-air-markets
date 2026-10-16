import { NextRequest, NextResponse } from "next/server";
import { adminGate } from "@/lib/admin-gate";
import { readInquiryBody } from "@/lib/inquiry-body";
import { retireCheckoutLinks } from "@/lib/reservation-withdraw-pg";
import { squareLinkCanceller } from "@/lib/square-link-cancel";
import { validSquareReservationId } from "@/lib/square-payment";
import { bookingBalanceDue, recordManualPayment } from "@/lib/vendor-balance-pg";
import { marketToday } from "@/lib/vendor-booking-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const headers = { "Cache-Control": "no-store" };

/**
 * Staff record a payment they took in Square directly (phone app or
 * computer), so the booking, the vendor's balance and reminders reflect it.
 * When the payment settles the booking, its portal payment link is
 * cancelled first (with Square's proof) so the vendor can't pay twice.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await adminGate(request);
  if ("error" in gated) return gated.error;
  const { marketId } = gated;
  const { id } = await params;
  if (!validSquareReservationId(id)) return NextResponse.json({ error: "Invalid reservation ID." }, { status: 400, headers });
  const decoded = await readInquiryBody(request);
  if ("status" in decoded) return NextResponse.json({ error: decoded.error }, { status: decoded.status, headers });
  const body = decoded.body;

  let owed;
  try { owed = await bookingBalanceDue(marketId, id); }
  catch { return NextResponse.json({ error: "Payments can't be recorded right now." }, { status: 503, headers }); }
  if (!owed) return NextResponse.json({ error: "Reservation not found." }, { status: 404, headers });
  const amount = Number(body.amountCents);
  // Check the simple things before touching Square.
  const paidOn = typeof body.paidOn === "string" ? body.paidOn : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || paidOn > marketToday()) return NextResponse.json({ error: "Enter the date the vendor paid (today or earlier)." }, { status: 400, headers });
  if (!Number.isSafeInteger(amount) || amount < 1) return NextResponse.json({ error: "Enter the amount the vendor paid." }, { status: 400, headers });
  if (amount > owed.balanceCents) return NextResponse.json({ error: `That's more than the ${(owed.balanceCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} still owed on this booking.` }, { status: 400, headers });
  if (Number.isSafeInteger(amount) && amount > 0 && amount >= owed.balanceCents && (owed.state === "held" || owed.state === "payment_pending")) {
    let retired;
    try { retired = await retireCheckoutLinks({ marketId, reservationId: id, cancelLink: squareLinkCanceller(process.env) }); }
    catch { retired = { kind: "square_unavailable" as const }; }
    if (retired.kind === "cancellation_unproven") return NextResponse.json({ error: `Square could not confirm this booking's online payment link was cancelled; the vendor may also have paid online. Check order ${retired.squareOrderId} in Square before recording this payment. Nothing was saved.` }, { status: 409, headers });
    if (retired.kind === "square_unavailable" || retired.kind === "link_closing" || retired.kind === "checkout_in_progress") return NextResponse.json({ error: "Square didn't confirm the booking's online payment link was cancelled. Nothing was saved; try again in a minute." }, { status: 503, headers });
  }
  try {
    const result = await recordManualPayment({ marketId, reservationId: id, amountCents: body.amountCents, paidOn: body.paidOn, note: body.note, today: marketToday(), actorAccountId: marketId });
    if (result.kind === "invalid") return NextResponse.json({ error: result.error }, { status: 400, headers });
    if (result.kind === "not_found") return NextResponse.json({ error: "Reservation not found." }, { status: 404, headers });
    if (result.kind === "not_allowed") return NextResponse.json({ error: result.reason }, { status: 409, headers });
    return NextResponse.json({ paymentId: result.paymentId, amountCents: result.amountCents, bookingPaid: result.bookingPaid }, { status: 201, headers });
  } catch { return NextResponse.json({ error: "The payment could not be saved right now. Nothing was saved; try again." }, { status: 503, headers }); }
}
