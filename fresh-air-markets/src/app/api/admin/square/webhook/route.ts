import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { DEMO_MARKET_ID } from "@/lib/seed";
import { squareCheckoutConfig, squarePortalOrigin, squareWebhookConfig } from "@/lib/square";
import { syncSquareWebhookSubscription } from "@/lib/square-webhook-subscription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/**
 * Manager-only operational check for the Square webhook subscription.
 * GET reports whether Square's stored URL matches SQUARE_WEBHOOK_URL;
 * POST rewrites Square's URL to match. Nothing from the request body is used:
 * the target URL comes only from the deployment's own configuration, which is
 * also what the checkout route requires to equal the vendor portal origin.
 */
async function gate(request: NextRequest, mutating: boolean) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (marketId === DEMO_MARKET_ID) return NextResponse.json({ error: "A private market account is required." }, { status: 403, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  if (mutating) {
    const origin = request.headers.get("origin");
    if (origin !== null) {
      let expectedOrigin;
      try { expectedOrigin = squarePortalOrigin(process.env); } catch { return NextResponse.json({ error: "Square is not configured." }, { status: 503, headers }); }
      if (origin !== expectedOrigin) return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
    }
  }
  if (process.env.VERCEL !== "1" || process.env.VERCEL_ENV !== "production" || process.env.FAME_MARKET_ACCOUNT_ID?.trim() !== marketId) {
    return NextResponse.json({ error: "Square webhook management is only available to the production market." }, { status: 403, headers });
  }
  return null;
}

async function run(request: NextRequest, apply: boolean) {
  const refusal = await gate(request, apply);
  if (refusal) return refusal;
  let config, webhook;
  try {
    config = squareCheckoutConfig(process.env);
    webhook = squareWebhookConfig(process.env);
    if (config.environment !== "production") throw new Error("production only");
  } catch { return NextResponse.json({ error: "Square is not configured for production." }, { status: 503, headers }); }
  try {
    const result = await syncSquareWebhookSubscription(config, webhook.webhookUrl, { apply });
    return NextResponse.json(result, { status: 200, headers });
  } catch {
    return NextResponse.json({ error: "Square webhook subscriptions are unavailable right now." }, { status: 503, headers });
  }
}

export async function GET(request: NextRequest) { return run(request, false); }
export async function POST(request: NextRequest) { return run(request, true); }
