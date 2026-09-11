import type { SquareCheckoutConfig } from "./square";

/**
 * Keeps Square's webhook subscription pointed at the URL this deployment
 * expects. The portal changes host (Vercel preview host, then the custom
 * domain); Square only delivers payment events to the URL stored on its side,
 * so the two must agree. This module reads the subscriptions with the
 * configured access token, picks the one that targets the portal's webhook
 * path, and can rewrite its URL. It never creates or deletes subscriptions
 * and never touches the signature key.
 */

const SQUARE_API_VERSION = "2026-08-19";
const API_BASE: Record<SquareCheckoutConfig["environment"], string> = {
  sandbox: "https://connect.squareupsandbox.com",
  production: "https://connect.squareup.com",
};
export const PORTAL_WEBHOOK_PATH = "/api/payments/square/webhook";
const REQUIRED_EVENTS = ["payment.created", "payment.updated"] as const;

export interface SquareWebhookSubscription {
  id: string;
  name: string;
  enabled: boolean;
  notificationUrl: string;
  eventTypes: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseSquareWebhookSubscriptions(payload: unknown): SquareWebhookSubscription[] {
  const list = record(payload)?.subscriptions;
  if (!Array.isArray(list)) return [];
  const parsed: SquareWebhookSubscription[] = [];
  for (const item of list) {
    const row = record(item);
    if (!row || typeof row.id !== "string" || !row.id || typeof row.notification_url !== "string") continue;
    parsed.push({
      id: row.id,
      name: typeof row.name === "string" ? row.name : "",
      enabled: row.enabled === true,
      notificationUrl: row.notification_url,
      eventTypes: Array.isArray(row.event_types) ? row.event_types.filter((e): e is string => typeof e === "string") : [],
    });
  }
  return parsed;
}

function targetsPortal(subscription: SquareWebhookSubscription): boolean {
  try {
    const url = new URL(subscription.notificationUrl);
    return url.protocol === "https:" && url.pathname === PORTAL_WEBHOOK_PATH;
  } catch { return false; }
}

function hasPaymentEvents(subscription: SquareWebhookSubscription): boolean {
  return REQUIRED_EVENTS.every(event => subscription.eventTypes.includes(event));
}

/**
 * The portal's subscription is the enabled one that already points at the
 * expected URL, else the enabled one on the portal webhook path with payment
 * events. Anything else (other apps' subscriptions) is left alone.
 */
export function selectPortalSubscription(subscriptions: SquareWebhookSubscription[], expectedUrl: string): SquareWebhookSubscription | null {
  const candidates = subscriptions.filter(s => s.enabled && targetsPortal(s) && hasPaymentEvents(s));
  return candidates.find(s => s.notificationUrl === expectedUrl) ?? candidates[0] ?? null;
}

export interface SquareWebhookSyncResult {
  expectedUrl: string;
  subscription: { id: string; name: string; notificationUrl: string; eventTypes: string[] } | null;
  /** True when Square now points at expectedUrl (already, or after this call). */
  inSync: boolean;
  updated: boolean;
  candidates: number;
}

async function squareJson(config: Pick<SquareCheckoutConfig, "environment" | "accessToken">, path: string, init: RequestInit, transport: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await transport(`${API_BASE[config.environment]}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${config.accessToken}`, "Square-Version": SQUARE_API_VERSION, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error("Square webhook subscription request failed."); }
  // Non-2xx bodies are not parsed or echoed; they can carry private data.
  if (!response.ok) throw new Error(`Square webhook subscription request failed (${response.status}).`);
  try { return await response.json(); } catch { throw new Error("Square webhook subscription response was malformed."); }
}

/** Reads (and, when `apply` is set, rewrites) the portal's Square webhook URL. */
export async function syncSquareWebhookSubscription(
  config: Pick<SquareCheckoutConfig, "environment" | "accessToken">,
  expectedUrl: string,
  options: { apply: boolean; transport?: typeof fetch } = { apply: false },
): Promise<SquareWebhookSyncResult> {
  const transport = options.transport ?? fetch;
  const expected = new URL(expectedUrl);
  if (expected.protocol !== "https:" || expected.pathname !== PORTAL_WEBHOOK_PATH) throw new Error("Expected webhook URL must be the portal webhook path over HTTPS.");
  const subscriptions = parseSquareWebhookSubscriptions(await squareJson(config, "/v2/webhooks/subscriptions?include_disabled=false", { method: "GET" }, transport));
  const candidates = subscriptions.filter(s => s.enabled && targetsPortal(s) && hasPaymentEvents(s)).length;
  const match = selectPortalSubscription(subscriptions, expected.toString());
  if (!match) return { expectedUrl: expected.toString(), subscription: null, inSync: false, updated: false, candidates };
  const summary = { id: match.id, name: match.name, notificationUrl: match.notificationUrl, eventTypes: match.eventTypes };
  if (match.notificationUrl === expected.toString()) return { expectedUrl: expected.toString(), subscription: summary, inSync: true, updated: false, candidates };
  if (!options.apply) return { expectedUrl: expected.toString(), subscription: summary, inSync: false, updated: false, candidates };
  const updated = record(record(await squareJson(config, `/v2/webhooks/subscriptions/${encodeURIComponent(match.id)}`, {
    method: "PUT", body: JSON.stringify({ subscription: { notification_url: expected.toString() } }),
  }, transport))?.subscription);
  const notificationUrl = typeof updated?.notification_url === "string" ? updated.notification_url : match.notificationUrl;
  return {
    expectedUrl: expected.toString(),
    subscription: { ...summary, notificationUrl },
    inSync: notificationUrl === expected.toString(),
    updated: notificationUrl === expected.toString(),
    candidates,
  };
}
