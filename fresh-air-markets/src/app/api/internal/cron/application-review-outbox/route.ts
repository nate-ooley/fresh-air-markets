import { cronAuthorized, cronSecretConfigured } from "@/lib/cron-auth";
import { dispatchApplicationReviewOutbox } from "@/lib/application-review-pg";
import {
  applicationReviewDeliveryConfigured,
  deliverApplicationReviewToGhl,
  readApplicationReviewDeliveryConfig,
} from "@/lib/ghl-application-review-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recovery-only endpoint for a trusted scheduler. It exposes counts, never
 * vendor data or HighLevel response bodies. The manager review route tries
 * its own job immediately, so this endpoint does not add ordinary workflow
 * latency.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!cronSecretConfigured(secret)) return Response.json({ error: "Review delivery scheduler is not configured." }, { status: 503 });
  if (!cronAuthorized(request, secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  if (!process.env.DATABASE_URL) return Response.json({ error: "Persistent application storage is not configured." }, { status: 503 });
  if (!applicationReviewDeliveryConfigured(process.env)) {
    return Response.json({ error: "HighLevel review delivery is not configured." }, { status: 503 });
  }
  try {
    const config = readApplicationReviewDeliveryConfig(process.env);
    const result = await dispatchApplicationReviewOutbox(
      message => deliverApplicationReviewToGhl(message, config),
      { limit: 5, leaseSeconds: 60 },
    );
    return Response.json(result);
  } catch {
    return Response.json({ error: "Review delivery is unavailable." }, { status: 503 });
  }
}
