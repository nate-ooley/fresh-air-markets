import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { marketBookableDates } from "@/lib/market-calendar";

export const dynamic = "force-dynamic";

/** Public: a market's booths with availability for ?dates=... (no vendor identities). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const store = await getStore();
  const account = await store.getAccountBySlug(slug);
  if (!account) return NextResponse.json({ error: "Market not found." }, { status: 404 });

  const valid = marketBookableDates(account.id);
  const dates = (req.nextUrl.searchParams.get("dates") ?? "")
    .split(",")
    .filter((d) => valid.has(d));
  const booths = await store.boothsWithAvailability(account.id, dates, false);
  return NextResponse.json({ booths, marketName: account.marketName });
}

