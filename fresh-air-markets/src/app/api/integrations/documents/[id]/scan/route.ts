import { handleApplicationDocumentScan } from "@/lib/application-document-ingress";
import { recordApplicationDocumentScan } from "@/lib/application-document-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Scanner callback for a single private document version. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!process.env.DATABASE_URL) return Response.json({ error: "Persistent document storage is not configured." }, { status: 503 });
  const { id } = await params;
  return handleApplicationDocumentScan(request, id, {
    secret: process.env.DOCUMENT_SCANNER_WEBHOOK_SECRET ?? "",
    marketId: process.env.FAME_MARKET_ACCOUNT_ID ?? "",
  }, recordApplicationDocumentScan);
}
