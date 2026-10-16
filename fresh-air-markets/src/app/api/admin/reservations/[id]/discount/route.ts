import { NextRequest, NextResponse } from "next/server";
import { adminGate } from "@/lib/admin-gate";
import { readInquiryBody } from "@/lib/inquiry-body";
import { validSquareReservationId } from "@/lib/square-payment";
import { addDiscount } from "@/lib/vendor-balance-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Staff discount an unpaid booking by an amount or a percent, with a reason kept on record. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await adminGate(request);
  if ("error" in gated) return gated.error;
  const { id } = await params;
  if (!validSquareReservationId(id)) return NextResponse.json({ error: "Invalid reservation ID." }, { status: 400, headers });
  const decoded = await readInquiryBody(request);
  if ("status" in decoded) return NextResponse.json({ error: decoded.error }, { status: decoded.status, headers });
  const body = decoded.body;
  try {
    const result = await addDiscount({ marketId: gated.marketId, reservationId: id, amountCents: body.amountCents, percent: body.percent, reason: body.reason, actorAccountId: gated.marketId });
    if (result.kind === "invalid") return NextResponse.json({ error: result.error }, { status: 400, headers });
    if (result.kind === "not_found") return NextResponse.json({ error: "Reservation not found." }, { status: 404, headers });
    if (result.kind === "not_adjustable") return NextResponse.json({ error: result.reason }, { status: 409, headers });
    return NextResponse.json({ adjustmentId: result.adjustmentId, amountCents: result.amountCents }, { status: 201, headers });
  } catch { return NextResponse.json({ error: "The discount could not be saved right now." }, { status: 503, headers }); }
}
