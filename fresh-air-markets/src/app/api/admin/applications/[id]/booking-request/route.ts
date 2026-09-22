import { NextResponse } from "next/server";
import { validApplicationId } from "@/lib/application-review";
import { getSessionAccountId } from "@/lib/auth";
import { freshAirFinalReservationConfig } from "@/lib/final-reservation-pg";
import { marketToday, vendorBookingOverview } from "@/lib/vendor-booking-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** Staff: the vendor's open date request (if any) plus what confirming it would use. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const { id } = await params;
  if (!validApplicationId(id)) return NextResponse.json({ error: "Invalid application ID." }, { status: 400, headers });
  try {
    const config = freshAirFinalReservationConfig(process.env);
    if (config.marketId !== marketId || !process.env.DATABASE_URL) throw new Error("Unavailable");
    const overview = await vendorBookingOverview({ marketId, applicationId: id, config, today: marketToday() });
    if (!overview) return NextResponse.json({ error: "Application not found." }, { status: 404, headers });
    return NextResponse.json({ pendingRequest: overview.pendingRequest, profile: overview.profile, eligible: overview.eligible, insuranceExpiresOn: overview.insuranceExpiresOn }, { headers });
  } catch {
    return NextResponse.json({ error: "Booking requests are unavailable." }, { status: 503, headers });
  }
}
