import { cronAuthorized, cronSecretConfigured } from "@/lib/cron-auth";
import {
  expireDueSquarePaymentHolds,
  postgresSquarePaymentLinkRetirementStore,
} from "@/lib/square-payment-pg";
import { dispatchSquarePaymentLinkRetirement } from "@/lib/square-payment";
import { squarePaymentRuntimeConfig, verifySquareIdentity } from "@/lib/square";
import { squareQaExpiryTransport, squareQaSupportConfig } from "@/lib/square-qa-faults";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPIRY_LIMIT = 25;
const RETIREMENT_LIMIT = 10;

/**
 * Authenticated recovery endpoint for the 48-hour payment window.
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

  let qaSupport;
  try {
    qaSupport = squareQaSupportConfig(process.env);
    // A checkout or webhook fault must never be ignored by the expiry worker:
    // otherwise a test setting could accidentally make this path touch an
    // unrelated real Sandbox hold. Expiry simulations have one exact target.
    if (qaSupport?.fault && qaSupport.fault.kind !== "expiry") {
      return Response.json({ error: "Square payment expiry QA configuration is not applicable." }, { status: 503 });
    }
  } catch {
    return Response.json({ error: "Square payment expiry is unavailable." }, { status: 503 });
  }
  const qaPaymentOrderId = qaSupport?.fault?.kind === "expiry"
    ? qaSupport.fault.paymentOrderId
    : undefined;

  let setup;
  try {
    // Check the exact deployment/provider pairing before claiming any hold.
    setup = squarePaymentRuntimeConfig(process.env);
  } catch {
    return Response.json({ error: "Square payment expiry is unavailable." }, { status: 503 });
  }

  let square;
  try {
    const identity = await verifySquareIdentity(setup);
    square = {
      environment: setup.environment,
      accessToken: setup.accessToken,
      merchantId: identity.merchantId,
      locationId: identity.locationId,
    };
  } catch {
    // Identity failure precedes any mutation of holds or retirement work.
    return Response.json({ error: "Square payment-link retirement is unavailable." }, { status: 503 });
  }

  let expiry;
  try {
    expiry = await expireDueSquarePaymentHolds({
      marketId, environment: setup.environment, paymentOrderId: qaPaymentOrderId, now: new Date(), limit: EXPIRY_LIMIT,
    });
  } catch {
    return Response.json({ error: "Square payment expiry is unavailable." }, { status: 503 });
  }

  let expired = 0;
  let deferred = 0;
  let manualReview = expiry.manualReview;
  try {
    for (let index = 0; index < RETIREMENT_LIMIT; index++) {
      const dispatchInput = {
        marketId,
        square,
        store: postgresSquarePaymentLinkRetirementStore,
        ...(qaPaymentOrderId ? {
          paymentOrderId: qaPaymentOrderId,
          transportForRetirement: (retirement: { paymentOrderId: string }) => squareQaExpiryTransport(
            qaSupport?.fault ?? null, retirement.paymentOrderId, square.locationId,
          ),
        } : {}),
      };
      const result = await dispatchSquarePaymentLinkRetirement({
        ...dispatchInput,
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
