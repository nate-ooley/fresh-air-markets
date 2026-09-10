import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPLICATION_DOCUMENT_SAMPLE_BYTES,
  MAX_APPLICATION_DOCUMENT_BYTES,
  applicationDocumentReviewFingerprint,
  applicationDocumentScanFingerprint,
  applicationDocumentSourceFingerprint,
  buildApplicationDocumentSourceEvent,
  documentReviewState,
  parseApplicationDocumentReview,
  parseApplicationDocumentScan,
  validateApplicationDocumentUpload,
} from "../src/lib/application-document.ts";

const applicationId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const sourceConfig = { marketId: "fame-market", locationId: "fame-location" };

const pdfSamples = {
  firstBytes: Buffer.from("%PDF-1.7\n% QA test upload\n"),
  lastBytes: Buffer.from("\n%%EOF\n"),
};
const pngSamples = {
  firstBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  lastBytes: Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
};
const jpegSamples = {
  firstBytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  lastBytes: Buffer.from([0x00, 0xff, 0xd9]),
};

function inspection(patch: Partial<Parameters<typeof validateApplicationDocumentUpload>[0]> = {}) {
  return {
    storageKey: "documents/qa/insurance-v1.pdf",
    sourceFileId: "qa-file-1",
    filename: "insurance.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    sha256: "a".repeat(64),
    ...pdfSamples,
    ...patch,
  };
}

test("upload guard admits only the configured PDF, PNG and JPEG signatures", () => {
  const pdf = validateApplicationDocumentUpload(inspection());
  const png = validateApplicationDocumentUpload(inspection({
    storageKey: "documents/qa/insurance-v2.png",
    sourceFileId: "qa-file-2",
    filename: "insurance.png",
    contentType: "image/png; charset=binary",
    ...pngSamples,
  }));
  const jpeg = validateApplicationDocumentUpload(inspection({
    storageKey: "documents/qa/insurance-v3.jpeg",
    sourceFileId: "qa-file-3",
    filename: "insurance.jpeg",
    contentType: "image/jpeg",
    ...jpegSamples,
  }));
  assert.equal(pdf.ok, true);
  assert.equal(png.ok, true);
  assert.equal(jpeg.ok, true);
  if (pdf.ok && png.ok && jpeg.ok) {
    assert.equal(pdf.file.contentType, "application/pdf");
    assert.equal(png.file.contentType, "image/png");
    assert.equal(jpeg.file.contentType, "image/jpeg");
    assert.equal(png.file.sha256, "a".repeat(64));
  }
});

test("upload guard rejects filename/MIME/signature disagreement and simple corrupt samples", () => {
  const extension = validateApplicationDocumentUpload(inspection({ filename: "insurance.pdf.exe" }));
  const spoofedPdf = validateApplicationDocumentUpload(inspection({ ...pngSamples }));
  const truncatedPdf = validateApplicationDocumentUpload(inspection({ lastBytes: Buffer.from("truncated") }));
  assert.deepEqual(extension, { ok: false, code: "extension_mismatch" });
  assert.deepEqual(spoofedPdf, { ok: false, code: "signature_mismatch" });
  assert.deepEqual(truncatedPdf, { ok: false, code: "signature_mismatch" });
});

test("upload guard enforces a counted bounded object, private reference and digest", () => {
  const unsafeReference = validateApplicationDocumentUpload(inspection({ storageKey: "documents/qa/../live.pdf" }));
  const empty = validateApplicationDocumentUpload(inspection({ sizeBytes: 0 }));
  const oversized = validateApplicationDocumentUpload(inspection({ sizeBytes: MAX_APPLICATION_DOCUMENT_BYTES + 1 }));
  const badDigest = validateApplicationDocumentUpload(inspection({ sha256: "not-a-digest" }));
  const unboundedSample = validateApplicationDocumentUpload(inspection({ firstBytes: new Uint8Array(APPLICATION_DOCUMENT_SAMPLE_BYTES + 1) }));
  const impossibleSample = validateApplicationDocumentUpload(inspection({ sizeBytes: 1 }));
  assert.deepEqual(unsafeReference, { ok: false, code: "invalid_storage_key" });
  assert.deepEqual(empty, { ok: false, code: "invalid_size" });
  assert.deepEqual(oversized, { ok: false, code: "file_too_large" });
  assert.deepEqual(badDigest, { ok: false, code: "invalid_sha256" });
  assert.deepEqual(unboundedSample, { ok: false, code: "invalid_sample" });
  assert.deepEqual(impossibleSample, { ok: false, code: "invalid_sample" });
});

test("document source event binds a validated upload to one configured market/location application", () => {
  const validated = validateApplicationDocumentUpload(inspection());
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const source = buildApplicationDocumentSourceEvent({
    eventId: "qa-upload-event-1",
    applicationId,
    locationId: sourceConfig.locationId,
    kind: "insurance",
    submittedAt: "2026-09-07T15:00:00-04:00",
    file: validated.file,
  }, sourceConfig);
  assert.ok(source);
  if (!source) return;
  assert.equal(source.marketId, sourceConfig.marketId);
  assert.equal(source.submittedAt, "2026-09-07T19:00:00.000Z");
  assert.equal(applicationDocumentSourceFingerprint(source), applicationDocumentSourceFingerprint(source));
  assert.equal(buildApplicationDocumentSourceEvent({ ...source, locationId: "other-location" }, sourceConfig), null);
  assert.equal(buildApplicationDocumentSourceEvent({ ...source, applicationId: "qa-contact" }, sourceConfig), null);
});

test("review and scanner contracts require an exact version, meaningful correction notes and idempotency", () => {
  const approval = parseApplicationDocumentReview({ expectedVersion: 2, action: "approve" }, idempotencyKey);
  const correction = parseApplicationDocumentReview({ expectedVersion: 2, action: "request_changes", reason: "Please upload a current certificate." }, idempotencyKey);
  const missingNote = parseApplicationDocumentReview({ expectedVersion: 2, action: "reject" }, idempotencyKey);
  const noKey = parseApplicationDocumentReview({ expectedVersion: 2, action: "approve" }, null);
  const clean = parseApplicationDocumentScan({ expectedVersion: 2, sourceEventId: "qa-scan-1", outcome: "clean" });
  const rejected = parseApplicationDocumentScan({ expectedVersion: 2, sourceEventId: "qa-scan-2", outcome: "rejected", reason: "parser_invalid" });
  assert.deepEqual(approval, { expectedVersion: 2, action: "approve", reason: "", idempotencyKey });
  assert.deepEqual(correction, { expectedVersion: 2, action: "request_changes", reason: "Please upload a current certificate.", idempotencyKey });
  assert.equal(missingNote, null);
  assert.equal(noKey, null);
  assert.deepEqual(clean, { expectedVersion: 2, sourceEventId: "qa-scan-1", outcome: "clean", reason: "" });
  assert.deepEqual(rejected, { expectedVersion: 2, sourceEventId: "qa-scan-2", outcome: "rejected", reason: "parser_invalid" });
  assert.equal(parseApplicationDocumentScan({ expectedVersion: 2, sourceEventId: "qa-scan-3", outcome: "rejected" }), null);
  assert.equal(documentReviewState("approve"), "approved");
  assert.equal(documentReviewState("request_changes"), "changes_requested");
  assert.equal(documentReviewState("reject"), "rejected");
});

test("document fingerprints change with a decision, version, source event or corrective reason", () => {
  const review = applicationDocumentReviewFingerprint(applicationId, 1, "approve", "");
  assert.notEqual(review, applicationDocumentReviewFingerprint(applicationId, 2, "approve", ""));
  assert.notEqual(review, applicationDocumentReviewFingerprint(applicationId, 1, "request_changes", "current document needed"));
  const scan = applicationDocumentScanFingerprint(applicationId, 1, "scan-1", "clean", "");
  assert.notEqual(scan, applicationDocumentScanFingerprint(applicationId, 1, "scan-2", "clean", ""));
  assert.notEqual(scan, applicationDocumentScanFingerprint(applicationId, 1, "scan-1", "rejected", "parser_invalid"));
});
