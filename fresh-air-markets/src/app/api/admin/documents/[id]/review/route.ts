import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { parseApplicationDocumentReview, validApplicationDocumentId } from "@/lib/application-document";
import { recordApplicationDocumentReview } from "@/lib/application-document-pg";
import { readObjectBody } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A signed-in market session can decide only the exact document ID in the
 * route. The client never controls application, market, storage, or actor.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!validApplicationDocumentId(id)) return NextResponse.json({ error: "Invalid document ID." }, { status: 400 });
  const body = await readObjectBody(request);
  if (!body) return NextResponse.json({ error: "A JSON object body is required." }, { status: 400 });
  const decision = parseApplicationDocumentReview(body, request.headers.get("Idempotency-Key"));
  if (!decision) return NextResponse.json({ error: "Invalid document review." }, { status: 400 });
  try {
    const result = await recordApplicationDocumentReview({
      documentId: id,
      marketId,
      actorAccountId: marketId,
      ...decision,
    });
    if (result.kind === "not_found") return NextResponse.json({ error: "Document not found." }, { status: 404 });
    if (result.kind === "stale") return NextResponse.json({ error: "Document changed; reload before reviewing." }, { status: 409 });
    if (result.kind === "awaiting_validation") return NextResponse.json({ error: "Document must pass validation before review." }, { status: 409 });
    if (result.kind === "terminal") return NextResponse.json({ error: `Document is already ${result.reviewState}.` }, { status: 409 });
    if (result.kind === "conflict") return NextResponse.json({ error: "This review key was already used for different content." }, { status: 409 });
    return NextResponse.json({
      document: { id: result.documentId, reviewState: result.reviewState },
      reviewEventId: result.reviewEventId,
      duplicate: result.kind === "duplicate",
    });
  } catch {
    return NextResponse.json({ error: "Document review is unavailable." }, { status: 503 });
  }
}
