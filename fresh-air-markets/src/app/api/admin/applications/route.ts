import { NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { listApplicationReviewDetails } from "@/lib/application-review-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The session is the sole market selector. The list intentionally accepts no
 * client market, contact, email, or opportunity filter, and the storage layer
 * caps it at a small manager-facing result set.
 */
export async function GET() {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ applications: await listApplicationReviewDetails(marketId, 50) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Application reviews are unavailable." }, { status: 503 });
  }
}
