import { NextRequest, NextResponse } from "next/server";
import { adminGate } from "@/lib/admin-gate";
import { voidAdjustment } from "@/lib/vendor-balance-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Undo a mistaken discount, credit or credit use; it stays on record as voided. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await adminGate(request);
  if ("error" in gated) return gated.error;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid adjustment ID." }, { status: 400, headers });
  try {
    const result = await voidAdjustment({ marketId: gated.marketId, adjustmentId: id });
    if (result.kind === "not_found") return NextResponse.json({ error: "That adjustment was not found or is already undone." }, { status: 404, headers });
    if (result.kind === "not_voidable") return NextResponse.json({ error: result.reason }, { status: 409, headers });
    return NextResponse.json({ voided: true }, { headers });
  } catch { return NextResponse.json({ error: "That could not be undone right now." }, { status: 503, headers }); }
}
