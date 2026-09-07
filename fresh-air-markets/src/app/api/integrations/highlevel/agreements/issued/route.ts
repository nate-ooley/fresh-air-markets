import { handleAgreementIssued } from "@/lib/agreement-completion";
import { persistAgreementIssuance } from "@/lib/agreement-completion-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * HighLevel's server-side workflow calls this only after the configured
 * agreement is issued. It binds the generated document ID before any signing
 * completion event is accepted.
 */
export async function POST(request: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) return Response.json({ error: "Persistent agreement storage is not configured." }, { status: 503 });
  return handleAgreementIssued(request, {
    secret: process.env.GHL_AGREEMENT_WEBHOOK_SECRET ?? "",
    locationId: process.env.GHL_LOCATION_ID ?? "",
    marketId: process.env.FAME_MARKET_ACCOUNT_ID ?? "",
    seasonId: process.env.FAME_SEASON_ID ?? "",
    templateId: process.env.GHL_AGREEMENT_TEMPLATE_ID ?? "",
    notificationEmail: process.env.GHL_AGREEMENT_NOTIFICATION_EMAIL ?? "",
  }, persistAgreementIssuance);
}
