import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgreementStageDeliveryMessage } from "../src/lib/agreement-completion-pg.ts";
import {
  AgreementStageDeliveryError,
  deliverAgreementStageToGhl,
  readAgreementStageDeliveryConfig,
} from "../src/lib/ghl-agreement-completion-delivery.ts";

const env = {
  GHL_API_TOKEN: "qa-token-at-least-sixteen-characters",
  GHL_LOCATION_ID: "qa_location_1",
  GHL_AGREEMENT_PIPELINE_ID: "qa_agreement_pipeline_1",
  GHL_AGREEMENT_SENT_STAGE_ID: "qa_agreement_sent_1",
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

test("agreement completion moves only its immutable opportunity to the configured completed stage", async () => {
  const script = scripted([
    opportunity(env.GHL_AGREEMENT_SENT_STAGE_ID),
    opportunity(env.GHL_AGREEMENT_COMPLETED_STAGE_ID),
    opportunity(env.GHL_AGREEMENT_COMPLETED_STAGE_ID),
  ]);
  await deliverAgreementStageToGhl(message(), config, script.transport);
  assert.equal(script.calls.length, 3);
  assert.equal(script.calls[0].url.endsWith(`/opportunities/${message().payload.opportunityId}`), true);
  assert.equal(script.calls[1].init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(script.calls[1].init?.body)), {
    pipelineId: env.GHL_AGREEMENT_PIPELINE_ID,
    pipelineStageId: env.GHL_AGREEMENT_COMPLETED_STAGE_ID,
    status: "open",
  });
  const headers = new Headers(script.calls[1].init?.headers);
  assert.equal(headers.get("version"), "v3");
  assert.equal(headers.get("authorization"), `Bearer ${env.GHL_API_TOKEN}`);
});

test("a completed-stage preflight is a no-PUT recovery after provider success and local interruption", async () => {
  const script = scripted([opportunity(env.GHL_AGREEMENT_COMPLETED_STAGE_ID)]);
  await deliverAgreementStageToGhl(message(), config, script.transport);
  assert.equal(script.calls.length, 1);
  assert.equal(script.calls[0].init?.method, "GET");
});

test("contact, opportunity location, and pipeline mismatches stop before a HighLevel PUT", async () => {
  for (const patch of [{ id: "other_opportunity" }, { contactId: "other_contact" }, { locationId: "other_location" }, { pipelineId: "other_pipeline" }]) {
    const script = scripted([opportunity(env.GHL_AGREEMENT_SENT_STAGE_ID, patch)]);
    await assert.rejects(
      () => deliverAgreementStageToGhl(message(), config, script.transport),
      error => error instanceof AgreementStageDeliveryError
        && ["ghl_identity_mismatch", "ghl_pipeline_mismatch"].includes(error.code),
    );
    assert.equal(script.calls.length, 1);
  }
  const wrongConfiguredLocation = readAgreementStageDeliveryConfig({ ...env, GHL_LOCATION_ID: "other_location" });
  const script = scripted([]);
  await assert.rejects(
    () => deliverAgreementStageToGhl(message(), wrongConfiguredLocation, script.transport),
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
  assert.equal(script.calls.length, 1);
});

test("a closed agreement opportunity is never reopened to complete its stage transition", async () => {
  const script = scripted([opportunity(env.GHL_AGREEMENT_SENT_STAGE_ID, { status: "won" })]);
  await assert.rejects(
    () => deliverAgreementStageToGhl(message(), config, script.transport),
    error => error instanceof AgreementStageDeliveryError && error.code === "ghl_status_diverged",
  );
  assert.equal(script.calls.length, 1);
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
  assert.equal(script.calls.length, 3);
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
