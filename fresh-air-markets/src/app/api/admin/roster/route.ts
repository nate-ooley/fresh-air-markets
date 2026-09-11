import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { freshAirFinalReservationConfig } from "@/lib/final-reservation-pg";
import { loadMarketRoster, rosterCsv, rosterForDate, seasonOverview, validRosterDate } from "@/lib/market-roster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/**
 * Market roster for staff. `?date=YYYY-MM-DD` selects a market Saturday
 * (defaults to the next one); `&format=csv` downloads that date as a
 * spreadsheet. Read-only, market-scoped by the session.
 */
export async function GET(request: NextRequest) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "The roster needs a database." }, { status: 503, headers });
  let config;
  try {
    config = freshAirFinalReservationConfig(process.env);
    if (config.marketId !== marketId) throw new Error("Market configuration mismatch.");
  } catch { return NextResponse.json({ error: "The roster is not configured for this market." }, { status: 503, headers }); }
  const dates = config.calendarDates;
  const requested = request.nextUrl.searchParams.get("date");
  const today = new Date().toISOString().slice(0, 10);
  const date = requested === null ? (dates.find(d => d >= today) ?? dates[dates.length - 1]) : requested;
  if (!validRosterDate(date, dates)) return NextResponse.json({ error: "Choose one of this season's market dates.", dates }, { status: 400, headers });
  let vendors;
  try { vendors = await loadMarketRoster(marketId); }
  catch { return NextResponse.json({ error: "The roster is unavailable right now." }, { status: 503, headers }); }
  if (request.nextUrl.searchParams.get("format") === "csv") {
    return new NextResponse(rosterCsv(vendors, date), {
      status: 200,
      headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="market-roster-${date}.csv"` },
    });
  }
  return NextResponse.json({
    date, dates, capacity: config.boothCapacity,
    day: rosterForDate(vendors, date),
    season: seasonOverview(vendors, dates, config.boothCapacity),
  }, { headers });
}
