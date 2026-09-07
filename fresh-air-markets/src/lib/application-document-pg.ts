import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  applicationDocumentReviewFingerprint,
  applicationDocumentScanFingerprint,
  applicationDocumentSourceFingerprint,
  documentReviewState,
  type ApplicationDocumentKind,
  type ApplicationDocumentSourceEvent,
  type DocumentReviewAction,
  type DocumentReviewState,
  type DocumentScanOutcome,
  type DocumentValidationState,
  type ValidatedDocumentUpload,
} from "./application-document";

type Sql = ReturnType<typeof postgres>;
type QuerySql = Sql | postgres.TransactionSql;
let client: Sql | undefined;

export interface ApplicationDocumentRecord {
  id: string;
  applicationId: string;
  marketId: string;
  kind: ApplicationDocumentKind;
  version: number;
  sourceEventId: string;
  file: ValidatedDocumentUpload;
  validationState: DocumentValidationState;
  reviewState: DocumentReviewState;
  reviewRevision: number;
  isCurrent: boolean;
}

export type ApplicationDocumentSourceResult =
  | { kind: "captured"; document: ApplicationDocumentRecord; outboxId: string }
  | { kind: "duplicate"; document: ApplicationDocumentRecord }
  | { kind: "conflict" };

export interface ApplicationDocumentScanInput {
  documentId: string;
  marketId: string;
  expectedVersion: number;
  sourceEventId: string;
  outcome: DocumentScanOutcome;
  reason: string;
}

export type ApplicationDocumentScanResult =
  | { kind: "applied"; documentId: string; validationState: DocumentValidationState; validationEventId: string; outboxId: string }
  | { kind: "duplicate"; documentId: string; validationState: DocumentValidationState; validationEventId: string; outboxId: string | null }
  | { kind: "conflict" }
  | { kind: "not_found" }
  | { kind: "stale"; currentVersion: number; isCurrent: boolean }
  | { kind: "not_pending"; validationState: DocumentValidationState };

export interface ApplicationDocumentReviewInput {
  documentId: string;
  marketId: string;
  actorAccountId: string;
  expectedVersion: number;
  idempotencyKey: string;
  action: DocumentReviewAction;
  reason: string;
}

export type ApplicationDocumentReviewResult =
  | { kind: "applied"; documentId: string; reviewState: DocumentReviewState; reviewEventId: string; outboxId: string }
  | { kind: "duplicate"; documentId: string; reviewState: DocumentReviewState; reviewEventId: string; outboxId: string | null }
  | { kind: "conflict" }
  | { kind: "not_found" }
  | { kind: "stale"; currentVersion: number; isCurrent: boolean }
  | { kind: "awaiting_validation"; validationState: DocumentValidationState }
  | { kind: "terminal"; reviewState: DocumentReviewState };

export type ApplicationDocumentOutboxTopic =
  | "document-submitted"
  | "document-ready-for-review"
  | "document-validation-rejected"
  | "document-review";

export interface ApplicationDocumentOutboxBase {
  topic: ApplicationDocumentOutboxTopic;
  applicationId: string;
  documentId: string;
  marketId: string;
  documentKind: ApplicationDocumentKind;
  version: number;
}

export interface ApplicationDocumentSubmittedOutbox extends ApplicationDocumentOutboxBase {
  topic: "document-submitted";
  sourceEventId: string;
  file: ValidatedDocumentUpload;
}

export interface ApplicationDocumentValidationOutbox extends ApplicationDocumentOutboxBase {
  topic: "document-ready-for-review" | "document-validation-rejected";
  validationEventId: string;
  sourceEventId: string;
  validationState: DocumentValidationState;
  reason: string;
}

export interface ApplicationDocumentReviewOutbox extends ApplicationDocumentOutboxBase {
  topic: "document-review";
  reviewEventId: string;
  actorAccountId: string;
  reviewState: DocumentReviewState;
  reason: string;
}

export type ApplicationDocumentOutboxPayload =
  | ApplicationDocumentSubmittedOutbox
  | ApplicationDocumentValidationOutbox
  | ApplicationDocumentReviewOutbox;

export interface ApplicationDocumentOutboxMessage {
  id: string;
  marketId: string;
  attempt: number;
  leaseToken: string;
  payload: ApplicationDocumentOutboxPayload;
}

/**
 * Immutable CRM/application identity resolved from the same database rows as
 * the document. A delivery worker receives this instead of doing a contact or
 * opportunity search of its own.
 */
export interface ApplicationDocumentDeliveryTarget {
  applicationId: string;
  marketId: string;
  locationId: string;
  contactId: string;
  opportunityId: string;
  seasonId: string;
  documentId: string;
  documentKind: ApplicationDocumentKind;
  version: number;
}

export type ApplicationDocumentDeliveryTargetResolution =
  | { kind: "ready"; target: ApplicationDocumentDeliveryTarget }
  | { kind: "stale" }
  | { kind: "identity_missing" };

export type ApplicationDocumentDeliveryEvent =
  | { topic: "document-submitted"; sourceEventId: string }
  | {
    topic: "document-ready-for-review" | "document-validation-rejected";
    validationEventId: string;
    sourceEventId: string;
    validationState: DocumentValidationState;
    reason: string;
  }
  | {
    topic: "document-review";
    reviewEventId: string;
    actorAccountId: string;
    reviewState: DocumentReviewState;
    reason: string;
  };

/**
 * The only contract passed to an external document delivery adapter. It
 * deliberately excludes storage keys, filenames, hashes, source file IDs and
 * public URLs. A provider-specific adapter can use the immutable application
 * and opportunity IDs, but cannot mistake arbitrary file metadata for a CRM
 * routing key.
 */
export interface ApplicationDocumentDeliveryEnvelope {
  schemaVersion: 1;
  outboxId: string;
  idempotencyKey: string;
  application: {
    id: string;
    marketId: string;
    locationId: string;
    contactId: string;
    opportunityId: string;
    seasonId: string;
  };
  document: {
    id: string;
    kind: ApplicationDocumentKind;
    version: number;
  };
  event: ApplicationDocumentDeliveryEvent;
}

/** A safe, typed failure code for the retrying outbox worker. */
export class ApplicationDocumentDeliveryError extends Error {
  public readonly code: string;
  public readonly retryAfterSeconds: number | undefined;

  constructor(code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface ApplicationRow {
  id: string;
  market_id: string;
  location_id: string;
}

interface DocumentRow {
  id: string;
  application_id: string;
  market_id: string;
  kind: ApplicationDocumentKind;
  version: number;
  source_event_id: string;
  source_file_id: string;
  storage_key: string;
  filename: string;
  content_type: ValidatedDocumentUpload["contentType"];
  size_bytes: number;
  content_sha256: string;
  validation_state: DocumentValidationState;
  review_state: DocumentReviewState;
  review_revision: number;
  is_current: boolean;
}

interface ApplicationDocumentDeliveryRow {
  document_id: string;
  application_id: string;
  market_id: string;
  kind: ApplicationDocumentKind;
  version: number;
  validation_state: DocumentValidationState;
  review_state: DocumentReviewState;
  is_current: boolean;
  application_record_id: string | null;
  location_id: string | null;
  contact_id: string | null;
  opportunity_id: string | null;
  season_id: string | null;
}

interface SourceEventRow {
  payload_hash: string;
  document_id: string | null;
}

interface ValidationEventRow {
  id: string;
  payload_hash: string;
  outbox_id: string | null;
}

interface ReviewEventRow {
  id: string;
  payload_hash: string;
  outbox_id: string | null;
}

function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent application document storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

const DELIVERY_IDENTIFIER = /^[A-Za-z0-9:_-]{1,192}$/;

function validDeliveryIdentifier(value: unknown): value is string {
  return typeof value === "string" && DELIVERY_IDENTIFIER.test(value);
}

function payloadMatchesCurrentDocument(
  payload: ApplicationDocumentOutboxPayload,
  validationState: DocumentValidationState,
  reviewState: DocumentReviewState,
): boolean {
  switch (payload.topic) {
    // A delayed received-file job must not reset a scan or review result.
    case "document-submitted":
      return validationState === "pending_scan" && reviewState === "submitted";
    // A manager decision moves the document beyond the scanner notification,
    // so late retries cannot send an obsolete review-ready/correction action.
    case "document-ready-for-review":
    case "document-validation-rejected":
      return validationState === payload.validationState && reviewState === "submitted";
    case "document-review":
      return reviewState === payload.reviewState;
  }
}

function deliveryEvent(payload: ApplicationDocumentOutboxPayload): ApplicationDocumentDeliveryEvent {
  switch (payload.topic) {
    case "document-submitted":
      return { topic: payload.topic, sourceEventId: payload.sourceEventId };
    case "document-ready-for-review":
    case "document-validation-rejected":
      return {
        topic: payload.topic,
        validationEventId: payload.validationEventId,
        sourceEventId: payload.sourceEventId,
        validationState: payload.validationState,
        reason: payload.reason,
      };
    case "document-review":
      return {
        topic: payload.topic,
        reviewEventId: payload.reviewEventId,
        actorAccountId: payload.actorAccountId,
        reviewState: payload.reviewState,
        reason: payload.reason,
      };
  }
}

/**
 * Create the provider-agnostic delivery payload only after the caller has
 * obtained a target from `resolveApplicationDocumentDeliveryTarget`. This
 * makes the stored application opportunity the sole routing identity: there
 * is no lookup by contact, name, or newest opportunity here.
 */
export function buildApplicationDocumentDeliveryEnvelope(
  message: ApplicationDocumentOutboxMessage,
  target: ApplicationDocumentDeliveryTarget,
): ApplicationDocumentDeliveryEnvelope {
  const payload = message.payload;
  if (!validDeliveryIdentifier(message.id)
    || !validDeliveryIdentifier(target.applicationId)
    || !validDeliveryIdentifier(target.marketId)
    || !validDeliveryIdentifier(target.locationId)
    || !validDeliveryIdentifier(target.contactId)
    || !validDeliveryIdentifier(target.opportunityId)
    || !validDeliveryIdentifier(target.seasonId)
    || !validDeliveryIdentifier(target.documentId)) {
    throw new ApplicationDocumentDeliveryError("document_identity_missing", "Document delivery is missing an exact application identity.");
  }
  if (target.applicationId !== payload.applicationId
    || target.marketId !== message.marketId
    || target.marketId !== payload.marketId
    || target.documentId !== payload.documentId
    || target.documentKind !== payload.documentKind
    || target.version !== payload.version) {
    throw new ApplicationDocumentDeliveryError("document_identity_mismatch", "Document delivery identity did not match its outbox record.");
  }
  return {
    schemaVersion: 1,
    outboxId: message.id,
    idempotencyKey: `fame-document:${message.id}`,
    application: {
      id: target.applicationId,
      marketId: target.marketId,
      locationId: target.locationId,
      contactId: target.contactId,
      opportunityId: target.opportunityId,
      seasonId: target.seasonId,
    },
    document: {
      id: target.documentId,
      kind: target.documentKind,
      version: target.version,
    },
    event: deliveryEvent(payload),
  };
}

function documentRecord(row: DocumentRow): ApplicationDocumentRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    marketId: row.market_id,
    kind: row.kind,
    version: Number(row.version),
    sourceEventId: row.source_event_id,
    file: {
      storageKey: row.storage_key,
      sourceFileId: row.source_file_id,
      filename: row.filename,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      sha256: row.content_sha256,
    },
    validationState: row.validation_state,
    reviewState: row.review_state,
    reviewRevision: Number(row.review_revision),
    isCurrent: row.is_current,
  };
}

async function documentForSourceEvent(tx: QuerySql, documentId: string): Promise<ApplicationDocumentRecord> {
  const [row] = await tx<DocumentRow[]>`
    SELECT id, application_id, market_id, kind, version, source_event_id, source_file_id,
           storage_key, filename, content_type, size_bytes, content_sha256,
           validation_state, review_state, review_revision, is_current
    FROM fame_application_documents
    WHERE id = ${documentId}`;
  if (!row) throw new Error("Document source event is missing its document record.");
  return documentRecord(row);
}

/**
 * Save an uploaded document as a new immutable version bound to one internal
 * application. The application row lock serializes same-application uploads,
 * so concurrent source events cannot produce two current version numbers.
 */
export async function persistApplicationDocumentSource(
  event: ApplicationDocumentSourceEvent,
  sql: Sql = configuredClient(),
): Promise<ApplicationDocumentSourceResult> {
  const payloadHash = applicationDocumentSourceFingerprint(event);
  return sql.begin(async tx => {
    const [application] = await tx<ApplicationRow[]>`
      SELECT id, market_id, location_id
      FROM fame_applications
      WHERE id = ${event.applicationId}
        AND market_id = ${event.marketId}
        AND location_id = ${event.locationId}
      FOR UPDATE`;
    if (!application) throw new Error("Configured application was not found for this market/location.");

    const inserted = await tx`
      INSERT INTO fame_document_source_events
        (location_id, event_id, market_id, application_id, payload_hash, payload)
      VALUES
        (${event.locationId}, ${event.eventId}, ${event.marketId}, ${event.applicationId},
         ${payloadHash}, ${tx.json({
           applicationId: event.applicationId,
           kind: event.kind,
           submittedAt: event.submittedAt,
           file: event.file,
         } as unknown as Parameters<typeof tx.json>[0])})
      ON CONFLICT (location_id, event_id) DO NOTHING
      RETURNING event_id`;
    if (!inserted.length) {
      const [prior] = await tx<SourceEventRow[]>`
        SELECT payload_hash, document_id
        FROM fame_document_source_events
        WHERE location_id = ${event.locationId} AND event_id = ${event.eventId}`;
      if (!prior || prior.payload_hash !== payloadHash || !prior.document_id) return { kind: "conflict" };
      return { kind: "duplicate", document: await documentForSourceEvent(tx, prior.document_id) };
    }

    // Source systems can deliver the same uploaded file more than once with
    // different webhook event IDs. Bind that later event to its immutable
    // document instead of creating a new pending version that could displace
    // an already reviewed certificate. A source system can assign a new file
    // ID or storage key when it retries the exact same bytes, so the verified
    // content type, size, and digest are the duplicate boundary here.
    const [existingDocument] = await tx<DocumentRow[]>`
      SELECT id, application_id, market_id, kind, version, source_event_id, source_file_id,
             storage_key, filename, content_type, size_bytes, content_sha256,
             validation_state, review_state, review_revision, is_current
      FROM fame_application_documents
      WHERE application_id = ${application.id}
        AND market_id = ${application.market_id}
        AND kind = ${event.kind}
        AND content_type = ${event.file.contentType}
        AND size_bytes = ${event.file.sizeBytes}
        AND content_sha256 = ${event.file.sha256}
      ORDER BY version DESC
      LIMIT 1`;
    if (existingDocument) {
      await tx`
        UPDATE fame_document_source_events
        SET document_id = ${existingDocument.id}
        WHERE location_id = ${event.locationId} AND event_id = ${event.eventId}`;
      return { kind: "duplicate", document: documentRecord(existingDocument) };
    }

    const [last] = await tx<{ version: number }[]>`
      SELECT COALESCE(MAX(version), 0) AS version
      FROM fame_application_documents
      WHERE application_id = ${application.id} AND kind = ${event.kind}`;
    const version = Number(last?.version ?? 0) + 1;
    const documentId = randomUUID();
    await tx`
      UPDATE fame_application_documents
      SET is_current = FALSE
      WHERE application_id = ${application.id} AND kind = ${event.kind} AND is_current`;
    await tx`
      INSERT INTO fame_application_documents
        (id, application_id, market_id, kind, version, source_event_id, source_file_id,
         storage_key, filename, content_type, size_bytes, content_sha256, submitted_at)
      VALUES
        (${documentId}, ${application.id}, ${application.market_id}, ${event.kind}, ${version},
         ${event.eventId}, ${event.file.sourceFileId}, ${event.file.storageKey}, ${event.file.filename},
         ${event.file.contentType}, ${event.file.sizeBytes}, ${event.file.sha256}, ${event.submittedAt})`;
    const outboxId = randomUUID();
    const outbox: ApplicationDocumentSubmittedOutbox = {
      topic: "document-submitted",
      applicationId: application.id,
      documentId,
      marketId: application.market_id,
      documentKind: event.kind,
      version,
      sourceEventId: event.eventId,
      file: event.file,
    };
    const outboxRows = await tx`
      INSERT INTO fame_document_outbox (id, market_id, topic, dedupe_key, payload)
      VALUES (${outboxId}, ${application.market_id}, ${outbox.topic}, ${`document-submitted:${documentId}`},
              ${tx.json(outbox as unknown as Parameters<typeof tx.json>[0])})
      RETURNING id`;
    if (!outboxRows.length) throw new Error("Document submission outbox write failed.");
    await tx`
      UPDATE fame_document_source_events
      SET document_id = ${documentId}
      WHERE location_id = ${event.locationId} AND event_id = ${event.eventId}`;
    const document = await documentForSourceEvent(tx, documentId);
    return { kind: "captured", document, outboxId };
  });
}

/**
 * A scanner/deep-parser records a result for the exact current document
 * version. It is the only transition from `pending_scan` to reviewable.
 */
export async function recordApplicationDocumentScan(
  input: ApplicationDocumentScanInput,
  sql: Sql = configuredClient(),
): Promise<ApplicationDocumentScanResult> {
  const payloadHash = applicationDocumentScanFingerprint(
    input.documentId, input.expectedVersion, input.sourceEventId, input.outcome, input.reason,
  );
  return sql.begin(async tx => {
    const [document] = await tx<DocumentRow[]>`
      SELECT id, application_id, market_id, kind, version, source_event_id, source_file_id,
             storage_key, filename, content_type, size_bytes, content_sha256,
             validation_state, review_state, review_revision, is_current
      FROM fame_application_documents
      WHERE id = ${input.documentId} AND market_id = ${input.marketId}
      FOR UPDATE`;
    if (!document) return { kind: "not_found" };
    const [prior] = await tx<ValidationEventRow[]>`
      SELECT id, payload_hash, outbox_id
      FROM fame_document_validation_events
      WHERE document_id = ${document.id} AND source_event_id = ${input.sourceEventId}`;
    if (prior) {
      if (prior.payload_hash !== payloadHash) return { kind: "conflict" };
      return {
        kind: "duplicate",
        documentId: document.id,
        validationState: document.validation_state,
        validationEventId: prior.id,
        outboxId: prior.outbox_id,
      };
    }
    if (!document.is_current || Number(document.version) !== input.expectedVersion) {
      return { kind: "stale", currentVersion: Number(document.version), isCurrent: document.is_current };
    }
    if (document.validation_state !== "pending_scan") return { kind: "not_pending", validationState: document.validation_state };

    const validationState: DocumentValidationState = input.outcome === "clean" ? "ready_for_review" : "rejected";
    const validationEventId = randomUUID();
    const outboxId = randomUUID();
    const topic: ApplicationDocumentValidationOutbox["topic"] = input.outcome === "clean"
      ? "document-ready-for-review"
      : "document-validation-rejected";
    const outbox: ApplicationDocumentValidationOutbox = {
      topic,
      applicationId: document.application_id,
      documentId: document.id,
      marketId: document.market_id,
      documentKind: document.kind,
      version: Number(document.version),
      validationEventId,
      sourceEventId: input.sourceEventId,
      validationState,
      reason: input.reason,
    };
    await tx`
      UPDATE fame_application_documents
      SET validation_state = ${validationState}, validation_reason = ${input.reason},
          validated_at = statement_timestamp()
      WHERE id = ${document.id}`;
    const outboxRows = await tx`
      INSERT INTO fame_document_outbox (id, market_id, topic, dedupe_key, payload)
      VALUES (${outboxId}, ${document.market_id}, ${outbox.topic}, ${`document-validation:${validationEventId}`},
              ${tx.json(outbox as unknown as Parameters<typeof tx.json>[0])})
      RETURNING id`;
    if (!outboxRows.length) throw new Error("Document validation outbox write failed.");
    await tx`
      INSERT INTO fame_document_validation_events
        (id, document_id, market_id, source_event_id, payload_hash, outcome, reason, outbox_id)
      VALUES
        (${validationEventId}, ${document.id}, ${document.market_id}, ${input.sourceEventId},
         ${payloadHash}, ${input.outcome}, ${input.reason}, ${outboxId})`;
    return { kind: "applied", documentId: document.id, validationState, validationEventId, outboxId };
  });
}

/**
 * A manager decision is accepted only for a clean, exact current version. The
 * decision audit and its downstream work item commit in one transaction.
 */
export async function recordApplicationDocumentReview(
  input: ApplicationDocumentReviewInput,
  sql: Sql = configuredClient(),
): Promise<ApplicationDocumentReviewResult> {
  const payloadHash = applicationDocumentReviewFingerprint(
    input.documentId, input.expectedVersion, input.action, input.reason,
  );
  return sql.begin(async tx => {
    const [document] = await tx<DocumentRow[]>`
      SELECT id, application_id, market_id, kind, version, source_event_id, source_file_id,
             storage_key, filename, content_type, size_bytes, content_sha256,
             validation_state, review_state, review_revision, is_current
      FROM fame_application_documents
      WHERE id = ${input.documentId} AND market_id = ${input.marketId}
      FOR UPDATE`;
    if (!document) return { kind: "not_found" };
    const [prior] = await tx<ReviewEventRow[]>`
      SELECT id, payload_hash, outbox_id
      FROM fame_document_review_events
      WHERE document_id = ${document.id} AND idempotency_key = ${input.idempotencyKey}`;
    if (prior) {
      if (prior.payload_hash !== payloadHash) return { kind: "conflict" };
      return {
        kind: "duplicate",
        documentId: document.id,
        reviewState: document.review_state,
        reviewEventId: prior.id,
        outboxId: prior.outbox_id,
      };
    }
    if (!document.is_current || Number(document.version) !== input.expectedVersion) {
      return { kind: "stale", currentVersion: Number(document.version), isCurrent: document.is_current };
    }
    if (document.validation_state !== "ready_for_review") {
      return { kind: "awaiting_validation", validationState: document.validation_state };
    }
    if (document.review_state !== "submitted") return { kind: "terminal", reviewState: document.review_state };

    const reviewState = documentReviewState(input.action);
    const reviewEventId = randomUUID();
    const outboxId = randomUUID();
    const outbox: ApplicationDocumentReviewOutbox = {
      topic: "document-review",
      applicationId: document.application_id,
      documentId: document.id,
      marketId: document.market_id,
      documentKind: document.kind,
      version: Number(document.version),
      reviewEventId,
      actorAccountId: input.actorAccountId,
      reviewState,
      reason: input.reason,
    };
    await tx`
      UPDATE fame_application_documents
      SET review_state = ${reviewState}, review_revision = review_revision + 1,
          reviewed_at = statement_timestamp(), reviewed_by_account_id = ${input.actorAccountId},
          review_reason = ${input.reason}
      WHERE id = ${document.id}`;
    const outboxRows = await tx`
      INSERT INTO fame_document_outbox (id, market_id, topic, dedupe_key, payload)
      VALUES (${outboxId}, ${document.market_id}, ${outbox.topic}, ${`document-review:${reviewEventId}`},
              ${tx.json(outbox as unknown as Parameters<typeof tx.json>[0])})
      RETURNING id`;
    if (!outboxRows.length) throw new Error("Document review outbox write failed.");
    await tx`
      INSERT INTO fame_document_review_events
        (id, document_id, application_id, market_id, actor_account_id, idempotency_key,
         payload_hash, from_state, to_state, reason, outbox_id)
      VALUES
        (${reviewEventId}, ${document.id}, ${document.application_id}, ${document.market_id},
         ${input.actorAccountId}, ${input.idempotencyKey}, ${payloadHash}, ${document.review_state},
         ${reviewState}, ${input.reason}, ${outboxId})`;
    return { kind: "applied", documentId: document.id, reviewState, reviewEventId, outboxId };
  });
}

/** Claim due work without directly contacting HighLevel, email, or file storage. */
export async function claimApplicationDocumentOutbox(
  limit = 10,
  leaseSeconds = 300,
  sql: Sql = configuredClient(),
): Promise<ApplicationDocumentOutboxMessage[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Outbox claim limit is invalid.");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 3600) throw new Error("Outbox lease is invalid.");
  const leaseToken = randomUUID();
  return sql.begin(async tx => {
    const rows = await tx<{
      id: string; market_id: string; attempts: number; lease_token: string; payload: ApplicationDocumentOutboxPayload;
    }[]>`
      WITH next AS (
        SELECT id
        FROM fame_document_outbox
        WHERE (status = 'pending' AND next_attempt_at <= statement_timestamp())
           OR (status = 'processing' AND locked_until <= statement_timestamp())
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE fame_document_outbox AS job
      SET status = 'processing', attempts = job.attempts + 1,
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

/** A worker with an old lease cannot acknowledge another worker's work. */
export async function markApplicationDocumentOutboxDelivered(
  id: string,
  leaseToken: string,
  sql: Sql = configuredClient(),
): Promise<boolean> {
  const rows = await sql`
    UPDATE fame_document_outbox
    SET status = 'delivered', delivered_at = statement_timestamp(), locked_until = NULL,
        lease_token = NULL, last_error_code = NULL
    WHERE id = ${id} AND status = 'processing' AND lease_token = ${leaseToken}
    RETURNING id`;
  return rows.length === 1;
}

/**
 * A new document version can make an older queued notification unsafe. This
 * terminally retires the job without pretending that a downstream side effect
 * was performed; `last_error_code` preserves that distinction for audit.
 */
export async function markApplicationDocumentOutboxSuperseded(
  id: string,
  leaseToken: string,
  sql: Sql = configuredClient(),
): Promise<boolean> {
  const rows = await sql`
    UPDATE fame_document_outbox
    SET status = 'delivered', delivered_at = statement_timestamp(), locked_until = NULL,
        lease_token = NULL, last_error_code = 'superseded'
    WHERE id = ${id} AND status = 'processing' AND lease_token = ${leaseToken}
    RETURNING id`;
  return rows.length === 1;
}

/** Store a safe short code, never an external-provider error body. */
export async function retryApplicationDocumentOutbox(
  id: string,
  leaseToken: string,
  errorCode: string,
  delaySeconds: number,
  sql: Sql = configuredClient(),
): Promise<boolean> {
  if (!/^[a-z0-9_.:-]{1,64}$/.test(errorCode)) throw new Error("Outbox error code is invalid.");
  if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86_400) throw new Error("Outbox retry delay is invalid.");
  const rows = await sql`
    UPDATE fame_document_outbox
    SET status = 'pending', next_attempt_at = statement_timestamp() + (${delaySeconds} * interval '1 second'),
        locked_until = NULL, lease_token = NULL, last_error_code = ${errorCode}
    WHERE id = ${id} AND status = 'processing' AND lease_token = ${leaseToken}
    RETURNING id`;
  return rows.length === 1;
}

export type ApplicationDocumentDelivery = (envelope: ApplicationDocumentDeliveryEnvelope) => Promise<void>;

export interface ApplicationDocumentOutboxDispatchOptions {
  limit?: number;
  leaseSeconds?: number;
  sql?: Sql;
}

/**
 * Fence a queued message against the current immutable document version before
 * an external worker acts on it. This is what prevents an approved v1 from
 * sending an approval after v2 was uploaded. Workers that use `claim...`
 * directly must apply this same check before delivery; `dispatch...` does it.
 */
export async function applicationDocumentOutboxMessageIsCurrent(
  message: ApplicationDocumentOutboxMessage,
  sql: Sql = configuredClient(),
): Promise<boolean> {
  const [document] = await sql<{
    validation_state: DocumentValidationState;
    review_state: DocumentReviewState;
  }[]>`
    SELECT validation_state, review_state
    FROM fame_application_documents
    WHERE id = ${message.payload.documentId}
      AND application_id = ${message.payload.applicationId}
      AND market_id = ${message.payload.marketId}
      AND kind = ${message.payload.documentKind}
      AND version = ${message.payload.version}
      AND is_current = TRUE`;
  if (!document) return false;
  return payloadMatchesCurrentDocument(message.payload, document.validation_state, document.review_state);
}

/**
 * Resolve the one immutable application/opportunity allowed to receive this
 * document event. The active outbox lease is part of the lookup, so a worker
 * that lost its lease cannot make a downstream call after another worker owns
 * the job. The query has no opportunity ordering or search condition.
 */
export async function resolveApplicationDocumentDeliveryTarget(
  message: ApplicationDocumentOutboxMessage,
  sql: Sql = configuredClient(),
): Promise<ApplicationDocumentDeliveryTargetResolution> {
  const [row] = await sql<ApplicationDocumentDeliveryRow[]>`
    SELECT d.id AS document_id, d.application_id, d.market_id, d.kind, d.version,
           d.validation_state, d.review_state, d.is_current,
           a.id AS application_record_id, a.location_id, a.contact_id,
           a.opportunity_id, a.season_id
    FROM fame_document_outbox AS o
    JOIN fame_application_documents AS d
      ON d.id = ${message.payload.documentId}
      AND d.application_id = ${message.payload.applicationId}
      AND d.market_id = ${message.payload.marketId}
      AND d.kind = ${message.payload.documentKind}
      AND d.version = ${message.payload.version}
      AND d.is_current = TRUE
    LEFT JOIN fame_applications AS a
      ON a.id = d.application_id AND a.market_id = d.market_id
    WHERE o.id = ${message.id}
      AND o.market_id = ${message.marketId}
      AND o.status = 'processing'
      AND o.lease_token = ${message.leaseToken}
      AND o.payload = ${sql.json(message.payload as unknown as Parameters<typeof sql.json>[0])}
      AND o.locked_until > statement_timestamp()`;
  if (!row) return { kind: "stale" };
  if (!payloadMatchesCurrentDocument(message.payload, row.validation_state, row.review_state)) return { kind: "stale" };
  if (row.application_record_id !== row.application_id
    || !validDeliveryIdentifier(row.application_id)
    || !validDeliveryIdentifier(row.market_id)
    || !validDeliveryIdentifier(row.location_id)
    || !validDeliveryIdentifier(row.contact_id)
    || !validDeliveryIdentifier(row.opportunity_id)
    || !validDeliveryIdentifier(row.season_id)
    || !validDeliveryIdentifier(row.document_id)) {
    return { kind: "identity_missing" };
  }
  return {
    kind: "ready",
    target: {
      applicationId: row.application_id,
      marketId: row.market_id,
      locationId: row.location_id,
      contactId: row.contact_id,
      opportunityId: row.opportunity_id,
      seasonId: row.season_id,
      documentId: row.document_id,
      documentKind: row.kind,
      version: Number(row.version),
    },
  };
}

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

/**
 * A scheduler injects the downstream delivery operation. This module never
 * sends email, changes HighLevel fields, or marks a document approved itself.
 */
export async function dispatchApplicationDocumentOutbox(
  deliver: ApplicationDocumentDelivery,
  options: ApplicationDocumentOutboxDispatchOptions = {},
): Promise<{ delivered: number; deferred: number; superseded: number; stale: number }> {
  const jobs = await claimApplicationDocumentOutbox(options.limit ?? 10, options.leaseSeconds ?? 300, options.sql);
  let delivered = 0;
  let deferred = 0;
  let superseded = 0;
  let stale = 0;
  for (const job of jobs) {
    if (!await applicationDocumentOutboxMessageIsCurrent(job, options.sql)) {
      if (await markApplicationDocumentOutboxSuperseded(job.id, job.leaseToken, options.sql)) superseded++;
      else stale++;
      continue;
    }
    try {
      const target = await resolveApplicationDocumentDeliveryTarget(job, options.sql);
      if (target.kind === "stale") {
        if (await markApplicationDocumentOutboxSuperseded(job.id, job.leaseToken, options.sql)) superseded++;
        else stale++;
        continue;
      }
      if (target.kind === "identity_missing") {
        throw new ApplicationDocumentDeliveryError("document_identity_missing", "Document delivery is waiting for its exact application opportunity.");
      }
      await deliver(buildApplicationDocumentDeliveryEnvelope(job, target.target));
      if (await markApplicationDocumentOutboxDelivered(job.id, job.leaseToken, options.sql)) delivered++;
      else stale++;
    } catch (error) {
      const failure = deliveryFailure(error, job.attempt);
      if (await retryApplicationDocumentOutbox(job.id, job.leaseToken, failure.code, failure.delaySeconds, options.sql)) deferred++;
      else stale++;
    }
  }
  return { delivered, deferred, superseded, stale };
}
