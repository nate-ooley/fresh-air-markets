import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

// This script deliberately has no app-module imports: Node's local
// type-stripping loader does not resolve the portal's extensionless TS imports.
// Keep this small gate equivalent to `squareQaSupportConfig`; a future change
// to either gate must keep both fail-closed requirements in sync.
const MAX_SQUARE_WEBHOOK_BYTES = 128 * 1024;
const QA_SIGNER_HEADER = "x-fame-square-qa-signer";
const RESERVATION_ID = /^[A-Za-z0-9:_-]{1,192}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,255}$/;
const CHECKOUT_MODES = new Set([
  "checkout_429",
  "checkout_500",
  "checkout_timeout",
  "checkout_permanent_400",
  "checkout_expired_link",
]);
const EXPIRY_MODES = new Set([
  "expiry_429",
  "expiry_500",
  "expiry_timeout",
  "expiry_link_mismatch",
  "expiry_cancelled_order_mismatch",
  "expiry_cancelled_order_missing",
  "expiry_missing_link_open",
  "expiry_missing_link_completed",
]);

// The route emits these compact bodies deliberately. Matching both the HTTP
// status and exact JSON makes this command evidence that the request reached
// the app handler, rather than a Vercel authentication page or another proxy
// response that happens to use the same status code.
const ROUTE_OUTCOMES = {
  invalid_hmac: { status: 401, body: { error: "Unauthorized." } },
  oversized: { status: 413, body: { error: "Square webhook is too large." } },
  invalid_event: { status: 400, body: { error: "Invalid Square payment event." } },
  paid: { status: 200, body: { status: "paid" } },
  duplicate: { status: 200, body: { status: "duplicate" } },
  ignored: { status: 200, body: { status: "ignored" } },
  manual_review: { status: 202, body: { status: "manual_review" } },
  rollback: { status: 503, body: { error: "Square payment processing is unavailable; retry the same event." } },
};

const MAX_QA_RESPONSE_BYTES = 8 * 1024;

function value(env, key) {
  const candidate = env[key]?.trim();
  return candidate || null;
}

/** Mirror the server gate before a local command can read/send any fixture. */
export function previewQaSignerSupport(env) {
  const signerSecret = value(env, "SQUARE_QA_SIGNER_SECRET");
  if (!signerSecret
    || env.VERCEL !== "1"
    || env.VERCEL_ENV !== "preview"
    || env.SQUARE_ENVIRONMENT !== "sandbox"
    || env.SQUARE_ALLOW_LIVE_PAYMENTS !== "false") {
    throw new Error("Preview Sandbox QA signer support is not configured.");
  }
  if (Buffer.byteLength(signerSecret) < 32) throw new Error("Preview QA signer secret is too short.");

  const mode = value(env, "SQUARE_QA_FAULT_MODE");
  const reservationId = value(env, "SQUARE_QA_FAULT_RESERVATION_ID");
  const paymentOrderId = value(env, "SQUARE_QA_FAULT_PAYMENT_ORDER_ID");
  const eventId = value(env, "SQUARE_QA_FAULT_EVENT_ID");
  if (!mode) {
    if (reservationId || paymentOrderId || eventId) throw new Error("Preview QA fault target requires a mode.");
    return { signerSecret };
  }
  if (CHECKOUT_MODES.has(mode)) {
    if (!reservationId || !RESERVATION_ID.test(reservationId) || paymentOrderId || eventId) {
      throw new Error("Preview QA checkout fault target is invalid.");
    }
    return { signerSecret };
  }
  if (EXPIRY_MODES.has(mode)) {
    if (!paymentOrderId || !RESERVATION_ID.test(paymentOrderId) || reservationId || eventId) {
      throw new Error("Preview QA expiry fault target is invalid.");
    }
    return { signerSecret };
  }
  if (mode === "webhook_rollback") {
    if (!eventId || !EVENT_ID.test(eventId) || reservationId || paymentOrderId) {
      throw new Error("Preview QA webhook rollback target is invalid.");
    }
    return { signerSecret };
  }
  throw new Error("Preview QA fault mode is invalid.");
}

/** Mirrors `squareWebhookConfig` while retaining the exact configured URL bytes. */
export function squareWebhookSignerConfig(env) {
  const webhookSignatureKey = value(env, "SQUARE_WEBHOOK_SIGNATURE_KEY");
  const webhookUrl = value(env, "SQUARE_WEBHOOK_URL");
  if (!webhookSignatureKey || !webhookUrl) throw new Error("Square webhook signer configuration is incomplete.");
  const url = new URL(webhookUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Square webhook URL is not a public HTTPS URL.");
  }
  return { webhookSignatureKey, webhookUrl };
}

export function parseArguments(argv) {
  const known = new Set(["--ack-preview-sandbox", "--invalid-hmac", "--oversized", "--body-file", "--expect"]);
  const seen = new Set();
  let bodyFile = null;
  let requestedExpectation = null;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!known.has(argument) || seen.has(argument)) throw new Error("Unsupported QA webhook argument.");
    seen.add(argument);
    if (argument === "--body-file" || argument === "--expect") {
      const candidate = argv[index + 1];
      if (!candidate || candidate.startsWith("--")) throw new Error("A QA webhook option value is required.");
      if (argument === "--body-file") bodyFile = candidate;
      else requestedExpectation = candidate;
      index++;
    }
  }
  const acknowledged = seen.has("--ack-preview-sandbox");
  const invalidHmac = seen.has("--invalid-hmac");
  const oversized = seen.has("--oversized");
  if (!acknowledged || (oversized && bodyFile) || (!oversized && !bodyFile) || (oversized && invalidHmac)) {
    throw new Error("Use --ack-preview-sandbox and exactly one of --body-file or --oversized.");
  }
  if ((invalidHmac || oversized) && requestedExpectation) {
    throw new Error("Negative webhook probes select their own expected route response.");
  }
  if (!invalidHmac && !oversized && !requestedExpectation) {
    throw new Error("A signed webhook body requires an explicit --expect outcome.");
  }
  const expectation = invalidHmac
    ? "invalid_hmac"
    : oversized
      ? "oversized"
      : requestedExpectation.replaceAll("-", "_");
  if (!(expectation in ROUTE_OUTCOMES)) {
    throw new Error("Unsupported expected QA webhook outcome.");
  }
  return { bodyFile, invalidHmac, oversized, expectation };
}

async function responseJson(response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) return null;
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_QA_RESPONSE_BYTES) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Prove the response is one emitted by this route. This must stay strict:
 * Vercel protection, a CDN, or an auth proxy can all return a 401/413 that is
 * not evidence of the portal's raw-body/HMAC boundary.
 */
export async function assertRouteOwnedResponse(response, expectation) {
  const body = await responseJson(response);
  const expected = ROUTE_OUTCOMES[expectation];
  if (!expected || expected.status !== response.status || !isDeepStrictEqual(expected.body, body)) {
    throw new Error("QA webhook response did not match the expected route-owned result.");
  }
  return expectation;
}

/** Bind the rollback-only signer capability to the exact configured event. */
function rollbackFixtureEventId(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("The rollback fixture must contain one valid JSON event ID.");
  }
  const eventId = body && typeof body === "object" && !Array.isArray(body) ? body.event_id : null;
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId)) {
    throw new Error("The rollback fixture must contain one valid JSON event ID.");
  }
  return eventId;
}

export async function main(env = process.env, argv = process.argv.slice(2), transport = fetch) {
  const options = parseArguments(argv);
  const qa = previewQaSignerSupport(env);
  // Do not send the QA signer capability for ordinary, invalid-HMAC, or
  // oversized probes. A stale local signer secret otherwise yields the same
  // 401 body as a bad HMAC before the raw-body boundary runs. The rollback
  // exercise is the sole case that needs this capability.
  if (options.expectation === "rollback" && value(env, "SQUARE_QA_FAULT_MODE") !== "webhook_rollback") {
    throw new Error("The rollback response is allowed only for the configured Preview webhook rollback case.");
  }
  const webhook = squareWebhookSignerConfig(env);
  const rawBody = options.oversized
    ? Buffer.alloc(MAX_SQUARE_WEBHOOK_BYTES + 1, "x")
    : await readFile(options.bodyFile);
  if (options.expectation === "rollback") {
    const configuredEventId = value(env, "SQUARE_QA_FAULT_EVENT_ID");
    if (!configuredEventId || rollbackFixtureEventId(rawBody) !== configuredEventId) {
      throw new Error("The rollback fixture does not match the configured Preview QA event.");
    }
  }
  const validSignature = createHmac("sha256", webhook.webhookSignatureKey)
    .update(webhook.webhookUrl)
    .update(rawBody)
    .digest("base64");
  // Mutate the computed value rather than substitute a fixed string, so this
  // negative test can never accidentally produce the valid HMAC.
  const signature = options.invalidHmac
    ? `${validSignature.startsWith("A") ? "B" : "A"}${validSignature.slice(1)}`
    : validSignature;
  const headers = {
    "content-type": "application/json",
    "x-square-hmacsha256-signature": signature,
  };
  if (options.expectation === "rollback") headers[QA_SIGNER_HEADER] = qa.signerSecret;
  let response;
  try {
    response = await transport(webhook.webhookUrl, {
      method: "POST",
      headers,
      body: rawBody,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("QA webhook request failed.");
  }
  const outcome = await assertRouteOwnedResponse(response, options.expectation);
  // Intentionally do not print the configured URL, payload, signature, or
  // signer secret. The runbook records only the expected route outcome and
  // HTTP status; it never receives the request/response payload.
  console.log(`QA webhook request completed: ${outcome} (HTTP ${response.status}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error("QA webhook command refused or failed. Check Preview Sandbox configuration.");
    process.exitCode = 1;
  });
}
