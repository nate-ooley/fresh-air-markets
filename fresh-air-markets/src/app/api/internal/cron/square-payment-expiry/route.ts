import { cronAuthorized, cronSecretConfigured } from "@/lib/cron-auth";
import {
  expireDueSquarePaymentHolds,
  postgresSquarePaymentLinkRetirementStore,
} from "@/lib/square-payment-pg";
import { dispatchSquarePaymentLinkRetirement } from "@/lib/square-payment";
import { squarePreviewSandboxRuntimeConfig, verifySquareSandboxSetup } from "@/lib/square";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPIRY_LIMIT = 25;
const RETIREMENT_LIMIT = 10;

/**
 * Authenticated recovery endpoint for the 48-hour Sandbox payment window.
 *
 * It first claims due holds for retirement while preserving their capacity. It
 * then retires up to ten matching hosted links using separately leased work
 * rows; only confirmed deletion atomically finalizes expiration and releases
 * capacity.
 * No email, SMS, HighLevel mutation, contact lookup, or browser redirect is
 * performed here. A provider outage leaves an expiry-pending hold plus a
 * pending retirement row for the next trusted scheduler invocation, with its
 * allocation still held.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!cronSecretConfigured(secret)) {
    return Response.json({ error: "Square payment expiry scheduler is not configured." }, { status: 503 });
  }
  if (!cronAuthorized(request, secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  if (!process.env.DATABASE_URL) {
    return Response.json({ error: "Persistent Square payment storage is not configured." }, { status: 503 });
  }
  const marketId = process.env.FAME_MARKET_ACCOUNT_ID?.trim();
  if (!marketId) {
    return Response.json({ error: "Square payment expiry market scope is not configured." }, { status: 503 });
  }

  let setup;
  try {
    // Check the local Preview/Sandbox gate before claiming anything. A copied
    // Sandbox setting in Production must not mutate payment holds.
    setup = squarePreviewSandboxRuntimeConfig(process.env);
  } catch {
    return Response.json({ error: "Square payment expiry is unavailable." }, { status: 503 });
  }

  let expiry;
  try {
    expiry = await expireDueSquarePaymentHolds({ marketId, now: new Date(), limit: EXPIRY_LIMIT });
  } catch {
    return Response.json({ error: "Square payment expiry is unavailable." }, { status: 503 });
  }

  let square;
  try {
    const identity = await verifySquareSandboxSetup(setup);
    square = {
      environment: "sandbox" as const,
      accessToken: setup.accessToken,
      merchantId: identity.merchantId,
      locationId: identity.locationId,
    };
  } catch {
    // The durable expiry claim remains committed and can safely be rerun.
    // Returning a retryable response tells the trusted scheduler that provider
    // retirement is pending, while the associated allocation stays held.
    return Response.json({ error: "Square payment-link retirement is unavailable." }, { status: 503 });
  }

  let expired = 0;
  let deferred = 0;
  let manualReview = expiry.manualReview;
  try {
    for (let index = 0; index < RETIREMENT_LIMIT; index++) {
      const result = await dispatchSquarePaymentLinkRetirement({
        marketId,
        square,
        store: postgresSquarePaymentLinkRetirementStore,
      });
      if (result.kind === "no_work") break;
      if (result.kind === "retired") expired++;
      if (result.kind === "in_progress" || result.kind === "retry_scheduled") deferred++;
      if (result.kind === "manual_review") manualReview++;
    }
  } catch {
    return Response.json({ error: "Square payment-link retirement is unavailable." }, { status: 503 });
  }
  return Response.json({ expiryPending: expiry.expiryPending, expired, deferred, manualReview });
}
