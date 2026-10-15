import { NextRequest, NextResponse } from "next/server";
import { adminGate } from "@/lib/admin-gate";
import { validFinalReservationApplicationId } from "@/lib/final-reservation";
import { listInvoicesForApplication } from "@/lib/vendor-invoice-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** Square invoices for every booking of one vendor, newest first. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await adminGate(request);
  if ("error" in gated) return gated.error;
  const { id } = await params;
  if (!validFinalReservationApplicationId(id)) return NextResponse.json({ error: "Invalid application ID." }, { status: 400, headers });
  try { return NextResponse.json({ invoices: await listInvoicesForApplication(gated.marketId, id) }, { headers }); }
  catch { return NextResponse.json({ error: "Billing is unavailable right now." }, { status: 503, headers }); }
}
