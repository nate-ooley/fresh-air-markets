import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { parseApplicationReview, validApplicationId } from "@/lib/application-review";
import {
  dispatchApplicationReviewOutboxById,
  getApplicationReviewDetail,
  recordApplicationReview,
} from "@/lib/application-review-pg";
import {
  applicationReviewDeliveryConfigured,
  deliverApplicationReviewToGhl,
  readApplicationReviewDeliveryConfig,
} from "@/lib/ghl-application-review-delivery";
import { readObjectBody } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read an exact, market-scoped review target before submitting a decision. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!validApplicationId(id)) return NextResponse.json({ error: "Invalid application ID." }, { status: 400 });
  try {
    const application = await getApplicationReviewDetail(id, marketId);
    if (!application) return NextResponse.json({ error: "Application not found." }, { status: 404 });
    return NextResponse.json({ application }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Application review is unavailable." }, { status: 503 });
  }
}

/**
 * The path, signed-in market session and latest source event bind this action
 * to one application. No contact, opportunity, email or market from the body
 * is trusted, so a forwarded/tracked link cannot select a "most recent" CRM
 * opportunity on the caller's behalf.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!validApplicationId(id)) return NextResponse.json({ error: "Invalid application ID." }, { status: 400 });
  const body = await readObjectBody(req);
  if (!body) return NextResponse.json({ error: "A JSON object body is required." }, { status: 400 });
  const decision = parseApplicationReview(body, req.headers.get("Idempotency-Key"));
  if (!decision) return NextResponse.json({ error: "Invalid application review." }, { status: 400 });
  try {
    const result = await recordApplicationReview({
      applicationId: id,
      marketId,
      actorAccountId: marketId,
      ...decision,
    });
    if (result.kind === "not_found") return NextResponse.json({ error: "Application not found." }, { status: 404 });
    if (result.kind === "missing_identity_snapshot") return NextResponse.json({ error: "The latest application snapshot is incomplete. Reload after a complete vendor submission is captured." }, { status: 409 });
    if (result.kind === "missing_opportunity") return NextResponse.json({ error: "Application is missing its CRM opportunity identity." }, { status: 409 });
    if (result.kind === "stale_source") return NextResponse.json({ error: "Application changed; reload before reviewing." }, { status: 409 });
    if (result.kind === "terminal") return NextResponse.json({ error: `Application is already ${result.reviewState}.` }, { status: 409 });
    if (result.kind === "awaiting_resubmission") return NextResponse.json({ error: "Awaiting a newer vendor submission before another review." }, { status: 409 });
    if (result.kind === "conflict") return NextResponse.json({ error: "This review key was already used for different content." }, { status: 409 });
    // A saved decision must remain visible even if HighLevel is unavailable.
    // When delivery is configured, try only this committed outbox item right
    // away; the authenticated worker route owns later retry/recovery.
    let delivery: "delivered" | "queued" = "queued";
    if ((result.kind === "applied" || result.kind === "duplicate")
      && result.outboxId
      && applicationReviewDeliveryConfigured(process.env)) {
      try {
        const config = readApplicationReviewDeliveryConfig(process.env);
        const dispatched = await dispatchApplicationReviewOutboxById(
          result.outboxId,
          message => deliverApplicationReviewToGhl(message, config),
        );
        if (dispatched.delivered === 1) delivery = "delivered";
      } catch {
        // The outbox transaction has already committed. Keep the decision and
        // let the authenticated retry worker recover without leaking details.
      }
    }
    return NextResponse.json({
      application: { id: result.applicationId, reviewState: result.reviewState },
      reviewEventId: result.reviewEventId,
      duplicate: result.kind === "duplicate",
      delivery,
    });
  } catch {
    return NextResponse.json({ error: "Application review is unavailable." }, { status: 503 });
  }
}
