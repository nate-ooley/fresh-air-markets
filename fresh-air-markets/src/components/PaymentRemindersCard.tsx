"use client";

import { useCallback, useEffect, useState } from "react";

interface Unpaid { reservationId: string; business: string; state: string; totalCents: number }
interface Result { reservationId: string; business: string; totalCents: number; outcome: "sent" | "skipped" | "failed"; detail: string }

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const STATE: Record<string, string> = { held: "reserved, no payment link yet", payment_pending: "payment link sent, not paid", expired: "earlier payment window lapsed" };

/** Staff: see who still owes and email all of them a payment reminder in one click. */
export default function PaymentRemindersCard() {
  const [unpaid, setUnpaid] = useState<Unpaid[] | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/payments/reminders", { cache: "no-store", headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => null);
      if (response.ok && Array.isArray(payload?.unpaid)) setUnpaid(payload.unpaid);
    } catch { /* the roster still works without this card */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const send = async () => {
    if (busy || !unpaid?.length) return;
    if (!window.confirm(`Email a payment reminder to ${unpaid.length} vendor${unpaid.length === 1 ? "" : "s"}? Each gets a fresh private payment link; earlier links for that booking stop working.`)) return;
    setBusy(true); setError(""); setResults(null);
    try {
      const response = await fetch("/api/admin/payments/reminders", { method: "POST", headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(payload?.results)) { setError(typeof payload?.error === "string" ? payload.error : "The reminders could not be sent."); return; }
      setResults(payload.results);
      await load();
    } catch { setError("The reminders could not be sent. Check your connection and try again."); }
    finally { setBusy(false); }
  };

  if (!unpaid) return null;
  return (
    <section className="mt-6 rounded-2xl border border-pine/15 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-pine-deep">Waiting on payment</h2>
          <p className="mt-1 text-sm text-ink/65">{unpaid.length ? `${unpaid.length} vendor${unpaid.length === 1 ? "" : "s"}, ${money(unpaid.reduce((sum, row) => sum + row.totalCents, 0))} outstanding. Payment links stay open until the vendor pays or you withdraw the booking.` : "Everyone with a booking has paid."}</p>
        </div>
        {unpaid.length > 0 && <button type="button" disabled={busy} onClick={() => void send()} className="rounded-full bg-pine px-5 py-2 text-sm font-semibold text-cream enabled:hover:bg-leaf disabled:opacity-45">{busy ? "Sending…" : "Email payment reminders"}</button>}
      </div>
      {unpaid.length > 0 && !results && (
        <ul className="mt-4 divide-y divide-pine/10 text-sm">
          {unpaid.map(row => <li key={row.reservationId} className="flex flex-wrap justify-between gap-2 py-2"><span className="font-semibold text-pine-deep">{row.business || "(name unavailable)"}</span><span className="text-ink/65">{money(row.totalCents)} · {STATE[row.state] ?? row.state}</span></li>)}
        </ul>
      )}
      {results && (
        <ul role="status" className="mt-4 divide-y divide-pine/10 text-sm">
          {results.map(row => <li key={row.reservationId} className="flex flex-wrap justify-between gap-2 py-2"><span className="font-semibold text-pine-deep">{row.business || "(name unavailable)"} · {money(row.totalCents)}</span><span className={row.outcome === "sent" ? "text-pine" : "text-clay"}>{row.detail}</span></li>)}
        </ul>
      )}
      {error && <p role="alert" className="mt-4 rounded-xl bg-clay/10 p-3 text-sm text-clay">{error}</p>}
    </section>
  );
}
