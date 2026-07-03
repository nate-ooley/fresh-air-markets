"use client";

import { useEffect, useState } from "react";
import MarketMap from "./MarketMap";
import { BoothWithAvailability } from "@/lib/types";
import { DEMO_SLUG } from "@/lib/seed";
import { upcomingWeekends } from "@/lib/dates";

/** Live product preview on the marketing site — the actual demo market, read from the real API. */
export default function LandingDemoMap() {
  const [booths, setBooths] = useState<BoothWithAvailability[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const dates = upcomingWeekends(new Date(), 1).flatMap((w) => w.dates.map((d) => d.date));
    fetch(`/api/m/${DEMO_SLUG}/booths?dates=${dates.join(",")}`)
      .then((r) => r.json())
      .then((d) => setBooths(d.booths ?? []))
      .catch(() => {});
  }, []);

  if (booths.length === 0) {
    return <div className="aspect-[1200/820] w-full animate-pulse rounded-3xl bg-pine/10" />;
  }

  return (
    <div className="relative">
      <MarketMap
        booths={booths}
        selectedId={selected}
        onSelect={(b) => setSelected((id) => (id === b.id ? null : b.id))}
      />
      <a
        href={`/m/${DEMO_SLUG}`}
        target="_blank"
        rel="noreferrer"
        className="absolute -bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-pine-deep px-5 py-2.5 text-sm font-semibold text-cream shadow-xl transition hover:-translate-y-0.5 hover:bg-pine"
      >
        Explore the live demo ↗
      </a>
    </div>
  );
}
