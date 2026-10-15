import { NextResponse, type NextRequest } from "next/server";
import { getSessionAccountId } from "./auth";
import { squarePortalOrigin } from "./square";

const headers = { "Cache-Control": "no-store" };

/** Signed-in manager of the configured market; same-origin for writes. */
export async function adminGate(request: NextRequest): Promise<{ marketId: string } | { error: NextResponse }> {
  const marketId = await getSessionAccountId();
  if (!marketId) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }) };
  if (request.method !== "GET") {
    if (request.headers.get("sec-fetch-site") === "cross-site") return { error: NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers }) };
    const origin = request.headers.get("origin");
    if (origin !== null) {
      let expected;
      try { expected = squarePortalOrigin(process.env); } catch { return { error: NextResponse.json({ error: "Payments are not configured." }, { status: 503, headers }) }; }
      if (origin !== expected) return { error: NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers }) };
    }
  }
  if (!process.env.DATABASE_URL || process.env.FAME_MARKET_ACCOUNT_ID?.trim() !== marketId) {
    return { error: NextResponse.json({ error: "Payments are not configured for this market." }, { status: 503, headers }) };
  }
  return { marketId };
}
