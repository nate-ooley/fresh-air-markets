import type { ApplicationReviewOutboxMessage } from "./application-review-pg";

/**
 * The approval worker intentionally uses HighLevel's v3 opportunity API
 * directly. It never searches for an opportunity, upserts a contact, or
 * chooses a "most recent" record: every ID comes from the committed review
 * outbox payload.
 */
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "v3";
const REQUEST_TIMEOUT_MS = 5_000;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,192}$/;
const LOCATION = "aooAnUXF0COePorBo7wL";
const QA_EMAILS = new Set(["lnooley@gmail.com", "nate@autocraftstudios.com"]);

type ReviewOutcome = "approved" | "changes_requested" | "declined";
type FetchTransport = typeof fetch;

export interface ApplicationReviewDeliveryConfig {
  mode: "qa" | "production";
  apiToken: string;
  locationId: string;
  pipelineId: string;
  reviewStageId: string;
  stageForOutcome: Record<ReviewOutcome, string>;
}

export class ApplicationReviewDeliveryError extends Error {
  public readonly code: string;
  public readonly retryAfterSeconds: number | undefined;

  constructor(
    code: string,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function validIdentifier(value: string | undefined): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

/** Read only server-side IDs. Names are too ambiguous to safely route a review. */
export function readApplicationReviewDeliveryConfig(
  env: Record<string, string | undefined>,
): ApplicationReviewDeliveryConfig {
  const apiToken = env.GHL_API_TOKEN?.trim() ?? "";
  const locationId = env.GHL_LOCATION_ID?.trim() ?? "";
  const productionPipelineId = env.GHL_APPLICATION_PIPELINE_ID?.trim() ?? "";
  const mode = env.VERCEL_ENV === "preview" ? "qa" : "production";
  const pipelineId = mode === "qa"
    ? env.GHL_QA_APPLICATION_PIPELINE_ID?.trim() ?? ""
    : productionPipelineId;
  const reviewStageId = env.GHL_APPLICATION_REVIEW_STAGE_ID?.trim() ?? "";
  const stageForOutcome = {
    approved: env.GHL_APPLICATION_APPROVED_STAGE_ID?.trim() ?? "",
    // A portal correction is still awaiting review in the five-stage native pipeline.
    changes_requested: reviewStageId,
    declined: env.GHL_APPLICATION_DECLINED_STAGE_ID?.trim() ?? "",
  };
  const ids = [locationId, pipelineId, reviewStageId, ...Object.values(stageForOutcome)];
  const stages = [reviewStageId, stageForOutcome.approved, stageForOutcome.declined];
  if (env.VERCEL !== "1" || !["preview", "production"].includes(env.VERCEL_ENV ?? "")
    || apiToken.length < 16 || /[\r\n\0]/.test(apiToken) || locationId !== LOCATION
    || ids.some(id => !validIdentifier(id)) || new Set(stages).size !== stages.length
    || (mode === "qa" && (env.GHL_PAYMENT_QA_ROUTING_VERIFIED !== "true"
      || !validIdentifier(productionPipelineId) || pipelineId === productionPipelineId))
    || (mode === "production" && Object.entries(env).some(([key, entry]) => entry?.trim()
      && (key.startsWith("GHL_QA_") || key.startsWith("GHL_PAYMENT_QA_"))))) {
    throw new ApplicationReviewDeliveryError("ghl_config_missing", "HighLevel application-review delivery is not configured.");
  }
  return { apiToken, locationId, pipelineId, reviewStageId, stageForOutcome, mode };
}

export function applicationReviewDeliveryConfigured(env: Record<string, string | undefined>): boolean {
  try {
    readApplicationReviewDeliveryConfig(env);
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

function value(record: Record<string, unknown>, camel: string, snake: string): string | undefined {
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
  const id = value(candidate, "id", "id");
  const contactId = value(candidate, "contactId", "contact_id");
  const pipelineId = value(candidate, "pipelineId", "pipeline_id");
  const pipelineStageId = value(candidate, "pipelineStageId", "pipeline_stage_id");
  const status = value(candidate, "status", "status");
  const locationId = value(candidate, "locationId", "location_id");
  return id && contactId && pipelineId && pipelineStageId
    && (status === "open" || status === "won" || status === "lost" || status === "abandoned")
    ? { id, contactId, pipelineId, pipelineStageId, status, locationId }
    : null;
}

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const value = Number(header);
  return Number.isInteger(value) && value >= 1 && value <= 3600 ? value : undefined;
}

async function request(
  transport: FetchTransport,
  config: ApplicationReviewDeliveryConfig,
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
    throw new ApplicationReviewDeliveryError("ghl_unavailable", "HighLevel application-review delivery is unavailable.");
  }
}

function providerError(response: Response): ApplicationReviewDeliveryError {
  if (response.status === 429) {
    return new ApplicationReviewDeliveryError("ghl_rate_limited", "HighLevel rate limited application-review delivery.", retryAfterSeconds(response));
  }
  if (response.status >= 500) return new ApplicationReviewDeliveryError("ghl_unavailable", "HighLevel application-review delivery is unavailable.");
  return new ApplicationReviewDeliveryError("ghl_rejected", "HighLevel rejected application-review delivery.");
}

function exactOpportunity(
  opportunity: OpportunityIdentity | null,
  message: ApplicationReviewOutboxMessage,
  config: ApplicationReviewDeliveryConfig,
): OpportunityIdentity {
  if (!opportunity
    || opportunity.id !== message.payload.opportunityId
    || opportunity.contactId !== message.payload.contactId
    || opportunity.locationId !== message.payload.locationId) {
    throw new ApplicationReviewDeliveryError("ghl_identity_mismatch", "HighLevel opportunity identity did not match the review record.");
  }
  if (opportunity.pipelineId !== config.pipelineId) {
    throw new ApplicationReviewDeliveryError("ghl_pipeline_mismatch", "HighLevel opportunity pipeline did not match the review configuration.");
  }
  return opportunity;
}

function outcomeFor(message: ApplicationReviewOutboxMessage): ReviewOutcome {
  const state = message.payload.reviewState;
  if (state === "approved" || state === "changes_requested" || state === "declined") return state;
  throw new ApplicationReviewDeliveryError("ghl_stage_diverged", "The review state cannot be delivered to HighLevel.");
}

async function getExactOpportunity(
  message: ApplicationReviewOutboxMessage,
  config: ApplicationReviewDeliveryConfig,
  transport: FetchTransport,
): Promise<OpportunityIdentity> {
  const response = await request(transport, config, `/opportunities/${encodeURIComponent(message.payload.opportunityId)}`, { method: "GET" });
  if (!response.ok) throw providerError(response);
  return exactOpportunity(opportunityFromResponse(await responseJson(response)), message, config);
}

async function verifyQaContact(
  message: ApplicationReviewOutboxMessage,
  config: ApplicationReviewDeliveryConfig,
  transport: FetchTransport,
): Promise<void> {
  if (config.mode !== "qa") return;
  const response = await request(transport, config, `/contacts/${encodeURIComponent(message.payload.contactId)}`, { method: "GET" });
  if (!response.ok) throw providerError(response);
  const contact = object((await responseJson(response))?.contact);
  if (!contact || contact.id !== message.payload.contactId || contact.locationId !== config.locationId
    || typeof contact.email !== "string" || !QA_EMAILS.has(contact.email.trim().toLowerCase())) {
    throw new ApplicationReviewDeliveryError("ghl_identity_mismatch", "HighLevel QA contact did not match an authorized test recipient.");
  }
}

/**
 * Reconcile only the outbox record's immutable opportunity. A correction
 * verifies Needs Review/Open without a PUT or vendor notification. For an
 * approval/decline, GET/PUT/GET permits a harmless crash-after-success retry.
 */
export async function deliverApplicationReviewToGhl(
  message: ApplicationReviewOutboxMessage,
  config: ApplicationReviewDeliveryConfig,
  transport: FetchTransport = fetch,
): Promise<void> {
  if (message.payload.locationId !== config.locationId) {
    throw new ApplicationReviewDeliveryError("ghl_identity_mismatch", "Review location did not match the HighLevel configuration.");
  }
  const targetStageId = config.stageForOutcome[outcomeFor(message)];
  await verifyQaContact(message, config, transport);
  const before = await getExactOpportunity(message, config, transport);
  if (before.status !== "open") {
    throw new ApplicationReviewDeliveryError("ghl_status_diverged", "HighLevel opportunity was not open for application review.");
  }
  if (before.pipelineStageId === targetStageId) return;
  if (before.pipelineStageId !== config.reviewStageId) {
    throw new ApplicationReviewDeliveryError("ghl_stage_diverged", "HighLevel opportunity was not in the configured review stage.");
  }
  // A queued snapshot is not permission to notify a contact whose email changed.
  await verifyQaContact(message, config, transport);

  const update = await request(transport, config, `/opportunities/${encodeURIComponent(message.payload.opportunityId)}`, {
    method: "PUT",
    body: JSON.stringify({
      pipelineStageId: targetStageId,
    }),
  });
  if (!update.ok) throw providerError(update);

  const after = await getExactOpportunity(message, config, transport);
  if (after.pipelineStageId !== targetStageId || after.status !== before.status) {
    throw new ApplicationReviewDeliveryError("ghl_stage_diverged", "HighLevel did not confirm the requested review stage.");
  }
}
