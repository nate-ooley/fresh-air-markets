import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { ApplicationHandoff, HandoffResult } from "./application-handoff";

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;

// Source capture and manager review take this same transaction-scoped lock.
// It closes the gap where a new source event could otherwise be inserted after
// a manager had read an application's latest event but before the decision was
// committed. The input IDs are already validated at the protected ingress.
function applicationIdentityKey(marketId: string, locationId: string, contactId: string, seasonId: string): string {
  return [marketId, locationId, contactId, seasonId].join("\u001f");
}

/** Run docs/migrations/001-application-handoff.sql before enabling the route.
 * Snapshot/event rows are append-only; existing approval history is never reset.
 */
export async function persistApplicationHandoff(event: ApplicationHandoff, sql?: Sql): Promise<HandoffResult> {
  if (!sql) {
    if (!process.env.DATABASE_URL) throw new Error("Persistent storage is required.");
    client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false });
    sql = client;
  }
  return sql.begin(async tx => {
    const market = await tx`SELECT id FROM accounts WHERE id = ${event.marketId}`;
    if (!market.length) throw new Error("Configured market does not exist.");
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${applicationIdentityKey(event.marketId, event.locationId, event.contactId, event.seasonId)}, 0))`;
    const inserted = await tx`INSERT INTO fame_application_events
      (location_id, event_id, market_id, payload_hash, snapshot)
      VALUES (${event.locationId}, ${event.eventId}, ${event.marketId}, ${event.payloadHash}, ${tx.json({ contactId: event.contactId, opportunityId: event.opportunityId, seasonId: event.seasonId, snapshot: event.snapshot } as Parameters<typeof tx.json>[0])})
      ON CONFLICT (location_id, event_id) DO NOTHING RETURNING event_id`;
    if (!inserted.length) {
      const [prior] = await tx`SELECT payload_hash, market_id FROM fame_application_events
        WHERE location_id = ${event.locationId} AND event_id = ${event.eventId}`;
      return prior?.payload_hash === event.payloadHash && prior?.market_id === event.marketId ? "duplicate" : "conflict";
    }
    await tx`INSERT INTO fame_applications (id, market_id, location_id, contact_id, season_id, opportunity_id)
      VALUES (${randomUUID()}, ${event.marketId}, ${event.locationId}, ${event.contactId}, ${event.seasonId}, ${event.opportunityId})
      ON CONFLICT (market_id, location_id, contact_id, season_id)
      DO UPDATE SET opportunity_id = COALESCE(fame_applications.opportunity_id, EXCLUDED.opportunity_id)`;
    const [application] = await tx`SELECT id FROM fame_applications WHERE market_id = ${event.marketId}
      AND location_id = ${event.locationId} AND contact_id = ${event.contactId} AND season_id = ${event.seasonId}`;
    await tx`UPDATE fame_application_events SET application_id = ${application.id}
      WHERE location_id = ${event.locationId} AND event_id = ${event.eventId}`;
    return "captured";
  });
}
