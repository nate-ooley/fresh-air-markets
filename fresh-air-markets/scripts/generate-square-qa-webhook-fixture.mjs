import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// This helper deliberately has no environment, Square SDK, network, signer,
// or app-module dependency. It creates a local body only; the separate
// Preview-only QA dispatcher supplies the HMAC when the case is run.
const CASES = new Set(["valid", "malformed", "wrong-identity", "late", "failed", "out-of-order"]);
const ID = /^[A-Za-z0-9._:-]{1,255}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,255}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MISMATCHES = new Set(["merchant", "location", "order", "amount", "currency"]);
const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export const HELP = `Usage: npm run square:qa-webhook-fixture -- --case <case> --out <local-file> [mapping options]

Cases: valid, malformed, wrong-identity, late, failed, out-of-order
Mapping options for every non-malformed case:
  --merchant-id <id> --location-id <id> --order-id <id> --payment-id <id> --amount-cents <integer>
Optional: --currency USD --event-id <id> --occurred-at <RFC3339>
          --payment-created-at <RFC3339> --payment-updated-at <RFC3339>
wrong-identity: --mismatch merchant|location|order|amount|currency (default merchant)
late: --due-at <RFC3339> (payment-updated-at must be after it)
out-of-order: --after-at <RFC3339> (payment-updated-at must be before it)

The helper writes a new local JSON file with mode 0600. It never reads
credentials, signs a webhook, calls Square, or overwrites an existing file.`;

function value(values, key) {
  const raw = values.get(key);
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function validTimestamp(value) {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, timezone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (timezone !== "Z") {
    const [, , offsetHourText, offsetMinuteText] = /^([+-])(\d{2}):(\d{2})$/.exec(timezone) ?? [];
    if (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59) return false;
  }
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(value));
}

function timestamp(values, key, fallback) {
  const candidate = value(values, key) ?? fallback;
  if (!validTimestamp(candidate)) throw new Error(`A valid RFC3339 ${key} is required.`);
  return candidate;
}

function positiveInteger(values, key) {
  const candidate = value(values, key);
  if (!candidate || !/^\d+$/.test(candidate)) throw new Error(`A non-negative integer ${key} is required.`);
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed)) throw new Error(`A non-negative integer ${key} is required.`);
  return parsed;
}

function requiredId(values, key, matcher = ID) {
  const candidate = value(values, key);
  if (!candidate || !matcher.test(candidate)) throw new Error(`A valid ${key} is required.`);
  return candidate;
}

function wrongId(kind, eventId) {
  const candidate = `qa-wrong-${kind}-${eventId}`.slice(0, 255);
  if (!ID.test(candidate)) throw new Error("The generated QA identity is invalid.");
  return candidate;
}

export function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  const values = new Map();
  const known = new Set([
    "--case", "--out", "--merchant-id", "--location-id", "--order-id", "--payment-id", "--amount-cents",
    "--currency", "--event-id", "--occurred-at", "--payment-created-at", "--payment-updated-at", "--mismatch",
    "--due-at", "--after-at",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!known.has(flag) || !argv[index + 1] || argv[index + 1].startsWith("--") || values.has(flag)) {
      throw new Error("Invalid QA webhook fixture arguments.");
    }
    values.set(flag, argv[index + 1]);
    index++;
  }
  const fixtureCase = value(values, "--case");
  const output = value(values, "--out");
  if (!fixtureCase || !CASES.has(fixtureCase) || !output) throw new Error("A supported QA fixture case and output file are required.");
  return { help: false, fixtureCase, output, values };
}

function baseEvent(values, fixtureCase) {
  const now = new Date().toISOString();
  const eventId = value(values, "--event-id") ?? `qa-sq-${fixtureCase}-${Date.now()}`;
  if (!EVENT_ID.test(eventId)) throw new Error("A valid --event-id is required.");
  const occurredAt = timestamp(values, "--occurred-at", now);
  const updatedAt = timestamp(values, "--payment-updated-at", occurredAt);
  const createdAt = timestamp(values, "--payment-created-at", updatedAt);
  const currency = value(values, "--currency") ?? "USD";
  if (!CURRENCY.test(currency)) throw new Error("A three-letter uppercase --currency is required.");
  return {
    event_id: eventId,
    type: "payment.updated",
    merchant_id: requiredId(values, "--merchant-id"),
    created_at: occurredAt,
    data: {
      type: "payment",
      id: `qa-payment-data-${eventId}`.slice(0, 255),
      object: {
        payment: {
          id: requiredId(values, "--payment-id"),
          status: "COMPLETED",
          location_id: requiredId(values, "--location-id"),
          order_id: requiredId(values, "--order-id"),
          amount_money: { amount: positiveInteger(values, "--amount-cents"), currency },
          created_at: createdAt,
          updated_at: updatedAt,
        },
      },
    },
  };
}

export function buildFixture(input) {
  const { fixtureCase, values } = input;
  if (fixtureCase === "malformed") {
    const eventId = value(values, "--event-id") ?? `qa-sq-malformed-${Date.now()}`;
    if (!EVENT_ID.test(eventId)) throw new Error("A valid --event-id is required.");
    return {
      event_id: eventId,
      type: "payment.updated",
      merchant_id: "qa-malformed-merchant",
      data: { type: "refund", id: "qa-malformed-data", object: { payment: {} } },
    };
  }

  const fixture = baseEvent(values, fixtureCase);
  const payment = fixture.data.object.payment;
  switch (fixtureCase) {
    case "valid":
      return fixture;
    case "wrong-identity": {
      const mismatch = value(values, "--mismatch") ?? "merchant";
      if (!MISMATCHES.has(mismatch)) throw new Error("Unsupported --mismatch value.");
      if (mismatch === "merchant") fixture.merchant_id = wrongId("merchant", fixture.event_id);
      if (mismatch === "location") payment.location_id = wrongId("location", fixture.event_id);
      if (mismatch === "order") payment.order_id = wrongId("order", fixture.event_id);
      if (mismatch === "amount") payment.amount_money.amount = payment.amount_money.amount === Number.MAX_SAFE_INTEGER
        ? payment.amount_money.amount - 1
        : payment.amount_money.amount + 1;
      if (mismatch === "currency") payment.amount_money.currency = payment.amount_money.currency === "USD" ? "EUR" : "USD";
      return fixture;
    }
    case "late": {
      const dueAt = timestamp(values, "--due-at", "");
      if (Date.parse(payment.updated_at) <= Date.parse(dueAt)) {
        throw new Error("A late fixture requires --payment-updated-at after --due-at.");
      }
      return fixture;
    }
    case "failed":
      payment.status = "FAILED";
      return fixture;
    case "out-of-order": {
      const afterAt = timestamp(values, "--after-at", "");
      if (Date.parse(payment.updated_at) >= Date.parse(afterAt)) {
        throw new Error("An out-of-order fixture requires --payment-updated-at before --after-at.");
      }
      payment.status = "FAILED";
      return fixture;
    }
  }
  throw new Error("Unsupported QA fixture case.");
}

export async function main(argv = process.argv.slice(2), writer = writeFile, logger = console.log) {
  const input = parseArguments(argv);
  if (input.help) {
    logger(HELP);
    return null;
  }
  const fixture = buildFixture(input);
  // Do not overwrite an operator's saved replay artifact. 0600 also keeps
  // Sandbox identities scoped to the local QA operator account.
  await writer(resolve(input.output), `${JSON.stringify(fixture, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  logger(`QA webhook fixture written: ${input.fixtureCase}.`);
  return fixture;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error("QA webhook fixture command refused or failed. Check local QA fixture arguments.");
    process.exitCode = 1;
  });
}
