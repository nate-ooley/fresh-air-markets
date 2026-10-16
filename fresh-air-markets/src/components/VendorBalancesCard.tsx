"use client";

import { useEffect, useState } from "react";

interface Row { applicationId: string; business: string; chargedCents: number; paidCents: number; owedCents: number; creditAvailableCents: number }
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/** Staff: every vendor's rolling balance across their bookings, largest balance first. */
export default function VendorBalancesCard() {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/admin/balances", { cache: "no-store", headers: { Accept: "application/json" } })
      .then(response => response.ok ? response.json() : null)
      .then(payload => { if (live && Array.isArray(payload?.balances)) setRows(payload.balances); })
      .catch(() => { /* the roster still works without this card */ });
    return () => { live = false; };
  }, []);
  if (!rows) return null;
  const owed = rows.reduce((sum, row) => sum + Math.max(0, row.owedCents), 0);
  const paid = rows.reduce((sum, row) => sum + row.paidCents, 0);
  return (
    <section className="mt-6 rounded-2xl border border-pine/15 bg-white p-5">
      <h2 className="font-display text-xl text-pine-deep">Vendor balances</h2>
      <p className="mt-1 text-sm text-ink/65">{money(paid)} collected, {money(owed)} still owed. Each balance counts every booking, discount, credit and payment; open a vendor to see the full list.</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink/50"><tr><th className="py-2 pr-4">Vendor</th><th className="py-2 pr-4 text-right">Booked</th><th className="py-2 pr-4 text-right">Paid</th><th className="py-2 text-right">Balance</th></tr></thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.applicationId} className="border-t border-pine/10">
                <td className="py-2 pr-4"><a href={`/applications/${encodeURIComponent(row.applicationId)}`} className="font-medium text-pine underline-offset-4 hover:underline">{row.business || "(name unavailable)"}</a></td>
                <td className="py-2 pr-4 text-right">{money(row.chargedCents)}</td>
                <td className="py-2 pr-4 text-right">{money(row.paidCents)}</td>
                <td className={`py-2 text-right font-semibold ${row.owedCents > 0 ? "text-clay" : "text-pine"}`}>{row.owedCents >= 0 ? money(row.owedCents) : `${money(-row.owedCents)} credit`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
