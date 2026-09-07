import { createHash } from "node:crypto";

/**
 * These are deliberately a small, explicit set. A browser-supplied MIME type
 * or filename is never enough to admit a file: the transfer worker must count
 * the bytes, calculate the digest, and retain bounded leading/trailing samples
 * while it streams the object into private storage.
 */
export const APPLICATION_DOCUMENT_KINDS = ["insurance", "food_license"] as const;
export type ApplicationDocumentKind = (typeof APPLICATION_DOCUMENT_KINDS)[number];

export const APPLICATION_DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
] as const;
export type ApplicationDocumentContentType = (typeof APPLICATION_DOCUMENT_CONTENT_TYPES)[number];

export const MAX_APPLICATION_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const APPLICATION_DOCUMENT_SAMPLE_BYTES = 4096;

export type DocumentValidationState = "pending_scan" | "ready_for_review" | "rejected";
export type DocumentReviewState = "submitted" | "approved" | "changes_requested" | "rejected";
export type DocumentReviewAction = "approve" | "request_changes" | "reject";
export type DocumentScanOutcome = "clean" | "rejected";

export interface DocumentUploadInspection {
  /** Private object-store key, never an untrusted public URL. */
  storageKey: string;
  /** Stable media/file identifier from the source system. */
  sourceFileId: string;
  filename: string;
  /** Declared source MIME type; it must agree with extension and bytes. */
  contentType: string;
  /** Counted by the server-side streaming transfer, never copied from a form field. */
  sizeBytes: number;
  /** SHA-256 of the complete streamed object. */
  sha256: string;
  /** First and last bounded samples of the streamed object. */
  firstBytes: Uint8Array;
  lastBytes: Uint8Array;
}

export interface ValidatedDocumentUpload {
  storageKey: string;
  sourceFileId: string;
  filename: string;
  contentType: ApplicationDocumentContentType;
  sizeBytes: number;
  sha256: string;
}

export type DocumentUploadValidation =
  | { ok: true; file: ValidatedDocumentUpload }
  | {
    ok: false;
    code:
      | "invalid_storage_key"
      | "invalid_source_file_id"
      | "invalid_filename"
      | "unsupported_type"
      | "extension_mismatch"
      | "invalid_size"
      | "file_too_large"
      | "invalid_sha256"
      | "invalid_sample"
      | "signature_mismatch";
  };

export interface DocumentSourceConfig {
  marketId: string;
  locationId: string;
}

/** A source upload has already passed the streaming metadata/signature gate. */
export interface ApplicationDocumentSourceInput {
  eventId: string;
  applicationId: string;
  locationId: string;
  kind: ApplicationDocumentKind;
  submittedAt: string;
  file: ValidatedDocumentUpload;
}

export interface ApplicationDocumentSourceEvent extends ApplicationDocumentSourceInput {
  marketId: string;
}

export interface ParsedDocumentReview {
  expectedVersion: number;
  action: DocumentReviewAction;
  reason: string;
  idempotencyKey: string;
}

export interface ParsedDocumentScan {
  expectedVersion: number;
  sourceEventId: string;
  outcome: DocumentScanOutcome;
  reason: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_ID = /^[A-Za-z0-9:_-]{1,192}$/;
const STORAGE_KEY = /^documents\/[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const SHA256 = /^[0-9a-f]{64}$/i;

export function validApplicationDocumentId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

export function validApplicationDocumentSourceId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_ID.test(value);
}

export function validApplicationDocumentStorageKey(value: unknown): value is string {
  return typeof value === "string"
    && STORAGE_KEY.test(value)
    && !value.includes("//")
    && !value.split("/").includes("..");
}

function normalizedContentType(value: unknown): ApplicationDocumentContentType | null {
  if (typeof value !== "string") return null;
  const type = value.split(";", 1)[0]?.trim().toLowerCase();
  return APPLICATION_DOCUMENT_CONTENT_TYPES.includes(type as ApplicationDocumentContentType)
    ? type as ApplicationDocumentContentType
    : null;
}

function extensionFor(filename: string): ApplicationDocumentContentType | null {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "pdf") return "application/pdf";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return null;
}

function signatureType(firstBytes: Uint8Array, lastBytes: Uint8Array): ApplicationDocumentContentType | null {
  const head = Buffer.from(firstBytes);
  const tail = Buffer.from(lastBytes);
  const pdfHeader = head.subarray(0, 1024).toString("latin1");
  const pdfMatch = /%PDF-[0-9]\.[0-9]/.exec(pdfHeader);
  if (pdfMatch && pdfMatch.index <= 1024 && tail.includes(Buffer.from("%%EOF"))) return "application/pdf";

  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngTrailer = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  if (head.subarray(0, pngSignature.length).equals(pngSignature)
    && tail.subarray(Math.max(0, tail.length - pngTrailer.length)).equals(pngTrailer)) return "image/png";

  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
    && tail.length >= 2 && tail[tail.length - 2] === 0xff && tail[tail.length - 1] === 0xd9) return "image/jpeg";
  return null;
}

/**
 * This is a bounded pre-admission check, not a malware scanner or a full PDF/
 * image parser. A passing object enters `pending_scan`, and cannot be approved
 * until a trusted scanner records `ready_for_review` for its exact version.
 */
export function validateApplicationDocumentUpload(input: DocumentUploadInspection): DocumentUploadValidation {
  if (!validApplicationDocumentStorageKey(input.storageKey)) return { ok: false, code: "invalid_storage_key" };
  if (!validApplicationDocumentSourceId(input.sourceFileId)) return { ok: false, code: "invalid_source_file_id" };
  if (typeof input.filename !== "string" || !input.filename.trim() || Buffer.byteLength(input.filename, "utf8") > 255
    || /[\u0000-\u001f\u007f/\\]/.test(input.filename)) return { ok: false, code: "invalid_filename" };
  const contentType = normalizedContentType(input.contentType);
  if (!contentType) return { ok: false, code: "unsupported_type" };
  if (extensionFor(input.filename) !== contentType) return { ok: false, code: "extension_mismatch" };
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) return { ok: false, code: "invalid_size" };
  if (input.sizeBytes > MAX_APPLICATION_DOCUMENT_BYTES) return { ok: false, code: "file_too_large" };
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) return { ok: false, code: "invalid_sha256" };
  if (!(input.firstBytes instanceof Uint8Array) || !(input.lastBytes instanceof Uint8Array)
    || input.firstBytes.byteLength > APPLICATION_DOCUMENT_SAMPLE_BYTES
    || input.lastBytes.byteLength > APPLICATION_DOCUMENT_SAMPLE_BYTES) return { ok: false, code: "invalid_sample" };
  if (signatureType(input.firstBytes, input.lastBytes) !== contentType) return { ok: false, code: "signature_mismatch" };
  return {
    ok: true,
    file: {
      storageKey: input.storageKey,
      sourceFileId: input.sourceFileId,
      filename: input.filename,
      contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256.toLowerCase(),
    },
  };
}

function isDocumentKind(value: unknown): value is ApplicationDocumentKind {
  return typeof value === "string" && (APPLICATION_DOCUMENT_KINDS as readonly string[]).includes(value);
}

function isValidatedUpload(value: unknown): value is ValidatedDocumentUpload {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<ValidatedDocumentUpload>;
  const sizeBytes = file.sizeBytes;
  return validApplicationDocumentStorageKey(file.storageKey)
    && validApplicationDocumentSourceId(file.sourceFileId)
    && typeof file.filename === "string"
    && Boolean(file.filename.trim())
    && Buffer.byteLength(file.filename, "utf8") <= 255
    && !/[\u0000-\u001f\u007f/\\]/.test(file.filename)
    && normalizedContentType(file.contentType) === file.contentType
    && extensionFor(file.filename) === file.contentType
    && typeof sizeBytes === "number" && Number.isSafeInteger(sizeBytes)
    && sizeBytes >= 1 && sizeBytes <= MAX_APPLICATION_DOCUMENT_BYTES
    && typeof file.sha256 === "string" && SHA256.test(file.sha256) && file.sha256 === file.sha256.toLowerCase();
}

/**
 * The caller supplies the configured market/location rather than accepting a
 * market ID from an upload source. The database separately verifies that this
 * internal application ID belongs to the same market and location.
 */
export function buildApplicationDocumentSourceEvent(
  input: ApplicationDocumentSourceInput,
  config: DocumentSourceConfig,
): ApplicationDocumentSourceEvent | null {
  if (!validApplicationDocumentSourceId(input.eventId)
    || !validApplicationDocumentId(input.applicationId)
    || !isDocumentKind(input.kind)
    || input.locationId !== config.locationId
    || !validApplicationDocumentSourceId(config.marketId)
    || !validApplicationDocumentSourceId(config.locationId)
    || !isValidatedUpload(input.file)) return null;
  // The transfer worker requires a timezone-bearing RFC3339 string, then
  // normalizes it to UTC. Date() otherwise turns values such as `null` and
  // `0` into legitimate-looking 1970 timestamps when an untyped webhook
  // reaches here. Validate the local components too: Date() normalizes an
  // impossible day such as February 31 instead of rejecting it.
  if (typeof input.submittedAt !== "string") return null;
  const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(input.submittedAt);
  if (!timestamp) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText = "", offset] = timestamp;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const milliseconds = Number(fractionText.padEnd(3, "0"));
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  if (offset !== "Z") {
    const [offsetHourText, offsetMinuteText] = offset.slice(1).split(":");
    if (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59) return null;
  }
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second, milliseconds));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day
    || local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) return null;
  const submittedAt = new Date(input.submittedAt);
  if (Number.isNaN(submittedAt.valueOf())) return null;
  return { ...input, marketId: config.marketId, submittedAt: submittedAt.toISOString() };
}

/** Hash only normalized stable metadata; raw file bytes remain in private storage. */
export function applicationDocumentSourceFingerprint(event: ApplicationDocumentSourceEvent): string {
  return createHash("sha256")
    .update(JSON.stringify([
      event.eventId, event.applicationId, event.marketId, event.locationId, event.kind, event.submittedAt,
      event.file.storageKey, event.file.sourceFileId, event.file.filename, event.file.contentType,
      event.file.sizeBytes, event.file.sha256,
    ]))
    .digest("hex");
}

function validVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1_000_000;
}

export function validDocumentReviewIdempotencyKey(value: string | null): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

/**
 * Routes place the exact internal document ID in their path. The expected
 * version prevents a manager's stale tab from deciding a corrected upload.
 */
export function parseApplicationDocumentReview(
  body: Record<string, unknown>,
  idempotencyKey: string | null,
): ParsedDocumentReview | null {
  if (!validDocumentReviewIdempotencyKey(idempotencyKey) || !validVersion(body.expectedVersion)) return null;
  if (body.action !== "approve" && body.action !== "request_changes" && body.action !== "reject") return null;
  if (body.reason !== undefined && typeof body.reason !== "string") return null;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length > 2000 || (body.action !== "approve" && !reason)) return null;
  return { expectedVersion: body.expectedVersion, action: body.action, reason, idempotencyKey };
}

export function documentReviewState(action: DocumentReviewAction): DocumentReviewState {
  if (action === "approve") return "approved";
  if (action === "request_changes") return "changes_requested";
  return "rejected";
}

export function applicationDocumentReviewFingerprint(
  documentId: string,
  expectedVersion: number,
  action: DocumentReviewAction,
  reason: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([documentId, expectedVersion, action, reason]))
    .digest("hex");
}

/** Scanner workers must bind their result to the exact document version too. */
export function parseApplicationDocumentScan(body: Record<string, unknown>): ParsedDocumentScan | null {
  if (!validVersion(body.expectedVersion) || !validApplicationDocumentSourceId(body.sourceEventId)) return null;
  if (body.outcome !== "clean" && body.outcome !== "rejected") return null;
  if (body.reason !== undefined && typeof body.reason !== "string") return null;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length > 512 || (body.outcome === "rejected" && !reason)) return null;
  return { expectedVersion: body.expectedVersion, sourceEventId: body.sourceEventId, outcome: body.outcome, reason };
}

export function applicationDocumentScanFingerprint(
  documentId: string,
  expectedVersion: number,
  sourceEventId: string,
  outcome: DocumentScanOutcome,
  reason: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([documentId, expectedVersion, sourceEventId, outcome, reason]))
    .digest("hex");
}
