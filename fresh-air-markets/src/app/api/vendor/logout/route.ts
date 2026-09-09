import { NextRequest, NextResponse } from "next/server";
import {
  hashVendorAccessToken, sameOriginVendorPost, validVendorAccessToken,
  vendorCookieOptions, vendorPaymentAccessConfig, VENDOR_PAYMENT_COOKIE,
} from "@/lib/vendor-payment-access";
import { postgresVendorPaymentAccessStore } from "@/lib/vendor-payment-access-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

export async function POST(request: NextRequest) {
  let config;
  try { config = vendorPaymentAccessConfig(process.env); }
  catch { return NextResponse.json({ error: "Vendor payment access is unavailable." }, { status: 503, headers }); }
  if (!sameOriginVendorPost(request, config.portalOrigin)) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  const token = request.cookies.get(VENDOR_PAYMENT_COOKIE)?.value;
  try {
    if (validVendorAccessToken(token)) await postgresVendorPaymentAccessStore.revoke({ config, sessionHash: hashVendorAccessToken(token), now: new Date() });
    const response = NextResponse.json({ ok: true }, { headers });
    response.cookies.set(VENDOR_PAYMENT_COOKIE, "", { ...vendorCookieOptions(), maxAge: 0 });
    return response;
  } catch { return NextResponse.json({ error: "Sign out could not be confirmed. Please try again." }, { status: 503, headers }); }
}
