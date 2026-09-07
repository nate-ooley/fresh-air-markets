import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  applicationReviewFingerprint,
  type ApplicationReviewAction,
  type ApplicationReviewState,
  stateForReviewAction,
  validApplicationId,
  validReviewIdempotencyKey,
  validSourceEventId,
} from "./application-review";

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;

export interface ApplicationReviewInput {
  applicationId: string;
  marketId: string;
  actorAccountId: string;
  sourceEventId: string;
  idempotencyKey: string;
  action: ApplicationReviewAction;
  reason: string;
}

export interface ApplicationReviewDetail {
  id: string;
  sourceEventId: string | null;
  reviewState: ApplicationReviewState;
  reviewRevision: number;
  hasOpportunity: boolean;
}

export type ApplicationReviewResult =
  | { kind: "applied"; applicationId: string; reviewState: ApplicationReviewState; reviewEventId: string; outboxId: string }
  | { kind: "duplicate"; applicationId: string; reviewState: ApplicationReviewState; reviewEventId: string; outboxId: string | null }
  | { kind: "conflict" }
  | { kind: "not_found" }
  | { kind: "missing_opportunity" }
  | { kind: "stale_source"; sourceEventId: string | null }
  | { kind: "terminal"; reviewState: ApplicationReviewState }
  | { kind: "awaiting_resubmission" };

export interface ApplicationReviewOutboxPayload {
  applicationId: string;
  reviewEventId: string;
  sourceEventId: string;
  marketId: string;
  locationId: string;
  contactId: string;
  opportunityId: string;
  seasonId: string;
  reviewState: ApplicationReviewState;
  actorAccountId: string;
  reason: string;
}

export interface ApplicationReviewOutboxMessage {
  id: string;
  marketId: string;
  attempt: number;
  leaseToken: string;
  payload: ApplicationReviewOutboxPayload;
}

export interface ApplicationReviewDispatchResult {
  delivered: number;
  deferred: number;
  stale: number;
}

interface ApplicationRow {
  id: string;
  market_id: string;
  location_id: string;
  contact_id: string;
  season_id: string;
  opportunity_id: string | null;
  review_state: ApplicationReviewState;
  review_revision: number;
}

interface ReviewEventRow {
  id: string;
  payload_hash: string;
  outbox_id: string | null;
  source_event_id: string;
}

function applicationIdentityKey(application: Pick<ApplicationRow, "market_id" | "location_id" | "contact_id" | "season_id">): string {
  return [application.market_id, application.location_id, application.contact_id, application.season_id].join("\u001f");
}

/** The review/outbox migration is deliberately a release prerequisite. */
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent application review storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

function applicationState(value: string): ApplicationReviewState {
  if (value === "needs_review" || value === "changes_requested" || value === "approved" || value === "declined") return value;
  return "unreviewed";
}

/**
 * Returns only the identifiers a signed-in market operator needs to render an
 * exact review screen. It intentionally excludes source snapshots and email.
 */
export async function getApplicationReviewDetail(
  applicationId: string,
  marketId: string,
  sql: Sql = configuredClient(),
): Promise<ApplicationReviewDetail | null> {
  const [application] = await sql<ApplicationRow[]>`
    SELECT id, market_id, location_id, contact_id, season_id, opportunity_id, review_state, review_revision
    FROM fame_applications
    WHERE id = ${applicationId} AND market_id = ${marketId}`;
  if (!application) return null;
  const [latest] = await sql<{ event_id: string }[]>`
    SELECT event_id FROM fame_application_events
    WHERE application_id = ${application.id}
    ORDER BY created_at DESC, event_id DESC
    LIMIT 1`;
  return {
    id: application.id,
    sourceEventId: latest?.event_id ?? null,
    reviewState: applicationState(application.review_state),
    reviewRevision: Number(application.review_revision),
    hasOpportunity: Boolean(application.opportunity_id),
  };
}

/**
 * Atomically records an authorized market operator's decision for exactly one
 * internal application ID and its latest captured source event. The same
 * transaction creates a durable outbound work item, so a crash cannot leave a
 * saved decision with no record that its downstream workflow still needs work.
 */
export async function recordApplicationReview(
  input: ApplicationReviewInput,
  sql: Sql = configuredClient(),
): Promise<ApplicationReviewResult> {
  // Current portal sessions authenticate a market operator account. There is
  // no separate user/role table yet, so never accept an arbitrary actor ID.
  if (input.actorAccountId !== input.marketId) throw new Error("Review actor is not authorized for this market.");
  if (!validApplicationId(input.applicationId)
    || !validReviewIdempotencyKey(input.idempotencyKey)
    || !validSourceEventId(input.sourceEventId)
    || (input.action !== "approve" && input.action !== "request_changes" && input.action !== "decline")
    || typeof input.reason !== "string" || input.reason.length > 2000
    || (input.action !== "approve" && !input.reason.trim())) {
    throw new Error("Application review input is invalid.");
  }
  const payloadHash = applicationReviewFingerprint(
    input.applicationId,
    input.sourceEventId,
    input.action,
    input.reason,
  );
  return sql.begin(async tx => {
    // Read the immutable identity first without holding a row lock, then take
    // the same advisory lock used by source capture. Holding the row lock
    // before the advisory lock could deadlock against an inbound handoff.
    const [candidate] = await tx<ApplicationRow[]>`
      SELECT id, market_id, location_id, contact_id, season_id, opportunity_id, review_state, review_revision
      FROM fame_applications
      WHERE id = ${input.applicationId} AND market_id = ${input.marketId}`;
    if (!candidate) return { kind: "not_found" };
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${applicationIdentityKey(candidate)}, 0))`;
    const [application] = await tx<ApplicationRow[]>`
      SELECT id, market_id, location_id, contact_id, season_id, opportunity_id, review_state, review_revision
      FROM fame_applications
      WHERE id = ${input.applicationId} AND market_id = ${input.marketId}
      FOR UPDATE`;
    if (!application) return { kind: "not_found" };

    // A replay must be recognized before terminal/stale checks, because the
    // original action may itself have made the application terminal.
    const [prior] = await tx<ReviewEventRow[]>`
      SELECT id, payload_hash, outbox_id, source_event_id
      FROM fame_application_review_events
      WHERE application_id = ${application.id} AND idempotency_key = ${input.idempotencyKey}`;
    if (prior) {
      if (prior.payload_hash !== payloadHash) return { kind: "conflict" };
      return {
        kind: "duplicate",
        applicationId: application.id,
        reviewState: applicationState(application.review_state),
        reviewEventId: prior.id,
        outboxId: prior.outbox_id,
      };
    }

    const [latest] = await tx<{ event_id: string }[]>`
      SELECT event_id FROM fame_application_events
      WHERE application_id = ${application.id}
      ORDER BY created_at DESC, event_id DESC
      LIMIT 1`;
    if (!latest || latest.event_id !== input.sourceEventId) {
      return { kind: "stale_source", sourceEventId: latest?.event_id ?? null };
    }
    if (!application.opportunity_id) return { kind: "missing_opportunity" };

    const currentState = applicationState(application.review_state);
    if (currentState === "approved" || currentState === "declined") {
      return { kind: "terminal", reviewState: currentState };
    }
    if (currentState === "changes_requested") {
      const [lastReview] = await tx<ReviewEventRow[]>`
        SELECT id, payload_hash, outbox_id, source_event_id
        FROM fame_application_review_events
        WHERE application_id = ${application.id}
        ORDER BY created_at DESC, id DESC
        LIMIT 1`;
      if (lastReview?.source_event_id === input.sourceEventId) return { kind: "awaiting_resubmission" };
    }

    const reviewState = stateForReviewAction(input.action);
    const reviewEventId = randomUUID();
    const outboxId = randomUUID();
    const payload: ApplicationReviewOutboxPayload = {
      applicationId: application.id,
      reviewEventId,
      sourceEventId: input.sourceEventId,
      marketId: application.market_id,
      locationId: application.location_id,
      contactId: application.contact_id,
      opportunityId: application.opportunity_id,
      seasonId: application.season_id,
      reviewState,
      actorAccountId: input.actorAccountId,
      reason: input.reason,
    };

    await tx`
      UPDATE fame_applications
      SET review_state = ${reviewState},
          review_revision = review_revision + 1,
          reviewed_at = statement_timestamp(),
          reviewed_by_account_id = ${input.actorAccountId}
      WHERE id = ${application.id} AND market_id = ${input.marketId}`;
    // The outbox record is written before the audit row because the audit row
    // has a foreign key to it. Both writes remain in this one transaction.
    const created = await tx`
      INSERT INTO fame_application_outbox
        (id, market_id, topic, dedupe_key, payload)
      VALUES
        (${outboxId}, ${application.market_id}, 'application-review',
         ${`application-review:${reviewEventId}`},
         ${tx.json(payload as unknown as Parameters<typeof tx.json>[0])})
      RETURNING id`;
    if (!created.length) throw new Error("Application review outbox write failed.");
    await tx`
      INSERT INTO fame_application_review_events
        (id, application_id, market_id, source_event_id, actor_account_id, idempotency_key,
         payload_hash, from_state, to_state, reason, outbox_id)
      VALUES
        (${reviewEventId}, ${application.id}, ${application.market_id}, ${input.sourceEventId},
         ${input.actorAccountId}, ${input.idempotencyKey}, ${payloadHash}, ${currentState},
         ${reviewState}, ${input.reason}, ${outboxId})`;
    return { kind: "applied", applicationId: application.id, reviewState, reviewEventId, outboxId };
  });
}

/** Claim due jobs without touching HighLevel. A worker supplies the delivery
 * function below, allowing retry/recovery to be tested without external UI.
 */
export async function claimApplicationReviewOutbox(
  limit = 10,
  leaseSeconds = 300,
  sql: Sql = configuredClient(),
): Promise<ApplicationReviewOutboxMessage[]> {
  return claimApplicationReviewOutboxWhere(null, limit, leaseSeconds, sql);
}

/** Claim one newly committed job without allowing it to steal an unrelated
 * ready item. This lets the review screen request an immediate delivery while
 * the normal scheduler remains the recovery path. */
export async function claimApplicationReviewOutboxById(
  id: string,
  leaseSeconds = 300,
  sql: Sql = configuredClient(),
): Promise<ApplicationReviewOutboxMessage[]> {
  if (!validApplicationId(id)) throw new Error("Application review outbox ID is invalid.");
  return claimApplicationReviewOutboxWhere(id, 1, leaseSeconds, sql);
}

async function claimApplicationReviewOutboxWhere(
  onlyId: string | null,
  limit: number,
  leaseSeconds: number,
  sql: Sql,
): Promise<ApplicationReviewOutboxMessage[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Outbox claim limit is invalid.");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 3600) throw new Error("Outbox lease is invalid.");
  const leaseToken = randomUUID();
  return sql.begin(async tx => {
    const rows = await tx<{
      id: string; market_id: string; attempts: number; lease_token: string; payload: ApplicationReviewOutboxPayload;
    }[]>`
      WITH next AS (
        SELECT id
        FROM fame_application_outbox
        WHERE ((status = 'pending' AND next_attempt_at <= statement_timestamp())
           OR (status = 'processing' AND locked_until <= statement_timestamp()))
          AND (${onlyId}::TEXT IS NULL OR id = ${onlyId})
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE fame_application_outbox AS job
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

/** A stale worker cannot mark another worker's lease delivered. */
export async function markApplicationReviewOutboxDelivered(
  id: string,
  leaseToken: string,
  sql: Sql = configuredClient(),
): Promise<boolean> {
  const rows = await sql`
    UPDATE fame_application_outbox
    SET status = 'delivered', delivered_at = statement_timestamp(), locked_until = NULL,
        lease_token = NULL, last_error_code = NULL
    WHERE id = ${id} AND status = 'processing' AND lease_token = ${leaseToken}
    RETURNING id`;
  return rows.length === 1;
}

/**
 * Stores a short safe error code only. Raw provider errors can contain vendor
 * details or credentials and must remain in the worker's private logs.
 */
export async function retryApplicationReviewOutbox(
  id: string,
  leaseToken: string,
  errorCode: string,
  delaySeconds: number,
  sql: Sql = configuredClient(),
): Promise<boolean> {
  if (!/^[a-z0-9_.:-]{1,64}$/.test(errorCode)) throw new Error("Outbox error code is invalid.");
  if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86_400) throw new Error("Outbox retry delay is invalid.");
  const rows = await sql`
    UPDATE fame_application_outbox
    SET status = 'pending',
        next_attempt_at = statement_timestamp() + (${delaySeconds} * interval '1 second'),
        locked_until = NULL, lease_token = NULL, last_error_code = ${errorCode}
    WHERE id = ${id} AND status = 'processing' AND lease_token = ${leaseToken}
    RETURNING id`;
  return rows.length === 1;
}

export type ApplicationReviewDelivery = (message: ApplicationReviewOutboxMessage) => Promise<void>;

function deliveryFailure(error: unknown, attempt: number): { code: string; delaySeconds: number } {
  const fallback = Math.min(3600, 30 * 2 ** Math.min(attempt - 1, 6));
  if (!error || typeof error !== "object") return { code: "delivery_failed", delaySeconds: fallback };
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
  return { code, delaySeconds };
}

async function dispatchClaimedApplicationReviewOutbox(
  jobs: ApplicationReviewOutboxMessage[],
  deliver: ApplicationReviewDelivery,
  sql: Sql | undefined,
): Promise<ApplicationReviewDispatchResult> {
  let delivered = 0;
  let deferred = 0;
  let stale = 0;
  for (const job of jobs) {
    try {
      await deliver(job);
      if (await markApplicationReviewOutboxDelivered(job.id, job.leaseToken, sql)) delivered++;
      else stale++;
    } catch (error) {
      const failure = deliveryFailure(error, job.attempt);
      if (await retryApplicationReviewOutbox(job.id, job.leaseToken, failure.code, failure.delaySeconds, sql)) deferred++;
      else stale++;
    }
  }
  return { delivered, deferred, stale };
}

/**
 * A scheduler/worker calls this with its authenticated downstream delivery
 * implementation. This module never makes a HighLevel request by itself.
 */
export async function dispatchApplicationReviewOutbox(
  deliver: ApplicationReviewDelivery,
  options: { limit?: number; leaseSeconds?: number; sql?: Sql } = {},
): Promise<ApplicationReviewDispatchResult> {
  const jobs = await claimApplicationReviewOutbox(options.limit ?? 10, options.leaseSeconds ?? 300, options.sql);
  return dispatchClaimedApplicationReviewOutbox(jobs, deliver, options.sql);
}

/** Attempt exactly one committed review job immediately after a portal
 * decision. If another worker already holds its lease, it returns no work and
 * leaves that worker as the sole delivery owner. */
export async function dispatchApplicationReviewOutboxById(
  id: string,
  deliver: ApplicationReviewDelivery,
  options: { leaseSeconds?: number; sql?: Sql } = {},
): Promise<ApplicationReviewDispatchResult> {
  const jobs = await claimApplicationReviewOutboxById(id, options.leaseSeconds ?? 60, options.sql);
  return dispatchClaimedApplicationReviewOutbox(jobs, deliver, options.sql);
}
