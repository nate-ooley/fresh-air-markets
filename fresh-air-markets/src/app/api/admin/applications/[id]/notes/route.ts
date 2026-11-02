import { NextRequest, NextResponse } from "next/server";
import { adminGate } from "@/lib/admin-gate";
import { getSessionStaff } from "@/lib/auth";
import { validFinalReservationApplicationId } from "@/lib/final-reservation";
import { readInquiryBody } from "@/lib/inquiry-body";
import { addVendorNote, listVendorNotes, staffDisplayName } from "@/lib/vendor-notes-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** Private manager notes on a vendor, newest first. Available at every stage. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await adminGate(request);
  if ("error" in gated) return gated.error;
  const { id } = await params;
  if (!validFinalReservationApplicationId(id)) return NextResponse.json({ error: "Invalid application ID." }, { status: 400, headers });
  try { return NextResponse.json({ notes: await listVendorNotes(gated.marketId, id) }, { headers }); }
  catch { return NextResponse.json({ error: "Notes are unavailable right now." }, { status: 503, headers }); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await adminGate(request);
  if ("error" in gated) return gated.error;
  const { id } = await params;
  if (!validFinalReservationApplicationId(id)) return NextResponse.json({ error: "Invalid application ID." }, { status: 400, headers });
  const decoded = await readInquiryBody(request);
  if ("status" in decoded) return NextResponse.json({ error: decoded.error }, { status: decoded.status, headers });
  try {
    const staff = await getSessionStaff();
    const authorName = await staffDisplayName(gated.marketId, staff?.userId ?? null);
    const result = await addVendorNote({ marketId: gated.marketId, applicationId: id, body: decoded.body.body, authorName, actorAccountId: gated.marketId });
    if (result.kind === "invalid") return NextResponse.json({ error: result.error }, { status: 400, headers });
    if (result.kind === "not_found") return NextResponse.json({ error: "Application not found." }, { status: 404, headers });
    return NextResponse.json({ note: result.note }, { status: 201, headers });
  } catch { return NextResponse.json({ error: "The note could not be saved. Try again." }, { status: 503, headers }); }
}
