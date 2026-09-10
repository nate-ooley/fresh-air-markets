import { handleApplicationHandoff } from "@/lib/application-handoff";
import { persistApplicationHandoff } from "@/lib/application-handoff-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) return Response.json({ error: "Persistent application storage is not configured." }, { status: 503 });
  return handleApplicationHandoff(request, {
    secret: process.env.GHL_APPLICATION_WEBHOOK_SECRET ?? "",
    locationId: process.env.GHL_LOCATION_ID ?? "",
    marketId: process.env.FAME_MARKET_ACCOUNT_ID ?? "",
    seasonId: process.env.FAME_SEASON_ID ?? "",
  }, persistApplicationHandoff);
}
