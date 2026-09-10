import { NextRequest, NextResponse } from "next/server";
import { hashVendorAccessToken, validVendorAccessToken, vendorPaymentAccessConfig, VENDOR_PAYMENT_COOKIE } from "@/lib/vendor-payment-access";
import { postgresVendorPaymentAccessStore } from "@/lib/vendor-payment-access-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

export async function GET(request: NextRequest) {
  const token = request.cookies.get(VENDOR_PAYMENT_COOKIE)?.value;
  if (!validVendorAccessToken(token)) return NextResponse.json({ error: "Vendor access is required." }, { status: 401, headers });
  let config;
  try {
    config = vendorPaymentAccessConfig(process.env);
    if (!process.env.DATABASE_URL) throw new Error("Storage required");
  } catch { return NextResponse.json({ error: "Vendor payment access is unavailable." }, { status: 503, headers }); }
  try {
    const reservation = await postgresVendorPaymentAccessStore.read({ config, sessionHash: hashVendorAccessToken(token), now: new Date() });
    if (!reservation) return NextResponse.json({ error: "Your vendor access has expired. Request a new link from the market manager." }, { status: 401, headers });
    return NextResponse.json({ reservation }, { headers });
  } catch { return NextResponse.json({ error: "Vendor payment details are unavailable." }, { status: 503, headers }); }
}
