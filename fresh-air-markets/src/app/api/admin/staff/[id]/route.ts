import { NextRequest, NextResponse } from "next/server";
import { getSessionStaff } from "@/lib/auth";
import { removeStaff } from "@/lib/staff-users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Owner ends a manager's access. Their session stops working on the next request. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionStaff();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (session.role !== "owner") return NextResponse.json({ error: "Only the market owner can remove staff." }, { status: 403, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "Staff accounts need a database." }, { status: 403, headers });
  const { id } = await params;
  if (!ID.test(id)) return NextResponse.json({ error: "Invalid staff id." }, { status: 400, headers });
  let result;
  try { result = await removeStaff({ marketId: session.marketId, userId: id, actorUserId: session.userId }); }
  catch { return NextResponse.json({ error: "Staff accounts are unavailable right now." }, { status: 503, headers }); }
  if (result.kind === "not_found") return NextResponse.json({ error: "Staff member not found." }, { status: 404, headers });
  if (result.kind === "refused") return NextResponse.json({ error: result.reason }, { status: 409, headers });
  return NextResponse.json({ staff: result.user }, { headers });
}
