import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { verifiedOpportunityFields, type GhlOpportunityFieldProof } from "./ghl-opportunity-field-proof";
import { withPaymentStageLock, paymentAgreementStageReadiness, type PaymentStageSql } from "./payment-stage-lock";
import { paymentPaidSyncFailure, type PaymentPaidSyncScope } from "./payment-paid-sync-pg";

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent payment storage is required.");
  return client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
}
export type PaymentPendingSyncScope = PaymentPaidSyncScope;
export interface PaymentPendingSyncMessage extends Omit<PaymentPendingSyncScope, "pipelineId" | "agreementStatusFieldId" | "paymentStatusFieldId"> {
  paymentOrderId: string; applicationId: string; agreementCompletionId: string; contactId: string; opportunityId: string;
  reservationId: string; reservationRevision: number; squareOrderId: string; paymentDueAt: string; attempt: number; leaseToken: string;
}
interface Row {
  payment_order_id: string; market_id: string; application_id: string; agreement_completion_id: string;
  location_id: string; contact_id: string; opportunity_id: string; season_id: string; reservation_id: string;
  reservation_revision: number; square_environment: "sandbox" | "production"; square_order_id: string;
  payment_due_at: Date; attempts: number; lease_token: string;
}
function message(row: Row): PaymentPendingSyncMessage {
  return { paymentOrderId: row.payment_order_id, marketId: row.market_id, applicationId: row.application_id,
    agreementCompletionId: row.agreement_completion_id, locationId: row.location_id, contactId: row.contact_id,
    opportunityId: row.opportunity_id, seasonId: row.season_id, reservationId: row.reservation_id,
    reservationRevision: row.reservation_revision, squareEnvironment: row.square_environment,
    squareOrderId: row.square_order_id, paymentDueAt: row.payment_due_at.toISOString(), attempt: row.attempts, leaseToken: row.lease_token };
}
function validate(scope: PaymentPendingSyncScope, limit: number): void {
  if (scope.marketId === "demo-market" || ![scope.marketId, scope.seasonId, scope.locationId, scope.pipelineId, scope.agreementStatusFieldId, scope.paymentStatusFieldId].every(v => typeof v === "string" && /^[A-Za-z0-9_-]{1,192}$/.test(v))
    || !["sandbox", "production"].includes(scope.squareEnvironment) || !Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new Error("Invalid pending payment sync scope.");
  }
}
export async function enqueueMissingPaymentPendingSync(scope: PaymentPendingSyncScope, limit = 5, sql: Sql = configuredClient()): Promise<number> {
  validate(scope, limit);
  const rows = await sql<{ inserted: number }[]>`SELECT fame_enqueue_payment_pending_sync(e.payment_order_id) AS inserted
    FROM fame_payment_pending_sync_eligible e WHERE e.market_id = ${scope.marketId} AND e.season_id = ${scope.seasonId}
      AND e.location_id = ${scope.locationId} AND e.square_environment = ${scope.squareEnvironment}
      AND NOT EXISTS (SELECT 1 FROM fame_payment_pending_sync_outbox j WHERE j.payment_order_id = e.payment_order_id)
    ORDER BY e.payment_order_id LIMIT ${limit}`;
  return rows.reduce((sum, row) => sum + Number(row.inserted), 0);
}
export async function claimPaymentPendingSync(scope: PaymentPendingSyncScope, limit = 1, sql: Sql = configuredClient()): Promise<PaymentPendingSyncMessage[]> {
  validate(scope, limit);
  const token = randomUUID();
  const rows = await sql<Row[]>`WITH next AS (
    SELECT payment_order_id FROM fame_payment_pending_sync_outbox WHERE market_id = ${scope.marketId} AND season_id = ${scope.seasonId}
      AND location_id = ${scope.locationId} AND square_environment = ${scope.squareEnvironment}
      AND ((status = 'pending' AND next_attempt_at <= statement_timestamp()) OR (status = 'processing' AND locked_until <= statement_timestamp()))
    ORDER BY next_attempt_at, created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
  ) UPDATE fame_payment_pending_sync_outbox j SET status = 'processing', attempts = attempts + 1,
    locked_until = statement_timestamp() + interval '60 seconds', lease_token = ${token}, updated_at = statement_timestamp()
    FROM next WHERE j.payment_order_id = next.payment_order_id RETURNING j.*`;
  return rows.map(message);
}
export async function paymentPendingSyncStillEligible(job: PaymentPendingSyncMessage, sql: PaymentStageSql = configuredClient()): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM fame_payment_pending_sync_eligible e
    JOIN fame_payment_pending_sync_outbox j ON j.payment_order_id = e.payment_order_id
    WHERE j.payment_order_id = ${job.paymentOrderId} AND j.lease_token = ${job.leaseToken}
      AND j.status = 'processing' AND j.locked_until > statement_timestamp()
      AND e.market_id = j.market_id AND e.application_id = j.application_id AND e.agreement_completion_id = j.agreement_completion_id
      AND e.location_id = j.location_id AND e.contact_id = j.contact_id AND e.opportunity_id = j.opportunity_id AND e.season_id = j.season_id
      AND e.reservation_id = j.reservation_id AND e.reservation_revision = j.reservation_revision
      AND e.square_environment = j.square_environment AND e.square_order_id = j.square_order_id AND e.payment_due_at = j.payment_due_at`;
  return rows.length === 1;
}
type Finish = "delivered" | "deferred" | "cancelled" | "manual_review" | "stale";
async function finish(job: PaymentPendingSyncMessage, kind: Exclude<Finish, "stale" | "deferred">,
  sql: PaymentStageSql, code: string | null = null, proof: GhlOpportunityFieldProof | null = null): Promise<Finish> {
  const rows = await sql`UPDATE fame_payment_pending_sync_outbox SET status = ${kind},
    delivered_at = ${kind === "delivered" ? sql`statement_timestamp()` : null},
    delivery_receipt = ${proof ? sql.json(proof as unknown as Parameters<typeof sql.json>[0]) : null},
    locked_until = NULL, lease_token = NULL, last_error_code = ${code}, updated_at = statement_timestamp()
    WHERE payment_order_id = ${job.paymentOrderId} AND lease_token = ${job.leaseToken}
      AND status = 'processing' AND locked_until > statement_timestamp() RETURNING payment_order_id`;
  return rows.length ? kind : "stale";
}
async function retry(job: PaymentPendingSyncMessage, error: unknown, sql: PaymentStageSql): Promise<Finish> {
  const failure = paymentPaidSyncFailure(error, job.attempt);
  const waiting = ["payment_stage_busy", "agreement_prerequisite_pending"].includes(failure.code);
  const rows = await sql`UPDATE fame_payment_pending_sync_outbox SET status = ${failure.terminal ? "manual_review" : "pending"},
    attempts = attempts - ${waiting ? 1 : 0}, next_attempt_at = statement_timestamp() + ${failure.delay} * interval '1 second',
    locked_until = NULL, lease_token = NULL, last_error_code = ${failure.code}, updated_at = statement_timestamp()
    WHERE payment_order_id = ${job.paymentOrderId} AND lease_token = ${job.leaseToken}
      AND status = 'processing' AND locked_until > statement_timestamp() RETURNING payment_order_id`;
  return rows.length ? failure.terminal ? "manual_review" : "deferred" : "stale";
}
export async function dispatchPaymentPendingSync(deliver: (job: PaymentPendingSyncMessage) => Promise<GhlOpportunityFieldProof>, scope: PaymentPendingSyncScope,
  options: { limit?: number; sql?: Sql } = {}): Promise<{ queued: number; delivered: number; deferred: number; cancelled: number; manual_review: number; stale: number }> {
  const sql = options.sql ?? configuredClient();
  const limit = options.limit ?? 5;
  const queued = await enqueueMissingPaymentPendingSync(scope, limit, sql);
  const result = { queued, delivered: 0, deferred: 0, cancelled: 0, manual_review: 0, stale: 0 };
  for (let index = 0; index < limit; index++) {
    const [job] = await claimPaymentPendingSync(scope, 1, sql);
    if (!job) break;
    try {
      const locked = await withPaymentStageLock(sql, job, async tx => {
        if (!await paymentPendingSyncStillEligible(job, tx)) return finish(job, "cancelled", tx, "pending_evidence_changed");
        const prerequisite = await paymentAgreementStageReadiness(tx, job, scope);
        if (prerequisite !== "ready") throw { code: `agreement_prerequisite_${prerequisite}` };
        const proof = await deliver(job);
        if (!verifiedOpportunityFields(proof, { locationId: job.locationId, contactId: job.contactId,
          opportunityId: job.opportunityId, pipelineId: scope.pipelineId, fields: [
            { fieldId: scope.agreementStatusFieldId, fieldValue: "Signed" },
            { fieldId: scope.paymentStatusFieldId, fieldValue: "Ready for Payment" },
          ] })) throw { code: "ghl_field_proof_invalid" };
        // A paid webhook may commit during provider work. The paid worker shares
        // this lock, so it can only advance to Confirmed after this operation ends.
        return await paymentPendingSyncStillEligible(job, tx)
          ? finish(job, "delivered", tx, null, proof) : finish(job, "cancelled", tx, "pending_evidence_changed");
      });
      if (!locked.acquired) throw { code: "payment_stage_busy" };
      result[locked.value]++;
    } catch (error) { result[await retry(job, error, sql)]++; }
  }
  return result;
}
