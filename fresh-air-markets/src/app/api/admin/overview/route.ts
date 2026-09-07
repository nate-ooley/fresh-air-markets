import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { marketBookableDates } from "@/lib/market-calendar";
import { getSessionAccountId } from "@/lib/auth";
import { toPublicAccount } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Dashboard: account + booths (with occupants) + bookings, scoped to the session's market. */
export async function GET(req: NextRequest) {
  const accountId = await getSessionAccountId();
  if (!accountId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const store = await getStore();
  const account = await store.getAccountById(accountId);
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const valid = marketBookableDates(account.id, process.env, new Date(), true);
  const dates = (req.nextUrl.searchParams.get("dates") ?? "")
    .split(",")
    .filter((d) => valid.has(d));
  const [booths, bookings] = await Promise.all([
    store.boothsWithAvailability(account.id, dates, true),
    store.listBookings(account.id),
  ]);
  return NextResponse.json({ account: toPublicAccount(account), booths, bookings });
}

