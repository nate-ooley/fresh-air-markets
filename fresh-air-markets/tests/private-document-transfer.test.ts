import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  transferPrivateApplicationDocument,
} = require("../.test-build/private-document-transfer.js") as typeof import("../src/lib/private-document-transfer");
const { MAX_APPLICATION_DOCUMENT_BYTES } = require("../.test-build/application-document.js") as typeof import("../src/lib/application-document");

const storageKey = "documents/qa/private-insurance-1.pdf";
const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");

function input(patch: Record<string, unknown> = {}) {
  return {
    storageKey,
    sourceFileId: "ghl-file-1",
    filename: "insurance.pdf",
    declaredContentType: "application/pdf",
    body: (async function* () {
      yield pdfBytes.subarray(0, 7);
      yield pdfBytes.subarray(7, 20);
      yield pdfBytes.subarray(20);
    })(),
    ...patch,
  };
}

function privateStore(options: { failPut?: boolean; failRemove?: boolean; skipBody?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const removed: string[] = [];
  return {
    objects,
    removed,
    store: {
      async put({ storageKey: key, body }: { storageKey: string; body: AsyncIterable<Uint8Array> }) {
        if (options.skipBody) return;
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        if (options.failPut) throw new Error("object-store timeout");
        objects.set(key, Buffer.concat(chunks));
      },
      async remove(key: string) {
        removed.push(key);
        if (options.failRemove) throw new Error("cleanup timeout");
        objects.delete(key);
      },
    },
  };
}

test("private transfer streams a valid object once, calculates its digest, and returns only a private reference", async () => {
  const target = privateStore();
  const result = await transferPrivateApplicationDocument(input(), target.store);
  assert.deepEqual(result, {
    kind: "stored",
    file: {
      storageKey,
      sourceFileId: "ghl-file-1",
      filename: "insurance.pdf",
      contentType: "application/pdf",
      sizeBytes: pdfBytes.byteLength,
      sha256: createHash("sha256").update(pdfBytes).digest("hex"),
    },
  });
  assert.deepEqual(target.objects.get(storageKey), pdfBytes);
  assert.deepEqual(target.removed, []);
  assert.equal(JSON.stringify(result).includes("http"), false);
});

test("private transfer rejects invalid private keys before the store sees them and removes a stored spoofed file", async () => {
  const invalidTarget = privateStore();
  assert.deepEqual(await transferPrivateApplicationDocument(input({ storageKey: "https://files.invalid/insurance.pdf" }), invalidTarget.store), {
    kind: "rejected", code: "invalid_storage_key",
  });
  assert.equal(invalidTarget.objects.size, 0);
  assert.deepEqual(invalidTarget.removed, []);

  const spoofedTarget = privateStore();
  const spoofed = await transferPrivateApplicationDocument(input({
    body: (async function* () { yield Buffer.from("not a PDF"); })(),
  }), spoofedTarget.store);
  assert.deepEqual(spoofed, { kind: "rejected", code: "signature_mismatch" });
  assert.equal(spoofedTarget.objects.size, 0);
  assert.deepEqual(spoofedTarget.removed, [storageKey]);
});

test("private transfer stops oversize and interrupted sources, then removes any partial private object", async () => {
  const oversizeTarget = privateStore();
  const oversize = await transferPrivateApplicationDocument(input({
    body: (async function* () { yield new Uint8Array(MAX_APPLICATION_DOCUMENT_BYTES + 1); })(),
  }), oversizeTarget.store);
  assert.deepEqual(oversize, { kind: "rejected", code: "file_too_large" });
  assert.equal(oversizeTarget.objects.size, 0);
  assert.deepEqual(oversizeTarget.removed, [storageKey]);

  const interruptedTarget = privateStore();
  const interrupted = await transferPrivateApplicationDocument(input({
    body: (async function* () {
      yield pdfBytes.subarray(0, 8);
      throw new Error("source connection dropped");
    })(),
  }), interruptedTarget.store);
  assert.deepEqual(interrupted, { kind: "failed", code: "source_unavailable" });
  assert.equal(interruptedTarget.objects.size, 0);
  assert.deepEqual(interruptedTarget.removed, [storageKey]);
});

test("private transfer fails closed when storage does not consume, stores, or clean up the inspected body", async () => {
  const nonConsumer = privateStore({ skipBody: true });
  assert.deepEqual(await transferPrivateApplicationDocument(input(), nonConsumer.store), {
    kind: "failed", code: "storage_unavailable",
  });
  assert.deepEqual(nonConsumer.removed, [storageKey]);

  const unavailable = privateStore({ failPut: true });
  assert.deepEqual(await transferPrivateApplicationDocument(input(), unavailable.store), {
    kind: "failed", code: "storage_unavailable",
  });
  assert.deepEqual(unavailable.removed, [storageKey]);

  const cleanupFailure = privateStore({ failRemove: true });
  assert.deepEqual(await transferPrivateApplicationDocument(input({
    body: (async function* () { yield Buffer.from("not a PDF"); })(),
  }), cleanupFailure.store), {
    kind: "failed", code: "storage_cleanup_failed",
  });
});
