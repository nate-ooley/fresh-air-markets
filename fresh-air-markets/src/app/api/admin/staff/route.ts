import { NextRequest, NextResponse } from "next/server";
import { getSessionStaff } from "@/lib/auth";
import { emailConfigured } from "@/lib/email";
import { notifyStaffInvitation, portalOrigin } from "@/lib/notifications";
import { readObjectBody } from "@/lib/request-body";
import { DEMO_MARKET_ID } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { INVITATION_TTL_DAYS, inviteStaff, listStaff } from "@/lib/staff-users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** Staff directory. Everyone signed in can read it; only owners invite. */
export async function GET() {
  const session = await getSessionStaff();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (!process.env.DATABASE_URL || session.marketId === DEMO_MARKET_ID) return NextResponse.json({ error: "Staff accounts need a private market with a database." }, { status: 403, headers });
  try {
    return NextResponse.json({ staff: await listStaff(session.marketId), me: { userId: session.userId, role: session.role } }, { headers });
  } catch {
    return NextResponse.json({ error: "Staff accounts are unavailable right now." }, { status: 503, headers });
  }
}

export async function POST(request: NextRequest) {
  const session = await getSessionStaff();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (session.role !== "owner") return NextResponse.json({ error: "Only the market owner can invite staff." }, { status: 403, headers });
  if (!process.env.DATABASE_URL || session.marketId === DEMO_MARKET_ID) return NextResponse.json({ error: "Staff accounts need a private market with a database." }, { status: 403, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  const body = await readObjectBody(request);
  if (!body) return NextResponse.json({ error: "A JSON object body is required." }, { status: 400, headers });
  let result;
  try {
    result = await inviteStaff({ marketId: session.marketId, email: body.email, name: body.name, invitedBy: session.userId });
  } catch {
    return NextResponse.json({ error: "Staff accounts are unavailable right now." }, { status: 503, headers });
  }
  if (result.kind === "invalid") return NextResponse.json({ error: result.reason }, { status: 400, headers });
  if (result.kind === "exists") return NextResponse.json({ error: `${result.user.email} already has access.` }, { status: 409, headers });
  const link = new URL(`/accept-invite#token=${result.token}`, portalOrigin()).toString();
  let invitation: "sent" | "failed" | "not_sent" = "not_sent";
  if (emailConfigured()) {
    let marketName = "the market";
    try { marketName = (await (await getStore()).getAccountById(session.marketId))?.marketName || marketName; } catch { /* keep default */ }
    invitation = await notifyStaffInvitation({ marketId: session.marketId, email: result.user.email, name: result.user.name, marketName, link, days: INVITATION_TTL_DAYS });
  }
  // When the email could not go out, hand the owner the link to forward themselves.
  return NextResponse.json({ staff: result.user, invitation, expiresAt: result.expiresAt, ...(invitation === "sent" ? {} : { inviteUrl: link }) }, { status: 201, headers });
}
