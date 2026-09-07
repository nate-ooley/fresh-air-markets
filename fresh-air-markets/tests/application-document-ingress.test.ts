import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";

// The test runner executes TypeScript tests as ESM, while the helper's local
// extensionless imports are intentionally compiled to CommonJS for route tests.
const require = createRequire(import.meta.url);
const { handleApplicationDocumentIngress, handleApplicationDocumentScan } = require("../.test-build/application-document-ingress.js") as typeof import("../src/lib/application-document-ingress");
const { MAX_APPLICATION_DOCUMENT_BYTES } = require("../.test-build/application-document.js");

const documentId = "11111111-1111-4111-8111-111111111111";
const applicationId = "22222222-2222-4222-8222-222222222222";
const config = {
  secret: "qa-document-ingress-secret-with-at-least-32-characters",
  locationId: "qa-location",
  marketId: "qa-market",
};
const scannerConfig = {
  secret: "qa-document-scanner-secret-with-at-least-32-characters",
  marketId: config.marketId,
};
const firstBytes = Buffer.from("%PDF-1.7\n1 0 obj\n");
const lastBytes = Buffer.from("\n%%EOF");

function body(patch: Record<string, unknown> = {}) {
  return {
    eventId: "qa-upload-event-1",
    applicationId,
    locationId: config.locationId,
    kind: "insurance",
    submittedAt: "2026-09-07T20:00:00.000Z",
    // This must be ignored: the configured market owns the event.
    marketId: "attacker-market",
    file: {
      storageKey: "documents/qa/insurance-1.pdf",
      sourceFileId: "ghl-file-1",
      filename: "insurance-1.pdf",
      contentType: "application/pdf",
      sizeBytes: 128,
      sha256: createHash("sha256").update("qa-insurance-1").digest("hex"),
      firstBytesBase64: firstBytes.toString("base64"),
      lastBytesBase64: lastBytes.toString("base64"),
    },
    ...patch,
  };
}

function request(value: unknown, secret = config.secret) {
  return new Request("https://unit-test.invalid/api/integrations/documents", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

function capturedResult() {
  return {
    kind: "captured" as const,
    document: {
      id: documentId,
      applicationId,
      marketId: config.marketId,
      kind: "insurance" as const,
      version: 1,
      sourceEventId: "qa-upload-event-1",
      file: {
        storageKey: "documents/qa/insurance-1.pdf",
        sourceFileId: "ghl-file-1",
        filename: "insurance-1.pdf",
        contentType: "application/pdf" as const,
        sizeBytes: 128,
        sha256: createHash("sha256").update("qa-insurance-1").digest("hex"),
      },
      validationState: "pending_scan" as const,
      reviewState: "submitted" as const,
      reviewRevision: 0,
      isCurrent: true,
    },
    outboxId: "qa-outbox-1",
  };
}

test("document ingress derives market identity from protected configuration and records only the inspected private object", async () => {
  let received: unknown;
  const response = await handleApplicationDocumentIngress(request(body()), config, async event => {
    received = event;
    return capturedResult();
  });
  assert.equal(response.status, 201);
  assert.deepEqual(received, {
    eventId: "qa-upload-event-1",
    applicationId,
    locationId: config.locationId,
    marketId: config.marketId,
    kind: "insurance",
    submittedAt: "2026-09-07T20:00:00.000Z",
    file: capturedResult().document.file,
  });
  assert.deepEqual(await response.json(), {
    status: "captured",
    document: { id: documentId, version: 1, validationState: "pending_scan" },
  });
});

test("document ingress rejects bad authorization, configuration, location, and malformed source identity before persistence", async () => {
  let writes = 0;
  const persist = async () => { writes++; return capturedResult(); };
  assert.equal((await handleApplicationDocumentIngress(request(body(), "wrong"), config, persist)).status, 401);
  assert.equal((await handleApplicationDocumentIngress(request(body({ locationId: "other-location" })), config, persist)).status, 400);
  assert.equal((await handleApplicationDocumentIngress(request(body({ applicationId: "wrong" })), config, persist)).status, 400);
  assert.equal((await handleApplicationDocumentIngress(request(body()), { ...config, secret: "short" }, persist)).status, 503);
  assert.equal(writes, 0);
});

test("document ingress rejects untyped or noncanonical timestamps and safely handles a locked request body", async () => {
  let writes = 0;
  const persist = async () => { writes++; return capturedResult(); };
  for (const submittedAt of [null, 0, true, "2026-09-07T20:00:00", "2026-02-31T20:00:00.000Z"]) {
    assert.equal((await handleApplicationDocumentIngress(request(body({ submittedAt })), config, persist)).status, 400);
  }
  const locked = request(body());
  const lock = locked.body?.getReader();
  try {
    assert.equal((await handleApplicationDocumentIngress(locked, config, persist)).status, 400);
  } finally {
    lock?.releaseLock();
  }
  assert.equal(writes, 0);
});

test("document ingress refuses spoofed signatures, noncanonical samples, and oversized transfers before persistence", async () => {
  let writes = 0;
  const persist = async () => { writes++; return capturedResult(); };
  const spoofed = body({ file: { ...body().file as Record<string, unknown>, firstBytesBase64: Buffer.from("not a PDF").toString("base64") } });
  const noncanonical = body({ file: { ...body().file as Record<string, unknown>, firstBytesBase64: `${firstBytes.toString("base64")}\n` } });
  const oversized = body({ file: { ...body().file as Record<string, unknown>, sizeBytes: MAX_APPLICATION_DOCUMENT_BYTES + 1 } });
  for (const value of [spoofed, noncanonical, oversized]) {
    assert.equal((await handleApplicationDocumentIngress(request(value), config, persist)).status, 400);
  }
  assert.equal(writes, 0);
});

test("document ingress distinguishes a harmless retry, a conflicting replay, and a transient write failure", async () => {
  const duplicate = { ...capturedResult(), kind: "duplicate" as const };
  assert.equal((await handleApplicationDocumentIngress(request(body()), config, async () => duplicate)).status, 200);
  assert.equal((await handleApplicationDocumentIngress(request(body()), config, async () => ({ kind: "conflict" as const }))).status, 409);
  const unavailable = await handleApplicationDocumentIngress(request(body()), config, async () => { throw new Error("storage-password"); });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.text()).includes("storage-password"), false);
});

test("scanner callbacks are separately authenticated, exact-version bound, and keep stale or duplicate outcomes explicit", async () => {
  let received: unknown;
  const clean = new Request(`https://unit-test.invalid/api/integrations/documents/${documentId}/scan`, {
    method: "POST",
    headers: { authorization: `Bearer ${scannerConfig.secret}`, "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: 1, sourceEventId: "qa-upload-event-1", outcome: "clean" }),
  });
  const response = await handleApplicationDocumentScan(clean, documentId, scannerConfig, async input => {
    received = input;
    return { kind: "applied", documentId, validationState: "ready_for_review", validationEventId: "scan-1", outboxId: "outbox-1" };
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    documentId,
    marketId: config.marketId,
    expectedVersion: 1,
    sourceEventId: "qa-upload-event-1",
    outcome: "clean",
    reason: "",
  });
  const wrongAuth = new Request(`https://unit-test.invalid/api/integrations/documents/${documentId}/scan`, {
    method: "POST",
    headers: { authorization: "Bearer wrong", "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: 1, sourceEventId: "qa-upload-event-1", outcome: "clean" }),
  });
  assert.equal((await handleApplicationDocumentScan(wrongAuth, documentId, scannerConfig, async () => { throw new Error("must not run"); })).status, 401);
  const stale = new Request(`https://unit-test.invalid/api/integrations/documents/${documentId}/scan`, {
    method: "POST",
    headers: { authorization: `Bearer ${scannerConfig.secret}`, "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: 1, sourceEventId: "qa-upload-event-1", outcome: "clean" }),
  });
  assert.equal((await handleApplicationDocumentScan(stale, documentId, scannerConfig, async () => ({ kind: "stale", currentVersion: 2, isCurrent: false }))).status, 409);
});
