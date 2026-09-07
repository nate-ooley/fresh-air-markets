import { test } from "node:test";
import assert from "node:assert/strict";
import { signingSecret } from "../src/lib/auth-secret.ts";

test("production rejects missing, blank, and known demo session secrets", () => {
  for (const AUTH_SECRET of [undefined, "", "   ", "demo-secret-change-me"]) {
    assert.throws(() => signingSecret({ NODE_ENV: "production", AUTH_SECRET }), /AUTH_SECRET/);
  }
});

test("production uses the configured private secret", () => {
  const AUTH_SECRET = "test-only-configured-secret-never-use-in-deployment";
  assert.equal(signingSecret({ NODE_ENV: "production", AUTH_SECRET }), AUTH_SECRET);
});

test("local demo mode remains available", () => {
  assert.equal(signingSecret({ NODE_ENV: "development" }), "demo-secret-change-me");
});
