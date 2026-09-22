"use client";

import { useEffect, useState } from "react";
import { reservationDateLabel } from "@/lib/final-reservation-ui";

interface Day { date: string; available: boolean; booked: boolean; past: boolean; uninsured: boolean }
interface Booking { id: string; state: string; dates: string[]; booths: number; totalCents: number }
interface PendingRequest { id: string; dates: string[]; booths: number; vendorNote: string; createdAt: string }
interface Overview {
  businessName: string; vendorName: string; eligible: boolean; reasons: string[];
  profile: { boothsPerMarket: number; vendorCategory: string };
  insuranceExpiresOn: string | null; bookings: Booking[]; pendingRequest: PendingRequest | null; days: Day[];
}

const STATE_LABEL: Record<string, string> = {
  held: "Reserved, payment link coming", payment_pending: "Awaiting your payment", paid: "Paid", confirmed: "Confirmed",
  expired: "Payment window passed", cancelled: "Withdrawn", declined: "Declined", manual_review: "Being checked by staff",
};
const RATE_NOTE = "$40 per Saturday, or $35 per Saturday when you book 4 or more in a row.";
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

function isOverview(value: unknown): value is Overview {
  const v = value as Overview | null;
  return Boolean(v && typeof v === "object" && Array.isArray(v.days) && Array.isArray(v.bookings) && typeof v.eligible === "boolean" && v.profile);
}

/** Reads the emailed link's token from the URL fragment, then shows the vendor's calendar. */
export default function VendorBookingPage() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [booths, setBooths] = useState("1");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<PendingRequest | null>(null);

  useEffect(() => {
    const match = /(?:^#|&)token=([A-Za-z0-9_.-]+)/.exec(window.location.hash);
    setToken(match ? match[1] : null);
    // Keep the personal link out of history and referrers.
    window.history.replaceState(null, "", window.location.pathname);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/vendor/booking", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ token, view: true }), cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok || !isOverview(payload)) { setLoadError((payload as { error?: string } | null)?.error ?? "Your booking page could not be loaded. Try the link again in a few minutes."); return; }
        setOverview(payload);
        setBooths(String(payload.profile.boothsPerMarket));
      } catch { if (!cancelled) setLoadError("Your booking page could not be loaded. Try the link again in a few minutes."); }
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function submit() {
    if (!token || busy || !selected.length) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/vendor/booking", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token, dates: selected, booths: Number(booths), note: note.trim() }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; request?: PendingRequest } | null;
      if (!response.ok || !payload?.request) { setError(payload?.error ?? "Your request could not be sent. Try again."); return; }
      setDone(payload.request);
    } catch { setError("Your request could not be sent. Check your connection and try again."); }
    finally { setBusy(false); }
  }

  if (!ready) return <p role="status" className="mt-6 text-sm text-ink/60">Checking your link…</p>;
  if (!token || loadError) {
    return <p role="alert" className="mt-6 rounded-2xl bg-clay/10 p-4 text-sm text-clay">{loadError || "This link is incomplete or has expired. Open the link from your most recent email from us, or reply to that email and we'll send a fresh one."}</p>;
  }
  if (!overview) return <p role="status" className="mt-6 text-sm text-ink/60">Loading your bookings…</p>;

  const live = overview.bookings.filter(b => ["held", "payment_pending", "paid", "confirmed", "manual_review"].includes(b.state));
  const pending = done ?? overview.pendingRequest;
  const openDays = overview.days.filter(d => !d.past && !d.booked && !d.uninsured && d.available);

  return (
    <div className="mt-8 space-y-8">
      <section className="rounded-2xl border border-pine/15 bg-parchment/50 p-5">
        <h2 className="font-semibold text-pine-deep">{overview.businessName || "Your bookings"}</h2>
        {live.length === 0 && <p className="mt-2 text-sm text-ink/65">No dates booked yet this season.</p>}
        <ul className="mt-3 space-y-2 text-sm text-pine-deep">
          {overview.bookings.filter(b => b.state !== "cancelled" && b.state !== "declined").map(b => (
            <li key={b.id} className="rounded-xl bg-white/70 p-3">
              <span className="font-semibold">{STATE_LABEL[b.state] ?? b.state}</span> · {b.booths} booth{b.booths === 1 ? "" : "s"} · {money(b.totalCents)}
              <div className="mt-1 text-ink/70">{b.dates.map(reservationDateLabel).join(" · ")}</div>
            </li>
          ))}
        </ul>
        {overview.insuranceExpiresOn && <p className="mt-3 text-xs text-ink/60">Your certificate of insurance on file expires {reservationDateLabel(overview.insuranceExpiresOn)}. Saturdays after that open up once you send us a renewed certificate.</p>}
      </section>

      {pending && (
        <section role="status" className="rounded-2xl bg-pine/10 p-5 text-sm text-pine">
          <h2 className="font-semibold text-pine-deep">{done ? "Request sent" : "Request waiting for market staff"}</h2>
          <p className="mt-2">You asked for {pending.booths} booth{pending.booths === 1 ? "" : "s"} on {pending.dates.map(reservationDateLabel).join(", ")}. Staff will confirm and email your payment link, usually within a day or two. Once confirmed, your dates are held for 48 hours; they&rsquo;re released if the payment link isn&rsquo;t used in time.</p>
        </section>
      )}

      {!pending && !overview.eligible && (
        <p role="alert" className="rounded-2xl bg-amber/15 p-4 text-sm text-clay">Your application isn&rsquo;t ready for more dates yet (for example, your insurance certificate may need approval). Reply to one of our emails or call (941) 740-8866 and we&rsquo;ll sort it out.</p>
      )}

      {!pending && overview.eligible && (
        <section className="rounded-2xl border border-pine/15 p-5">
          <h2 className="font-semibold text-pine-deep">Choose your Saturdays</h2>
          <p className="mt-1 text-sm text-ink/65">{RATE_NOTE} You&rsquo;ll get a payment link once staff confirm.</p>
          <label className="mt-4 block text-sm font-semibold text-pine-deep">Booths per Saturday
            <select value={booths} onChange={e => setBooths(e.target.value)} disabled={busy} className="mt-1 w-full max-w-xs rounded-xl border border-pine/20 bg-white px-3 py-3 text-sm font-normal text-ink">
              {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {overview.days.filter(d => !d.past).map(day => {
              const blocked = day.booked || day.uninsured || !day.available;
              const why = day.booked ? "already booked" : day.uninsured ? "after your insurance expires" : !day.available ? "full" : "";
              return (
                <label key={day.date} className={`flex items-center gap-2 rounded-lg px-2 py-2 text-sm ${blocked ? "text-ink/40" : "text-pine-deep hover:bg-parchment/60"}`}>
                  <input type="checkbox" disabled={blocked || busy} checked={selected.includes(day.date)} onChange={e => setSelected(current => e.target.checked ? [...current, day.date].sort() : current.filter(d => d !== day.date))} />
                  {reservationDateLabel(day.date)}{why ? ` (${why})` : ""}
                </label>
              );
            })}
          </div>
          {openDays.length === 0 && <p className="mt-3 text-sm text-ink/65">No open Saturdays right now.</p>}
          <p className="mt-3 text-xs font-semibold text-pine">{selected.length} Saturday{selected.length === 1 ? "" : "s"} selected</p>
          <label className="mt-4 block text-sm font-semibold text-pine-deep">Anything staff should know? (optional)
            <textarea value={note} onChange={e => setNote(e.target.value)} disabled={busy} maxLength={1000} rows={2} className="mt-1 w-full rounded-xl border border-pine/20 bg-white px-3 py-3 text-sm font-normal text-ink" />
          </label>
          <button type="button" disabled={busy || !selected.length} onClick={() => void submit()} className="mt-5 rounded-full bg-pine px-6 py-3 text-sm font-semibold text-cream enabled:hover:bg-leaf disabled:cursor-not-allowed disabled:opacity-45">{busy ? "Sending…" : "Send my date request"}</button>
          {error && <p role="alert" className="mt-4 rounded-2xl bg-clay/10 p-4 text-sm text-clay">{error}</p>}
        </section>
      )}
    </div>
  );
}
