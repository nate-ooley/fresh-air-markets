import { randomUUID } from "node:crypto";
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent payment storage is required.");
  return client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
}
export interface PaymentPaidSyncScope {
  marketId: string;
  seasonId: string;
  locationId: string;
  squareEnvironment: "sandbox" | "production";
}
export interface PaymentPaidSyncMessage extends PaymentPaidSyncScope {
  paymentOrderId: string;
  applicationId: string;
  contactId: string;
  opportunityId: string;
  reservationId: string;
  reservationRevision: number;
  squareMerchantId: string;
  squareLocationId: string;
  squareOrderId: string;
  paymentId: string;
  eventId: string;
  attempt: number;
  leaseToken: string;
}
interface Row {
  payment_order_id: string; market_id: string; application_id: string;
  location_id: string; contact_id: string; opportunity_id: string; season_id: string;
  reservation_id: string; reservation_revision: number; square_environment: "sandbox" | "production";
  square_merchant_id: string; square_location_id: string; square_order_id: string;
  payment_id: string; event_id: string; attempts: number; lease_token: string;
}
function message(row: Row): PaymentPaidSyncMessage {
  return {
    paymentOrderId: row.payment_order_id, marketId: row.market_id, applicationId: row.application_id,
    locationId: row.location_id, contactId: row.contact_id, opportunityId: row.opportunity_id,
    seasonId: row.season_id, reservationId: row.reservation_id,
    reservationRevision: Number(row.reservation_revision), squareEnvironment: row.square_environment,
    squareMerchantId: row.square_merchant_id, squareLocationId: row.square_location_id,
    squareOrderId: row.square_order_id, paymentId: row.payment_id, eventId: row.event_id,
    attempt: Number(row.attempts), leaseToken: row.lease_token,
  };
}
function validate(scope: PaymentPaidSyncScope, limit: number): void {
  if (![scope.marketId, scope.seasonId, scope.locationId].every(v => /^[A-Za-z0-9_-]{1,192}$/.test(v))
    || !["sandbox", "production"].includes(scope.squareEnvironment)
    || !Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error("Invalid payment sync scope.");
}
/** A repair scan does not infer payment from a browser or create new paid facts. */
export async function enqueueMissingPaymentPaidSync(scope: PaymentPaidSyncScope, limit = 5, sql: Sql = configuredClient()): Promise<number> {
  validate(scope, limit);
  const rows = await sql<{ inserted: number }[]>`
    SELECT fame_enqueue_payment_paid_sync(e.payment_order_id) AS inserted
    FROM fame_payment_paid_sync_eligible e
    WHERE e.market_id = ${scope.marketId} AND e.season_id = ${scope.seasonId}
      AND e.location_id = ${scope.locationId} AND e.square_environment = ${scope.squareEnvironment}
      AND NOT EXISTS (SELECT 1 FROM fame_payment_paid_sync_outbox j WHERE j.payment_order_id = e.payment_order_id)
    ORDER BY e.payment_order_id LIMIT ${limit}`;
  return rows.reduce((total, row) => total + Number(row.inserted), 0);
}
export async function claimPaymentPaidSync(scope: PaymentPaidSyncScope, limit = 5, leaseSeconds = 60, sql: Sql = configuredClient()): Promise<PaymentPaidSyncMessage[]> {
  validate(scope, limit);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 600) throw new Error("Invalid payment sync lease.");
  const token = randomUUID();
  const rows = await sql<Row[]>`
    WITH next AS (
      SELECT payment_order_id FROM fame_payment_paid_sync_outbox
      WHERE market_id = ${scope.marketId} AND season_id = ${scope.seasonId}
        AND location_id = ${scope.locationId} AND square_environment = ${scope.squareEnvironment}
        AND ((status = 'pending' AND next_attempt_at <= statement_timestamp())
          OR (status = 'processing' AND locked_until <= statement_timestamp()))
      ORDER BY next_attempt_at, created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    UPDATE fame_payment_paid_sync_outbox j SET status = 'processing', attempts = attempts + 1,
      locked_until = statement_timestamp() + ${leaseSeconds} * interval '1 second',
      lease_token = ${token}, updated_at = statement_timestamp()
    FROM next WHERE j.payment_order_id = next.payment_order_id RETURNING j.*`;
  return rows.map(message);
}
/** The immutable queued identity must still match all current paid evidence. */
export async function paymentPaidSyncStillEligible(job: PaymentPaidSyncMessage, sql: Sql = configuredClient()): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM fame_payment_paid_sync_eligible e
    JOIN fame_payment_paid_sync_outbox j ON j.payment_order_id = e.payment_order_id
    WHERE j.payment_order_id = ${job.paymentOrderId} AND j.lease_token = ${job.leaseToken}
      AND j.status = 'processing' AND j.locked_until > statement_timestamp()
      AND e.market_id = j.market_id AND e.application_id = j.application_id
      AND e.location_id = j.location_id AND e.contact_id = j.contact_id
      AND e.opportunity_id = j.opportunity_id AND e.season_id = j.season_id
      AND e.reservation_id = j.reservation_id AND e.reservation_revision = j.reservation_revision
      AND e.square_environment = j.square_environment AND e.square_merchant_id = j.square_merchant_id
      AND e.square_location_id = j.square_location_id AND e.square_order_id = j.square_order_id
      AND e.payment_id = j.payment_id AND e.event_id = j.event_id`;
  return rows.length === 1;
}
export async function markPaymentPaidSyncDelivered(job: PaymentPaidSyncMessage, sql: Sql = configuredClient()): Promise<boolean> {
  const rows = await sql`
    UPDATE fame_payment_paid_sync_outbox j SET status = 'delivered', delivered_at = statement_timestamp(),
      locked_until = NULL, lease_token = NULL, last_error_code = NULL, updated_at = statement_timestamp()
    FROM fame_payment_paid_sync_eligible e
    WHERE j.payment_order_id = ${job.paymentOrderId} AND j.lease_token = ${job.leaseToken}
      AND j.status = 'processing' AND j.locked_until > statement_timestamp()
      AND e.payment_order_id = j.payment_order_id AND e.market_id = j.market_id
      AND e.application_id = j.application_id AND e.location_id = j.location_id
      AND e.contact_id = j.contact_id AND e.opportunity_id = j.opportunity_id AND e.season_id = j.season_id
      AND e.reservation_id = j.reservation_id AND e.reservation_revision = j.reservation_revision
      AND e.square_environment = j.square_environment AND e.square_merchant_id = j.square_merchant_id
      AND e.square_location_id = j.square_location_id AND e.square_order_id = j.square_order_id
      AND e.payment_id = j.payment_id AND e.event_id = j.event_id RETURNING j.payment_order_id`;
  return rows.length === 1;
}
const RETRY_CODES = new Set(["ghl_rate_limited", "ghl_unavailable", "delivery_unavailable"]);
const TERMINAL_CODES = new Set(["ghl_config_missing", "ghl_identity_mismatch", "ghl_qa_recipient_rejected", "ghl_pipeline_mismatch", "ghl_stage_diverged", "ghl_status_diverged", "ghl_rejected", "paid_evidence_changed"]);
export function paymentPaidSyncFailure(error: unknown, attempt: number): { code: string; terminal: boolean; delay: number } {
  const candidate = error && typeof error === "object" ? error as { code?: unknown; retryAfterSeconds?: unknown } : {};
  const supplied = typeof candidate.code === "string" ? candidate.code : "";
  const code = RETRY_CODES.has(supplied) || TERMINAL_CODES.has(supplied) ? supplied : "delivery_unavailable";
  const seconds = Number(candidate.retryAfterSeconds);
  return { code, terminal: TERMINAL_CODES.has(code) || attempt >= 8,
    delay: Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600 ? seconds : Math.min(3600, 30 * 2 ** Math.min(attempt - 1, 7)) };
}
export async function failOrRetryPaymentPaidSync(job: PaymentPaidSyncMessage, error: unknown, sql: Sql = configuredClient()): Promise<"manual_review" | "deferred" | "stale"> {
  const failure = paymentPaidSyncFailure(error, job.attempt);
  const rows = await sql`
    UPDATE fame_payment_paid_sync_outbox SET status = ${failure.terminal ? "manual_review" : "pending"},
      next_attempt_at = statement_timestamp() + ${failure.delay} * interval '1 second',
      locked_until = NULL, lease_token = NULL, last_error_code = ${failure.code}, updated_at = statement_timestamp()
    WHERE payment_order_id = ${job.paymentOrderId} AND lease_token = ${job.leaseToken}
      AND status = 'processing' AND locked_until > statement_timestamp() RETURNING payment_order_id`;
  return rows.length ? failure.terminal ? "manual_review" : "deferred" : "stale";
}
export async function dispatchPaymentPaidSync(deliver: (job: PaymentPaidSyncMessage) => Promise<void>, scope: PaymentPaidSyncScope,
  options: { limit?: number; sql?: Sql } = {}): Promise<{ queued: number; delivered: number; deferred: number; manual_review: number; stale: number }> {
  const sql = options.sql ?? configuredClient();
  const limit = options.limit ?? 5;
  const queued = await enqueueMissingPaymentPaidSync(scope, limit, sql);
  const result = { queued, delivered: 0, deferred: 0, manual_review: 0, stale: 0 };
  // Claim one at a time: a previous network timeout cannot consume a later job's lease.
  for (let i = 0; i < limit; i++) {
    const [job] = await claimPaymentPaidSync(scope, 1, 60, sql);
    if (!job) break;
    try {
      if (!await paymentPaidSyncStillEligible(job, sql)) throw { code: "paid_evidence_changed" };
      await deliver(job);
      if (await markPaymentPaidSyncDelivered(job, sql)) result.delivered++;
      else result.stale++;
    } catch (error) {
      result[await failOrRetryPaymentPaidSync(job, error, sql)]++;
    }
  }
  return result;
}
