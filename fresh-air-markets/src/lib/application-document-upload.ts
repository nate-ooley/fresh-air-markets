import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  APPLICATION_DOCUMENT_KINDS,
  buildApplicationDocumentSourceEvent,
  validApplicationDocumentId,
  type ApplicationDocumentKind,
  type DocumentReviewState,
  type DocumentValidationState,
} from "./application-document";
import {
  persistApplicationDocumentSource,
  recordApplicationDocumentScan,
  type ApplicationDocumentRecord,
} from "./application-document-pg";
import { transferPrivateApplicationDocument, type PrivateDocumentByteSource } from "./private-document-transfer";
import { postgresPrivateDocumentStore, type PostgresPrivateDocumentStore } from "./private-document-store-pg";

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;

function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent application document storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

/**
 * Recorded as the validation reason for staff uploads. There is no external
 * malware scanner in this deployment; the upload is admitted to review on the
 * strength of the signed-in staff session plus the streaming type, size and
 * file-signature checks. The wording is stored with every such document so a
 * later audit can tell these apart from scanner-verified ones.
 */
export const MANAGER_UPLOAD_SCAN_REASON =
  "Uploaded by signed-in market staff; type, size and file signature verified. No external malware scanner is configured.";

export interface ManagerDocumentUploadInput {
  applicationId: string;
  marketId: string;
  locationId: string;
  kind: string;
  filename: string;
  declaredContentType: string;
  body: PrivateDocumentByteSource;
}

export type ManagerDocumentUploadResult =
  | { kind: "captured"; document: ApplicationDocumentRecord }
  | { kind: "duplicate"; document: ApplicationDocumentRecord }
  | { kind: "not_found" }
  | { kind: "rejected"; code: string }
  | { kind: "failed"; code: string };

export interface ManagerDocumentUploadDeps {
  sql?: Sql;
  store?: PostgresPrivateDocumentStore;
}

function isKind(value: unknown): value is ApplicationDocumentKind {
  return typeof value === "string" && (APPLICATION_DOCUMENT_KINDS as readonly string[]).includes(value);
}

function keySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "x";
}

/**
 * Staff upload of a vendor's insurance or food-license document. The bytes are
 * streamed into the private store, inspected, bound to the exact application
 * as a new immutable version, and admitted to review. Every failure after the
 * object was written removes that object again.
 */
export async function uploadApplicationDocumentAsManager(
  input: ManagerDocumentUploadInput,
  deps: ManagerDocumentUploadDeps = {},
): Promise<ManagerDocumentUploadResult> {
  if (!validApplicationDocumentId(input.applicationId) || !isKind(input.kind)) return { kind: "rejected", code: "invalid_request" };
  const sql = deps.sql ?? configuredClient();
  const store = deps.store ?? postgresPrivateDocumentStore(sql);
  const [application] = await sql<{ id: string }[]>`
    SELECT id FROM fame_applications
    WHERE id = ${input.applicationId} AND market_id = ${input.marketId} AND location_id = ${input.locationId}`;
  if (!application) return { kind: "not_found" };

  const uploadId = randomUUID();
  const sourceId = `manager-upload:${uploadId}`;
  const storageKey = `documents/${keySegment(input.marketId)}/${input.applicationId}/${uploadId}`;
  const transfer = await transferPrivateApplicationDocument({
    storageKey, sourceFileId: sourceId, filename: input.filename,
    declaredContentType: input.declaredContentType, body: input.body,
  }, store);
  if (transfer.kind !== "stored") return transfer;

  const discard = () => store.remove(storageKey).catch(() => {});
  const event = buildApplicationDocumentSourceEvent({
    eventId: sourceId, applicationId: input.applicationId, locationId: input.locationId,
    kind: input.kind, submittedAt: new Date().toISOString(), file: transfer.file,
  }, { marketId: input.marketId, locationId: input.locationId });
  if (!event) { await discard(); return { kind: "failed", code: "source_event_invalid" }; }

  let persisted;
  try {
    persisted = await persistApplicationDocumentSource(event, sql);
  } catch {
    await discard();
    return { kind: "failed", code: "storage_unavailable" };
  }
  if (persisted.kind === "conflict") { await discard(); return { kind: "failed", code: "source_conflict" }; }
  if (persisted.kind === "duplicate") {
    // The same bytes already exist as a ledger version under its own key.
    await discard();
    return { kind: "duplicate", document: persisted.document };
  }

  const scan = await recordApplicationDocumentScan({
    documentId: persisted.document.id, marketId: input.marketId,
    expectedVersion: persisted.document.version, sourceEventId: sourceId,
    outcome: "clean", reason: MANAGER_UPLOAD_SCAN_REASON,
  }, sql);
  const validationState: DocumentValidationState = scan.kind === "applied" || scan.kind === "duplicate"
    ? scan.validationState : persisted.document.validationState;
  return { kind: "captured", document: { ...persisted.document, validationState } };
}

interface DocumentListRow {
  id: string; application_id: string; market_id: string; kind: ApplicationDocumentKind; version: number;
  source_event_id: string; source_file_id: string; storage_key: string; filename: string;
  content_type: ApplicationDocumentRecord["file"]["contentType"]; size_bytes: string | number; content_sha256: string;
  validation_state: DocumentValidationState; review_state: DocumentReviewState; review_revision: number; is_current: boolean;
  submitted_at: Date; review_reason: string; validation_reason: string;
}

/** Everything the manager needs to review; storage keys stay server-side. */
export interface ApplicationDocumentSummary {
  id: string;
  kind: ApplicationDocumentKind;
  version: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  submittedAt: string;
  validationState: DocumentValidationState;
  validationReason: string;
  reviewState: DocumentReviewState;
  reviewReason: string;
  isCurrent: boolean;
}

export async function listApplicationDocuments(
  applicationId: string,
  marketId: string,
  sql: Sql = configuredClient(),
): Promise<ApplicationDocumentSummary[]> {
  if (!validApplicationDocumentId(applicationId)) return [];
  const rows = await sql<DocumentListRow[]>`
    SELECT id, application_id, market_id, kind, version, source_event_id, source_file_id, storage_key,
           filename, content_type, size_bytes, content_sha256, validation_state, review_state,
           review_revision, is_current, submitted_at, review_reason, validation_reason
    FROM fame_application_documents
    WHERE application_id = ${applicationId} AND market_id = ${marketId}
    ORDER BY kind, version DESC`;
  return rows.map(row => ({
    id: row.id, kind: row.kind, version: Number(row.version), filename: row.filename,
    contentType: row.content_type, sizeBytes: Number(row.size_bytes),
    submittedAt: new Date(row.submitted_at).toISOString(),
    validationState: row.validation_state, validationReason: row.validation_reason,
    reviewState: row.review_state, reviewReason: row.review_reason, isCurrent: row.is_current,
  }));
}

export interface ApplicationDocumentFile {
  filename: string;
  contentType: string;
  sizeBytes: number;
  body: Buffer;
}

/** Bytes for an exact market-owned document; null when the ledger or store has no such object. */
export async function readApplicationDocumentFile(
  documentId: string,
  marketId: string,
  deps: ManagerDocumentUploadDeps = {},
): Promise<ApplicationDocumentFile | null> {
  if (!validApplicationDocumentId(documentId)) return null;
  const sql = deps.sql ?? configuredClient();
  const store = deps.store ?? postgresPrivateDocumentStore(sql);
  const [row] = await sql<{ storage_key: string; filename: string; content_type: string }[]>`
    SELECT storage_key, filename, content_type FROM fame_application_documents
    WHERE id = ${documentId} AND market_id = ${marketId}`;
  if (!row) return null;
  const object = await store.get(row.storage_key);
  if (!object) return null;
  return { filename: row.filename, contentType: row.content_type, sizeBytes: object.sizeBytes, body: object.body };
}
