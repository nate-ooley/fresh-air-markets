import { handleApplicationHandoff } from "@/lib/application-handoff";
import { persistApplicationHandoff } from "@/lib/application-handoff-pg";
import { mapHighLevelWorkflowApplication } from "@/lib/highlevel-workflow-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BYTES = 128 * 1024;

/**
 * Target for a HighLevel Workflow "Webhook" action (POST, JSON, header
 * `Authorization: Bearer <GHL_APPLICATION_WEBHOOK_SECRET>`). The native
 * payload is normalized into the exact handoff envelope and then passes
 * through the same authentication, validation and idempotent persistence as
 * the server-to-server handoff route.
 */
export async function POST(request: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) return Response.json({ error: "Persistent application storage is not configured." }, { status: 503 });
  const config = {
    secret: process.env.GHL_APPLICATION_WEBHOOK_SECRET ?? "",
    locationId: process.env.GHL_LOCATION_ID?.trim() ?? "",
    marketId: process.env.FAME_MARKET_ACCOUNT_ID?.trim() ?? "",
    seasonId: process.env.FAME_SEASON_ID?.trim() ?? "",
  };
  // Authenticate before reading or reflecting anything about the body.
  const authorization = request.headers.get("authorization") ?? "";
  const probe = await handleApplicationHandoff(
    new Request(request.url, { method: "POST", headers: { authorization }, body: "{}" }),
    config, async () => "captured",
  );
  if (probe.status === 401 || probe.status === 503) return probe;

  const raw = await request.text().catch(() => "");
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) return Response.json({ error: "Payload is too large." }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return Response.json({ error: "A JSON object is required." }, { status: 400 }); }
  const mapped = mapHighLevelWorkflowApplication(body, { locationId: config.locationId, seasonId: config.seasonId });
  if (!mapped) return Response.json({ error: "The webhook body has no recognizable contact for this location." }, { status: 400 });
  return handleApplicationHandoff(
    new Request(request.url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(mapped) }),
    config, persistApplicationHandoff,
  );
}
