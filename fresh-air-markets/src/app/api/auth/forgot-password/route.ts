import { NextRequest, NextResponse } from "next/server";
import { emailConfigured } from "@/lib/email";
import { consumeInquiryLimit, inquiryClient } from "@/lib/inquiry-rate-limit";
import { notifyPasswordReset, portalOrigin } from "@/lib/notifications";
import { PASSWORD_RESET_TTL_MINUTES, requestPasswordReset } from "@/lib/password-reset";
import { readObjectBody } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNAVAILABLE = "Password reset is not available right now. Contact the market administrator.";

/**
 * Starts a staff password reset. The response is the same whether or not the
 * email belongs to an account, so the form cannot be used to discover staff
 * addresses. The link is only ever delivered by email.
 */
export async function POST(request: NextRequest) {
  if (!process.env.DATABASE_URL || !emailConfigured()) return NextResponse.json({ error: UNAVAILABLE }, { status: 503, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  const body = await readObjectBody(request);
  if (!body) return NextResponse.json({ error: "A JSON object body is required." }, { status: 400, headers });
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL.test(email)) return NextResponse.json({ error: "Enter the email address you sign in with." }, { status: 400, headers });
  try {
    for (const [kind, subject] of [["ip", inquiryClient(request.headers)], ["email", email]] as const) {
      const decision = await consumeInquiryLimit(kind, subject);
      if (!decision.allowed) return NextResponse.json({ error: "Too many reset requests. Please wait and try again." }, { status: 429, headers: { ...headers, "Retry-After": String(decision.retryAfterSeconds) } });
    }
  } catch { return NextResponse.json({ error: UNAVAILABLE }, { status: 503, headers }); }
  let reset;
  try { reset = await requestPasswordReset(email); } catch { return NextResponse.json({ error: UNAVAILABLE }, { status: 503, headers }); }
  if (reset) {
    const link = new URL(`/reset-password#token=${reset.token}`, portalOrigin()).toString();
    await notifyPasswordReset({ marketId: reset.accountId, email: reset.email, name: reset.ownerName, link, minutes: PASSWORD_RESET_TTL_MINUTES });
  }
  return NextResponse.json({ ok: true, message: "If that email belongs to a market staff account, a reset link is on its way. It works for 30 minutes." }, { status: 202, headers });
}
