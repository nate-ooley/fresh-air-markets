import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  QA_SIGNER_HEADER,
  squareQaCheckoutTransport,
  squareQaSignerAuthorization,
  squareQaSupportConfig,
  squareQaWebhookRollbackEventId,
} = require("../.test-build/square-qa-faults.js") as typeof import("../src/lib/square-qa-faults");

const previewSandbox = {
  VERCEL: "1",
  VERCEL_ENV: "preview",
  SQUARE_ENVIRONMENT: "sandbox",
  SQUARE_ALLOW_LIVE_PAYMENTS: "false",
};
const signerSecret = "qa-preview-signer-secret-at-least-32-bytes";

test("QA support is absent by default and fails closed outside Vercel Preview Sandbox", () => {
  assert.equal(squareQaSupportConfig({ SQUARE_ENVIRONMENT: "production" }), null);
  assert.throws(() => squareQaSupportConfig({
    SQUARE_ENVIRONMENT: "production",
    SQUARE_QA_SIGNER_SECRET: signerSecret,
  }));
  for (const invalid of [
    { ...previewSandbox, VERCEL_ENV: "production" },
    { ...previewSandbox, VERCEL: "" },
    { ...previewSandbox, SQUARE_ENVIRONMENT: "production" },
    { ...previewSandbox, SQUARE_ALLOW_LIVE_PAYMENTS: "true" },
  ]) {
    assert.throws(() => squareQaSupportConfig({
      ...invalid,
      SQUARE_QA_FAULT_MODE: "checkout_429",
      SQUARE_QA_FAULT_RESERVATION_ID: "qa-reservation-1",
    }));
  }
});

test("QA controls require one exact target and a webhook rollback requires the private signer capability", () => {
  assert.deepEqual(squareQaSupportConfig({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: "checkout_429",
    SQUARE_QA_FAULT_RESERVATION_ID: "qa-reservation-1",
  }), {
    fault: { kind: "checkout", mode: "checkout_429", reservationId: "qa-reservation-1" },
    signerSecret: null,
  });
  assert.throws(() => squareQaSupportConfig({ ...previewSandbox, SQUARE_QA_FAULT_MODE: "checkout_429" }));
  assert.throws(() => squareQaSupportConfig({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: "checkout_429",
    SQUARE_QA_FAULT_RESERVATION_ID: "qa-reservation-1",
    SQUARE_QA_FAULT_EVENT_ID: "qa-event-1",
  }));
  assert.throws(() => squareQaSupportConfig({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: "webhook_rollback",
    SQUARE_QA_FAULT_EVENT_ID: "qa-event-1",
  }));
  assert.deepEqual(squareQaSupportConfig({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: "webhook_rollback",
    SQUARE_QA_FAULT_EVENT_ID: "qa-event-1",
    SQUARE_QA_SIGNER_SECRET: signerSecret,
  }), {
    fault: { kind: "webhook", mode: "webhook_rollback", eventId: "qa-event-1" },
    signerSecret,
  });
});

test("checkout QA transports return every synthetic provider fault and never call a network transport", async () => {
  const at = new Date("2026-10-03T12:00:00.000Z");
  const support = squareQaSupportConfig({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: "checkout_429",
    SQUARE_QA_FAULT_RESERVATION_ID: "qa-reservation-1",
  });
  const rateLimited = squareQaCheckoutTransport(support?.fault ?? null, "qa-reservation-1", at);
  assert.equal((await rateLimited?.("https://should-not-be-called.invalid")).status, 429);
  assert.equal(squareQaCheckoutTransport(support?.fault ?? null, "different-reservation", at), undefined);

  const unavailableSupport = squareQaSupportConfig({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: "checkout_500",
    SQUARE_QA_FAULT_RESERVATION_ID: "qa-reservation-1",
  });
  assert.equal((await squareQaCheckoutTransport(unavailableSupport?.fault ?? null, "qa-reservation-1", at)?.("https://should-not-be-called.invalid")).status, 500);

  const timeoutSupport = squareQaSupportConfig({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: "checkout_timeout",
    SQUARE_QA_FAULT_RESERVATION_ID: "qa-reservation-1",
  });
  await assert.rejects(squareQaCheckoutTransport(timeoutSupport?.fault ?? null, "qa-reservation-1", at)?.("https://should-not-be-called.invalid"));

  const permanentSupport = squareQaSupportConfig({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: "checkout_permanent_400",
    SQUARE_QA_FAULT_RESERVATION_ID: "qa-reservation-1",
  });
  assert.equal((await squareQaCheckoutTransport(permanentSupport?.fault ?? null, "qa-reservation-1", at)?.("https://should-not-be-called.invalid")).status, 400);

  const expiredSupport = squareQaSupportConfig({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: "checkout_expired_link",
    SQUARE_QA_FAULT_RESERVATION_ID: "qa-reservation-1",
  });
  const payload = await (await squareQaCheckoutTransport(expiredSupport?.fault ?? null, "qa-reservation-1", at)?.("https://should-not-be-called.invalid")).json();
  assert.ok(Date.parse(payload.payment_link.created_at) < at.valueOf() - 48 * 60 * 60 * 1000);
});

test("the local signer capability is constant-time checked and unlocks only its one configured rollback event", () => {
  const support = squareQaSupportConfig({
    ...previewSandbox,
    SQUARE_QA_FAULT_MODE: "webhook_rollback",
    SQUARE_QA_FAULT_EVENT_ID: "qa-event-rollback",
    SQUARE_QA_SIGNER_SECRET: signerSecret,
  });
  assert.equal(QA_SIGNER_HEADER, "x-fame-square-qa-signer");
  assert.equal(squareQaSignerAuthorization(null, support), "absent");
  assert.equal(squareQaSignerAuthorization("wrong", support), "unauthorized");
  assert.equal(squareQaWebhookRollbackEventId(support, "unauthorized"), null);
  assert.equal(squareQaSignerAuthorization(signerSecret, support), "authorized");
  assert.equal(squareQaWebhookRollbackEventId(support, "authorized"), "qa-event-rollback");
});
