import { handleHighLevelApplicationDocumentIngress } from "@/lib/application-document-ingress";
import {
  persistApplicationDocumentSource,
  resolveApplicationDocumentSourceTarget,
} from "@/lib/application-document-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Private-transfer-worker ingress for a HighLevel upload. This route accepts
 * inspected metadata only after the worker has stored the file privately; it
 * resolves the internal application from exact stored IDs and never accepts a
 * browser-selected application ID or a public file URL.
 */
export async function POST(request: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) return Response.json({ error: "Persistent document storage is not configured." }, { status: 503 });
  return handleHighLevelApplicationDocumentIngress(request, {
    secret: process.env.DOCUMENT_INGRESS_WEBHOOK_SECRET ?? "",
    locationId: process.env.GHL_LOCATION_ID ?? "",
    marketId: process.env.FAME_MARKET_ACCOUNT_ID ?? "",
    seasonId: process.env.FAME_SEASON_ID ?? "",
  }, resolveApplicationDocumentSourceTarget, persistApplicationDocumentSource);
}
