import { NextRequest, NextResponse } from "next/server";
import { adminGate } from "@/lib/admin-gate";
import { removeVendorNote } from "@/lib/vendor-notes-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Takes a manager note off the vendor's page. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await adminGate(request);
  if ("error" in gated) return gated.error;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid note ID." }, { status: 400, headers });
  try {
    if (!await removeVendorNote({ marketId: gated.marketId, noteId: id })) return NextResponse.json({ error: "That note was not found or is already removed." }, { status: 404, headers });
    return NextResponse.json({ removed: true }, { headers });
  } catch { return NextResponse.json({ error: "The note could not be removed. Try again." }, { status: 503, headers }); }
}
