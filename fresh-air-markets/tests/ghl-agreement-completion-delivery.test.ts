import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgreementStageDeliveryMessage } from "../src/lib/agreement-completion-pg.ts";
import {
  AgreementStageDeliveryError,
  deliverAgreementStageToGhl,
  readAgreementStageDeliveryConfig,
} from "../src/lib/ghl-agreement-completion-delivery.ts";
import { readApplicationReviewDeliveryConfig, deliverApplicationReviewToGhl } from "../src/lib/ghl-application-review-delivery.ts";

const env = {
  VERCEL: "1",
  VERCEL_ENV: "preview",
  GHL_PAYMENT_QA_ROUTING_VERIFIED: "true",
  GHL_API_TOKEN: "qa-token-at-least-sixteen-characters",
  GHL_LOCATION_ID: "aooAnUXF0COePorBo7wL",
  GHL_APPLICATION_PIPELINE_ID: "production_application_pipeline",
  GHL_QA_APPLICATION_PIPELINE_ID: "qa_application_pipeline",
  GHL_AGREEMENT_PIPELINE_ID: "qa_application_pipeline",
  GHL_APPLICATION_REVIEW_STAGE_ID: "qa_review",
  GHL_APPLICATION_APPROVED_STAGE_ID: "qa_approved",
  GHL_APPLICATION_CHANGES_REQUESTED_STAGE_ID: "qa_changes",
  GHL_APPLICATION_DECLINED_STAGE_ID: "qa_declined",
  GHL_AGREEMENT_SENT_STAGE_ID: "qa_approved",
  GHL_AGREEMENT_COMPLETED_STAGE_ID: "qa_agreement_completed_1",
};
const config = readAgreementStageDeliveryConfig(env);

function message(): AgreementStageDeliveryMessage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    marketId: "qa_market_1",
    attempt: 1,
    leaseToken: "22222222-2222-4222-8222-222222222222",
    payload: {
      applicationId: "33333333-3333-4333-8333-333333333333",
      completionId: "44444444-4444-4444-8444-444444444444",
      documentId: "qa_document_1",
      templateId: "qa_template_1",
      marketId: "qa_market_1",
      locationId: env.GHL_LOCATION_ID,
      contactId: "qa_contact_1",
      opportunityId: "qa_opportunity_1",
      seasonId: "2026-2027",
    },
  };
}

function opportunity(stage: string, patch: Record<string, unknown> = {}): Response {
  return Response.json({
    opportunity: {
      id: "qa_opportunity_1",
      contactId: "qa_contact_1",
      locationId: env.GHL_LOCATION_ID,
      pipelineId: env.GHL_AGREEMENT_PIPELINE_ID,
      pipelineStageId: stage,
      status: "open",
      ...patch,
    },
  });
}

function scripted(responses: Response[], contactPatches: Array<Record<string, unknown>> = []) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (String(input).includes("/contacts/")) {
      return Response.json({ contact: { id: "qa_contact_1", locationId: env.GHL_LOCATION_ID,
        email: "lnooley@gmail.com", ...contactPatches.shift() } });
    }
    const next = responses.shift();
    if (!next) throw new Error("Unexpected request");
    return next;
  }) as typeof fetch;
  return { calls, transport };
}

test("agreement completion moves only its immutable opportunity to the configured completed stage", async () => {
  const script = scripted([
    opportunity(env.GHL_AGREEMENT_SENT_STAGE_ID),
    opportunity(env.GHL_AGREEMENT_COMPLETED_STAGE_ID),
    opportunity(env.GHL_AGREEMENT_COMPLETED_STAGE_ID),
  ]);
  await deliverAgreementStageToGhl(message(), config, script.transport);
  assert.equal(script.calls.length, 5);
  assert.equal(script.calls[1].url.endsWith(`/opportunities/${message().payload.opportunityId}`), true);
  assert.equal(script.calls[3].init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(script.calls[3].init?.body)), {
    pipelineStageId: env.GHL_AGREEMENT_COMPLETED_STAGE_ID,
  });
  const headers = new Headers(script.calls[3].init?.headers);
  assert.equal(headers.get("version"), "v3");
  assert.equal(headers.get("authorization"), `Bearer ${env.GHL_API_TOKEN}`);
});

test("a completed-stage preflight is a no-PUT recovery after provider success and local interruption", async () => {
  const script = scripted([opportunity(env.GHL_AGREEMENT_COMPLETED_STAGE_ID)]);
  await deliverAgreementStageToGhl(message(), config, script.transport);
  assert.equal(script.calls.length, 2);
  assert.equal(script.calls[0].init?.method, "GET");
});

test("contact, opportunity location, and pipeline mismatches stop before a HighLevel PUT", async () => {
  for (const patch of [{ id: "other_opportunity" }, { contactId: "other_contact" }, { locationId: "other_location" }, { locationId: undefined }, { pipelineId: "other_pipeline" }]) {
    const script = scripted([opportunity(env.GHL_AGREEMENT_SENT_STAGE_ID, patch)]);
    await assert.rejects(
      () => deliverAgreementStageToGhl(message(), config, script.transport),
      error => error instanceof AgreementStageDeliveryError
        && ["ghl_identity_mismatch", "ghl_pipeline_mismatch"].includes(error.code),
    );
    assert.equal(script.calls.length, 2);
  }
  assert.throws(() => readAgreementStageDeliveryConfig({ ...env, GHL_LOCATION_ID: "other_location" }), AgreementStageDeliveryError);
  const wrongLocation = message(); wrongLocation.payload.locationId = "other_location";
  const script = scripted([]);
  await assert.rejects(
    () => deliverAgreementStageToGhl(wrongLocation, config, script.transport),
    error => error instanceof AgreementStageDeliveryError && error.code === "ghl_identity_mismatch",
  );
  assert.equal(script.calls.length, 0);
});

test("an unexpected source stage cannot be overwritten", async () => {
  const script = scripted([opportunity("manual_other_stage")]);
  await assert.rejects(
    () => deliverAgreementStageToGhl(message(), config, script.transport),
    error => error instanceof AgreementStageDeliveryError && error.code === "ghl_stage_diverged",
  );
  assert.equal(script.calls.length, 2);
});

test("a closed agreement opportunity is never reopened to complete its stage transition", async () => {
  const script = scripted([opportunity(env.GHL_AGREEMENT_SENT_STAGE_ID, { status: "won" })]);
  await assert.rejects(
    () => deliverAgreementStageToGhl(message(), config, script.transport),
    error => error instanceof AgreementStageDeliveryError && error.code === "ghl_status_diverged",
  );
  assert.equal(script.calls.length, 2);
  assert.equal(script.calls[0].init?.method, "GET");
});

test("the post-update readback rejects a provider status change", async () => {
  const script = scripted([
    opportunity(env.GHL_AGREEMENT_SENT_STAGE_ID),
    opportunity(env.GHL_AGREEMENT_COMPLETED_STAGE_ID),
    opportunity(env.GHL_AGREEMENT_COMPLETED_STAGE_ID, { status: "lost" }),
  ]);
  await assert.rejects(
    () => deliverAgreementStageToGhl(message(), config, script.transport),
    error => error instanceof AgreementStageDeliveryError && error.code === "ghl_stage_diverged",
  );
  assert.equal(script.calls.length, 5);
});

test("agreement configuration selects the same application pipeline as review and rejects a different legacy alias", () => {
  assert.equal(config.pipelineId, readApplicationReviewDeliveryConfig(env).pipelineId);
  assert.equal(config.sentStageId, readApplicationReviewDeliveryConfig(env).stageForOutcome.approved);
  assert.equal(readAgreementStageDeliveryConfig({ ...env, GHL_AGREEMENT_PIPELINE_ID: "" }).pipelineId, env.GHL_QA_APPLICATION_PIPELINE_ID);
  for (const patch of [
    { GHL_AGREEMENT_PIPELINE_ID: "another_pipeline" }, { GHL_AGREEMENT_PIPELINE_ID: env.GHL_APPLICATION_PIPELINE_ID },
    { GHL_QA_APPLICATION_PIPELINE_ID: env.GHL_APPLICATION_PIPELINE_ID }, { GHL_PAYMENT_QA_ROUTING_VERIFIED: "false" },
    { GHL_APPLICATION_PIPELINE_ID: "" }, { VERCEL: "" }, { VERCEL_ENV: "development" },
  ]) assert.throws(() => readAgreementStageDeliveryConfig({ ...env, ...patch }), AgreementStageDeliveryError);
  const production = { ...env, VERCEL_ENV: "production", GHL_AGREEMENT_PIPELINE_ID: env.GHL_APPLICATION_PIPELINE_ID,
    GHL_QA_APPLICATION_PIPELINE_ID: "", GHL_PAYMENT_QA_ROUTING_VERIFIED: "" };
  assert.equal(readAgreementStageDeliveryConfig(production).pipelineId, readApplicationReviewDeliveryConfig(production).pipelineId);
  assert.throws(() => readAgreementStageDeliveryConfig({ ...production, GHL_PAYMENT_QA_ROUTING_VERIFIED: "false" }), AgreementStageDeliveryError);
});

test("QA agreement completion rejects a live or switched contact before any opportunity mutation", async () => {
  for (const patch of [{ email: "live@example.com" }, { email: "lnooley+test@gmail.com" },
    { locationId: "other_location" }, { id: "other_contact" }, { email: undefined }]) {
    const script = scripted([], [patch]);
    await assert.rejects(() => deliverAgreementStageToGhl(message(), config, script.transport),
      error => error instanceof AgreementStageDeliveryError && error.code === "ghl_identity_mismatch");
    assert.equal(script.calls.length, 1); assert.equal(script.calls[0].init?.method, "GET");
  }
  const changed = scripted([opportunity(env.GHL_AGREEMENT_SENT_STAGE_ID)], [{ email: "nate@autocraftstudios.com" }, { email: "live@example.com" }]);
  await assert.rejects(() => deliverAgreementStageToGhl(message(), config, changed.transport),
    error => error instanceof AgreementStageDeliveryError && error.code === "ghl_identity_mismatch");
  assert.equal(changed.calls.some(call => call.init?.method === "PUT"), false);
});

test("the same QA opportunity advances from review to approved and then agreement signed without a pipeline move", async () => {
  const reviewConfig = readApplicationReviewDeliveryConfig(env);
  let stage = env.GHL_APPLICATION_REVIEW_STAGE_ID;
  const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.equal(init?.redirect, "error");
    if (url.endsWith("/contacts/qa_contact_1")) return Response.json({ contact: {
      id: "qa_contact_1", email: "nate@autocraftstudios.com", locationId: env.GHL_LOCATION_ID,
    } });
    assert.equal(url.endsWith("/opportunities/qa_opportunity_1"), true);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)); writes.push({ url, body });
      if (body.pipelineId !== undefined) assert.equal(body.pipelineId, env.GHL_QA_APPLICATION_PIPELINE_ID);
      stage = body.pipelineStageId;
    }
    return opportunity(stage);
  }) as typeof fetch;
  const agreement = message();
  await deliverApplicationReviewToGhl({ ...agreement, payload: {
    ...agreement.payload, reviewEventId: "review-event-1", sourceEventId: "source-event-1", reviewState: "approved",
    actorAccountId: agreement.marketId, reason: "",
  } }, reviewConfig, transport);
  assert.equal(stage, env.GHL_AGREEMENT_SENT_STAGE_ID);
  await deliverAgreementStageToGhl(agreement, config, transport);
  assert.equal(stage, env.GHL_AGREEMENT_COMPLETED_STAGE_ID);
  assert.equal(writes.length, 2); assert.equal(writes[0].url, writes[1].url);
  assert.deepEqual(writes[1].body, { pipelineStageId: env.GHL_AGREEMENT_COMPLETED_STAGE_ID });
});

test("rate limits and invalid agreement-stage configuration remain retriable and fail closed", async () => {
  const script = scripted([new Response("limited", { status: 429, headers: { "retry-after": "17" } })]);
  await assert.rejects(
    () => deliverAgreementStageToGhl(message(), config, script.transport),
    error => error instanceof AgreementStageDeliveryError
      && error.code === "ghl_rate_limited"
      && error.retryAfterSeconds === 17,
  );
  assert.throws(
    () => readAgreementStageDeliveryConfig({ ...env, GHL_AGREEMENT_COMPLETED_STAGE_ID: env.GHL_AGREEMENT_SENT_STAGE_ID }),
    /not configured/,
  );
});
