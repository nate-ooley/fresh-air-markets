import { test } from "node:test";
import assert from "node:assert/strict";
import type { ApplicationReviewOutboxMessage } from "../src/lib/application-review-pg.ts";
import {
  ApplicationReviewDeliveryError,
  deliverApplicationReviewToGhl,
  readApplicationReviewDeliveryConfig,
} from "../src/lib/ghl-application-review-delivery.ts";

const env = {
  VERCEL: "1",
  VERCEL_ENV: "production",
  GHL_API_TOKEN: "qa-token-at-least-sixteen-characters",
  GHL_LOCATION_ID: "aooAnUXF0COePorBo7wL",
  GHL_APPLICATION_PIPELINE_ID: "qa_pipeline_1",
  GHL_APPLICATION_REVIEW_STAGE_ID: "qa_review_1",
  GHL_APPLICATION_APPROVED_STAGE_ID: "qa_approved_1",
  GHL_APPLICATION_CHANGES_REQUESTED_STAGE_ID: "qa_changes_1",
  GHL_APPLICATION_DECLINED_STAGE_ID: "qa_declined_1",
};
const config = readApplicationReviewDeliveryConfig(env);

function message(reviewState: "approved" | "changes_requested" | "declined" = "approved"): ApplicationReviewOutboxMessage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    marketId: "qa_market_1",
    attempt: 1,
    leaseToken: "22222222-2222-4222-8222-222222222222",
    payload: {
      applicationId: "33333333-3333-4333-8333-333333333333",
      reviewEventId: "44444444-4444-4444-8444-444444444444",
      sourceEventId: "application:qa:current",
      marketId: "qa_market_1",
      locationId: env.GHL_LOCATION_ID,
      contactId: "qa_contact_1",
      opportunityId: "qa_opportunity_1",
      seasonId: "2026-2027",
      reviewState,
      actorAccountId: "qa_market_1",
      reason: "",
    },
  };
}

function opportunity(stage: string, patch: Record<string, unknown> = {}): Response {
  return Response.json({
    opportunity: {
      id: "qa_opportunity_1",
      contactId: "qa_contact_1",
      locationId: env.GHL_LOCATION_ID,
      pipelineId: env.GHL_APPLICATION_PIPELINE_ID,
      pipelineStageId: stage,
      status: "open",
      ...patch,
    },
  });
}

function scripted(responses: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected request");
    return next;
  }) as typeof fetch;
  return { calls, transport };
}

test("approval PUT moves only the immutable opportunity from review to its configured stage", async () => {
  const script = scripted([
    opportunity(env.GHL_APPLICATION_REVIEW_STAGE_ID),
    opportunity(env.GHL_APPLICATION_APPROVED_STAGE_ID),
    opportunity(env.GHL_APPLICATION_APPROVED_STAGE_ID),
  ]);
  await deliverApplicationReviewToGhl(message(), config, script.transport);
  assert.equal(script.calls.length, 3);
  assert.equal(script.calls[0].url.endsWith(`/opportunities/${message().payload.opportunityId}`), true);
  assert.equal(script.calls[1].init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(script.calls[1].init?.body)), {
    pipelineStageId: env.GHL_APPLICATION_APPROVED_STAGE_ID,
  });
  const headers = new Headers(script.calls[1].init?.headers);
  assert.equal(headers.get("version"), "v3");
  assert.equal(headers.get("authorization"), `Bearer ${env.GHL_API_TOKEN}`);
});

test("each review result maps only to its configured HighLevel stage", async () => {
  for (const [state, expectedStage] of Object.entries(config.stageForOutcome) as Array<["approved" | "changes_requested" | "declined", string]>) {
    const script = scripted([opportunity(env.GHL_APPLICATION_REVIEW_STAGE_ID), opportunity(expectedStage), opportunity(expectedStage)]);
    await deliverApplicationReviewToGhl(message(state), config, script.transport);
    assert.equal(JSON.parse(String(script.calls[1].init?.body)).pipelineStageId, expectedStage);
  }
});

test("identity and pipeline mismatches fail before a HighLevel PUT", async () => {
  for (const patch of [{ id: "another_opportunity" }, { contactId: "another_contact" }, { pipelineId: "another_pipeline" }, { locationId: "another_location" }, { locationId: undefined }]) {
    const script = scripted([opportunity(env.GHL_APPLICATION_REVIEW_STAGE_ID, patch)]);
    await assert.rejects(
      () => deliverApplicationReviewToGhl(message(), config, script.transport),
      error => error instanceof ApplicationReviewDeliveryError
        && ["ghl_identity_mismatch", "ghl_pipeline_mismatch"].includes(error.code),
    );
    assert.equal(script.calls.length, 1);
  }
  const wrongLocationMessage = message();
  wrongLocationMessage.payload.locationId = "another_location";
  const script = scripted([]);
  await assert.rejects(
    () => deliverApplicationReviewToGhl(wrongLocationMessage, config, script.transport),
    error => error instanceof ApplicationReviewDeliveryError && error.code === "ghl_identity_mismatch",
  );
  assert.equal(script.calls.length, 0);
});

test("a target-stage preflight is a no-PUT recovery after a crash following a successful update", async () => {
  const script = scripted([opportunity(env.GHL_APPLICATION_APPROVED_STAGE_ID)]);
  await deliverApplicationReviewToGhl(message(), config, script.transport);
  assert.equal(script.calls.length, 1);
  assert.equal(script.calls[0].init?.method, "GET");
});

test("an unexpected source stage or closed opportunity is never overwritten", async () => {
  for (const source of [
    opportunity("manual_other_stage"),
    opportunity(env.GHL_APPLICATION_REVIEW_STAGE_ID, { status: "won" }),
    opportunity(env.GHL_APPLICATION_APPROVED_STAGE_ID, { status: "won" }),
    opportunity(env.GHL_APPLICATION_APPROVED_STAGE_ID, { status: "lost" }),
    opportunity(env.GHL_APPLICATION_APPROVED_STAGE_ID, { status: "abandoned" }),
  ]) {
    const script = scripted([source]);
    await assert.rejects(
      () => deliverApplicationReviewToGhl(message(), config, script.transport),
      error => error instanceof ApplicationReviewDeliveryError
        && ["ghl_stage_diverged", "ghl_status_diverged"].includes(error.code),
    );
    assert.equal(script.calls.length, 1);
    assert.equal(script.calls[0].init?.method, "GET");
  }
});

test("the post-update readback rejects a provider lifecycle-status change", async () => {
  const script = scripted([
    opportunity(env.GHL_APPLICATION_REVIEW_STAGE_ID),
    opportunity(env.GHL_APPLICATION_APPROVED_STAGE_ID),
    opportunity(env.GHL_APPLICATION_APPROVED_STAGE_ID, { status: "lost" }),
  ]);
  await assert.rejects(
    () => deliverApplicationReviewToGhl(message(), config, script.transport),
    error => error instanceof ApplicationReviewDeliveryError && error.code === "ghl_stage_diverged",
  );
  assert.equal(script.calls.length, 3);
});

test("a stage-only PUT cannot reopen or move back an opportunity changed by an operator after preflight", async () => {
  const current = {
    id: message().payload.opportunityId, contactId: message().payload.contactId,
    locationId: config.locationId, pipelineId: config.pipelineId,
    pipelineStageId: config.reviewStageId, status: "open",
  };
  const transport = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      current.status = "won";
      current.pipelineId = "operator_selected_pipeline";
      const update = JSON.parse(String(init.body));
      assert.deepEqual(update, { pipelineStageId: config.stageForOutcome.approved });
      Object.assign(current, update);
    }
    return Response.json({ opportunity: current });
  }) as typeof fetch;
  await assert.rejects(() => deliverApplicationReviewToGhl(message(), config, transport),
    error => error instanceof ApplicationReviewDeliveryError && error.code === "ghl_pipeline_mismatch");
  assert.equal(current.status, "won");
  assert.equal(current.pipelineId, "operator_selected_pipeline");
});

test("rate limits and bad configuration remain safe and report bounded retry signals", async () => {
  const script = scripted([new Response("limited", { status: 429, headers: { "retry-after": "17" } })]);
  await assert.rejects(
    () => deliverApplicationReviewToGhl(message(), config, script.transport),
    error => error instanceof ApplicationReviewDeliveryError
      && error.code === "ghl_rate_limited"
      && error.retryAfterSeconds === 17,
  );
  assert.throws(() => readApplicationReviewDeliveryConfig({ ...env, GHL_APPLICATION_DECLINED_STAGE_ID: env.GHL_APPLICATION_APPROVED_STAGE_ID }), /not configured/);
});
