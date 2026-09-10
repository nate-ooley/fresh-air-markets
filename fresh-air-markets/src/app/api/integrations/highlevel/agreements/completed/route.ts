import { handleAgreementCompleted } from "@/lib/agreement-completion";
import {
  dispatchAgreementStageOutboxById,
  persistAgreementCompletionWithStageOutbox,
} from "@/lib/agreement-completion-pg";
import {
  agreementStageDeliveryConfigured,
  deliverAgreementStageToGhl,
  readAgreementStageDeliveryConfig,
} from "@/lib/ghl-agreement-completion-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * This does not trust a contact lookup or the most-recent opportunity. The
 * completion must match an active document binding captured by /issued.
 */
export async function POST(request: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) return Response.json({ error: "Persistent agreement storage is not configured." }, { status: 503 });
  let stageOutboxId: string | undefined;
  const response = await handleAgreementCompleted(request, {
    secret: process.env.GHL_AGREEMENT_WEBHOOK_SECRET ?? "",
    locationId: process.env.GHL_LOCATION_ID ?? "",
    marketId: process.env.FAME_MARKET_ACCOUNT_ID ?? "",
    seasonId: process.env.FAME_SEASON_ID ?? "",
    templateId: process.env.GHL_AGREEMENT_TEMPLATE_ID ?? "",
    notificationEmail: process.env.GHL_AGREEMENT_NOTIFICATION_EMAIL ?? "",
  }, async event => {
    const result = await persistAgreementCompletionWithStageOutbox(event);
    stageOutboxId = result.stageOutboxId;
    return result.outcome;
  });

  // The source event is already safely captured. An unavailable CRM must not
  // turn that successful receipt into a failed webhook acknowledgement; the
  // fenced outbox and authenticated recovery endpoint retain the work.
  if (response.status !== 201 || !stageOutboxId || !agreementStageDeliveryConfigured(process.env)) return response;
  try {
    const config = readAgreementStageDeliveryConfig(process.env);
    await dispatchAgreementStageOutboxById(
      stageOutboxId,
      message => deliverAgreementStageToGhl(message, config),
      { fieldScope: config, leaseSeconds: 60 },
    );
  } catch {
    // The durable item remains pending/expired for a later recovery pass.
  }
  return response;
}
