import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { freshAirFinalReservationConfig, reopenExpiredReservation } from "@/lib/final-reservation-pg";
import { validSquareReservationId } from "@/lib/square-payment";
import { squarePortalOrigin } from "@/lib/square";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/**
 * Manager reopens an expired payment hold so a new payment request can be
 * created. Dates, booths and price are unchanged; capacity is re-checked.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let expected;
    try { expected = squarePortalOrigin(process.env); } catch { return NextResponse.json({ error: "Reservations are not configured." }, { status: 503, headers }); }
    if (origin !== expected) return NextResponse.json({ error: "Same-origin request is required." }, { status: 403, headers });
  }
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "Reservation storage is not configured." }, { status: 503, headers });
  const { id } = await params;
  if (!validSquareReservationId(id)) return NextResponse.json({ error: "Invalid reservation ID." }, { status: 400, headers });
  let config;
  try {
    config = freshAirFinalReservationConfig(process.env);
    if (config.marketId !== marketId) throw new Error("Market configuration mismatch.");
  } catch { return NextResponse.json({ error: "Reservations are not configured for this market." }, { status: 503, headers }); }
  let result;
  try { result = await reopenExpiredReservation({ marketId, reservationId: id, config }); }
  catch { return NextResponse.json({ error: "The reservation could not be reopened right now." }, { status: 503, headers }); }
  if (result.kind === "not_found") return NextResponse.json({ error: "Reservation not found." }, { status: 404, headers });
  if (result.kind === "not_expired") return NextResponse.json({ error: `Only expired holds (or holds waiting on manager review with no live payment attempt) can be reopened. This reservation is ${result.state.replace("_", " ")}.` }, { status: 409, headers });
  if (result.kind === "unavailable") return NextResponse.json({ error: `These dates no longer have room: ${result.unavailableDates.join(", ")}. Create a new reservation with different dates instead.`, unavailableDates: result.unavailableDates }, { status: 409, headers });
  return NextResponse.json({ reservation: result.reservation }, { status: 200, headers });
}
