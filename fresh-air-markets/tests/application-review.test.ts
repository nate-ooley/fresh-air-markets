import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applicationReviewFingerprint,
  parseApplicationReview,
  stateForReviewAction,
  validApplicationId,
} from "../src/lib/application-review.ts";

const key = "11111111-1111-4111-8111-111111111111";
const sourceEventId = "application:qa:current";

test("review input accepts only a server-bound action, stable source event and retry key", () => {
  const review = parseApplicationReview(
    { action: "request_changes", sourceEventId, reason: "Please upload the current certificate." },
    key,
  );
  assert.deepEqual(review, {
    action: "request_changes",
    sourceEventId,
    reason: "Please upload the current certificate.",
    idempotencyKey: key,
  });
  assert.equal(validApplicationId("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(validApplicationId("qa-contact"), false);
});

test("review input rejects body attempts to substitute identity, malformed retries and blank correction reasons", () => {
  for (const [body, header] of [
    [{ action: "approve", sourceEventId: "../other" }, key],
    [{ action: "approve", sourceEventId }, "not-a-key"],
    [{ action: "request_changes", sourceEventId, reason: " " }, key],
    [{ action: "decline", sourceEventId }, key],
    [{ action: "approve", sourceEventId, reason: "x".repeat(2001) }, key],
  ] as const) {
    assert.equal(parseApplicationReview(body, header), null);
  }
});

test("decision hashes are stable for exact replay and change if the exact source/action changes", () => {
  const original = applicationReviewFingerprint("11111111-1111-4111-8111-111111111111", sourceEventId, "approve", "");
  assert.equal(original, applicationReviewFingerprint("11111111-1111-4111-8111-111111111111", sourceEventId, "approve", ""));
  assert.notEqual(original, applicationReviewFingerprint("11111111-1111-4111-8111-111111111111", "application:qa:new", "approve", ""));
  assert.notEqual(original, applicationReviewFingerprint("11111111-1111-4111-8111-111111111111", sourceEventId, "decline", "No capacity"));
});

test("action mapping does not infer an approval from a source snapshot", () => {
  assert.equal(stateForReviewAction("approve"), "approved");
  assert.equal(stateForReviewAction("request_changes"), "changes_requested");
  assert.equal(stateForReviewAction("decline"), "declined");
});
