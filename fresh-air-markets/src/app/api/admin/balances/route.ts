import { NextRequest, NextResponse } from "next/server";
import { adminGate } from "@/lib/admin-gate";
import { marketBalances } from "@/lib/vendor-balance-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** Every vendor's balance for the Roster page. */
export async function GET(request: NextRequest) {
  const gated = await adminGate(request);
  if ("error" in gated) return gated.error;
  try { return NextResponse.json({ balances: await marketBalances(gated.marketId) }, { headers }); }
  catch { return NextResponse.json({ error: "Balances are unavailable right now." }, { status: 503, headers }); }
}
