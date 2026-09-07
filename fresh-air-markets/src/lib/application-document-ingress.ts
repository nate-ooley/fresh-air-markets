import { createHash, timingSafeEqual } from "node:crypto";
import {
  APPLICATION_DOCUMENT_SAMPLE_BYTES,
  buildApplicationDocumentSourceEvent,
  parseApplicationDocumentScan,
  validApplicationDocumentId,
  validApplicationDocumentSourceId,
  validateApplicationDocumentUpload,
  type ApplicationDocumentSourceEvent,
  type DocumentUploadInspection,
  type ParsedDocumentScan,
} from "./application-document";
import type {
  ApplicationDocumentScanResult,
  ApplicationDocumentSourceResult,
  ApplicationDocumentSourceTargetInput,
  ApplicationDocumentSourceTargetResolution,
} from "./application-document-pg";

/**
 * The intake endpoint is for the trusted transfer worker, after it has
 * streamed an uploaded file into private storage. It is deliberately not a
 * browser upload endpoint and never accepts a public file URL.
 */
export interface ApplicationDocumentIngressConfig {
  secret: string;
  locationId: string;
  marketId: string;
}

/**
 * Pins a HighLevel-bound document source to the same season as its application
 * handoff. The transfer worker provides contact/opportunity IDs, never an
 * internal application ID selected by a public form submission.
 */
export interface HighLevelApplicationDocumentIngressConfig extends ApplicationDocumentIngressConfig {
  seasonId: string;
}

/** A separate scanner credential prevents an upload-source secret from approving files. */
export interface ApplicationDocumentScannerConfig {
  secret: string;
  marketId: string;
}

const MAX_DOCUMENT_INGRESS_BYTES = 48 * 1024;
const MAX_DOCUMENT_SCAN_BYTES = 8 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function authorized(request: Request, secret: string): boolean {
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

async function readObject(request: Request, maximumBytes: number): Promise<Record<string, unknown> | null | "too_large"> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) return "too_large";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    // getReader itself throws for a body an intermediary has already locked.
    // Treat that exactly like malformed input instead of escaping a route's
    // safe 400 response path.
    reader = request.body?.getReader();
    if (!reader) return null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => {});
        return "too_large";
      }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    await reader?.cancel().catch(() => {});
    return null;
  } finally {
    reader?.releaseLock();
  }
}

function decodeSample(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !BASE64.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > APPLICATION_DOCUMENT_SAMPLE_BYTES) return null;
  // Buffer is permissive with malformed strings, so require a canonical
  // encoding rather than letting it silently discard unexpected characters.
  if (bytes.toString("base64") !== value) return null;
  return bytes;
}

function sourceEventFromBody(
  body: Record<string, unknown>,
  config: ApplicationDocumentIngressConfig,
): ApplicationDocumentSourceEvent | null {
  if (!body.file || typeof body.file !== "object" || Array.isArray(body.file)) return null;
  if (body.locationId !== config.locationId) return null;
  const file = body.file as Record<string, unknown>;
  const inspection: DocumentUploadInspection = {
    storageKey: file.storageKey as string,
    sourceFileId: file.sourceFileId as string,
    filename: file.filename as string,
    contentType: file.contentType as string,
    sizeBytes: file.sizeBytes as number,
    sha256: file.sha256 as string,
    firstBytes: decodeSample(file.firstBytesBase64) ?? new Uint8Array(APPLICATION_DOCUMENT_SAMPLE_BYTES + 1),
    lastBytes: decodeSample(file.lastBytesBase64) ?? new Uint8Array(APPLICATION_DOCUMENT_SAMPLE_BYTES + 1),
  };
  const validated = validateApplicationDocumentUpload(inspection);
  if (!validated.ok) return null;
  return buildApplicationDocumentSourceEvent({
    eventId: body.eventId as string,
    applicationId: body.applicationId as string,
    locationId: body.locationId as string,
    kind: body.kind as "insurance" | "food_license",
    submittedAt: body.submittedAt as string,
    file: validated.file,
  }, { locationId: config.locationId, marketId: config.marketId });
}

function ingressConfigured(config: ApplicationDocumentIngressConfig): boolean {
  return config.secret.length >= 32
    && validApplicationDocumentSourceId(config.locationId)
    && validApplicationDocumentSourceId(config.marketId);
}

function highLevelIngressConfigured(config: HighLevelApplicationDocumentIngressConfig): boolean {
  return ingressConfigured(config) && validApplicationDocumentSourceId(config.seasonId);
}

function scannerConfigured(config: ApplicationDocumentScannerConfig): boolean {
  return config.secret.length >= 32 && validApplicationDocumentSourceId(config.marketId);
}

/**
 * Accept a metadata-only record from a trusted worker. The worker must do the
 * streaming and signature inspection first; this handler binds the result to
 * exactly one internal application and persists it without any provider call.
 */
export async function handleApplicationDocumentIngress(
  request: Request,
  config: ApplicationDocumentIngressConfig,
  persist: (event: ApplicationDocumentSourceEvent) => Promise<ApplicationDocumentSourceResult>,
): Promise<Response> {
  if (!ingressConfigured(config)) return Response.json({ error: "Document intake is not configured." }, { status: 503 });
  if (!authorized(request, config.secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const body = await readObject(request, MAX_DOCUMENT_INGRESS_BYTES);
  if (body === "too_large") return Response.json({ error: "Document intake event is too large." }, { status: 413 });
  if (!body) return Response.json({ error: "A JSON object is required." }, { status: 400 });
  const event = sourceEventFromBody(body, config);
  if (!event) return Response.json({ error: "Invalid document intake event." }, { status: 400 });
  try {
    const result = await persist(event);
    if (result.kind === "conflict") return Response.json({ error: "Event ID was already used for different content." }, { status: 409 });
    return Response.json({
      status: result.kind,
      document: { id: result.document.id, version: result.document.version, validationState: result.document.validationState },
    }, { status: result.kind === "captured" ? 201 : 200 });
  } catch {
    // The worker retries the exact stable event ID after a persistence failure.
    return Response.json({ error: "Document intake unavailable; retry the same event." }, { status: 503 });
  }
}

/**
 * HighLevel-bound intake resolves the recipient application from the exact
 * contact, opportunity, location, and configured season captured by the
 * application handoff. The caller's payload never controls an internal
 * application ID, and no HighLevel search is performed here.
 */
export async function handleHighLevelApplicationDocumentIngress(
  request: Request,
  config: HighLevelApplicationDocumentIngressConfig,
  resolve: (input: ApplicationDocumentSourceTargetInput) => Promise<ApplicationDocumentSourceTargetResolution>,
  persist: (event: ApplicationDocumentSourceEvent) => Promise<ApplicationDocumentSourceResult>,
): Promise<Response> {
  if (!highLevelIngressConfigured(config)) return Response.json({ error: "HighLevel document intake is not configured." }, { status: 503 });
  if (!authorized(request, config.secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const body = await readObject(request, MAX_DOCUMENT_INGRESS_BYTES);
  if (body === "too_large") return Response.json({ error: "Document intake event is too large." }, { status: 413 });
  if (!body) return Response.json({ error: "A JSON object is required." }, { status: 400 });
  if (body.locationId !== config.locationId
    || !validApplicationDocumentSourceId(body.contactId)
    || !validApplicationDocumentSourceId(body.opportunityId)) {
    return Response.json({ error: "Invalid document source identity." }, { status: 400 });
  }

  let target: ApplicationDocumentSourceTargetResolution;
  try {
    target = await resolve({
      marketId: config.marketId,
      locationId: config.locationId,
      seasonId: config.seasonId,
      contactId: body.contactId,
      opportunityId: body.opportunityId,
    });
  } catch {
    return Response.json({ error: "Document application mapping is unavailable; retry the same event." }, { status: 503 });
  }
  if (target.kind !== "ready") return Response.json({ error: "No matching application was found for this document source." }, { status: 404 });

  // `applicationId` from the request (if one was supplied) is overwritten by
  // the committed exact mapping above. This keeps public/form payloads from
  // choosing another application's document ledger.
  const event = sourceEventFromBody({ ...body, applicationId: target.applicationId }, config);
  if (!event) return Response.json({ error: "Invalid document intake event." }, { status: 400 });
  try {
    const result = await persist(event);
    if (result.kind === "conflict") return Response.json({ error: "Event ID was already used for different content." }, { status: 409 });
    return Response.json({
      status: result.kind,
      document: { id: result.document.id, version: result.document.version, validationState: result.document.validationState },
    }, { status: result.kind === "captured" ? 201 : 200 });
  } catch {
    return Response.json({ error: "Document intake unavailable; retry the same event." }, { status: 503 });
  }
}

function scanResponse(result: ApplicationDocumentScanResult): Response {
  if (result.kind === "not_found") return Response.json({ error: "Document not found." }, { status: 404 });
  if (result.kind === "conflict") return Response.json({ error: "Scanner event conflicts with its earlier payload." }, { status: 409 });
  if (result.kind === "stale") return Response.json({ error: "Document changed; scan the current version." }, { status: 409 });
  if (result.kind === "not_pending") return Response.json({ error: "Document is not awaiting validation." }, { status: 409 });
  return Response.json({
    documentId: result.documentId,
    validationState: result.validationState,
    duplicate: result.kind === "duplicate",
  });
}

/** A scanner can release only the exact document/version supplied in the path. */
export async function handleApplicationDocumentScan(
  request: Request,
  documentId: string,
  config: ApplicationDocumentScannerConfig,
  record: (input: ParsedDocumentScan & { documentId: string; marketId: string }) => Promise<ApplicationDocumentScanResult>,
): Promise<Response> {
  if (!scannerConfigured(config)) return Response.json({ error: "Document scanner is not configured." }, { status: 503 });
  if (!authorized(request, config.secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  if (!validApplicationDocumentId(documentId)) return Response.json({ error: "Invalid document ID." }, { status: 400 });
  const body = await readObject(request, MAX_DOCUMENT_SCAN_BYTES);
  if (body === "too_large") return Response.json({ error: "Document scan event is too large." }, { status: 413 });
  if (!body) return Response.json({ error: "A JSON object is required." }, { status: 400 });
  const scan = parseApplicationDocumentScan(body);
  if (!scan) return Response.json({ error: "Invalid document scan event." }, { status: 400 });
  try {
    return scanResponse(await record({ ...scan, documentId, marketId: config.marketId }));
  } catch {
    return Response.json({ error: "Document scan processing unavailable; retry the same event." }, { status: 503 });
  }
}
