import { cronAuthorized, cronSecretConfigured } from "@/lib/cron-auth";
import { dispatchAgreementStageOutbox } from "@/lib/agreement-completion-pg";
import {
  agreementStageDeliveryConfigured,
  deliverAgreementStageToGhl,
  readAgreementStageDeliveryConfig,
} from "@/lib/ghl-agreement-completion-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Recovery-only endpoint. It has no recipient/email behavior and returns only
 * aggregate counts, so an authorized scheduler cannot enumerate vendor data.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!cronSecretConfigured(secret)) return Response.json({ error: "Agreement-stage scheduler is not configured." }, { status: 503 });
  if (!cronAuthorized(request, secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  if (!process.env.DATABASE_URL) return Response.json({ error: "Persistent agreement storage is not configured." }, { status: 503 });
  // CRM delivery is optional; a deployment without it reports the worker as disabled, not failed.
  if (!agreementStageDeliveryConfigured(process.env)) return Response.json({ enabled: false });
  try {
    const config = readAgreementStageDeliveryConfig(process.env);
    const result = await dispatchAgreementStageOutbox(
      message => deliverAgreementStageToGhl(message, config),
      { fieldScope: config, limit: 1, leaseSeconds: 60 },
    );
    return Response.json(result);
  } catch {
    return Response.json({ error: "Agreement-stage delivery is unavailable." }, { status: 503 });
  }
}
