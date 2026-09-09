import type { PaymentPaidSyncMessage, PaymentPaidSyncScope } from "./payment-paid-sync-pg";

const BASE = "https://services.leadconnectorhq.com";
const LOCATION = "aooAnUXF0COePorBo7wL";
const ID = /^[A-Za-z0-9_-]{1,192}$/;
const QA_EMAILS = new Set(["lnooley@gmail.com", "nate@autocraftstudios.com"]);
export interface PaymentPaidDeliveryConfig extends PaymentPaidSyncScope {
  apiToken: string;
  mode: "qa" | "production";
  pipelineId: string;
  pendingStageId: string;
  confirmedStageId: string;
  agreementCompletedStageId: string;
}
export class PaymentPaidDeliveryError extends Error {
  constructor(public readonly code: string, public readonly retryAfterSeconds?: number) {
    super("Payment status delivery could not be verified.");
  }
}
/** Explicitly off until both the tenant mapping and notification routing are proven. */
export function readPaymentPaidDeliveryConfig(env: Record<string, string | undefined>): PaymentPaidDeliveryConfig {
  const fail = (): never => { throw new PaymentPaidDeliveryError("ghl_config_missing"); };
  if (env.GHL_PAYMENT_SYNC_ENABLED !== "true" || env.VERCEL !== "1") fail();
  const apiToken = env.GHL_API_TOKEN?.trim() ?? "";
  const marketId = env.FAME_MARKET_ACCOUNT_ID?.trim() ?? "";
  const seasonId = env.FAME_SEASON_ID?.trim() ?? "";
  const locationId = env.GHL_LOCATION_ID?.trim() ?? "";
  const pendingStageId = env.GHL_PAYMENT_PENDING_STAGE_ID?.trim() ?? "";
  const confirmedStageId = env.GHL_PAYMENT_CONFIRMED_STAGE_ID?.trim() ?? "";
  const agreementCompletedStageId = env.GHL_AGREEMENT_COMPLETED_STAGE_ID?.trim() ?? "";
  const mode = env.GHL_PAYMENT_DELIVERY_MODE;
  if (apiToken.length < 16 || locationId !== LOCATION || marketId === "demo-market"
    || ![marketId, seasonId, pendingStageId, confirmedStageId, agreementCompletedStageId].every(id => ID.test(id))
    || new Set([pendingStageId, confirmedStageId, agreementCompletedStageId]).size !== 3) fail();
  let pipelineId: string;
  let squareEnvironment: "sandbox" | "production";
  if (mode === "qa") {
    pipelineId = env.GHL_QA_APPLICATION_PIPELINE_ID?.trim() ?? "";
    if (env.VERCEL_ENV !== "preview" || env.SQUARE_ENVIRONMENT !== "sandbox"
      || env.SQUARE_ALLOW_LIVE_PAYMENTS !== "false" || env.GHL_PAYMENT_QA_ROUTING_VERIFIED !== "true"
      || !ID.test(pipelineId) || !ID.test(env.GHL_APPLICATION_PIPELINE_ID?.trim() ?? "")
      || pipelineId === env.GHL_APPLICATION_PIPELINE_ID?.trim()) fail();
    squareEnvironment = "sandbox";
  } else if (mode === "production") {
    pipelineId = env.GHL_APPLICATION_PIPELINE_ID?.trim() ?? "";
    if (env.VERCEL_ENV !== "production" || env.SQUARE_ENVIRONMENT !== "production"
      || env.SQUARE_ALLOW_LIVE_PAYMENTS !== "true" || !ID.test(pipelineId)
      || Object.entries(env).some(([key, value]) => value?.trim()
        && (key.startsWith("SQUARE_QA_") || key.startsWith("GHL_QA_") || key.startsWith("GHL_PAYMENT_QA_")))) fail();
    squareEnvironment = "production";
  } else return fail();
  return { apiToken, marketId, seasonId, locationId, pendingStageId, confirmedStageId, agreementCompletedStageId, mode, pipelineId, squareEnvironment };
}
const object = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
async function body(response: Response): Promise<Record<string, unknown>> {
  try { return object(await response.json()) ?? {}; } catch { return {}; }
}
function providerError(response: Response): PaymentPaidDeliveryError {
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    return new PaymentPaidDeliveryError("ghl_rate_limited", Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600 ? seconds : undefined);
  }
  return new PaymentPaidDeliveryError(response.status >= 500 ? "ghl_unavailable" : "ghl_rejected");
}
export async function requestPaymentStage(config: PaymentPaidDeliveryConfig, transport: typeof fetch, path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await transport(`${BASE}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${config.apiToken}`, Version: "v3", Accept: "application/json", ...(init.method === "PUT" ? { "Content-Type": "application/json" } : {}) } });
  } catch { throw new PaymentPaidDeliveryError("ghl_unavailable"); }
  if (!response.ok) throw providerError(response);
  return response;
}
export async function readExactPaymentContact(job: Pick<PaymentPaidSyncMessage, "contactId">, config: PaymentPaidDeliveryConfig, transport: typeof fetch): Promise<void> {
  const response = await requestPaymentStage(config, transport, `/contacts/${encodeURIComponent(job.contactId)}`, { method: "GET" });
  const contact = object((await body(response)).contact);
  if (contact?.id !== job.contactId || contact.locationId !== config.locationId) throw new PaymentPaidDeliveryError("ghl_identity_mismatch");
  if (config.mode === "qa" && (typeof contact.email !== "string" || !QA_EMAILS.has(contact.email.trim().toLowerCase()))) {
    throw new PaymentPaidDeliveryError("ghl_qa_recipient_rejected");
  }
}
export async function readExactPaymentOpportunity(job: Pick<PaymentPaidSyncMessage, "contactId" | "opportunityId">, config: PaymentPaidDeliveryConfig, transport: typeof fetch): Promise<Record<string, unknown>> {
  const response = await requestPaymentStage(config, transport, `/opportunities/${encodeURIComponent(job.opportunityId)}`, { method: "GET" });
  const opportunity = object((await body(response)).opportunity);
  if (!opportunity || opportunity.id !== job.opportunityId || opportunity.contactId !== job.contactId
    || opportunity.locationId !== config.locationId) throw new PaymentPaidDeliveryError("ghl_identity_mismatch");
  if (opportunity.pipelineId !== config.pipelineId) throw new PaymentPaidDeliveryError("ghl_pipeline_mismatch");
  if (opportunity.status !== "open") throw new PaymentPaidDeliveryError("ghl_status_diverged");
  return opportunity;
}
/** No searches/upserts or notification calls. A retry verifies the target stage before writing. */
export async function deliverPaymentPaidToGhl(job: PaymentPaidSyncMessage, config: PaymentPaidDeliveryConfig, transport: typeof fetch = fetch): Promise<void> {
  if (job.marketId !== config.marketId || job.seasonId !== config.seasonId || job.locationId !== config.locationId
    || job.squareEnvironment !== config.squareEnvironment
    || ![job.contactId, job.opportunityId].every(id => ID.test(id))) throw new PaymentPaidDeliveryError("ghl_identity_mismatch");
  await readExactPaymentContact(job, config, transport);
  const before = await readExactPaymentOpportunity(job, config, transport);
  if (before.pipelineStageId === config.confirmedStageId) return;
  // The paid worker supplies exact reconciled Square evidence under the shared
  // stage lock. A fast payment need not wait for a Pending-stage worker first.
  if (before.pipelineStageId !== config.pendingStageId && before.pipelineStageId !== config.agreementCompletedStageId) throw new PaymentPaidDeliveryError("ghl_stage_diverged");
  // Fetch current contact again immediately before mutation: stale queued email is never a QA permit.
  await readExactPaymentContact(job, config, transport);
  await requestPaymentStage(config, transport, `/opportunities/${encodeURIComponent(job.opportunityId)}`, {
    method: "PUT", body: JSON.stringify({ pipelineStageId: config.confirmedStageId }),
  });
  const after = await readExactPaymentOpportunity(job, config, transport);
  if (after.pipelineStageId !== config.confirmedStageId) throw new PaymentPaidDeliveryError("ghl_stage_diverged");
}
