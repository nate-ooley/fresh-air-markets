"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Vendor { reservationId: string; applicationId: string; businessName: string; vendorName: string; email: string; phone: string; applicantType: string; category: string; booths: number; status: "paid" | "confirmed" | "pending"; paymentDueAt: string | null }
interface Group { category: string; vendors: Vendor[]; booths: number }
interface Roster {
  date: string; dates: string[]; capacity: number;
  day: { confirmed: Group[]; pending: Group[]; totals: { confirmedVendors: number; confirmedBooths: number; pendingVendors: number; pendingBooths: number } };
  season: { date: string; confirmedVendors: number; confirmedBooths: number; pendingBooths: number; capacity: number; openBooths: number }[];
}

const long = (date: string) => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const short = (date: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const due = (iso: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }).format(new Date(iso));

function GroupTable({ groups, pending }: { groups: Group[]; pending: boolean }) {
  if (groups.length === 0) return <p className="mt-3 text-sm text-ink/60">{pending ? "Nobody is waiting on payment for this date." : "No confirmed vendors for this date yet."}</p>;
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-ink/50">
          <tr><th className="py-2 pr-4">Business</th><th className="py-2 pr-4">Contact</th><th className="py-2 pr-4 text-right">Booths</th><th className="py-2">{pending ? "Payment due" : "Status"}</th></tr>
        </thead>
        {groups.map(group => (
          <tbody key={group.category} className="border-t border-pine/10">
            <tr className="bg-parchment/60"><td colSpan={2} className="py-2 pr-4 font-semibold text-pine-deep">{group.category}</td><td className="py-2 pr-4 text-right font-semibold text-pine-deep">{group.booths}</td><td className="py-2 text-xs text-ink/50">{group.vendors.length} vendor{group.vendors.length === 1 ? "" : "s"}</td></tr>
            {group.vendors.map(v => (
              <tr key={v.reservationId} className="border-t border-pine/5">
                <td className="py-2 pr-4"><a href={`/applications/${encodeURIComponent(v.applicationId)}`} className="font-medium text-pine underline-offset-4 hover:underline">{v.businessName}</a>{v.applicantType === "Non-Profit Organization" && <span className="ml-2 rounded-full bg-sky/10 px-2 py-0.5 text-xs text-navy">Non-profit</span>}</td>
                <td className="py-2 pr-4 text-ink/70">{v.vendorName}{v.email && <span className="block text-xs text-ink/50">{v.email}{v.phone ? ` · ${v.phone}` : ""}</span>}</td>
                <td className="py-2 pr-4 text-right">{v.booths}</td>
                <td className="py-2 text-xs">{pending ? (v.paymentDueAt ? due(v.paymentDueAt) : "—") : v.status === "paid" ? <span className="rounded-full bg-pine/10 px-2 py-0.5 font-semibold text-pine">Paid</span> : <span className="rounded-full bg-parchment px-2 py-0.5 text-pine">No payment due</span>}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

export default function RosterPanel() {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (selected: string | null) => {
    setLoading(true); setError("");
    try {
      const res = await fetch(`/api/admin/roster${selected ? `?date=${encodeURIComponent(selected)}` : ""}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? "The roster is unavailable."); return; }
      setRoster(data); setDate(data.date);
    } catch { setError("The roster is unavailable."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(null); }, [load]);

  return (
    <main className="min-h-screen bg-parchment/50 pb-16">
      <header className="border-b border-pine/10 bg-cream/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-leaf">Market staff</p>
            <h1 className="font-display text-2xl text-pine-deep">Market roster</h1>
          </div>
          <nav className="flex items-center gap-4 text-sm font-semibold text-pine">
            <Link href="/applications" className="hover:underline">Applications</Link>
            <Link href="/messages" className="hover:underline">Messages</Link>
            <Link href="/staff" className="hover:underline">Staff</Link>
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-6 py-8">
        {error && <p role="alert" className="mb-6 rounded-2xl bg-clay/10 p-4 text-sm text-clay">{error}</p>}
        {roster && (
          <>
            <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-pine/10">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">Market date
                  <select value={date ?? ""} onChange={e => void load(e.target.value)} className="mt-1 block rounded-xl border border-pine/20 bg-white px-4 py-2 text-base font-normal normal-case tracking-normal text-ink">
                    {roster.dates.map(d => <option key={d} value={d}>{long(d)}</option>)}
                  </select>
                </label>
                <a href={`/api/admin/roster?date=${encodeURIComponent(roster.date)}&format=csv`} className="rounded-full bg-pine px-5 py-2 text-sm font-semibold text-cream hover:bg-leaf">Download spreadsheet</a>
              </div>
              <dl className="mt-6 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <div><dt className="text-ink/55">Confirmed vendors</dt><dd className="mt-1 text-2xl font-bold text-pine">{roster.day.totals.confirmedVendors}</dd></div>
                <div><dt className="text-ink/55">Confirmed booths</dt><dd className="mt-1 text-2xl font-bold text-pine">{roster.day.totals.confirmedBooths} <span className="text-sm font-normal text-ink/50">of {roster.capacity}</span></dd></div>
                <div><dt className="text-ink/55">Pending vendors</dt><dd className="mt-1 text-2xl font-bold text-clay">{roster.day.totals.pendingVendors}</dd></div>
                <div><dt className="text-ink/55">Pending booths</dt><dd className="mt-1 text-2xl font-bold text-clay">{roster.day.totals.pendingBooths}</dd></div>
              </dl>
              {loading && <p role="status" className="mt-4 text-sm text-ink/60">Updating…</p>}
            </section>
            <section className="mt-6 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-pine/10">
              <h2 className="font-semibold text-pine-deep">Confirmed for {long(roster.date)}</h2>
              <p className="mt-1 text-xs text-ink/55">Paid reservations and non-profits with no payment due, grouped by category.</p>
              <GroupTable groups={roster.day.confirmed} pending={false} />
            </section>
            <section className="mt-6 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-pine/10">
              <h2 className="font-semibold text-pine-deep">Waiting on payment</h2>
              <p className="mt-1 text-xs text-ink/55">Reservations for this date whose payment link has not been paid. Unpaid holds are released after the due time.</p>
              <GroupTable groups={roster.day.pending} pending />
            </section>
            <section className="mt-6 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-pine/10">
              <h2 className="font-semibold text-pine-deep">Season at a glance</h2>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-ink/50"><tr><th className="py-2 pr-4">Date</th><th className="py-2 pr-4 text-right">Vendors</th><th className="py-2 pr-4 text-right">Booths confirmed</th><th className="py-2 pr-4 text-right">Pending</th><th className="py-2 text-right">Open</th></tr></thead>
                  <tbody>
                    {roster.season.map(day => (
                      <tr key={day.date} className={`border-t border-pine/10 ${day.date === roster.date ? "bg-parchment/60" : ""}`}>
                        <td className="py-2 pr-4"><button type="button" onClick={() => void load(day.date)} className="font-medium text-pine underline-offset-4 hover:underline">{short(day.date)}</button></td>
                        <td className="py-2 pr-4 text-right">{day.confirmedVendors}</td>
                        <td className="py-2 pr-4 text-right">{day.confirmedBooths} / {day.capacity}</td>
                        <td className="py-2 pr-4 text-right text-clay">{day.pendingBooths}</td>
                        <td className="py-2 text-right">{day.openBooths}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
        {!roster && !error && <p role="status" className="text-sm text-ink/60">Loading the roster…</p>}
      </div>
    </main>
  );
}
