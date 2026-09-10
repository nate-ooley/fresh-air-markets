import { test } from "node:test";
import assert from "node:assert/strict";
import { handleApplicationHandoff } from "../src/lib/application-handoff.ts";
import type { ApplicationHandoff } from "../src/lib/application-handoff.ts";

const config = { secret: "test-only-secret-at-least-32-characters", locationId: "fame-location", marketId: "fame-market", seasonId: "2026-2027" };
const body = { eventId: "application:qa:2026-2027", contactId: "qa-contact", opportunityId: "qa-opportunity", locationId: config.locationId, seasonId: config.seasonId, snapshot: { email: "nate@autocraftstudios.com", agreementStatus: "Signed", requestedDates: ["Full Season (Oct 3 - May 27)"] } };
const request = (value: unknown = body, auth = `Bearer ${config.secret}`) => new Request("https://unit-test.invalid/api/integrations/highlevel/applications", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(value) });

test("handoff rejects missing/wrong/Unicode authorization without persistence", async () => {
  let writes = 0;
  for (const authorization of ["", "Bearer wrong", "Bearer " + "é".repeat(64)]) {
    const response = await handleApplicationHandoff(request(body, authorization), config, async () => { writes++; return "captured"; });
    assert.equal(response.status, 401);
  }
  assert.equal(writes, 0);
});

test("handoff requires configured identity and a strong shared secret", async () => {
  for (const patch of [{ secret: "short" }, { locationId: "" }, { marketId: "" }, { seasonId: "" }]) {
    const response = await handleApplicationHandoff(request(), { ...config, ...patch }, async () => { throw new Error("Must not persist"); });
    assert.equal(response.status, 503);
  }
});

test("handoff rejects malformed/scalar bodies and wrong location or season", async () => {
  let writes = 0;
  for (const value of [null, [], "text", {}, { ...body, locationId: "zeal" }, { ...body, seasonId: "old" }, { ...body, contactId: "" }, { ...body, eventId: "" }, { ...body, opportunityId: "../other" }, { ...body, snapshot: [] }]) {
    const response = await handleApplicationHandoff(request(value), config, async () => { writes++; return "captured"; });
    assert.equal(response.status, 400);
  }
  assert.equal(writes, 0);
});

test("handoff preserves existing contact ID, signed state and original preliminary dates", async () => {
  const events: ApplicationHandoff[] = [];
  const response = await handleApplicationHandoff(request(), config, async event => { events.push(event); return "captured"; });
  assert.equal(response.status, 201);
  assert.equal(events[0].contactId, body.contactId);
  assert.equal(events[0].opportunityId, body.opportunityId);
  assert.deepEqual(events[0].snapshot, body.snapshot);
  assert.equal(events[0].marketId, config.marketId);
  assert.equal(JSON.stringify(await response.json()).includes(body.snapshot.email), false);
});

test("handoff reports duplicate delivery or conflicting event reuse distinctly", async () => {
  assert.equal((await handleApplicationHandoff(request(), config, async () => "duplicate")).status, 200);
  assert.equal((await handleApplicationHandoff(request(), config, async () => "conflict")).status, 409);
});

test("handoff never acknowledges failed database persistence or exposes errors", async () => {
  const response = await handleApplicationHandoff(request(), config, async () => { throw new Error("postgres://private-credentials"); });
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("private-credentials"), false);
});

test("oversized application snapshot fails before persistence", async () => {
  const response = await handleApplicationHandoff(request({ ...body, snapshot: { message: "x".repeat(129 * 1024) } }), config, async () => { throw new Error("Must not persist"); });
  assert.equal(response.status, 413);
});
