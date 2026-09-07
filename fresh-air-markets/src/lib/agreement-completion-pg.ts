import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  AgreementAlreadyCompletedError,
  AgreementMappingError,
  type AgreementCompleted,
  type AgreementIngressResult,
  type AgreementIssued,
  validAgreementId,
} from "./agreement-completion";

type Sql = ReturnType<typeof postgres>;
type Query = postgres.ISql;
let client: Sql | undefined;

interface ApplicationRow {
  id: string;
  market_id: string;
  location_id: string;
  contact_id: string;
  season_id: string;
  opportunity_id: string | null;
}

interface AgreementEventRow {
  payload_hash: string;
  market_id: string;
  event_kind: "issued" | "completed";
}

interface AgreementIssuanceRow {
  application_id: string;
  market_id: string;
  location_id: string;
  contact_id: string;
  opportunity_id: string;
  season_id: string;
  template_id: string;
  document_id: string;
  superseded_at: Date | null;
}

interface AgreementCompletionRow {
  id: string;
  document_id: string;
  template_id: string;
  contact_id: string;
  opportunity_id: string;
  season_id: string;
}

export interface AgreementNotificationPayload {
  applicationId: string;
  completionId: string;
  documentId: string;
  templateId: string;
  contactId: string;
  opportunityId: string;
  seasonId: string;
}

/** Immutable identity for the CRM stage update. This is deliberately separate
 * from the notification payload: a CRM receipt must never be mistaken for a
 * delivered email. */
export interface AgreementStageDeliveryPayload {
  applicationId: string;
  completionId: string;
  documentId: string;
  templateId: string;
  marketId: string;
  locationId: string;
  contactId: string;
  opportunityId: string;
  seasonId: string;
}

export interface AgreementStageDeliveryMessage {
  id: string;
  marketId: string;
  attempt: number;
  leaseToken: string;
  payload: AgreementStageDeliveryPayload;
}

export interface AgreementCompletionPersistence {
  outcome: AgreementIngressResult;
  stageOutboxId?: string;
}

export interface AgreementNotificationMessage {
  id: string;
  marketId: string;
  recipientEmail: string;
  attempt: number;
  leaseToken: string;
  payload: AgreementNotificationPayload;
}

export type AgreementNotificationDelivery = (message: AgreementNotificationMessage) => Promise<void>;

function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent agreement storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

async function recordEvent(
  tx: Query,
  event: AgreementIssued | AgreementCompleted,
  eventKind: "issued" | "completed",
): Promise<AgreementIngressResult | null> {
  const inserted = await tx`
    INSERT INTO fame_agreement_events
      (location_id, event_id, market_id, event_kind, document_id, payload_hash)
    VALUES
      (${event.locationId}, ${event.eventId}, ${event.marketId}, ${eventKind}, ${event.documentId}, ${event.payloadHash})
    ON CONFLICT (location_id, event_id) DO NOTHING
    RETURNING event_id`;
  if (inserted.length) return null;
  const [prior] = await tx<AgreementEventRow[]>`
    SELECT payload_hash, market_id, event_kind
    FROM fame_agreement_events
    WHERE location_id = ${event.locationId} AND event_id = ${event.eventId}`;
  return prior?.payload_hash === event.payloadHash
    && prior.market_id === event.marketId
    && prior.event_kind === eventKind
    ? "duplicate"
    : "conflict";
}

async function exactApplicationForEvent(
  tx: Query,
  event: AgreementIssued | AgreementCompleted,
): Promise<ApplicationRow> {
  const [application] = await tx<ApplicationRow[]>`
    SELECT id, market_id, location_id, contact_id, season_id, opportunity_id
    FROM fame_applications
    WHERE market_id = ${event.marketId}
      AND location_id = ${event.locationId}
      AND contact_id = ${event.contactId}
      AND season_id = ${event.seasonId}
      AND opportunity_id = ${event.opportunityId}
    FOR UPDATE`;
  if (!application) throw new AgreementMappingError();
  return application;
}

/**
 * Binds an issued agreement document to one exact portal application. A newer
 * document supersedes an unsigned prior document for that same application;
 * an old signing event can therefore never update the current application.
 */
export async function persistAgreementIssuance(
  event: AgreementIssued,
  sql: Sql = configuredClient(),
): Promise<AgreementIngressResult> {
  return sql.begin(async tx => {
    const prior = await recordEvent(tx, event, "issued");
    if (prior) return prior;
    const application = await exactApplicationForEvent(tx, event);
    const [completed] = await tx<AgreementCompletionRow[]>`
      SELECT id, document_id, template_id, contact_id, opportunity_id, season_id
      FROM fame_agreement_completions
      WHERE application_id = ${application.id}`;
    if (completed) throw new AgreementAlreadyCompletedError();

    // The application row lock makes concurrent reissues deterministic: the
    // later issued document becomes the only active document for that record.
    await tx`
      UPDATE fame_agreement_issuances
      SET superseded_at = statement_timestamp()
      WHERE application_id = ${application.id}
        AND superseded_at IS NULL
        AND document_id <> ${event.documentId}`;
    const issued = await tx`
      INSERT INTO fame_agreement_issuances
        (location_id, document_id, market_id, application_id, contact_id,
         opportunity_id, season_id, template_id, issued_event_id, payload_hash)
      VALUES
        (${event.locationId}, ${event.documentId}, ${event.marketId}, ${application.id},
         ${event.contactId}, ${event.opportunityId}, ${event.seasonId}, ${event.templateId},
         ${event.eventId}, ${event.payloadHash})
      ON CONFLICT DO NOTHING
      RETURNING document_id`;
    if (!issued.length) throw new AgreementMappingError();
    await tx`
      UPDATE fame_agreement_events
      SET application_id = ${application.id}
      WHERE location_id = ${event.locationId} AND event_id = ${event.eventId}`;
    return "captured";
  });
}

/**
 * Marks one exact active issuance complete and writes independent internal
 * notice and CRM-stage work items in the same transaction. This function never
 * contacts email or HighLevel; workers claim work only after commit.
 */
export async function persistAgreementCompletionWithStageOutbox(
  event: AgreementCompleted,
  sql: Sql = configuredClient(),
): Promise<AgreementCompletionPersistence> {
  return sql.begin(async tx => {
    const prior = await recordEvent(tx, event, "completed");
    if (prior) return { outcome: prior };
    // Read only the application key first, then take the same application-row
    // lock used by issuance. Re-read the issuance after that lock: otherwise a
    // concurrent reissue could supersede this document between these two
    // statements and an old signing event could slip through.
    const [issuanceKey] = await tx<{ application_id: string }[]>`
      SELECT application_id
      FROM fame_agreement_issuances
      WHERE location_id = ${event.locationId} AND document_id = ${event.documentId}`;
    if (!issuanceKey) throw new AgreementMappingError();
    const [application] = await tx<ApplicationRow[]>`
      SELECT id, market_id, location_id, contact_id, season_id, opportunity_id
      FROM fame_applications
      WHERE id = ${issuanceKey.application_id}
        AND market_id = ${event.marketId}
        AND location_id = ${event.locationId}
        AND contact_id = ${event.contactId}
        AND season_id = ${event.seasonId}
        AND opportunity_id = ${event.opportunityId}
      FOR UPDATE`;
    if (!application) throw new AgreementMappingError();
    const [issuance] = await tx<AgreementIssuanceRow[]>`
      SELECT application_id, market_id, location_id, contact_id, opportunity_id,
             season_id, template_id, document_id, superseded_at
      FROM fame_agreement_issuances
      WHERE location_id = ${event.locationId} AND document_id = ${event.documentId}`;
    if (!issuance
      || issuance.application_id !== application.id
      || issuance.superseded_at !== null
      || issuance.market_id !== event.marketId
      || issuance.location_id !== event.locationId
      || issuance.contact_id !== event.contactId
      || issuance.opportunity_id !== event.opportunityId
      || issuance.season_id !== event.seasonId
      || issuance.template_id !== event.templateId) throw new AgreementMappingError();

    const [completed] = await tx<AgreementCompletionRow[]>`
      SELECT id, document_id, template_id, contact_id, opportunity_id, season_id
      FROM fame_agreement_completions
      WHERE application_id = ${application.id}`;
    if (completed) {
      if (completed.document_id !== event.documentId
        || completed.template_id !== event.templateId
        || completed.contact_id !== event.contactId
        || completed.opportunity_id !== event.opportunityId
        || completed.season_id !== event.seasonId) throw new AgreementAlreadyCompletedError();
      await tx`
        UPDATE fame_agreement_events
        SET application_id = ${application.id}
        WHERE location_id = ${event.locationId} AND event_id = ${event.eventId}`;
      return { outcome: "duplicate" };
    }

    const completionId = randomUUID();
    const notificationOutboxId = randomUUID();
    const stageOutboxId = randomUUID();
    const notificationPayload: AgreementNotificationPayload = {
      applicationId: application.id,
      completionId,
      documentId: event.documentId,
      templateId: event.templateId,
      contactId: event.contactId,
      opportunityId: event.opportunityId,
      seasonId: event.seasonId,
    };
    const stagePayload: AgreementStageDeliveryPayload = {
      ...notificationPayload,
      marketId: event.marketId,
      locationId: event.locationId,
    };
    await tx`
      INSERT INTO fame_agreement_completions
        (id, application_id, market_id, location_id, contact_id, opportunity_id,
         season_id, document_id, template_id, completion_event_id)
      VALUES
        (${completionId}, ${application.id}, ${event.marketId}, ${event.locationId},
         ${event.contactId}, ${event.opportunityId}, ${event.seasonId},
         ${event.documentId}, ${event.templateId}, ${event.eventId})`;
    const outbox = await tx`
      INSERT INTO fame_agreement_notification_outbox
        (id, market_id, application_id, completion_id, recipient_email, topic,
         dedupe_key, payload)
      VALUES
        (${notificationOutboxId}, ${event.marketId}, ${application.id}, ${completionId},
         ${event.notificationEmail}, 'agreement-completed',
         ${`agreement-completed:${completionId}`},
         ${tx.json(notificationPayload as unknown as Parameters<typeof tx.json>[0])})
      RETURNING id`;
    if (!outbox.length) throw new Error("Agreement notification outbox write failed.");
    const stageOutbox = await tx`
      INSERT INTO fame_agreement_stage_outbox
        (id, market_id, application_id, completion_id, topic, dedupe_key, payload)
      VALUES
        (${stageOutboxId}, ${event.marketId}, ${application.id}, ${completionId},
         'agreement-completed-stage', ${`agreement-stage:${completionId}`},
         ${tx.json(stagePayload as unknown as Parameters<typeof tx.json>[0])})
      RETURNING id`;
    if (!stageOutbox.length) throw new Error("Agreement stage outbox write failed.");
    await tx`
      UPDATE fame_agreement_events
      SET application_id = ${application.id}
      WHERE location_id = ${event.locationId} AND event_id = ${event.eventId}`;
    return { outcome: "captured", stageOutboxId };
  });
}

/** Backwards-compatible completion persistence for the webhook boundary. */
export async function persistAgreementCompletion(
  event: AgreementCompleted,
  sql: Sql = configuredClient(),
): Promise<AgreementIngressResult> {
  return (await persistAgreementCompletionWithStageOutbox(event, sql)).outcome;
}

/** Claim due agreement notices. Expired leases are replayable, but a stale
 * worker cannot commit a result because completion/retry require its token.
 */
export async function claimAgreementNotificationOutbox(
  limit = 10,
  leaseSeconds = 300,
  sql: Sql = configuredClient(),
): Promise<AgreementNotificationMessage[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Outbox claim limit is invalid.");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 3600) throw new Error("Outbox lease is invalid.");
  const leaseToken = randomUUID();
  return sql.begin(async tx => {
    const rows = await tx<{
      id: string; market_id: string; recipient_email: string; attempts: number;
      lease_token: string; payload: AgreementNotificationPayload;
    }[]>`
      WITH next AS (
        SELECT id
        FROM fame_agreement_notification_outbox
        WHERE (status = 'pending' AND next_attempt_at <= statement_timestamp())
           OR (status = 'processing' AND locked_until <= statement_timestamp())
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE fame_agreement_notification_outbox AS job
      SET status = 'processing',
          attempts = job.attempts + 1,
          locked_until = statement_timestamp() + (${leaseSeconds} * interval '1 second'),
          lease_token = ${leaseToken}
      FROM next
      WHERE job.id = next.id
      RETURNING job.id, job.market_id, job.recipient_email, job.attempts,
                job.lease_token, job.payload`;
    return rows.map(row => ({
      id: row.id,
      marketId: row.market_id,
      recipientEmail: row.recipient_email,
      attempt: Number(row.attempts),
      leaseToken: row.lease_token,
      payload: row.payload,
    }));
  });
}

export async function markAgreementNotificationDelivered(
  id: string,
  leaseToken: string,
  sql: Sql = configuredClient(),
): Promise<boolean> {
  const rows = await sql`
    UPDATE fame_agreement_notification_outbox
    SET status = 'delivered', delivered_at = statement_timestamp(),
        locked_until = NULL, lease_token = NULL, last_error_code = NULL
    WHERE id = ${id} AND status = 'processing' AND lease_token = ${leaseToken}
      AND locked_until > statement_timestamp()
    RETURNING id`;
  return rows.length === 1;
}

/** Persist a bounded safe code, never a provider response or recipient data. */
export async function retryAgreementNotificationOutbox(
  id: string,
  leaseToken: string,
  errorCode: string,
  delaySeconds: number,
  sql: Sql = configuredClient(),
): Promise<boolean> {
  if (!/^[a-z0-9_.:-]{1,64}$/.test(errorCode)) throw new Error("Outbox error code is invalid.");
  if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86_400) throw new Error("Outbox retry delay is invalid.");
  const rows = await sql`
    UPDATE fame_agreement_notification_outbox
    SET status = 'pending',
        next_attempt_at = statement_timestamp() + (${delaySeconds} * interval '1 second'),
        locked_until = NULL, lease_token = NULL, last_error_code = ${errorCode}
    WHERE id = ${id} AND status = 'processing' AND lease_token = ${leaseToken}
      AND locked_until > statement_timestamp()
    RETURNING id`;
  return rows.length === 1;
}

/**
 * Delivery is injected, so this code can be fully pressure-tested without
 * sending a real email. A deployment must supply an authenticated sender and
 * only then schedule this worker.
 */
export async function dispatchAgreementNotificationOutbox(
  deliver: AgreementNotificationDelivery,
  options: { limit?: number; leaseSeconds?: number; sql?: Sql } = {},
): Promise<{ delivered: number; deferred: number; stale: number }> {
  const jobs = await claimAgreementNotificationOutbox(options.limit ?? 10, options.leaseSeconds ?? 300, options.sql);
  let delivered = 0;
  let deferred = 0;
  let stale = 0;
  for (const job of jobs) {
    try {
      await deliver(job);
      if (await markAgreementNotificationDelivered(job.id, job.leaseToken, options.sql)) delivered++;
      else stale++;
    } catch {
      const seconds = Math.min(3600, 30 * 2 ** Math.min(job.attempt - 1, 6));
      if (await retryAgreementNotificationOutbox(job.id, job.leaseToken, "delivery_failed", seconds, options.sql)) deferred++;
      else stale++;
    }
  }
  return { delivered, deferred, stale };
}

export type AgreementStageDelivery = (message: AgreementStageDeliveryMessage) => Promise<void>;
export interface AgreementStageDispatchResult { delivered: number; deferred: number; failed: number; stale: number }

/** Claim stage-transition work independently from internal email notices. */
export async function claimAgreementStageOutbox(
  limit = 10,
  leaseSeconds = 300,
  sql: Sql = configuredClient(),
): Promise<AgreementStageDeliveryMessage[]> {
  return claimAgreementStageOutboxWhere(null, limit, leaseSeconds, sql);
}

/** The completion webhook uses this to attempt only its own committed item. */
export async function claimAgreementStageOutboxById(
  id: string,
  leaseSeconds = 300,
  sql: Sql = configuredClient(),
): Promise<AgreementStageDeliveryMessage[]> {
  if (!validAgreementId(id)) throw new Error("Agreement stage outbox ID is invalid.");
  return claimAgreementStageOutboxWhere(id, 1, leaseSeconds, sql);
}

async function claimAgreementStageOutboxWhere(
  onlyId: string | null,
  limit: number,
  leaseSeconds: number,
  sql: Sql,
): Promise<AgreementStageDeliveryMessage[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Outbox claim limit is invalid.");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 3600) throw new Error("Outbox lease is invalid.");
  const leaseToken = randomUUID();
  return sql.begin(async tx => {
    const rows = await tx<{
      id: string; market_id: string; attempts: number; lease_token: string; payload: AgreementStageDeliveryPayload;
    }[]>`
      WITH next AS (
        SELECT id
        FROM fame_agreement_stage_outbox
        WHERE ((status = 'pending' AND next_attempt_at <= statement_timestamp())
           OR (status = 'processing' AND locked_until <= statement_timestamp()))
          AND (${onlyId}::TEXT IS NULL OR id = ${onlyId})
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE fame_agreement_stage_outbox AS job
      SET status = 'processing',
          attempts = job.attempts + 1,
          locked_until = statement_timestamp() + (${leaseSeconds} * interval '1 second'),
          lease_token = ${leaseToken}
      FROM next
      WHERE job.id = next.id
      RETURNING job.id, job.market_id, job.attempts, job.lease_token, job.payload`;
    return rows.map(row => ({
      id: row.id,
      marketId: row.market_id,
      attempt: Number(row.attempts),
      leaseToken: row.lease_token,
      payload: row.payload,
    }));
  });
}

/** A worker whose lease expired cannot complete a newer worker's result. */
export async function markAgreementStageOutboxDelivered(
  id: string,
  leaseToken: string,
  sql: Sql = configuredClient(),
): Promise<boolean> {
  const rows = await sql`
    UPDATE fame_agreement_stage_outbox
    SET status = 'delivered', delivered_at = statement_timestamp(),
        locked_until = NULL, lease_token = NULL, last_error_code = NULL
    WHERE id = ${id} AND status = 'processing' AND lease_token = ${leaseToken}
      AND locked_until > statement_timestamp()
    RETURNING id`;
  return rows.length === 1;
}

/** Provider diagnostics never enter the durable application ledger. */
export async function retryAgreementStageOutbox(
  id: string,
  leaseToken: string,
  errorCode: string,
  delaySeconds: number,
  sql: Sql = configuredClient(),
): Promise<boolean> {
  if (!/^[a-z0-9_.:-]{1,64}$/.test(errorCode)) throw new Error("Outbox error code is invalid.");
  if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86_400) throw new Error("Outbox retry delay is invalid.");
  const rows = await sql`
    UPDATE fame_agreement_stage_outbox
    SET status = 'pending',
        next_attempt_at = statement_timestamp() + (${delaySeconds} * interval '1 second'),
        locked_until = NULL, lease_token = NULL, last_error_code = ${errorCode}
    WHERE id = ${id} AND status = 'processing' AND lease_token = ${leaseToken}
      AND locked_until > statement_timestamp()
    RETURNING id`;
  return rows.length === 1;
}

/**
 * Record a permanent provider/domain failure without pretending that the CRM
 * update succeeded. Failed rows are intentionally excluded from future claims;
 * an operator must inspect and explicitly requeue a corrected mapping.
 */
export async function failAgreementStageOutbox(
  id: string,
  leaseToken: string,
  errorCode: string,
  sql: Sql = configuredClient(),
): Promise<boolean> {
  if (!/^[a-z0-9_.:-]{1,64}$/.test(errorCode)) throw new Error("Outbox error code is invalid.");
  const rows = await sql`
    UPDATE fame_agreement_stage_outbox
    SET status = 'failed', failed_at = statement_timestamp(),
        locked_until = NULL, lease_token = NULL, last_error_code = ${errorCode}
    WHERE id = ${id} AND status = 'processing' AND lease_token = ${leaseToken}
      AND locked_until > statement_timestamp()
    RETURNING id`;
  return rows.length === 1;
}

const TERMINAL_STAGE_DELIVERY_CODES = new Set([
  "ghl_config_missing",
  "ghl_identity_mismatch",
  "ghl_pipeline_mismatch",
  "ghl_rejected",
  "ghl_stage_diverged",
  "ghl_status_diverged",
]);

function stageDeliveryFailure(error: unknown, attempt: number): { code: string; delaySeconds: number; terminal: boolean } {
  const fallback = Math.min(3600, 30 * 2 ** Math.min(attempt - 1, 6));
  if (!error || typeof error !== "object") return { code: "delivery_failed", delaySeconds: fallback, terminal: false };
  const candidate = error as { code?: unknown; retryAfterSeconds?: unknown };
  const code = typeof candidate.code === "string" && /^[a-z0-9_.:-]{1,64}$/.test(candidate.code)
    ? candidate.code
    : "delivery_failed";
  const retryAfterSeconds = candidate.retryAfterSeconds;
  const delaySeconds = Number.isInteger(retryAfterSeconds)
    && Number(retryAfterSeconds) >= 1
    && Number(retryAfterSeconds) <= 3600
    ? Number(retryAfterSeconds)
    : fallback;
  return { code, delaySeconds, terminal: TERMINAL_STAGE_DELIVERY_CODES.has(code) };
}

async function dispatchClaimedAgreementStageOutbox(
  jobs: AgreementStageDeliveryMessage[],
  deliver: AgreementStageDelivery,
  sql: Sql | undefined,
): Promise<AgreementStageDispatchResult> {
  let delivered = 0;
  let deferred = 0;
  let failed = 0;
  let stale = 0;
  for (const job of jobs) {
    try {
      await deliver(job);
      if (await markAgreementStageOutboxDelivered(job.id, job.leaseToken, sql)) delivered++;
      else stale++;
    } catch (error) {
      const failure = stageDeliveryFailure(error, job.attempt);
      if (failure.terminal) {
        if (await failAgreementStageOutbox(job.id, job.leaseToken, failure.code, sql)) failed++;
        else stale++;
      } else if (await retryAgreementStageOutbox(job.id, job.leaseToken, failure.code, failure.delaySeconds, sql)) deferred++;
      else stale++;
    }
  }
  return { delivered, deferred, failed, stale };
}

/** Recovery worker; delivery receives only a committed exact-ID message. */
export async function dispatchAgreementStageOutbox(
  deliver: AgreementStageDelivery,
  options: { limit?: number; leaseSeconds?: number; sql?: Sql } = {},
): Promise<AgreementStageDispatchResult> {
  const jobs = await claimAgreementStageOutbox(options.limit ?? 10, options.leaseSeconds ?? 300, options.sql);
  return dispatchClaimedAgreementStageOutbox(jobs, deliver, options.sql);
}

/** Immediate, exact-job attempt after a committed agreement completion. */
export async function dispatchAgreementStageOutboxById(
  id: string,
  deliver: AgreementStageDelivery,
  options: { leaseSeconds?: number; sql?: Sql } = {},
): Promise<AgreementStageDispatchResult> {
  const jobs = await claimAgreementStageOutboxById(id, options.leaseSeconds ?? 60, options.sql);
  return dispatchClaimedAgreementStageOutbox(jobs, deliver, options.sql);
}
