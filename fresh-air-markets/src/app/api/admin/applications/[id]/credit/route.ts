import { NextRequest, NextResponse } from "next/server";
import { adminGate } from "@/lib/admin-gate";
import { validFinalReservationApplicationId } from "@/lib/final-reservation";
import { readInquiryBody } from "@/lib/inquiry-body";
import { addCredit } from "@/lib/vendor-balance-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Staff add a credit to the vendor's balance (e.g. a rain-out); it's used later on an unpaid booking. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await adminGate(request);
  if ("error" in gated) return gated.error;
  const { id } = await params;
  if (!validFinalReservationApplicationId(id)) return NextResponse.json({ error: "Invalid application ID." }, { status: 400, headers });
  const decoded = await readInquiryBody(request);
  if ("status" in decoded) return NextResponse.json({ error: decoded.error }, { status: decoded.status, headers });
  try {
    const result = await addCredit({ marketId: gated.marketId, applicationId: id, amountCents: decoded.body.amountCents, reason: decoded.body.reason, actorAccountId: gated.marketId });
    if (result.kind === "invalid") return NextResponse.json({ error: result.error }, { status: 400, headers });
    if (result.kind === "not_found") return NextResponse.json({ error: "Application not found." }, { status: 404, headers });
    if (result.kind === "not_adjustable") return NextResponse.json({ error: result.reason }, { status: 409, headers });
    return NextResponse.json({ adjustmentId: result.adjustmentId, amountCents: result.amountCents }, { status: 201, headers });
  } catch { return NextResponse.json({ error: "The credit could not be saved right now." }, { status: 503, headers }); }
}
