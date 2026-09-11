import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { validSquareReservationId } from "@/lib/square-payment";
import { issueVendorPaymentInvitation, readVendorAccessBody, sameOriginVendorPost, vendorPaymentAccessConfig } from "@/lib/vendor-payment-access";
import { postgresVendorPaymentAccessStore } from "@/lib/vendor-payment-access-pg";
import { notifyPaymentRequest } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actorAccountId = await getSessionAccountId();
  if (!actorAccountId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  let config;
  try {
    config = vendorPaymentAccessConfig(process.env);
    if (!process.env.DATABASE_URL) throw new Error("Storage required");
  } catch { return NextResponse.json({ error: "Vendor payment access is unavailable." }, { status: 503, headers }); }
  if (actorAccountId !== config.marketId || !sameOriginVendorPost(request, config.portalOrigin)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  }
  const { id } = await context.params;
  const body = await readVendorAccessBody(request);
  if (!validSquareReservationId(id) || !body || Object.keys(body).length) {
    return NextResponse.json({ error: "A reservation and empty JSON object are required." }, { status: 400, headers });
  }
  try {
    const result = await issueVendorPaymentInvitation({ config, reservationId: id, actorAccountId, store: postgresVendorPaymentAccessStore });
    if (result.kind === "issued") {
      const vendorNotification = await notifyPaymentRequest({ reservationId: id, marketId: config.marketId, invitationUrl: result.invitationUrl, expiresAt: result.expiresAt });
      return NextResponse.json({ invitationToken: result.invitationToken, invitationUrl: result.invitationUrl, expiresAt: result.expiresAt, vendorNotification }, { status: 201, headers });
    }
    if (result.kind === "not_found") return NextResponse.json({ error: "Reservation not found." }, { status: 404, headers });
    if (result.kind === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
    return NextResponse.json({ error: "A finalized reservation and ready payment request or confirmation are required." }, { status: 409, headers });
  } catch { return NextResponse.json({ error: "Vendor payment access is unavailable." }, { status: 503, headers }); }
}
