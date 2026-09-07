import { createHash } from "node:crypto";
import {
  APPLICATION_DOCUMENT_SAMPLE_BYTES,
  MAX_APPLICATION_DOCUMENT_BYTES,
  validApplicationDocumentSourceId,
  validApplicationDocumentStorageKey,
  validateApplicationDocumentUpload,
  type DocumentUploadValidation,
  type ValidatedDocumentUpload,
} from "./application-document";

/** A server-side adapter for a private object store. It must never return a public URL. */
export interface PrivateDocumentObjectStore {
  put(input: {
    storageKey: string;
    contentType: string;
    body: AsyncIterable<Uint8Array>;
  }): Promise<void>;
  remove(storageKey: string): Promise<void>;
}

/** The source comes from an authenticated server-side fetch or worker, never a browser form. */
export type PrivateDocumentByteSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

export interface PrivateDocumentTransferInput {
  /** Server-generated private object key; never a public URL or source filename. */
  storageKey: string;
  sourceFileId: string;
  filename: string;
  declaredContentType: string;
  body: PrivateDocumentByteSource;
}

type DocumentUploadValidationErrorCode = Extract<DocumentUploadValidation, { ok: false }>["code"];

export type PrivateDocumentTransferResult =
  | { kind: "stored"; file: ValidatedDocumentUpload }
  | { kind: "rejected"; code: DocumentUploadValidationErrorCode }
  | { kind: "failed"; code: "source_unavailable" | "storage_unavailable" | "storage_cleanup_failed" };

class TransferFailure extends Error {
  constructor(public readonly code: "source_unavailable" | "file_too_large") {
    super(code);
  }
}

function takeLeading(current: Uint8Array, chunk: Uint8Array, keep: number): Uint8Array {
  if (current.byteLength >= keep || chunk.byteLength === 0) return current;
  const accepted = chunk.subarray(0, keep - current.byteLength);
  const result = new Uint8Array(current.byteLength + accepted.byteLength);
  result.set(current);
  result.set(accepted, current.byteLength);
  return result;
}

function takeTrailing(current: Uint8Array, chunk: Uint8Array, keep: number): Uint8Array {
  if (current.byteLength >= keep && chunk.byteLength === 0) return current;
  const joined = new Uint8Array(current.byteLength + chunk.byteLength);
  joined.set(current);
  joined.set(chunk, current.byteLength);
  return joined.subarray(Math.max(0, joined.byteLength - keep));
}

async function* byteChunks(source: PrivateDocumentByteSource): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in source) {
    for await (const chunk of source as AsyncIterable<Uint8Array>) yield chunk;
    return;
  }
  const reader = (source as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function removePrivateObject(store: PrivateDocumentObjectStore, storageKey: string): Promise<boolean> {
  try {
    await store.remove(storageKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Streams an already-authenticated source into private storage while deriving
 * its digest, counted size, and bounded byte samples. Failed inspection or an
 * interrupted transfer removes the object before returning, so callers can
 * only persist a verified private reference.
 *
 * This deliberately does not fetch a source URL or choose a storage provider.
 * It also does not perform malware/deep-file scanning: accepted documents
 * remain pending until an independent scanner reports the exact version.
 */
export async function transferPrivateApplicationDocument(
  input: PrivateDocumentTransferInput,
  store: PrivateDocumentObjectStore,
): Promise<PrivateDocumentTransferResult> {
  // A storage adapter must never receive an unsafe caller-controlled key.
  if (!validApplicationDocumentStorageKey(input.storageKey)) return { kind: "rejected", code: "invalid_storage_key" };
  if (!validApplicationDocumentSourceId(input.sourceFileId)) return { kind: "rejected", code: "invalid_source_file_id" };

  const hash = createHash("sha256");
  let sizeBytes = 0;
  let firstBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let lastBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let streamCompleted = false;

  const inspectedBody = (async function* (): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of byteChunks(input.body)) {
        if (!(chunk instanceof Uint8Array)) throw new TransferFailure("source_unavailable");
        sizeBytes += chunk.byteLength;
        if (sizeBytes > MAX_APPLICATION_DOCUMENT_BYTES) throw new TransferFailure("file_too_large");
        hash.update(chunk);
        firstBytes = takeLeading(firstBytes, chunk, APPLICATION_DOCUMENT_SAMPLE_BYTES);
        lastBytes = takeTrailing(lastBytes, chunk, APPLICATION_DOCUMENT_SAMPLE_BYTES);
        yield chunk;
      }
      streamCompleted = true;
    } catch (error) {
      if (error instanceof TransferFailure) throw error;
      throw new TransferFailure("source_unavailable");
    }
  })();

  try {
    await store.put({ storageKey: input.storageKey, contentType: input.declaredContentType, body: inspectedBody });
  } catch (error) {
    const cleaned = await removePrivateObject(store, input.storageKey);
    if (!cleaned) return { kind: "failed", code: "storage_cleanup_failed" };
    if (error instanceof TransferFailure) {
      if (error.code === "file_too_large") return { kind: "rejected", code: "file_too_large" };
      return { kind: "failed", code: error.code };
    }
    return { kind: "failed", code: "storage_unavailable" };
  }
  // A store which resolves without consuming the supplied stream cannot prove
  // that it saved the inspected bytes. Fail closed and remove that object.
  if (!streamCompleted) {
    if (!await removePrivateObject(store, input.storageKey)) return { kind: "failed", code: "storage_cleanup_failed" };
    return { kind: "failed", code: "storage_unavailable" };
  }

  const validation = validateApplicationDocumentUpload({
    storageKey: input.storageKey,
    sourceFileId: input.sourceFileId,
    filename: input.filename,
    contentType: input.declaredContentType,
    sizeBytes,
    sha256: hash.digest("hex"),
    firstBytes,
    lastBytes,
  });
  if (validation.ok === true) return { kind: "stored", file: validation.file };
  if (!await removePrivateObject(store, input.storageKey)) return { kind: "failed", code: "storage_cleanup_failed" };
  return { kind: "rejected", code: validation.code };
}
