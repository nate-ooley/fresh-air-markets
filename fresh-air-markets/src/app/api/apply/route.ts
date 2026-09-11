import { NextRequest, NextResponse } from "next/server";
import { readObjectBody } from "@/lib/request-body";
import { consumeInquiryLimit, inquiryClient } from "@/lib/inquiry-rate-limit";
import { readPortalConfig, submitPortalApplication, validatePortalApplication } from "@/lib/portal-intake";
import { notifyApplicationReceived } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

async function limited(kind: "ip" | "email", subject: string): Promise<NextResponse | null> {
  try {
    const decision = await consumeInquiryLimit(kind, subject);
    if (decision.allowed) return null;
    return NextResponse.json({ error: "Too many submissions. Please wait a few minutes and try again." },
      { status: 429, headers: { ...headers, "Retry-After": String(decision.retryAfterSeconds) } });
  } catch {
    return NextResponse.json({ error: "Applications are temporarily unavailable. Please try again shortly." }, { status: 503, headers });
  }
}

/** Public vendor / non-profit application. Writes only to this app's database. */
export async function POST(request: NextRequest) {
  const config = readPortalConfig();
  if (!config) return NextResponse.json({ error: "Applications are not open yet. Please check back soon." }, { status: 503, headers });
  const ip = inquiryClient(request.headers);
  const ipLimit = await limited("ip", ip);
  if (ipLimit) return ipLimit;
  const body = await readObjectBody(request);
  if (!body) return NextResponse.json({ error: "A JSON object body is required." }, { status: 400, headers });
  // Honeypot: real browsers leave it empty.
  if (typeof body.website === "string" && body.website.trim()) return NextResponse.json({ ok: true, status: "captured" }, { status: 201, headers });
  const validation = validatePortalApplication(body);
  if (!validation.ok) return NextResponse.json({ error: validation.errors.join(" "), errors: validation.errors }, { status: 400, headers });
  const emailLimit = await limited("email", JSON.stringify([config.marketId, validation.input.email]));
  if (emailLimit) return emailLimit;
  try {
    const result = await submitPortalApplication(validation.input, config, { clientIp: ip, userAgent: request.headers.get("user-agent") ?? "" });
    let notified: "sent" | "failed" | "not_sent" = "not_sent";
    if (result.status === "captured") {
      const { input } = validation;
      notified = await notifyApplicationReceived({
        applicationId: result.applicationId, marketId: config.marketId, email: input.email,
        name: `${input.firstName} ${input.lastName}`.trim(), businessName: input.businessName, type: input.registrationType,
      });
    }
    return NextResponse.json({ ok: true, status: result.status, emailed: notified === "sent" }, { status: result.status === "captured" ? 201 : 200, headers });
  } catch {
    return NextResponse.json({ error: "Your application could not be saved. Please try again." }, { status: 503, headers });
  }
}
