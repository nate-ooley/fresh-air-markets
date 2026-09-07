import { handleAgreementCompleted } from "@/lib/agreement-completion";
import { persistAgreementCompletion } from "@/lib/agreement-completion-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * This does not trust a contact lookup or the most-recent opportunity. The
 * completion must match an active document binding captured by /issued.
 */
export async function POST(request: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) return Response.json({ error: "Persistent agreement storage is not configured." }, { status: 503 });
  return handleAgreementCompleted(request, {
    secret: process.env.GHL_AGREEMENT_WEBHOOK_SECRET ?? "",
    locationId: process.env.GHL_LOCATION_ID ?? "",
    marketId: process.env.FAME_MARKET_ACCOUNT_ID ?? "",
    seasonId: process.env.FAME_SEASON_ID ?? "",
    templateId: process.env.GHL_AGREEMENT_TEMPLATE_ID ?? "",
    notificationEmail: process.env.GHL_AGREEMENT_NOTIFICATION_EMAIL ?? "",
  }, persistAgreementCompletion);
}
