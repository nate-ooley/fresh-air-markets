import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { getSessionAccountId } from "@/lib/auth";
import { syncBookingToGhl } from "@/lib/ghl";

export const dynamic = "force-dynamic";

/**
 * Verification board: approve / reject inquiries for the session's market.
 * Approval is atomic and enforces one vendor per booth per market day.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const { action } = await req.json().catch(() => ({ action: "" }));
  const store = await getStore();

  if (action === "approve") {
    const result = await store.approveBooking(marketId, id);
    if (!result.ok) {
      const detail = result.conflicts
        .map((c) => `${c.date} is held by ${c.businessName}`)
        .join("; ");
      return NextResponse.json(
        { error: detail ? `Double-booking blocked: ${detail}.` : "Booking not found." },
        { status: detail ? 409 : 404 },
      );
    }
    const booth = await store.getBooth(marketId, result.booking.boothId);
    await syncBookingToGhl(result.booking, "booth-approved", booth?.label ?? result.booking.boothId);
    return NextResponse.json({ booking: result.booking });
  }

  if (action === "reject" || action === "cancel") {
    const status = action === "reject" ? "rejected" : "cancelled";
    const booking = await store.setBookingStatus(marketId, id, status);
    if (!booking) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
    if (status === "rejected") {
      const booth = await store.getBooth(marketId, booking.boothId);
      await syncBookingToGhl(booking, "booth-rejected", booth?.label ?? booking.boothId);
    }
    return NextResponse.json({ booking });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
