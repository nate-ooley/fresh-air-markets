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
import { FRESH_AIR_SEASON_DATES } from "./fresh-air-season";

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
  /**
   * A deliberately small projection of the snapshot on the exact current
   * source event. Internal CRM identifiers, tokens, unknown form answers and
   * prior snapshots never leave this module.
   */
  identitySnapshot: ApplicationReviewIdentitySnapshot | null;
}

export interface ApplicationReviewIdentitySnapshot {
  vendorName: string;
  businessName: string;
  email: string;
  applicantType: string;
  dates: string[];
  fullSeason: boolean;
  requiresFinalDateConfirmation: boolean;
  category: string;
  details: string | null;
  /** Booths per market day the vendor asked for; 1 when the source did not say. */
  boothsRequested: number;
}

export interface ApplicationReviewListItem extends ApplicationReviewDetail {}

export type ApplicationReviewResult =
  | { kind: "applied"; applicationId: string; reviewState: ApplicationReviewState; reviewEventId: string; outboxId: string }
  | { kind: "duplicate"; applicationId: string; reviewState: ApplicationReviewState; reviewEventId: string; outboxId: string | null }
  | { kind: "conflict" }
  | { kind: "not_found" }
  | { kind: "missing_opportunity" }
  | { kind: "missing_identity_snapshot" }
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
  failed: number;
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

interface SourceEventRow {
  event_id: string;
  snapshot: unknown;
}

interface ApplicationListRow extends ApplicationRow {
  event_id: string | null;
  snapshot: unknown | null;
}

const MAX_SNAPSHOT_FIELD_LENGTH = 200;
const MAX_SNAPSHOT_DETAILS_LENGTH = 2000;
const MAX_SNAPSHOT_DATES = 64;
const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAMED_MARKET_DATES = new Set(FRESH_AIR_SEASON_DATES.map(date => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
  weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
})));
// This exact legacy AI Studio value remains display-only. It must not be
// converted into a billable May 29 selection without a later final reservation.
const FULL_SEASON_LABELS = new Set(["Full Season (Oct 3 - May 27)", "Full Season (Oct 3 - May 29)"]);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maximumLength ? text : null;
}

function firstSafeText(source: Record<string, unknown>, keys: readonly string[], maximumLength: number): string | null {
  for (const key of keys) {
    const text = safeText(source[key], maximumLength);
    if (text) return text;
  }
  return null;
}

function validSnapshotDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function sourceDateSelection(value: unknown): { dates: string[]; fullSeason: boolean; requiresFinalDateConfirmation: boolean } | null {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOT_DATES) return null;
  const dates = value.map(entry => typeof entry === "string" ? entry.trim() : "");
  if (!dates.length) return { dates: [], fullSeason: false, requiresFinalDateConfirmation: false };
  if (dates.length === 1 && FULL_SEASON_LABELS.has(dates[0])) {
    return { dates, fullSeason: true, requiresFinalDateConfirmation: dates[0] === "Full Season (Oct 3 - May 27)" };
  }
  if (!dates.every(date => validSnapshotDate(date) || NAMED_MARKET_DATES.has(date))
    || new Set(dates).size !== dates.length) return null;
  return {
    dates: [...dates].sort(),
    fullSeason: false,
    // A normalized historical May 27 date is still preliminary. Do not let a
    // sender bypass the final-date confirmation merely by changing its label.
    requiresFinalDateConfirmation: dates.includes("2027-05-27"),
  };
}

function sourceApplicantType(source: Record<string, unknown>): "Vendor" | "Non-Profit Organization" | null {
  const value = firstSafeText(source, ["registrationType", "applicantType"], MAX_SNAPSHOT_FIELD_LENGTH);
  if (value === "Vendor") return "Vendor";
  if (value === "Non-Profit" || value === "Non-Profit Organization") return "Non-Profit Organization";
  return null;
}

function sourceName(source: Record<string, unknown>): string | null {
  const firstName = firstSafeText(source, ["firstName", "first_name"], 100);
  const lastName = firstSafeText(source, ["lastName", "last_name"], 100);
  const fromParts = [firstName, lastName].filter((part): part is string => Boolean(part)).join(" ");
  return fromParts || firstSafeText(source, ["vendorName", "name"], MAX_SNAPSHOT_FIELD_LENGTH);
}

function sourceVendorCategory(source: Record<string, unknown>): string | null {
  const category = firstSafeText(source, ["vendorCategory", "category"], MAX_SNAPSHOT_FIELD_LENGTH);
  if (category !== "Other") return category;
  const other = firstSafeText(source, ["otherCategory"], MAX_SNAPSHOT_FIELD_LENGTH);
  return other ? `Other — ${other}` : null;
}

/**
 * Project only the staff-facing fields from the immutable handoff envelope.
 * The envelope itself is written by persistApplicationHandoff as
 * { contactId, opportunityId, seasonId, snapshot }; read nothing except the
 * nested source snapshot, even when an event row has other JSON properties.
 * The accepted keys mirror the AI Studio form: firstName/lastName,
 * registrationType, businessName or orgName, vendorDatesRequested,
 * vendorCategory, and message or mission. HighLevel custom-field IDs must be
 * normalized into those explicit names by the handoff sender.
 */
export function reviewIdentitySnapshot(value: unknown): ApplicationReviewIdentitySnapshot | null {
  const envelope = objectValue(value);
  const source = objectValue(envelope?.snapshot);
  if (!source) return null;

  const applicantType = sourceApplicantType(source);
  const vendorName = sourceName(source);
  const businessName = applicantType === "Vendor"
    ? firstSafeText(source, ["businessName", "vendorBusinessName"], MAX_SNAPSHOT_FIELD_LENGTH)
    : firstSafeText(source, ["orgName", "nonProfitOrgName"], MAX_SNAPSHOT_FIELD_LENGTH);
  const email = firstSafeText(source, ["email"], 254);
  const selection = applicantType === "Vendor"
    ? sourceDateSelection(source.vendorDatesRequested ?? source.selectedDates ?? source.requestedDates ?? source.dates)
    : { dates: [], fullSeason: false, requiresFinalDateConfirmation: false };
  const fullSeason = source.fullSeason === true || Boolean(selection?.fullSeason);
  const requiresFinalDateConfirmation = selection?.requiresFinalDateConfirmation
    || (source.fullSeason === true && !selection?.fullSeason);
  const dates = selection?.dates ?? [];
  const category = applicantType === "Vendor" ? sourceVendorCategory(source) : "Non-Profit Organization";
  const details = applicantType === "Non-Profit Organization"
    ? firstSafeText(source, ["mission", "nonProfitMission"], MAX_SNAPSHOT_DETAILS_LENGTH)
    : firstSafeText(source, ["details", "message", "description"], MAX_SNAPSHOT_DETAILS_LENGTH);

  const requested = source.boothsRequested;
  const boothsRequested = typeof requested === "number" && Number.isSafeInteger(requested) && requested >= 1 && requested <= 50 ? requested : 1;

  if (!vendorName || !businessName || !email || !SIMPLE_EMAIL.test(email)
    || !applicantType || !category || !selection || (applicantType === "Non-Profit Organization" && !details)) return null;
  return {
    boothsRequested,
    vendorName,
    businessName,
    email,
    applicantType,
    dates: dates ?? [],
    fullSeason,
    requiresFinalDateConfirmation,
    category,
    details,
  };
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

/** Returns the exact application and a deliberately whitelisted projection of
 * its latest source snapshot for the signed-in market only. */
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
  const [latest] = await sql<SourceEventRow[]>`
    SELECT event_id, snapshot FROM fame_application_events
    WHERE application_id = ${application.id}
      AND market_id = ${application.market_id}
      AND location_id = ${application.location_id}
    ORDER BY created_at DESC, event_id DESC
    LIMIT 1`;
  const sourceEventId = latest && validSourceEventId(latest.event_id) ? latest.event_id : null;
  return {
    id: application.id,
    sourceEventId,
    reviewState: applicationState(application.review_state),
    reviewRevision: Number(application.review_revision),
    hasOpportunity: Boolean(application.opportunity_id),
    identitySnapshot: sourceEventId ? reviewIdentitySnapshot(latest?.snapshot) : null,
  };
}

/**
 * Lists at most 100 exact, market-scoped applications. Every row uses the
 * current event from that same application/market/location; it never selects
 * an application by email, contact, opportunity, or a client-supplied market.
 */
export async function listApplicationReviewDetails(
  marketId: string,
  limit = 50,
  sql: Sql = configuredClient(),
): Promise<ApplicationReviewListItem[]> {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
  const rows = await sql<ApplicationListRow[]>`
    SELECT a.id, a.market_id, a.location_id, a.contact_id, a.season_id,
           a.opportunity_id, a.review_state, a.review_revision,
           source.event_id, source.snapshot
    FROM fame_applications AS a
    LEFT JOIN LATERAL (
      SELECT event_id, snapshot, created_at
      FROM fame_application_events
      WHERE application_id = a.id
        AND market_id = a.market_id
        AND location_id = a.location_id
      ORDER BY created_at DESC, event_id DESC
      LIMIT 1
    ) AS source ON TRUE
    WHERE a.market_id = ${marketId}
    ORDER BY source.created_at DESC NULLS LAST, a.created_at DESC, a.id DESC
    LIMIT ${boundedLimit}`;
  return rows.map(row => {
    const sourceEventId = row.event_id && validSourceEventId(row.event_id) ? row.event_id : null;
    return {
      id: row.id,
      sourceEventId,
      reviewState: applicationState(row.review_state),
      reviewRevision: Number(row.review_revision),
      hasOpportunity: Boolean(row.opportunity_id),
      identitySnapshot: sourceEventId ? reviewIdentitySnapshot(row.snapshot) : null,
    };
  });
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

    const [latest] = await tx<SourceEventRow[]>`
      SELECT event_id, snapshot FROM fame_application_events
      WHERE application_id = ${application.id}
        AND market_id = ${application.market_id}
        AND location_id = ${application.location_id}
      ORDER BY created_at DESC, event_id DESC
      LIMIT 1`;
    if (!latest || latest.event_id !== input.sourceEventId) {
      return { kind: "stale_source", sourceEventId: latest?.event_id ?? null };
    }
    // Do not allow a hand-crafted PATCH to bypass the manager UI's snapshot
    // guard. The decision remains bound to this exact source event, and staff
    // must be able to see its minimally complete identity before reviewing it.
    if (!reviewIdentitySnapshot(latest.snapshot)) return { kind: "missing_identity_snapshot" };
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

export type ApplicationReviewOutboxStatus = "pending" | "processing" | "delivered" | "failed";

/** A replay reads its original decision's result, never an unrelated current job. */
export async function getApplicationReviewOutboxStatus(
  input: { outboxId: string; reviewEventId: string; applicationId: string; marketId: string },
  sql: Sql = configuredClient(),
): Promise<ApplicationReviewOutboxStatus | null> {
  if (![input.outboxId, input.reviewEventId, input.applicationId].every(validApplicationId)) return null;
  const [row] = await sql<{ status: string }[]>`
    SELECT j.status
    FROM fame_application_outbox j
    JOIN fame_application_review_events e ON e.outbox_id = j.id AND e.market_id = j.market_id
    JOIN fame_applications a ON a.id = e.application_id AND a.market_id = e.market_id
    WHERE j.id = ${input.outboxId} AND j.market_id = ${input.marketId}
      AND e.id = ${input.reviewEventId} AND e.application_id = ${input.applicationId}
      AND j.topic = 'application-review'
      AND j.payload->>'applicationId' = e.application_id
      AND j.payload->>'reviewEventId' = e.id`;
  return row && (row.status === "pending" || row.status === "processing" || row.status === "delivered" || row.status === "failed")
    ? row.status : null;
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
      AND locked_until > statement_timestamp()
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
      AND locked_until > statement_timestamp()
    RETURNING id`;
  return rows.length === 1;
}

/**
 * Permanent identity, mapping, or provider rejections must be visible for an
 * operator to correct. Failed rows are intentionally excluded from claims.
 */
export async function failApplicationReviewOutbox(
  id: string,
  leaseToken: string,
  errorCode: string,
  sql: Sql = configuredClient(),
): Promise<boolean> {
  if (!/^[a-z0-9_.:-]{1,64}$/.test(errorCode)) throw new Error("Outbox error code is invalid.");
  const rows = await sql`
    UPDATE fame_application_outbox
    SET status = 'failed', failed_at = statement_timestamp(),
        locked_until = NULL, lease_token = NULL, last_error_code = ${errorCode}
    WHERE id = ${id} AND status = 'processing' AND lease_token = ${leaseToken}
      AND locked_until > statement_timestamp()
    RETURNING id`;
  return rows.length === 1;
}

export type ApplicationReviewDelivery = (message: ApplicationReviewOutboxMessage) => Promise<void>;

const TERMINAL_REVIEW_DELIVERY_CODES = new Set([
  "ghl_config_missing",
  "ghl_identity_mismatch",
  "ghl_pipeline_mismatch",
  "ghl_rejected",
  "ghl_stage_diverged",
  "ghl_status_diverged",
]);

function deliveryFailure(error: unknown, attempt: number): { code: string; delaySeconds: number; terminal: boolean } {
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
  return { code, delaySeconds, terminal: TERMINAL_REVIEW_DELIVERY_CODES.has(code) };
}

async function dispatchClaimedApplicationReviewOutbox(
  jobs: ApplicationReviewOutboxMessage[],
  deliver: ApplicationReviewDelivery,
  sql: Sql | undefined,
): Promise<ApplicationReviewDispatchResult> {
  let delivered = 0;
  let deferred = 0;
  let failed = 0;
  let stale = 0;
  for (const job of jobs) {
    try {
      await deliver(job);
      if (await markApplicationReviewOutboxDelivered(job.id, job.leaseToken, sql)) delivered++;
      else stale++;
    } catch (error) {
      const failure = deliveryFailure(error, job.attempt);
      if (failure.terminal) {
        if (await failApplicationReviewOutbox(job.id, job.leaseToken, failure.code, sql)) failed++;
        else stale++;
      } else if (await retryApplicationReviewOutbox(job.id, job.leaseToken, failure.code, failure.delaySeconds, sql)) deferred++;
      else stale++;
    }
  }
  return { delivered, deferred, failed, stale };
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
