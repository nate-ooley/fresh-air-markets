import { handleApplicationDocumentIngress } from "@/lib/application-document-ingress";
import { persistApplicationDocumentSource } from "@/lib/application-document-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Trusted post-transfer ingress. HighLevel must hand the file to a private
 * transfer worker first; this endpoint accepts only its inspected metadata.
 */
export async function POST(request: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) return Response.json({ error: "Persistent document storage is not configured." }, { status: 503 });
  return handleApplicationDocumentIngress(request, {
    secret: process.env.DOCUMENT_INGRESS_WEBHOOK_SECRET ?? "",
    locationId: process.env.GHL_LOCATION_ID ?? "",
    marketId: process.env.FAME_MARKET_ACCOUNT_ID ?? "",
  }, persistApplicationDocumentSource);
}
