import { NextRequest, NextResponse } from "next/server";
import { createApplicationPrefillToken, normalizeApplicationPrefill } from "@/lib/application-prefill";
import { getSessionStaff } from "@/lib/auth";
import { emailConfigured } from "@/lib/email";
import { notifyApplicationInvitation, portalOrigin } from "@/lib/notifications";
import { readPortalConfig } from "@/lib/portal-intake";
import { readObjectBody } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const MAX_VENDORS = 50;

/**
 * Owner sends vendors a personal link to the application form with their
 * known details filled in. Nothing is written to the database; every email
 * is logged like any other notification.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionStaff();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (session.role !== "owner") return NextResponse.json({ error: "Only the market owner can send application invitations." }, { status: 403, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  const config = readPortalConfig();
  if (!config || config.marketId !== session.marketId) return NextResponse.json({ error: "Applications are not configured for this market." }, { status: 503, headers });
  if (!emailConfigured()) return NextResponse.json({ error: "Email is not configured." }, { status: 503, headers });
  const body = await readObjectBody(request);
  const vendors = Array.isArray(body?.vendors) ? body.vendors : null;
  if (!vendors || vendors.length === 0 || vendors.length > MAX_VENDORS) return NextResponse.json({ error: `Send between 1 and ${MAX_VENDORS} vendors.` }, { status: 400, headers });
  const invitedFrom = typeof body?.invitedFrom === "string" ? body.invitedFrom : "staff";
  const results = [];
  for (const raw of vendors) {
    const prefill = raw && typeof raw === "object" ? normalizeApplicationPrefill(raw as Record<string, unknown>, config.marketId, invitedFrom) : null;
    if (!prefill) { results.push({ email: typeof (raw as { email?: unknown })?.email === "string" ? (raw as { email: string }).email : "", outcome: "invalid_email" }); continue; }
    const link = new URL(`/apply#prefill=${createApplicationPrefillToken(prefill)}`, portalOrigin()).toString();
    const outcome = await notifyApplicationInvitation({
      marketId: config.marketId, email: prefill.email, name: `${prefill.firstName} ${prefill.lastName}`.trim(), businessName: prefill.businessName,
      fullSeason: prefill.fullSeason, dates: prefill.dates, link,
    });
    results.push({ email: prefill.email, outcome });
  }
  return NextResponse.json({ results, sent: results.filter(r => r.outcome === "sent").length }, { status: 200, headers });
}
