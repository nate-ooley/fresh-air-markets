import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgreementAlreadyCompletedError,
  AgreementMappingError,
  handleAgreementCompleted,
  handleAgreementIssued,
  type AgreementCompleted,
  type AgreementIssued,
} from "../src/lib/agreement-completion.ts";

const config = {
  secret: "qa-agreement-secret-with-at-least-32-characters",
  locationId: "qa-location",
  marketId: "qa-market",
  seasonId: "2026-2027",
  templateId: "qa-agreement-template",
  notificationEmail: "NATE@AUTOCRAFTSTUDIOS.COM",
};
const common = {
  eventId: "qa-agreement-event",
  documentId: "qa-document",
  templateId: config.templateId,
  contactId: "qa-contact",
  opportunityId: "qa-opportunity",
  locationId: config.locationId,
  seasonId: config.seasonId,
};

function request(value: unknown, auth = `Bearer ${config.secret}`) {
  return new Request("https://unit-test.invalid/api/integrations/highlevel/agreements", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

test("issuance requires a configured, authenticated exact sent event and derives the admin target server-side", async () => {
  const received: AgreementIssued[] = [];
  const response = await handleAgreementIssued(request({ ...common, status: "sent", notificationEmail: "live-admin@example.com" }), config, async event => {
    received.push(event);
    return "captured";
  });
  assert.equal(response.status, 201);
  assert.equal(received.length, 1);
  assert.equal(received[0].marketId, config.marketId);
  assert.equal(received[0].notificationEmail, "nate@autocraftstudios.com");
  assert.equal(received[0].documentId, common.documentId);
  assert.equal(JSON.stringify(await response.json()).includes("nate@autocraftstudios.com"), false);
});

test("authorization, missing setup, malformed identity, wrong template and non-sent statuses cannot persist an issuance", async () => {
  let writes = 0;
  const invalid = [
    null, [], { ...common, status: "completed" }, { ...common, status: "sent", templateId: "other-template" },
    { ...common, status: "sent", opportunityId: "../other" }, { ...common, status: "sent", locationId: "other-location" },
  ];
  for (const body of invalid) {
    const response = await handleAgreementIssued(request(body), config, async () => { writes++; return "captured"; });
    assert.equal(response.status, 400);
  }
  for (const auth of ["", "Bearer wrong", `Bearer ${"é".repeat(64)}`]) {
    const response = await handleAgreementIssued(request({ ...common, status: "sent" }, auth), config, async () => { writes++; return "captured"; });
    assert.equal(response.status, 401);
  }
  const setup = await handleAgreementIssued(request({ ...common, status: "sent" }), { ...config, notificationEmail: "" }, async () => { writes++; return "captured"; });
  assert.equal(setup.status, 503);
  assert.equal(writes, 0);
});

test("completion accepts only completed status and gives semantically identical retries the same stable fingerprint", async () => {
  const received: AgreementCompleted[] = [];
  const persist = async (event: AgreementCompleted) => { received.push(event); return "captured" as const; };
  const first = await handleAgreementCompleted(request({ ...common, status: "completed", ignoredProviderField: { nested: true } }), config, persist);
  const second = await handleAgreementCompleted(request({ status: "completed", seasonId: common.seasonId, opportunityId: common.opportunityId, documentId: common.documentId, contactId: common.contactId, eventId: common.eventId, locationId: common.locationId, templateId: common.templateId }), config, persist);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(received.length, 2);
  assert.equal(received[0].payloadHash, received[1].payloadHash);
  for (const status of ["sent", "declined", "viewed", ""] as const) {
    const response = await handleAgreementCompleted(request({ ...common, status }), config, persist);
    assert.equal(response.status, 400);
  }
  assert.equal(received.length, 2);
});

test("completion makes mapping, prior completion, duplicate, conflict and transient outcomes explicit without leaking internals", async () => {
  const body = { ...common, status: "completed" };
  const mapping = await handleAgreementCompleted(request(body), config, async () => { throw new AgreementMappingError(); });
  assert.equal(mapping.status, 422);
  const already = await handleAgreementCompleted(request(body), config, async () => { throw new AgreementAlreadyCompletedError(); });
  assert.equal(already.status, 409);
  assert.equal((await already.text()).includes("database-password"), false);
  assert.equal((await handleAgreementCompleted(request(body), config, async () => "duplicate")).status, 200);
  assert.equal((await handleAgreementCompleted(request(body), config, async () => "conflict")).status, 409);
  const transient = await handleAgreementCompleted(request(body), config, async () => { throw new Error("database-password"); });
  assert.equal(transient.status, 503);
  assert.equal((await transient.text()).includes("database-password"), false);
});

test("oversized agreement events are rejected before their persistence callback", async () => {
  let writes = 0;
  const response = await handleAgreementCompleted(request({ ...common, status: "completed", padding: "x".repeat(33 * 1024) }), config, async () => {
    writes++;
    return "captured";
  });
  assert.equal(response.status, 413);
  assert.equal(writes, 0);
});
