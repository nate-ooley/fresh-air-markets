"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BoothWithAvailability, VENDOR_CATEGORIES } from "@/lib/types";
import type { MarketWeekend } from "@/lib/dates";

interface BookingPanelProps {
  booth: BoothWithAvailability | null;
  weekends: MarketWeekend[];
  slug: string;
  onClose: () => void;
  onSubmitted: () => void;
}

const EMPTY_FORM = {
  name: "",
  businessName: "",
  email: "",
  phone: "",
  category: "",
  message: "",
};

export default function BookingPanel({ booth, weekends, slug, onClose, onSubmitted }: BookingPanelProps) {
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const inFlight = useRef(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);

  // Reset date selection when switching booths (keep contact info).
  useEffect(() => {
    setSelectedDates(new Set());
    setError("");
    setSuccess(false);
  }, [booth?.id]);

  const total = useMemo(
    () => (booth ? booth.pricePerDay * selectedDates.size : 0),
    [booth, selectedDates],
  );

  if (!booth) {
    return (
      <aside className="hidden rounded-3xl border-2 border-dashed border-pine/20 bg-parchment/50 p-8 text-center lg:flex lg:flex-col lg:items-center lg:justify-center">
        <div className="text-5xl">🧺</div>
        <h3 className="mt-4 font-display text-2xl text-pine-deep">Choose your booth</h3>
        <p className="mt-2 text-sm text-ink/60">
          Click any available booth on the map to see pricing and send a rental inquiry.
        </p>
      </aside>
    );
  }

  if (success) {
    return (
      <aside className="animate-rise self-start rounded-3xl bg-pine-deep p-8 text-cream shadow-xl">
        <div className="text-5xl">🌽</div>
        <h3 className="mt-4 font-display text-2xl">Inquiry sent!</h3>
        <p className="mt-3 text-sm leading-relaxed text-cream/80">
          Thanks, {form.name.split(" ")[0] || "friend"} — the market team will review your request
          for booth <strong>{booth.label}</strong> and reach out by email with approval and
          payment details. Keep an eye on your inbox.
        </p>
        <button
          onClick={() => {
            setSuccess(false);
            onClose();
          }}
          className="mt-6 rounded-full bg-amber px-6 py-2.5 font-semibold text-white transition hover:bg-clay"
        >
          Back to the map
        </button>
      </aside>
    );
  }

  const toggleDate = (date: string) => {
    const next = new Set(selectedDates);
    if (next.has(date)) next.delete(date);
    else next.add(date);
    setSelectedDates(next);
  };

  const toggleWeekend = (w: MarketWeekend) => {
    const open = w.dates.map((d) => d.date).filter((d) => !booth.bookedDates.includes(d));
    const allSelected = open.length > 0 && open.every((d) => selectedDates.has(d));
    const next = new Set(selectedDates);
    for (const d of open) {
      if (allSelected) next.delete(d);
      else next.add(d);
    }
    setSelectedDates(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError("");
    setSubmitting(true);
    try {
      const payload = JSON.stringify({ ...form, boothId: booth.id, dates: [...selectedDates].sort() });
      if (attempt.current?.payload !== payload) {
        let key = crypto.randomUUID();
        // Retain retry identity across a reload in this tab without storing
        // vendor fields in browser storage. In-memory retry still works if
        // the browser disallows sessionStorage.
        try {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
          const fingerprint = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
          const storageKey = `fame-inquiry:${slug}:${fingerprint}`;
          const prior = sessionStorage.getItem(storageKey);
          if (prior && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(prior)) key = prior as typeof key;
          sessionStorage.setItem(storageKey, key);
        } catch { /* Session storage is optional; the request key is not. */ }
        attempt.current = { payload, key };
      }
      const res = await fetch(`/api/m/${slug}/inquiries`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.current.key },
        body: payload,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong — please try again.");
      } else {
        setSuccess(true);
        onSubmitted();
      }
    } catch {
      setError("Network error — please try again.");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const field =
    "w-full rounded-xl border border-pine/20 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-amber focus:ring-2 focus:ring-amber/30";

  return (
    <aside className="animate-rise self-start rounded-3xl bg-white p-6 shadow-xl ring-1 ring-pine/10">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-display text-2xl text-pine-deep">Booth {booth.label}</h3>
          <p className="text-sm text-ink/60">
            {booth.zone} · <strong className="text-clay">${booth.pricePerDay}/day</strong>
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded-full p-2 text-ink/40 transition hover:bg-parchment hover:text-ink"
        >
          ✕
        </button>
      </div>

      <form onSubmit={submit} className="mt-5 space-y-5">
        <div>
          <p className="mb-2 text-sm font-semibold text-pine-deep">
            Pick your market days <span className="font-normal text-ink/50">(one weekend or many)</span>
          </p>
          <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
            {weekends.map((w) => {
              const open = w.dates.filter((d) => !booth.bookedDates.includes(d.date));
              const allSelected = open.length > 0 && open.every((d) => selectedDates.has(d.date));
              return (
                <div key={w.key} className="rounded-xl bg-parchment/60 p-2.5">
                  <button
                    type="button"
                    onClick={() => toggleWeekend(w)}
                    disabled={open.length === 0}
                    className={`mb-1.5 text-xs font-bold uppercase tracking-wider ${
                      open.length === 0
                        ? "cursor-not-allowed text-ink/30"
                        : allSelected
                          ? "text-amber"
                          : "text-pine hover:text-amber"
                    }`}
                  >
                    {w.label} {open.length === 0 ? "· fully booked" : allSelected ? "· whole weekend ✓" : "· select all"}
                  </button>
                  <div className="flex gap-1.5">
                    {w.dates.map((d) => {
                      const taken = booth.bookedDates.includes(d.date);
                      const on = selectedDates.has(d.date);
                      return (
                        <button
                          key={d.date}
                          type="button"
                          disabled={taken}
                          onClick={() => toggleDate(d.date)}
                          className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition ${
                            taken
                              ? "cursor-not-allowed bg-ink/5 text-ink/30 line-through"
                              : on
                                ? "bg-pine text-cream shadow"
                                : "bg-white text-pine ring-1 ring-pine/15 hover:ring-amber"
                          }`}
                        >
                          {d.dow} {d.date.slice(8)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <input required placeholder="Your name" className={field} value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input required placeholder="Business name" className={field} value={form.businessName}
            onChange={(e) => setForm({ ...form, businessName: e.target.value })} />
          <input required type="email" placeholder="Email" className={field} value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input placeholder="Phone" className={field} value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>

        <select required className={field} value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}>
          <option value="">What do you sell?</option>
          {VENDOR_CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <textarea rows={2} placeholder="Anything else we should know? (optional)" className={field}
          value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />

        {error && (
          <p className="rounded-xl bg-clay/10 px-4 py-3 text-sm font-medium text-clay">{error}</p>
        )}

        <div className="flex items-center justify-between rounded-2xl bg-pine-deep px-5 py-4 text-cream">
          <div>
            <p className="text-xs uppercase tracking-wider text-cream/60">Total</p>
            <p className="font-display text-2xl">
              ${total}
              <span className="ml-1.5 text-sm font-normal text-cream/60">
                {selectedDates.size} day{selectedDates.size === 1 ? "" : "s"}
              </span>
            </p>
          </div>
          <button
            type="submit"
            disabled={submitting || selectedDates.size === 0}
            className="rounded-full bg-amber px-6 py-3 font-semibold text-white shadow transition enabled:hover:bg-clay disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Sending…" : "Send inquiry"}
          </button>
        </div>
        <p className="text-center text-xs text-ink/50">
          No payment now — the market team approves every vendor first.
        </p>
      </form>
    </aside>
  );
}
