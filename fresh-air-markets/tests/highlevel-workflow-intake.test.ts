import { test } from "node:test";
import assert from "node:assert/strict";
import { mapHighLevelWorkflowApplication } from "../src/lib/highlevel-workflow-intake.ts";
import { handleApplicationHandoff, type ApplicationHandoff } from "../src/lib/application-handoff.ts";

const config = { locationId: "aooAnUXF0COePorBo7wL", seasonId: "2026-2027" };
const native = {
  contact_id: "c0nTact123", first_name: "Rosa", last_name: "Alvarez", full_name: "Rosa Alvarez",
  email: "rosa@sunrisefarms.example", phone: "+15550100", tags: "vendor-application",
  date_created: "2026-09-10T18:00:00.000Z",
  "Vendor Business Name": "Sunrise Farms", "Vendor Category": "Produce",
  "Vendor Dates Requested": "Sat, Oct 3, 2026, Sat, Oct 10, 2026",
  "Registration Type": "Vendor", "Tell us about your business": "Organic produce.",
  location: { id: config.locationId, name: "Fresh Air Markets" },
  workflow: { id: "wf_1", name: "Vendor application → portal" },
  customData: { opportunityId: "opp_9" },
};

test("native workflow payload maps to the handoff envelope the review step can read", () => {
  const mapped = mapHighLevelWorkflowApplication(native, config);
  assert.ok(mapped);
  assert.equal(mapped.contactId, "c0nTact123");
  assert.equal(mapped.opportunityId, "opp_9");
  assert.equal(mapped.locationId, config.locationId);
  assert.equal(mapped.seasonId, "2026-2027");
  assert.match(mapped.eventId, /^hl:c0nTact123:[0-9a-f]{32}$/);
  const snapshot = mapped.snapshot;
  assert.equal(snapshot.firstName, "Rosa");
  assert.equal(snapshot.lastName, "Alvarez");
  assert.equal(snapshot.email, "rosa@sunrisefarms.example");
  assert.equal(snapshot.businessName, "Sunrise Farms");
  assert.equal(snapshot.vendorCategory, "Produce");
  assert.equal(snapshot.registrationType, "Vendor");
  assert.deepEqual(snapshot.vendorDatesRequested, ["Sat, Oct 3, 2026", "Sat, Oct 10, 2026"]);
  assert.equal(snapshot.message, "Organic produce.");
  assert.equal(snapshot.workflowId, "wf_1");
  assert.deepEqual(snapshot.raw, native);
});

test("event IDs are stable for identical content and change when the submission changes", () => {
  const a = mapHighLevelWorkflowApplication(native, config)!;
  const b = mapHighLevelWorkflowApplication({ ...native, date_created: "2026-09-11T00:00:00.000Z" }, config)!;
  const c = mapHighLevelWorkflowApplication({ ...native, "Vendor Category": "Baked Goods" }, config)!;
  assert.equal(a.eventId, b.eventId);
  assert.notEqual(a.eventId, c.eventId);
  const explicit = mapHighLevelWorkflowApplication({ ...native, customData: { eventId: "form:submission:77", seasonId: "2027-2028" } }, config)!;
  assert.equal(explicit.eventId, "form:submission:77");
  assert.equal(explicit.seasonId, "2027-2028");
});

test("non-profit, full-season, array dates, opportunity trigger and missing identity cases", () => {
  const nonprofit = mapHighLevelWorkflowApplication({
    contact_id: "np1", email: "org@example.org", full_name: "Pat Lee", location: { id: config.locationId },
    "Applying As": "Non-Profit Organization", "Organization Name": "Helping Hands", "Mission": "Food access.",
  }, config)!;
  assert.equal(nonprofit.snapshot.registrationType, "Non-Profit");
  assert.equal(nonprofit.snapshot.orgName, "Helping Hands");
  assert.equal(nonprofit.snapshot.mission, "Food access.");
  assert.equal(nonprofit.snapshot.name, "Pat Lee");

  const fullSeason = mapHighLevelWorkflowApplication({ ...native, "Vendor Dates Requested": "Full Season (Oct 3 - May 29)" }, config)!;
  assert.deepEqual(fullSeason.snapshot.vendorDatesRequested, ["Full Season (Oct 3 - May 29)"]);
  const arrayDates = mapHighLevelWorkflowApplication({ ...native, "Vendor Dates Requested": ["2026-10-03", "2026-10-10"] }, config)!;
  assert.deepEqual(arrayDates.snapshot.vendorDatesRequested, ["2026-10-03", "2026-10-10"]);

  const opportunityTrigger = mapHighLevelWorkflowApplication({ ...native, customData: undefined, id: "opp_native", opportunity_name: "Sunrise Farms" }, config)!;
  assert.equal(opportunityTrigger.opportunityId, "opp_native");
  const noOpportunity = mapHighLevelWorkflowApplication({ ...native, customData: undefined }, config)!;
  assert.equal("opportunityId" in noOpportunity, false);

  assert.equal(mapHighLevelWorkflowApplication({ ...native, location: { id: "other-location" } }, config), null);
  assert.equal(mapHighLevelWorkflowApplication({ ...native, contact_id: undefined, customData: undefined }, config), null);
  assert.equal(mapHighLevelWorkflowApplication("text", config), null);
  assert.equal(mapHighLevelWorkflowApplication({ ...native, contact_id: "../bad" }, config), null);
});

test("the mapped envelope passes the existing handoff validation and persists the normalized snapshot", async () => {
  const handoff = { secret: "test-only-secret-at-least-32-characters", locationId: config.locationId, marketId: "fame-market", seasonId: config.seasonId };
  const mapped = mapHighLevelWorkflowApplication(native, config)!;
  const events: ApplicationHandoff[] = [];
  const response = await handleApplicationHandoff(new Request("https://unit-test.invalid/api/integrations/highlevel/workflow/applications", {
    method: "POST", headers: { authorization: `Bearer ${handoff.secret}`, "content-type": "application/json" }, body: JSON.stringify(mapped),
  }), handoff, async event => { events.push(event); return "captured"; });
  assert.equal(response.status, 201);
  assert.equal(events[0].contactId, "c0nTact123");
  assert.equal(events[0].opportunityId, "opp_9");
  assert.equal(events[0].snapshot.businessName, "Sunrise Farms");
});
