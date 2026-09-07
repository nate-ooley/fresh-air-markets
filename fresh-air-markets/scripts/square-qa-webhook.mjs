import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

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
  const eventId = value(env, "SQUARE_QA_FAULT_EVENT_ID");
  if (!mode) {
    if (reservationId || eventId) throw new Error("Preview QA fault target requires a mode.");
    return { signerSecret };
  }
  if (CHECKOUT_MODES.has(mode)) {
    if (!reservationId || !RESERVATION_ID.test(reservationId) || eventId) {
      throw new Error("Preview QA checkout fault target is invalid.");
    }
    return { signerSecret };
  }
  if (mode === "webhook_rollback") {
    if (!eventId || !EVENT_ID.test(eventId) || reservationId) {
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
  const acknowledged = argv.includes("--ack-preview-sandbox");
  const invalidHmac = argv.includes("--invalid-hmac");
  const oversized = argv.includes("--oversized");
  const bodyIndex = argv.indexOf("--body-file");
  const bodyFile = bodyIndex >= 0 ? argv[bodyIndex + 1] : null;
  const known = new Set(["--ack-preview-sandbox", "--invalid-hmac", "--oversized", "--body-file"]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--body-file") {
      if (!argv[index + 1]) throw new Error("A QA webhook body file is required.");
      index++;
    } else if (!known.has(argument)) {
      throw new Error("Unsupported QA webhook argument.");
    }
  }
  if (!acknowledged || (oversized && bodyFile) || (!oversized && !bodyFile)) {
    throw new Error("Use --ack-preview-sandbox and exactly one of --body-file or --oversized.");
  }
  return { bodyFile, invalidHmac, oversized };
}

export async function main(env = process.env, argv = process.argv.slice(2), transport = fetch) {
  const options = parseArguments(argv);
  const qa = previewQaSignerSupport(env);
  const webhook = squareWebhookSignerConfig(env);
  const rawBody = options.oversized
    ? Buffer.alloc(MAX_SQUARE_WEBHOOK_BYTES + 1, "x")
    : await readFile(options.bodyFile);
  const validSignature = createHmac("sha256", webhook.webhookSignatureKey)
    .update(webhook.webhookUrl)
    .update(rawBody)
    .digest("base64");
  // Mutate the computed value rather than substitute a fixed string, so this
  // negative test can never accidentally produce the valid HMAC.
  const signature = options.invalidHmac
    ? `${validSignature.startsWith("A") ? "B" : "A"}${validSignature.slice(1)}`
    : validSignature;
  let response;
  try {
    response = await transport(webhook.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-square-hmacsha256-signature": signature,
        [QA_SIGNER_HEADER]: qa.signerSecret,
      },
      body: rawBody,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("QA webhook request failed.");
  }
  // Intentionally do not print the configured URL, payload, signature, or
  // signer secret. The runbook records only the case ID and HTTP status.
  console.log(`QA webhook request completed: HTTP ${response.status}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error("QA webhook command refused or failed. Check Preview Sandbox configuration.");
    process.exitCode = 1;
  });
}
