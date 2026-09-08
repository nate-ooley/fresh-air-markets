import { timingSafeEqual } from "node:crypto";
import { PAYMENT_WINDOW_MS } from "./square";

/**
 * These controls exist only to exercise a Preview Sandbox deployment's
 * negative paths. They are never selected by a request body or public route.
 * Vercel supplies `VERCEL` and `VERCEL_ENV`; requiring both prevents a copied
 * QA environment variable from enabling synthetic behavior in Production.
 */
const QA_SIGNER_HEADER = "x-fame-square-qa-signer";
const RESERVATION_ID = /^[A-Za-z0-9:_-]{1,192}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,255}$/;

export const SQUARE_QA_CHECKOUT_FAULT_MODES = [
  "checkout_429",
  "checkout_500",
  "checkout_timeout",
  "checkout_permanent_400",
  "checkout_expired_link",
] as const;

export type SquareQaCheckoutFaultMode = typeof SQUARE_QA_CHECKOUT_FAULT_MODES[number];

/** Preview-only provider simulations for one already-expired QA hold. */
export const SQUARE_QA_EXPIRY_FAULT_MODES = [
  "expiry_429",
  "expiry_500",
  "expiry_timeout",
  "expiry_link_mismatch",
  "expiry_cancelled_order_mismatch",
  "expiry_cancelled_order_missing",
  "expiry_missing_link_open",
  "expiry_missing_link_completed",
] as const;

export type SquareQaExpiryFaultMode = typeof SQUARE_QA_EXPIRY_FAULT_MODES[number];

export type SquareQaFault =
  | { kind: "checkout"; mode: SquareQaCheckoutFaultMode; reservationId: string }
  | { kind: "expiry"; mode: SquareQaExpiryFaultMode; paymentOrderId: string }
  | { kind: "webhook"; mode: "webhook_rollback"; eventId: string };

export interface SquareQaSupportConfig {
  fault: SquareQaFault | null;
  /** A Preview-only local signer capability. It is never returned by a route. */
  signerSecret: string | null;
}

export type SquareQaSignerAuthorization = "absent" | "authorized" | "unauthorized";

type Environment = Record<string, string | undefined>;

function value(env: Environment, key: string): string | null {
  const candidate = env[key]?.trim();
  return candidate || null;
}

function configuredQaValue(env: Environment): boolean {
  return [
    "SQUARE_QA_FAULT_MODE",
    "SQUARE_QA_FAULT_RESERVATION_ID",
    "SQUARE_QA_FAULT_PAYMENT_ORDER_ID",
    "SQUARE_QA_FAULT_EVENT_ID",
    "SQUARE_QA_SIGNER_SECRET",
  ].some(key => value(env, key) !== null);
}

function isPreviewSandbox(env: Environment): boolean {
  return env.VERCEL === "1"
    && env.VERCEL_ENV === "preview"
    && env.SQUARE_ENVIRONMENT === "sandbox"
    && env.SQUARE_ALLOW_LIVE_PAYMENTS === "false";
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Parse only explicitly configured Preview QA controls. A QA value in any
 * other environment is a deployment error, rather than a dormant backdoor.
 */
export function squareQaSupportConfig(env: Environment): SquareQaSupportConfig | null {
  if (!configuredQaValue(env)) return null;
  if (!isPreviewSandbox(env)) {
    throw new Error("Square QA support is allowed only in Vercel Preview Sandbox with live payments disabled.");
  }

  const mode = value(env, "SQUARE_QA_FAULT_MODE");
  const reservationId = value(env, "SQUARE_QA_FAULT_RESERVATION_ID");
  const paymentOrderId = value(env, "SQUARE_QA_FAULT_PAYMENT_ORDER_ID");
  const eventId = value(env, "SQUARE_QA_FAULT_EVENT_ID");
  const signerSecret = value(env, "SQUARE_QA_SIGNER_SECRET");
  if (signerSecret && Buffer.byteLength(signerSecret) < 32) {
    throw new Error("Square QA signer secret is too short.");
  }

  if (!mode) {
    if (reservationId || paymentOrderId || eventId) throw new Error("Square QA fault target requires a fault mode.");
    return { fault: null, signerSecret };
  }

  if ((SQUARE_QA_CHECKOUT_FAULT_MODES as readonly string[]).includes(mode)) {
    if (!reservationId || !RESERVATION_ID.test(reservationId) || paymentOrderId || eventId) {
      throw new Error("Square QA checkout fault requires one valid reservation target.");
    }
    return {
      fault: { kind: "checkout", mode: mode as SquareQaCheckoutFaultMode, reservationId },
      signerSecret,
    };
  }

  if ((SQUARE_QA_EXPIRY_FAULT_MODES as readonly string[]).includes(mode)) {
    if (!paymentOrderId || !RESERVATION_ID.test(paymentOrderId) || reservationId || eventId) {
      throw new Error("Square QA expiry fault requires one valid payment-order target.");
    }
    return {
      fault: { kind: "expiry", mode: mode as SquareQaExpiryFaultMode, paymentOrderId },
      signerSecret,
    };
  }

  if (mode === "webhook_rollback") {
    if (!eventId || !EVENT_ID.test(eventId) || reservationId || paymentOrderId || !signerSecret) {
      throw new Error("Square QA webhook rollback requires one event target and a signer secret.");
    }
    return { fault: { kind: "webhook", mode, eventId }, signerSecret };
  }

  throw new Error("Unknown Square QA fault mode.");
}

/** A local QA signer is denied unless its separate Preview-only secret matches. */
export function squareQaSignerAuthorization(
  header: string | null,
  support: SquareQaSupportConfig | null,
): SquareQaSignerAuthorization {
  if (header === null) return "absent";
  return support?.signerSecret && sameSecret(header, support.signerSecret)
    ? "authorized"
    : "unauthorized";
}

/** No network is used by these transports; they simulate only the provider result. */
export function squareQaCheckoutTransport(
  fault: SquareQaFault | null,
  reservationId: string,
  now = new Date(),
): typeof fetch | undefined {
  if (!fault || fault.kind !== "checkout" || fault.reservationId !== reservationId) return undefined;
  switch (fault.mode) {
    case "checkout_429":
      return async () => new Response(null, { status: 429 });
    case "checkout_500":
      return async () => new Response(null, { status: 500 });
    case "checkout_timeout":
      return async () => { throw new Error("QA simulated Square timeout."); };
    case "checkout_permanent_400":
      return async () => new Response(null, { status: 400 });
    case "checkout_expired_link": {
      const createdAt = new Date(now.valueOf() - PAYMENT_WINDOW_MS - 1).toISOString();
      return async () => new Response(JSON.stringify({
        payment_link: {
          id: "qa-fault-expired-link",
          order_id: "qa-fault-expired-order",
          url: "https://square.link/qa-fault-expired",
          created_at: createdAt,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  }
}

function urlTerminalId(url: string | URL | Request): string {
  const pathname = new URL(String(url)).pathname;
  return decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) ?? "");
}

/**
 * A synthetic retirement transport is usable only after the scheduler has
 * claimed the one explicitly configured payment order. It never calls Square.
 */
export function squareQaExpiryTransport(
  fault: SquareQaFault | null,
  paymentOrderId: string,
  locationId: string,
): typeof fetch | undefined {
  if (!fault || fault.kind !== "expiry" || fault.paymentOrderId !== paymentOrderId) return undefined;
  switch (fault.mode) {
    case "expiry_429":
      return async () => new Response(null, { status: 429 });
    case "expiry_500":
      return async () => new Response(null, { status: 500 });
    case "expiry_timeout":
      return async () => { throw new Error("QA simulated Square retirement timeout."); };
    case "expiry_link_mismatch":
      return async () => new Response(JSON.stringify({ id: "qa-other-link", cancelled_order_id: "qa-order" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    case "expiry_cancelled_order_mismatch":
      return async url => new Response(JSON.stringify({
        id: urlTerminalId(url), cancelled_order_id: "qa-other-order",
      }), { status: 200, headers: { "content-type": "application/json" } });
    case "expiry_cancelled_order_missing":
      return async url => new Response(JSON.stringify({ id: urlTerminalId(url) }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    case "expiry_missing_link_open":
    case "expiry_missing_link_completed":
      return async url => {
        const path = new URL(String(url)).pathname;
        if (path.includes("/payment-links/")) return new Response(null, { status: 404 });
        return new Response(JSON.stringify({ order: {
          id: urlTerminalId(url), location_id: locationId,
          state: fault.mode === "expiry_missing_link_open" ? "OPEN" : "COMPLETED",
        } }), { status: 200, headers: { "content-type": "application/json" } });
      };
  }
}

/** The rollback is enabled only for a locally signed, exact QA event. */
export function squareQaWebhookRollbackEventId(
  support: SquareQaSupportConfig | null,
  signer: SquareQaSignerAuthorization,
): string | null {
  return signer === "authorized" && support?.fault?.kind === "webhook"
    ? support.fault.eventId
    : null;
}

export { QA_SIGNER_HEADER };
