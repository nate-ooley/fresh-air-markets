import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import {
  parseFinalReservationSelection,
  validFinalReservationApplicationId,
} from "@/lib/final-reservation";
import {
  freshAirFinalReservationConfig,
  getFinalApplicationReservation,
  reserveFinalApplication,
} from "@/lib/final-reservation-pg";
import { readInquiryBody } from "@/lib/inquiry-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const headers = { "Cache-Control": "private, no-store" };
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const { id } = await params;
  if (!validFinalReservationApplicationId(id)) return NextResponse.json({ error: "Invalid application ID." }, { status: 400, headers });
  try {
    const config = freshAirFinalReservationConfig(process.env);
    if (config.marketId !== marketId || !process.env.DATABASE_URL) throw new Error("Unavailable");
    const result = await getFinalApplicationReservation(marketId, id);
    return result ? NextResponse.json(result, { headers })
      : NextResponse.json({ error: "Application not found." }, { status: 404, headers });
  } catch {
    return NextResponse.json({ error: "Final reservation is unavailable." }, { status: 503, headers });
  }
}

function reservationResponse(status: 200 | 201, reservation: {
  id: string;
  state: string;
  paymentRequired: boolean;
  totalCents: number;
  finalDates: string[];
  finalBoothQuantity: number;
  quoteVersion: string;
}, duplicate: boolean) {
  return NextResponse.json({ reservation, duplicate }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Authenticated manager CHECK→RESERVE action. The body may describe only the
 * manager's final type/category/date/quantity/license decision. The path and
 * signed-in market bind identity, while the transaction re-reads all approval
 * facts, quote inputs and capacity. This route never calls Square or sends a
 * message; checkout remains a separate manager action after this has committed.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "Final reservation storage is not configured." }, { status: 503 });
  }

  const { id: applicationId } = await params;
  if (!validFinalReservationApplicationId(applicationId)) {
    return NextResponse.json({ error: "Invalid application ID." }, { status: 400 });
  }
  const decoded = await readInquiryBody(request);
  if ("status" in decoded) return NextResponse.json({ error: decoded.error }, { status: decoded.status });
  const selection = parseFinalReservationSelection(decoded.body, request.headers.get("Idempotency-Key"));
  if (!selection) return NextResponse.json({ error: "Invalid final reservation." }, { status: 400 });

  let config;
  try {
    config = freshAirFinalReservationConfig(process.env);
    // The session is the tenant boundary. A deployed route pointed at another
    // tenant's capacity setting must fail closed rather than select a record.
    if (config.marketId !== marketId) throw new Error("Market configuration mismatch.");
  } catch {
    return NextResponse.json({ error: "Final reservation is not configured for this market." }, { status: 503 });
  }

  try {
    const result = await reserveFinalApplication({
      marketId,
      applicationId,
      actorAccountId: marketId,
      selection,
      config,
    });
    if (result.kind === "created") return reservationResponse(201, result.reservation, false);
    if (result.kind === "duplicate") return reservationResponse(200, result.reservation, true);
    if (result.kind === "not_found") return NextResponse.json({ error: "Application not found." }, { status: 404 });
    if (result.kind === "conflict") {
      return NextResponse.json({ error: "This application already has a different final reservation." }, { status: 409 });
    }
    if (result.kind === "invalid_selection") {
      return NextResponse.json({ error: "The final reservation selection is not valid for this market." }, { status: 400 });
    }
    if (result.kind === "not_eligible") {
      return NextResponse.json({
        error: "The application is not eligible for final reservation.",
        eligibility: result.reason,
      }, { status: 409 });
    }
    return NextResponse.json({
      error: "One or more requested market dates are unavailable.",
      availability: result.availability,
    }, { status: 409 });
  } catch {
    return NextResponse.json({ error: "Final reservation is unavailable. Retry the same request." }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "15" },
    });
  }
}
