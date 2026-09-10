import { test } from "node:test";
import assert from "node:assert/strict";
import { signingSecret } from "../src/lib/auth-secret.ts";

test("production rejects missing, blank, short, and known demo session secrets", () => {
  for (const AUTH_SECRET of [undefined, "", "   ", "demo-secret-change-me", "only-thirty-one-characters-here", "x".repeat(31)]) {
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

test("a 32 character secret is the minimum accepted in production", () => {
  const AUTH_SECRET = "y".repeat(32);
  assert.equal(signingSecret({ NODE_ENV: "production", AUTH_SECRET }), AUTH_SECRET);
});
