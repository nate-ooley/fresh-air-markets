import { createHash } from "node:crypto";

export type ApplicationReviewAction = "approve" | "request_changes" | "decline";
export type ApplicationReviewState = "unreviewed" | "needs_review" | "changes_requested" | "approved" | "declined";

export interface ParsedApplicationReview {
  action: ApplicationReviewAction;
  reason: string;
  sourceEventId: string;
  idempotencyKey: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_EVENT_ID = /^[A-Za-z0-9:_-]{1,192}$/;

/** Portal application IDs are generated internally. Do not accept a contact,
 * opportunity, email address, or a client-provided market ID in their place.
 */
export function validApplicationId(value: string): boolean {
  return UUID_V4.test(value);
}

export function validReviewIdempotencyKey(value: string | null): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

export function validSourceEventId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_EVENT_ID.test(value);
}

/**
 * Parse the intentionally small decision body. The path supplies the exact
 * portal application ID; session authentication supplies the market/actor.
 * A correction or decline cannot be sent without a useful manager note.
 */
export function parseApplicationReview(
  body: Record<string, unknown>,
  idempotencyKey: string | null,
): ParsedApplicationReview | null {
  if (!validReviewIdempotencyKey(idempotencyKey) || !validSourceEventId(body.sourceEventId)) return null;
  if (body.action !== "approve" && body.action !== "request_changes" && body.action !== "decline") return null;
  if (body.reason !== undefined && typeof body.reason !== "string") return null;
  const reason = (typeof body.reason === "string" ? body.reason : "").trim();
  if (reason.length > 2000 || (body.action !== "approve" && !reason)) return null;
  return { action: body.action, reason, sourceEventId: body.sourceEventId, idempotencyKey };
}

export function stateForReviewAction(action: ApplicationReviewAction): ApplicationReviewState {
  if (action === "approve") return "approved";
  if (action === "request_changes") return "changes_requested";
  return "declined";
}

/** Hash the normalized decision, not a mutable application snapshot. */
export function applicationReviewFingerprint(
  applicationId: string,
  sourceEventId: string,
  action: ApplicationReviewAction,
  reason: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([applicationId, sourceEventId, action, reason]))
    .digest("hex");
}
