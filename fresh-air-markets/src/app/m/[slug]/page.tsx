import { notFound } from "next/navigation";
import { marketWeekends } from "@/lib/market-calendar";
import { getStore } from "@/lib/store";
import MarketBooking from "@/components/MarketBooking";

export const dynamic = "force-dynamic";

/** A market's public vendor-booking page. */
export default async function MarketPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const store = await getStore();
  const account = await store.getAccountBySlug(slug);
  if (!account) notFound();
  return (
    <MarketBooking
      weekends={marketWeekends(account.id)}
      slug={account.slug}
      marketName={account.marketName}
    />
  );
}

