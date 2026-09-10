import type postgres from "postgres";
import { verifiedOpportunityFields } from "./ghl-opportunity-field-proof";

export type PaymentStageSql = ReturnType<typeof postgres> | postgres.TransactionSql;

/** A queued agreement stage owns the earlier transition until its exact receipt
 * is delivered. Downstream workers never race it or infer delivery from signing. */
export async function paymentAgreementStageReadiness(sql: PaymentStageSql,
  identity: { marketId: string; reservationId: string; applicationId: string },
  fieldScope: { pipelineId: string; agreementStatusFieldId: string },
): Promise<"ready" | "pending" | "failed"> {
  const [row] = await sql<{ status: string | null; exact: boolean; delivery_receipt: unknown; location_id: string; contact_id: string; opportunity_id: string }[]>`
    SELECT j.status, j.delivery_receipt, g.location_id, g.contact_id, g.opportunity_id, COALESCE(
      j.payload->>'marketId' = g.market_id AND j.payload->>'applicationId' = g.application_id
      AND j.payload->>'completionId' = g.id AND j.payload->>'locationId' = g.location_id
      AND j.payload->>'contactId' = g.contact_id AND j.payload->>'opportunityId' = g.opportunity_id
      AND j.payload->>'seasonId' = g.season_id, FALSE) AS exact
    FROM fame_reservation_finalizations f
    JOIN fame_agreement_completions g ON g.id = f.agreement_completion_id AND g.market_id = f.market_id AND g.application_id = f.application_id
    LEFT JOIN fame_agreement_stage_outbox j ON j.completion_id = g.id AND j.market_id = g.market_id AND j.application_id = g.application_id
    WHERE f.reservation_id = ${identity.reservationId} AND f.market_id = ${identity.marketId} AND f.application_id = ${identity.applicationId}`;
  if (!row?.exact) return "failed";
  if (row.status === "delivered") return verifiedOpportunityFields(row.delivery_receipt, {
    locationId: row.location_id, contactId: row.contact_id, opportunityId: row.opportunity_id,
    pipelineId: fieldScope.pipelineId, fields: [{ fieldId: fieldScope.agreementStatusFieldId, fieldValue: "Signed" }],
  }) ? "ready" : "failed";
  return row.status === "pending" || row.status === "processing" ? "pending" : "failed";
}

/** Shared exclusion for Pending and Confirmed writes. The advisory lock does not
 * lock reservation/order rows, so a Square webhook remains free to commit. */
export async function withPaymentStageLock<T>(sql: ReturnType<typeof postgres>,
  identity: { marketId: string; reservationId: string }, work: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const key = JSON.stringify(["fresh-air-payment-stage-v1", identity.marketId, identity.reservationId]);
  return sql.begin(async tx => {
    const [lock] = await tx<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired`;
    if (!lock.acquired) return { acquired: false as const };
    return { acquired: true as const, value: await work(tx) };
  }) as Promise<{ acquired: false } | { acquired: true; value: T }>;
}
