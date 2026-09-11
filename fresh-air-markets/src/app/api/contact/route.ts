import { NextRequest, NextResponse } from "next/server";
import { readObjectBody } from "@/lib/request-body";
import { consumeInquiryLimit, inquiryClient } from "@/lib/inquiry-rate-limit";
import { readPortalConfig, saveContactMessage, saveSubscriber, validateContactMessage } from "@/lib/portal-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Public contact form and newsletter signup. Stored for market staff; nothing is sent anywhere. */
export async function POST(request: NextRequest) {
  const config = readPortalConfig();
  if (!config) return NextResponse.json({ error: "Messages are temporarily unavailable." }, { status: 503, headers });
  let decision;
  try { decision = await consumeInquiryLimit("ip", inquiryClient(request.headers)); } catch {
    return NextResponse.json({ error: "Messages are temporarily unavailable." }, { status: 503, headers });
  }
  if (!decision.allowed) return NextResponse.json({ error: "Too many messages. Please wait a few minutes." }, { status: 429, headers: { ...headers, "Retry-After": String(decision.retryAfterSeconds) } });
  const body = await readObjectBody(request);
  if (!body) return NextResponse.json({ error: "A JSON object body is required." }, { status: 400, headers });
  if (typeof body.website === "string" && body.website.trim()) return NextResponse.json({ ok: true }, { status: 201, headers });
  try {
    if (body.kind === "subscribe") {
      if (typeof body.email !== "string") return NextResponse.json({ error: "Enter your email address." }, { status: 400, headers });
      const outcome = await saveSubscriber(body.email, config.marketId);
      return NextResponse.json({ ok: true, outcome }, { status: 201, headers });
    }
    const validation = validateContactMessage(body);
    if (!validation.ok) return NextResponse.json({ error: validation.errors.join(" "), errors: validation.errors }, { status: 400, headers });
    await saveContactMessage(validation.input, config.marketId, inquiryClient(request.headers));
    return NextResponse.json({ ok: true }, { status: 201, headers });
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_email") return NextResponse.json({ error: "Enter a valid email address." }, { status: 400, headers });
    return NextResponse.json({ error: "Your message could not be saved. Please try again." }, { status: 503, headers });
  }
}
