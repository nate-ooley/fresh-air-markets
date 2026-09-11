import { NextRequest, NextResponse } from "next/server";
import { verifyApplicationPrefillToken } from "@/lib/application-prefill";
import { consumeInquiryLimit, inquiryClient } from "@/lib/inquiry-rate-limit";
import { readPortalConfig } from "@/lib/portal-intake";
import { readObjectBody } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Turns a pre-filled application link's token back into form values. */
export async function POST(request: NextRequest) {
  const config = readPortalConfig();
  if (!config) return NextResponse.json({ error: "Applications are not open yet." }, { status: 503, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  try {
    const decision = await consumeInquiryLimit("ip", inquiryClient(request.headers));
    if (!decision.allowed) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { ...headers, "Retry-After": String(decision.retryAfterSeconds) } });
  } catch { return NextResponse.json({ error: "Applications are temporarily unavailable." }, { status: 503, headers }); }
  const body = await readObjectBody(request);
  const prefill = body ? verifyApplicationPrefillToken(body.token) : null;
  if (!prefill || prefill.marketId !== config.marketId) return NextResponse.json({ error: "This link has expired. You can still fill in the form below." }, { status: 410, headers });
  const { marketId: _market, invitedFrom: _from, ...fields } = prefill;
  return NextResponse.json({ prefill: fields }, { headers });
}
