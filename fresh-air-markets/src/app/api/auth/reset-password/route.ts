import { NextRequest, NextResponse } from "next/server";
import { consumeInquiryLimit, inquiryClient } from "@/lib/inquiry-rate-limit";
import { consumePasswordReset, passwordProblem } from "@/lib/password-reset";
import { readObjectBody } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const UNAVAILABLE = "Password reset is not available right now. Please try again shortly.";

/** Completes a staff password reset with the emailed single-use token. */
export async function POST(request: NextRequest) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: UNAVAILABLE }, { status: 503, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  const body = await readObjectBody(request);
  if (!body) return NextResponse.json({ error: "A JSON object body is required." }, { status: 400, headers });
  const problem = passwordProblem(body.password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400, headers });
  try {
    const decision = await consumeInquiryLimit("ip", inquiryClient(request.headers));
    if (!decision.allowed) return NextResponse.json({ error: "Too many attempts. Please wait and try again." }, { status: 429, headers: { ...headers, "Retry-After": String(decision.retryAfterSeconds) } });
  } catch { return NextResponse.json({ error: UNAVAILABLE }, { status: 503, headers }); }
  let outcome;
  try { outcome = await consumePasswordReset(body.token, body.password as string); } catch { return NextResponse.json({ error: UNAVAILABLE }, { status: 503, headers }); }
  if (outcome.kind === "expired") return NextResponse.json({ error: "This reset link has expired. Request a new one from the sign-in page." }, { status: 400, headers });
  if (outcome.kind === "invalid") return NextResponse.json({ error: "This reset link is not valid or was already used. Request a new one from the sign-in page." }, { status: 400, headers });
  return NextResponse.json({ ok: true }, { status: 200, headers });
}
