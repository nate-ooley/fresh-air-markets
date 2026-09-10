import { NextRequest, NextResponse } from "next/server";
import {
  exchangeVendorPaymentInvitation, readVendorAccessBody, sameOriginVendorPost,
  vendorCookieOptions, vendorPaymentAccessConfig, VENDOR_PAYMENT_COOKIE,
} from "@/lib/vendor-payment-access";
import { postgresVendorPaymentAccessStore } from "@/lib/vendor-payment-access-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

export async function POST(request: NextRequest) {
  let config;
  try {
    config = vendorPaymentAccessConfig(process.env);
    if (!process.env.DATABASE_URL) throw new Error("Storage required");
  } catch { return NextResponse.json({ error: "Vendor payment access is unavailable." }, { status: 503, headers }); }
  if (!sameOriginVendorPost(request, config.portalOrigin)) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  const body = await readVendorAccessBody(request);
  if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, "token")) {
    return NextResponse.json({ error: "An invitation token is required." }, { status: 400, headers });
  }
  try {
    const result = await exchangeVendorPaymentInvitation({ token: body.token, config, store: postgresVendorPaymentAccessStore });
    if (result.kind !== "exchanged") return NextResponse.json({ error: "This invitation is invalid, expired, or already used. Request a new link from the market manager." }, { status: 401, headers });
    const response = NextResponse.json({ ok: true, expiresAt: result.expiresAt }, { headers });
    response.cookies.set(VENDOR_PAYMENT_COOKIE, result.sessionToken, vendorCookieOptions(new Date(result.expiresAt)));
    return response;
  } catch { return NextResponse.json({ error: "Vendor payment access is unavailable." }, { status: 503, headers }); }
}
