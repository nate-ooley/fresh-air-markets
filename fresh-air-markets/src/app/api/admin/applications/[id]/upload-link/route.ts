import { NextRequest, NextResponse } from "next/server";
import { validApplicationDocumentId } from "@/lib/application-document";
import { getSessionAccountId } from "@/lib/auth";
import { emailConfigured } from "@/lib/email";
import { notifyDocumentUploadLink } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/**
 * Staff email the vendor a personal 14-day document upload link without
 * changing the application's review state. Useful when a vendor emailed or
 * texted about documents instead of uploading them.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "Persistent storage is required." }, { status: 503, headers });
  if (!emailConfigured()) return NextResponse.json({ error: "Email is not configured." }, { status: 503, headers });
  const { id } = await params;
  if (!validApplicationDocumentId(id)) return NextResponse.json({ error: "Invalid application ID." }, { status: 400, headers });
  const outcome = await notifyDocumentUploadLink({ applicationId: id, marketId });
  if (outcome === "not_found") return NextResponse.json({ error: "Application not found." }, { status: 404, headers });
  if (outcome !== "sent") return NextResponse.json({ error: "The upload link email could not be sent. Try again or contact the vendor another way." }, { status: 502, headers });
  return NextResponse.json({ ok: true, vendorNotification: "sent" }, { headers });
}
