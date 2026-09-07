import { createHash, timingSafeEqual } from "node:crypto";

/**
 * A document is bound to an application when it is issued, then only that
 * exact binding may mark the application agreement complete.  The external
 * source never supplies a portal application ID, an admin email, or a market
 * identity; those are derived from private server configuration and the
 * established application record.
 */
export interface AgreementWebhookConfig {
  secret: string;
  locationId: string;
  marketId: string;
  seasonId: string;
  templateId: string;
  notificationEmail: string;
}

export interface AgreementIssued {
  eventId: string;
  locationId: string;
  marketId: string;
  seasonId: string;
  documentId: string;
  templateId: string;
  contactId: string;
  opportunityId: string;
  notificationEmail: string;
  payloadHash: string;
}

export interface AgreementCompleted extends AgreementIssued {
  status: "completed";
}

export type AgreementIngressResult = "captured" | "duplicate" | "conflict";

/** The database deliberately returns this without explaining which ID failed. */
export class AgreementMappingError extends Error {
  constructor() { super("Agreement does not match an active application binding."); }
}

/** A different document cannot change a signed application a second time. */
export class AgreementAlreadyCompletedError extends Error {
  constructor() { super("Application agreement has already been completed."); }
}

const MAX_AGREEMENT_EVENT_BYTES = 32 * 1024;
const ID = /^[A-Za-z0-9:_-]{1,192}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validAgreementId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function validAgreementNotificationEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && EMAIL.test(value);
}

export function agreementWebhookConfigured(config: AgreementWebhookConfig): boolean {
  return config.secret.length >= 32
    && validAgreementId(config.locationId)
    && validAgreementId(config.marketId)
    && validAgreementId(config.seasonId)
    && validAgreementId(config.templateId)
    && validAgreementNotificationEmail(config.notificationEmail);
}

function hasAuthorization(request: Request, secret: string): boolean {
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

async function readAgreementObject(request: Request): Promise<Record<string, unknown> | null | "too_large"> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_AGREEMENT_EVENT_BYTES) return "too_large";
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_AGREEMENT_EVENT_BYTES) {
        await reader.cancel().catch(() => {});
        return "too_large";
      }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  } finally {
    reader.releaseLock();
  }
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

function parseAgreementEvent(
  body: Record<string, unknown>,
  config: AgreementWebhookConfig,
  expectedStatus: "sent" | "completed",
): AgreementIssued | AgreementCompleted | null {
  const fields = ["eventId", "documentId", "templateId", "contactId", "opportunityId"] as const;
  if (fields.some(field => !validAgreementId(body[field]))) return null;
  if (body.locationId !== config.locationId || body.seasonId !== config.seasonId || body.templateId !== config.templateId || body.status !== expectedStatus) return null;
  const eventId = body.eventId as string;
  const documentId = body.documentId as string;
  const templateId = body.templateId as string;
  const contactId = body.contactId as string;
  const opportunityId = body.opportunityId as string;

  // Hash only validated, semantically material values in a fixed order. JSON
  // key order and ignored provider fields cannot turn a safe retry into a
  // conflict, while a changed identity still does.
  const payloadHash = createHash("sha256").update(JSON.stringify([
    expectedStatus, eventId, documentId, templateId,
    contactId, opportunityId, body.locationId, body.seasonId,
  ])).digest("hex");
  const common: AgreementIssued = {
    eventId,
    documentId,
    templateId,
    contactId,
    opportunityId,
    locationId: config.locationId,
    marketId: config.marketId,
    seasonId: config.seasonId,
    notificationEmail: normalizedEmail(config.notificationEmail),
    payloadHash,
  };
  return expectedStatus === "completed" ? { ...common, status: "completed" } : common;
}

function responseForResult(result: AgreementIngressResult): Response {
  if (result === "conflict") return Response.json({ error: "Event ID was already used for different content." }, { status: 409 });
  return Response.json({ status: result }, { status: result === "captured" ? 201 : 200 });
}

async function handleAgreementEvent<T extends AgreementIssued | AgreementCompleted>(
  request: Request,
  config: AgreementWebhookConfig,
  expectedStatus: "sent" | "completed",
  persist: (event: T) => Promise<AgreementIngressResult>,
): Promise<Response> {
  if (!agreementWebhookConfigured(config)) return Response.json({ error: "Agreement webhook is not configured." }, { status: 503 });
  if (!hasAuthorization(request, config.secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const body = await readAgreementObject(request);
  if (body === "too_large") return Response.json({ error: "Agreement event is too large." }, { status: 413 });
  if (!body) return Response.json({ error: "A JSON object is required." }, { status: 400 });
  const event = parseAgreementEvent(body, config, expectedStatus);
  if (!event) return Response.json({ error: "Invalid agreement event." }, { status: 400 });
  try {
    return responseForResult(await persist(event as T));
  } catch (error) {
    if (error instanceof AgreementMappingError) return Response.json({ error: "Agreement does not match an active application." }, { status: 422 });
    if (error instanceof AgreementAlreadyCompletedError) return Response.json({ error: "Agreement was already completed for this application." }, { status: 409 });
    // A source must replay the exact event ID after a transient persistence
    // failure. Never expose provider/database details to a webhook caller.
    return Response.json({ error: "Agreement processing unavailable; retry the same event." }, { status: 503 });
  }
}

/** Record the exact document/application binding immediately after issuance. */
export function handleAgreementIssued(
  request: Request,
  config: AgreementWebhookConfig,
  persist: (event: AgreementIssued) => Promise<AgreementIngressResult>,
): Promise<Response> {
  return handleAgreementEvent(request, config, "sent", persist);
}

/** Completion is accepted only for an existing, active issuance binding. */
export function handleAgreementCompleted(
  request: Request,
  config: AgreementWebhookConfig,
  persist: (event: AgreementCompleted) => Promise<AgreementIngressResult>,
): Promise<Response> {
  return handleAgreementEvent(request, config, "completed", persist);
}
