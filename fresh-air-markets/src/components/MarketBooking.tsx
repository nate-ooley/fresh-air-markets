"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import MarketMap from "./MarketMap";
import BookingPanel from "./BookingPanel";
import { BoothWithAvailability, BoothStatus } from "@/lib/types";
import type { MarketWeekend } from "@/lib/dates";

interface MarketBookingProps {
  weekends: MarketWeekend[];
  slug: string;
  marketName: string;
}

export default function MarketBooking({ weekends, slug, marketName }: MarketBookingProps) {
  const allDates = useMemo(() => weekends.flatMap((w) => w.dates.map((d) => d.date)), [weekends]);
  const [booths, setBooths] = useState<BoothWithAvailability[]>([]);
  const [viewedWeekend, setViewedWeekend] = useState(weekends[0]?.key ?? "");
  const [selected, setSelected] = useState<BoothWithAvailability | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/m/${slug}/booths?dates=${allDates.join(",")}`);
    const data = await res.json();
    setBooths(data.booths ?? []);
    setLoading(false);
  }, [allDates, slug]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const weekend = weekends.find((w) => w.key === viewedWeekend) ?? weekends[0];

  const statusFor = useCallback(
    (booth: BoothWithAvailability): BoothStatus => {
      const days = weekend?.dates.map((d) => d.date) ?? [];
      const taken = booth.bookedDates.filter((d) => days.includes(d));
      if (taken.length === 0) return "available";
      return taken.length >= days.length ? "rented" : "partial";
    },
    [weekend],
  );

  const availableCount = booths.filter((b) => statusFor(b) === "available").length;

  return (
    <main className="min-h-screen">
      {/* ── Hero ─────────────────────────────────────────── */}
      <header className="relative overflow-hidden bg-pine-deep text-cream">
        <div
          className="absolute inset-0 opacity-20"
          style={{
            background:
              "radial-gradient(60rem 30rem at 20% -10%, #f2b04c 0%, transparent 55%), radial-gradient(50rem 26rem at 90% 110%, #3a7d54 0%, transparent 60%)",
          }}
        />
        <div className="relative mx-auto max-w-6xl px-6 py-20 md:py-28">
          <p className="animate-rise mb-4 text-sm font-semibold uppercase tracking-[0.3em] text-amber-soft">
            Open Friday · Saturday · Sunday
          </p>
          <h1 className="animate-rise font-display text-5xl leading-tight md:text-7xl" style={{ animationDelay: "80ms" }}>
            {marketName}
          </h1>
          <p className="animate-rise mt-5 max-w-xl text-lg text-cream/80" style={{ animationDelay: "160ms" }}>
            Pick your spot on the map, choose one weekend or many, and join a
            community of growers, bakers, and makers.
          </p>
          <div className="animate-rise mt-8 flex flex-wrap items-center gap-4" style={{ animationDelay: "240ms" }}>
            <a
              href="#map"
              className="rounded-full bg-amber px-7 py-3.5 font-semibold text-white shadow-lg transition hover:-translate-y-0.5 hover:bg-clay"
            >
              Reserve a booth
            </a>
            <span className="text-sm text-cream/70">
              {loading ? "Loading availability…" : `${availableCount} booths open ${weekend?.label ?? ""}`}
            </span>
          </div>
        </div>
      </header>

      {/* ── Map + booking ────────────────────────────────── */}
      <section id="map" className="mx-auto max-w-7xl px-4 py-14 md:px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-3xl text-pine-deep md:text-4xl">The market map</h2>
            <p className="mt-1 text-sm text-ink/60">
              Tap any booth to see pricing and request it. Showing availability for{" "}
              <strong>{weekend?.label}</strong>.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold text-pine">
            Market date
            <select
              value={viewedWeekend}
              onChange={(event) => setViewedWeekend(event.target.value)}
              disabled={weekends.length === 0}
              className="rounded-xl bg-parchment px-4 py-2 ring-1 ring-pine/20"
            >
              {weekends.length === 0 && <option value="">No upcoming market dates</option>}
              {weekends.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
            </select>
          </label>
        </div>

        <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
          <div>
            <MarketMap
              booths={booths}
              statusFor={statusFor}
              selectedId={selected?.id}
              onSelect={(b) => setSelected(b)}
            />
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink/70">
              <Legend swatch="bg-white ring-1 ring-moss" label="Available" />
              <Legend swatch="bg-[#fdeed3] ring-1 ring-amber" label="Partly booked" />
              <Legend swatch="bg-[#2d6647]" label="Rented" />
              <Legend swatch="bg-[#f8b25c] ring-1 ring-amber" label="Your selection" />
            </div>
          </div>

          <BookingPanel
            booth={selected}
            weekends={weekends}
            slug={slug}
            onClose={() => setSelected(null)}
            onSubmitted={() => {
              refresh();
            }}
          />
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────── */}
      <section className="bg-parchment/70">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="font-display text-3xl text-pine-deep md:text-4xl">How renting works</h2>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {[
              {
                n: "1",
                title: "Pick a booth & dates",
                body: "Choose your spot on the map and select a single weekend or a whole season of them. Pricing is per market day and varies by location.",
              },
              {
                n: "2",
                title: "Send your inquiry",
                body: "Tell us about your business. Our market team reviews every request to keep the vendor mix balanced — only one vendor per booth, guaranteed.",
              },
              {
                n: "3",
                title: "Get approved & sell",
                body: "You'll hear from us by email or text with your approval and payment details. Then just show up, set up, and meet your customers.",
              },
            ].map((s) => (
              <div key={s.n} className="rounded-2xl bg-cream p-6 shadow-sm ring-1 ring-pine/10">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber font-display text-xl text-white">
                  {s.n}
                </div>
                <h3 className="mt-4 font-display text-xl text-pine-deep">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink/70">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="bg-pine-deep py-10 text-center text-sm text-cream/60">
        <p>{marketName} · Fridays–Sundays · 8am–2pm</p>
        <p className="mt-2">
          <a href="/login" className="underline-offset-2 hover:underline">
            Market staff sign in
          </a>
          <span className="mx-3 opacity-40">|</span>
          Powered by{" "}
          <a href="/" className="font-semibold text-amber-soft underline-offset-2 hover:underline">
            Fresh Air Markets &amp; Events
          </a>
        </p>
      </footer>
    </main>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-block h-3.5 w-3.5 rounded ${swatch}`} />
      {label}
    </span>
  );
}
