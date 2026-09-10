const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ApplicationDocumentDeliveryError,
  buildApplicationDocumentDeliveryEnvelope,
} = require('../.test-build/application-document-pg.js');

const target = {
  applicationId: '11111111-1111-4111-8111-111111111111',
  marketId: 'qa-market',
  locationId: 'qa-location',
  contactId: 'qa-contact',
  opportunityId: 'qa-opportunity',
  seasonId: '2026-2027',
  documentId: 'qa-document-1',
  documentKind: 'insurance',
  version: 2,
};

function message(payload) {
  return {
    id: 'qa-outbox-1',
    marketId: target.marketId,
    attempt: 1,
    leaseToken: 'qa-lease-1',
    payload,
  };
}

function submittedPayload() {
  return {
    topic: 'document-submitted',
    applicationId: target.applicationId,
    documentId: target.documentId,
    marketId: target.marketId,
    documentKind: target.documentKind,
    version: target.version,
    sourceEventId: 'qa-upload-1',
    file: {
      storageKey: 'documents/private/qa-document-1.pdf',
      sourceFileId: 'qa-file-1',
      filename: 'insurance.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      sha256: 'a'.repeat(64),
    },
  };
}

test('document delivery envelope uses the exact stored application opportunity and exposes no private file reference', () => {
  const envelope = buildApplicationDocumentDeliveryEnvelope(message(submittedPayload()), target);

  assert.deepEqual(envelope.application, {
    id: target.applicationId,
    marketId: target.marketId,
    locationId: target.locationId,
    contactId: target.contactId,
    opportunityId: target.opportunityId,
    seasonId: target.seasonId,
  });
  assert.deepEqual(envelope.document, { id: target.documentId, kind: 'insurance', version: 2 });
  assert.deepEqual(envelope.event, { topic: 'document-submitted', sourceEventId: 'qa-upload-1' });
  assert.equal(envelope.outboxId, 'qa-outbox-1');
  assert.equal(envelope.idempotencyKey, 'fame-document:qa-outbox-1');
  const serialized = JSON.stringify(envelope);
  for (const privateField of ['storageKey', 'sourceFileId', 'filename', 'sha256', 'private/qa-document']) {
    assert.equal(serialized.includes(privateField), false);
  }
});

test('document delivery envelope preserves exact validation and review event meanings', () => {
  const ready = buildApplicationDocumentDeliveryEnvelope(message({
    topic: 'document-ready-for-review',
    applicationId: target.applicationId,
    documentId: target.documentId,
    marketId: target.marketId,
    documentKind: target.documentKind,
    version: target.version,
    validationEventId: 'qa-scan-1',
    sourceEventId: 'qa-upload-1',
    validationState: 'ready_for_review',
    reason: '',
  }), target);
  const rejected = buildApplicationDocumentDeliveryEnvelope(message({
    topic: 'document-validation-rejected',
    applicationId: target.applicationId,
    documentId: target.documentId,
    marketId: target.marketId,
    documentKind: target.documentKind,
    version: target.version,
    validationEventId: 'qa-scan-2',
    sourceEventId: 'qa-upload-1',
    validationState: 'rejected',
    reason: 'parser_invalid',
  }), target);
  const review = buildApplicationDocumentDeliveryEnvelope(message({
    topic: 'document-review',
    applicationId: target.applicationId,
    documentId: target.documentId,
    marketId: target.marketId,
    documentKind: target.documentKind,
    version: target.version,
    reviewEventId: 'qa-review-1',
    actorAccountId: 'qa-admin',
    reviewState: 'changes_requested',
    reason: 'Please upload a current certificate.',
  }), target);

  assert.deepEqual(ready.event, {
    topic: 'document-ready-for-review', validationEventId: 'qa-scan-1', sourceEventId: 'qa-upload-1',
    validationState: 'ready_for_review', reason: '',
  });
  assert.deepEqual(rejected.event, {
    topic: 'document-validation-rejected', validationEventId: 'qa-scan-2', sourceEventId: 'qa-upload-1',
    validationState: 'rejected', reason: 'parser_invalid',
  });
  assert.deepEqual(review.event, {
    topic: 'document-review', reviewEventId: 'qa-review-1', actorAccountId: 'qa-admin',
    reviewState: 'changes_requested', reason: 'Please upload a current certificate.',
  });
});

test('document delivery refuses missing or substituted application identities before an adapter can run', () => {
  const submitted = message(submittedPayload());
  assert.throws(
    () => buildApplicationDocumentDeliveryEnvelope(submitted, { ...target, opportunityId: '' }),
    error => error instanceof ApplicationDocumentDeliveryError && error.code === 'document_identity_missing',
  );
  assert.throws(
    () => buildApplicationDocumentDeliveryEnvelope(submitted, { ...target, documentId: 'another-document' }),
    error => error instanceof ApplicationDocumentDeliveryError && error.code === 'document_identity_mismatch',
  );
  assert.throws(
    () => buildApplicationDocumentDeliveryEnvelope({ ...submitted, marketId: 'other-market' }, target),
    error => error instanceof ApplicationDocumentDeliveryError && error.code === 'document_identity_mismatch',
  );
});
