import type { AgreementStageDeliveryMessage } from "./agreement-completion-pg";

/**
 * A signed agreement moves only the immutable opportunity recorded with that
 * document completion. The worker never searches contacts, creates records,
 * or relies on HighLevel's "most recent opportunity" selection.
 */
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "v3";
const REQUEST_TIMEOUT_MS = 5_000;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,192}$/;
const LOCATION = "aooAnUXF0COePorBo7wL";
const QA_EMAILS = new Set(["lnooley@gmail.com", "nate@autocraftstudios.com"]);

type FetchTransport = typeof fetch;

export interface AgreementStageDeliveryConfig {
  mode: "qa" | "production";
  apiToken: string;
  locationId: string;
  pipelineId: string;
  sentStageId: string;
  completedStageId: string;
}

export class AgreementStageDeliveryError extends Error {
  public readonly code: string;
  public readonly retryAfterSeconds: number | undefined;

  constructor(code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function validIdentifier(value: string | undefined): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

/** Names can be changed by an operator; exact IDs are the only safe mapping. */
export function readAgreementStageDeliveryConfig(
  env: Record<string, string | undefined>,
): AgreementStageDeliveryConfig {
  const apiToken = env.GHL_API_TOKEN?.trim() ?? "";
  const locationId = env.GHL_LOCATION_ID?.trim() ?? "";
  const productionPipelineId = env.GHL_APPLICATION_PIPELINE_ID?.trim() ?? "";
  const mode = env.VERCEL_ENV === "preview" ? "qa" : "production";
  const pipelineId = mode === "qa" ? env.GHL_QA_APPLICATION_PIPELINE_ID?.trim() ?? "" : productionPipelineId;
  const legacyPipelineId = env.GHL_AGREEMENT_PIPELINE_ID?.trim() ?? "";
  const sentStageId = env.GHL_AGREEMENT_SENT_STAGE_ID?.trim() ?? "";
  const completedStageId = env.GHL_AGREEMENT_COMPLETED_STAGE_ID?.trim() ?? "";
  const ids = [locationId, pipelineId, sentStageId, completedStageId];
  if (env.VERCEL !== "1" || !["preview", "production"].includes(env.VERCEL_ENV ?? "")
    || apiToken.length < 16 || /[\r\n\0]/.test(apiToken) || locationId !== LOCATION
    || ids.some(id => !validIdentifier(id)) || sentStageId === completedStageId
    || (legacyPipelineId && legacyPipelineId !== pipelineId)
    || (mode === "qa" && (env.GHL_PAYMENT_QA_ROUTING_VERIFIED !== "true"
      || !validIdentifier(productionPipelineId) || pipelineId === productionPipelineId))
    || (mode === "production" && Object.entries(env).some(([key, value]) => value?.trim()
      && (key.startsWith("GHL_QA_") || key.startsWith("GHL_PAYMENT_QA_"))))) {
    throw new AgreementStageDeliveryError("ghl_config_missing", "HighLevel agreement-stage delivery is not configured.");
  }
  return { apiToken, locationId, pipelineId, sentStageId, completedStageId, mode };
}

export function agreementStageDeliveryConfigured(env: Record<string, string | undefined>): boolean {
  try {
    readAgreementStageDeliveryConfig(env);
    return true;
  } catch {
    return false;
  }
}

interface OpportunityIdentity {
  id: string;
  contactId: string;
  pipelineId: string;
  pipelineStageId: string;
  status: "open" | "won" | "lost" | "abandoned";
  locationId?: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(record: Record<string, unknown>, camel: string, snake: string): string | undefined {
  const candidate = record[camel] ?? record[snake];
  return typeof candidate === "string" ? candidate : undefined;
}

async function responseJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return object(await response.json());
  } catch {
    return null;
  }
}

function opportunityFromResponse(body: Record<string, unknown> | null): OpportunityIdentity | null {
  if (!body) return null;
  const candidate = object(body.opportunity) ?? body;
  const id = text(candidate, "id", "id");
  const contactId = text(candidate, "contactId", "contact_id");
  const pipelineId = text(candidate, "pipelineId", "pipeline_id");
  const pipelineStageId = text(candidate, "pipelineStageId", "pipeline_stage_id");
  const status = text(candidate, "status", "status");
  const locationId = text(candidate, "locationId", "location_id");
  return id && contactId && pipelineId && pipelineStageId
    && (status === "open" || status === "won" || status === "lost" || status === "abandoned")
    ? { id, contactId, pipelineId, pipelineStageId, status, locationId }
    : null;
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = Number(response.headers.get("retry-after"));
  return Number.isInteger(value) && value >= 1 && value <= 3600 ? value : undefined;
}

async function request(
  transport: FetchTransport,
  config: AgreementStageDeliveryConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await transport(`${GHL_BASE}${path}`, {
      ...init,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        Version: GHL_VERSION,
        Accept: "application/json",
        ...(init.method === "PUT" ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AgreementStageDeliveryError("ghl_unavailable", "HighLevel agreement-stage delivery is unavailable.");
  }
}

function providerError(response: Response): AgreementStageDeliveryError {
  if (response.status === 429) {
    return new AgreementStageDeliveryError("ghl_rate_limited", "HighLevel rate limited agreement-stage delivery.", retryAfterSeconds(response));
  }
  if (response.status >= 500) return new AgreementStageDeliveryError("ghl_unavailable", "HighLevel agreement-stage delivery is unavailable.");
  return new AgreementStageDeliveryError("ghl_rejected", "HighLevel rejected agreement-stage delivery.");
}

function exactOpportunity(
  opportunity: OpportunityIdentity | null,
  message: AgreementStageDeliveryMessage,
  config: AgreementStageDeliveryConfig,
): OpportunityIdentity {
  if (!opportunity
    || opportunity.id !== message.payload.opportunityId
    || opportunity.contactId !== message.payload.contactId
    || opportunity.locationId !== message.payload.locationId) {
    throw new AgreementStageDeliveryError("ghl_identity_mismatch", "HighLevel opportunity identity did not match the agreement completion.");
  }
  if (opportunity.pipelineId !== config.pipelineId) {
    throw new AgreementStageDeliveryError("ghl_pipeline_mismatch", "HighLevel opportunity pipeline did not match the agreement configuration.");
  }
  return opportunity;
}

async function getExactOpportunity(
  message: AgreementStageDeliveryMessage,
  config: AgreementStageDeliveryConfig,
  transport: FetchTransport,
): Promise<OpportunityIdentity> {
  const response = await request(transport, config, `/opportunities/${encodeURIComponent(message.payload.opportunityId)}`, { method: "GET" });
  if (!response.ok) throw providerError(response);
  return exactOpportunity(opportunityFromResponse(await responseJson(response)), message, config);
}

/** QA must verify the current contact immediately before any workflow-triggering stage write. */
async function verifyQaContact(message: AgreementStageDeliveryMessage, config: AgreementStageDeliveryConfig,
  transport: FetchTransport): Promise<void> {
  if (config.mode !== "qa") return;
  const response = await request(transport, config, `/contacts/${encodeURIComponent(message.payload.contactId)}`, { method: "GET" });
  if (!response.ok) throw providerError(response);
  const contact = object((await responseJson(response))?.contact);
  if (!contact || contact.id !== message.payload.contactId || contact.locationId !== config.locationId
    || typeof contact.email !== "string" || !QA_EMAILS.has(contact.email.trim().toLowerCase())) {
    throw new AgreementStageDeliveryError("ghl_identity_mismatch", "HighLevel agreement contact did not match the allowed QA recipient.");
  }
}

/**
 * The preflight/final read is intentional: if HighLevel accepts a PUT but the
 * process exits before the local receipt is written, the retry sees the target
 * state and marks the same job delivered without a second workflow trigger.
 */
export async function deliverAgreementStageToGhl(
  message: AgreementStageDeliveryMessage,
  config: AgreementStageDeliveryConfig,
  transport: FetchTransport = fetch,
): Promise<void> {
  if (message.payload.locationId !== config.locationId) {
    throw new AgreementStageDeliveryError("ghl_identity_mismatch", "Agreement completion location did not match the HighLevel configuration.");
  }
  await verifyQaContact(message, config, transport);
  const before = await getExactOpportunity(message, config, transport);
  // Agreement completion is a stage transition, not a lifecycle-status change.
  // Never reopen a won/lost/abandoned opportunity merely because a stale
  // completion event arrives after an operator moved it out of the open flow.
  if (before.status !== "open") {
    throw new AgreementStageDeliveryError("ghl_status_diverged", "HighLevel opportunity was not open for agreement completion.");
  }
  if (before.pipelineStageId === config.completedStageId) return;
  if (before.pipelineStageId !== config.sentStageId) {
    throw new AgreementStageDeliveryError("ghl_stage_diverged", "HighLevel opportunity was not in the configured agreement-sent stage.");
  }
  await verifyQaContact(message, config, transport);

  const update = await request(transport, config, `/opportunities/${encodeURIComponent(message.payload.opportunityId)}`, {
    method: "PUT",
    body: JSON.stringify({
      pipelineStageId: config.completedStageId,
    }),
  });
  if (!update.ok) throw providerError(update);

  const after = await getExactOpportunity(message, config, transport);
  if (after.pipelineStageId !== config.completedStageId || after.status !== before.status) {
    throw new AgreementStageDeliveryError("ghl_stage_diverged", "HighLevel did not confirm the agreement-completed opportunity state.");
  }
}
