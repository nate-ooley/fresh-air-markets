import { test } from "node:test";
import assert from "node:assert/strict";
import { cronAuthorized, cronSecretConfigured } from "../src/lib/cron-auth.ts";

const secret = "qa-cron-secret-with-at-least-thirty-two-characters";

test("cron endpoint authentication accepts only the configured bearer secret", () => {
  assert.equal(cronSecretConfigured(secret), true);
  assert.equal(cronSecretConfigured("too-short"), false);
  assert.equal(cronAuthorized(new Request("https://unit-test.invalid"), secret), false);
  assert.equal(cronAuthorized(new Request("https://unit-test.invalid", { headers: { authorization: "Bearer wrong" } }), secret), false);
  assert.equal(cronAuthorized(new Request("https://unit-test.invalid", { headers: { authorization: `Bearer ${secret}` } }), secret), true);
});
