import { createHash, timingSafeEqual } from "node:crypto";

export interface ApplicationHandoffConfig { secret: string; locationId: string; marketId: string; seasonId: string }
export interface ApplicationHandoff {
  eventId: string; locationId: string; marketId: string; seasonId: string;
  contactId: string; opportunityId: string | null; payloadHash: string;
  snapshot: Record<string, unknown>;
}
export type HandoffResult = "captured" | "duplicate" | "conflict";

/** Server-to-server ingress. It preserves a source snapshot and stable IDs;
 * it never creates CRM contacts, sends messages, or changes approval state.
 */
export async function handleApplicationHandoff(
  request: Request,
  config: ApplicationHandoffConfig,
  persist: (event: ApplicationHandoff) => Promise<HandoffResult>,
): Promise<Response> {
  if (config.secret.length < 32 || !config.locationId || !config.marketId || !config.seasonId) return Response.json({ error: "Application handoff is not configured." }, { status: 503 });
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${config.secret}`;
  if (!timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(expected).digest())) return Response.json({ error: "Unauthorized." }, { status: 401 });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "A JSON object is required." }, { status: 400 });
  let value: unknown;
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      bytes += chunk.byteLength;
      if (bytes > 128 * 1024) {
        await reader.cancel();
        return Response.json({ error: "Application snapshot is too large." }, { status: 413 });
      }
      chunks.push(chunk);
    }
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return Response.json({ error: "A JSON object is required." }, { status: 400 });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return Response.json({ error: "A JSON object is required." }, { status: 400 });
  const body = value as Record<string, unknown>;
  const validId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9:_-]{1,192}$/.test(v);
  if (!validId(body.eventId) || !validId(body.contactId) || body.locationId !== config.locationId || body.seasonId !== config.seasonId || (body.opportunityId !== undefined && !validId(body.opportunityId))) {
    return Response.json({ error: "Invalid event identity, location or season." }, { status: 400 });
  }
  if (!body.snapshot || typeof body.snapshot !== "object" || Array.isArray(body.snapshot)) return Response.json({ error: "An application snapshot is required." }, { status: 400 });
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  try {
    const result = await persist({ eventId: body.eventId, contactId: body.contactId, locationId: config.locationId, marketId: config.marketId, seasonId: config.seasonId, opportunityId: typeof body.opportunityId === "string" ? body.opportunityId : null, snapshot: body.snapshot as Record<string, unknown>, payloadHash });
    if (result === "conflict") return Response.json({ error: "Event ID was already used for different content." }, { status: 409 });
    return Response.json({ status: result }, { status: result === "captured" ? 201 : 200 });
  } catch {
    // Caller must retry the same event ID. Never acknowledge a failed DB write.
    return Response.json({ error: "Application capture unavailable; retry the same event." }, { status: 503 });
  }
}
