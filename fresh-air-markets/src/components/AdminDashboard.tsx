"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import MarketMap from "./MarketMap";
import { Booking, BoothWithAvailability, BoothStatus, PublicAccount } from "@/lib/types";
import type { MarketWeekend } from "@/lib/dates";
import { prettyDate } from "@/lib/dates";
import { trialDaysLeft } from "@/lib/plans";
import { LogoMark } from "./Logo";

interface AdminDashboardProps {
  weekends: MarketWeekend[];
  demoMode: boolean;
  account: PublicAccount;
}

export default function AdminDashboard({ weekends, demoMode, account }: AdminDashboardProps) {
  const router = useRouter();
  const allDates = useMemo(() => weekends.flatMap((w) => w.dates.map((d) => d.date)), [weekends]);
  const [booths, setBooths] = useState<BoothWithAvailability[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [viewedWeekend, setViewedWeekend] = useState(weekends[0]?.key ?? "");
  const [selectedBooth, setSelectedBooth] = useState<BoothWithAvailability | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const flash = (kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 5000);
  };

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/admin/overview?dates=${allDates.join(",")}`);
    if (res.status === 401) {
      router.push("/login");
      return;
    }
    const data = await res.json();
    setBooths(data.booths ?? []);
    setBookings(data.bookings ?? []);
  }, [allDates, router]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const weekend = weekends.find((w) => w.key === viewedWeekend) ?? weekends[0];
  const weekendDays = useMemo(() => weekend?.dates.map((d) => d.date) ?? [], [weekend]);

  const statusFor = useCallback(
    (booth: BoothWithAvailability): BoothStatus => {
      const taken = booth.bookedDates.filter((d) => weekendDays.includes(d));
      if (taken.length === 0) return "available";
      return taken.length >= weekendDays.length ? "rented" : "partial";
    },
    [weekendDays],
  );

  // Scope occupant labels on the map to the viewed weekend.
  const boothsForMap = useMemo(
    () =>
      booths.map((b) => ({
        ...b,
        occupants: b.occupants?.filter((o) => weekendDays.includes(o.date)),
      })),
    [booths, weekendDays],
  );

  const pending = bookings.filter((b) => b.status === "pending");
  const approved = bookings.filter((b) => b.status === "approved");
  const weekendApproved = approved.filter((b) => b.dates.some((d) => weekendDays.includes(d)));
  const revenue = approved.reduce((sum, b) => sum + b.totalPrice, 0);
  const occupancy = booths.length
    ? Math.round((booths.filter((b) => statusFor(b) !== "available").length / booths.length) * 100)
    : 0;

  const boothLabel = (id: string) => booths.find((b) => b.id === id)?.label ?? id;

  const act = async (bookingId: string, action: "approve" | "reject" | "cancel") => {
    setBusyId(bookingId);
    try {
      const res = await fetch(`/api/admin/bookings/${bookingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        flash("err", data.error ?? "Action failed.");
      } else {
        flash("ok", action === "approve" ? "Booking approval saved." : `Booking ${action}ed.`);
      }
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const moveBooth = async (id: string, x: number, y: number) => {
    setBooths((bs) => bs.map((b) => (b.id === id ? { ...b, x, y } : b)));
    await fetch(`/api/admin/booths/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y }),
    });
  };

  const updateBooth = async (id: string, patch: Record<string, unknown>) => {
    const res = await fetch(`/api/admin/booths/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const { booth } = await res.json();
      setBooths((bs) => bs.map((b) => (b.id === id ? { ...b, ...booth } : b)));
      setSelectedBooth((s) => (s?.id === id ? { ...s, ...booth } : s));
      flash("ok", `Booth ${booth.label} updated.`);
    }
  };

  const addBooth = async () => {
    const res = await fetch("/api/admin/booths", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: `N${booths.length + 1}` }),
    });
    if (res.ok) {
      await refresh();
      flash("ok", "Booth added — drag it into place.");
    }
  };

  const removeBooth = async (id: string) => {
    if (!confirm(`Remove booth ${boothLabel(id)} from the map?`)) return;
    await fetch(`/api/admin/booths/${id}`, { method: "DELETE" });
    setSelectedBooth(null);
    await refresh();
  };

  const logout = async () => {
    await fetch("/api/auth/login", { method: "DELETE" });
    router.push("/login");
  };

  const daysLeft = trialDaysLeft(account.trialEndsAt);
  const publicUrl = `/m/${account.slug}`;

  return (
    <main className="min-h-screen bg-parchment/50 pb-16">
      {/* ── Top bar ─────────────────────────────────────── */}
      <header className="sticky top-0 z-20 border-b border-pine/10 bg-cream/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-3">
            <LogoMark size={28} />
            <div>
              <h1 className="font-display text-xl leading-none text-pine-deep">{account.marketName}</h1>
              <p className="text-xs text-ink/50">
                {account.plan[0].toUpperCase() + account.plan.slice(1)} plan · License {account.licenseKey}
              </p>
            </div>
            {account.licenseStatus === "trial" && (
              <span className="rounded-full bg-amber/15 px-3 py-1 text-xs font-semibold text-clay">
                Trial · {daysLeft} day{daysLeft === 1 ? "" : "s"} left
              </span>
            )}
            {demoMode && (
              <span className="rounded-full bg-amber/15 px-3 py-1 text-xs font-semibold text-clay">
                DEMO MODE — data resets; attach a database to persist
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <a href="/applications" className="rounded-full px-4 py-2 text-sm font-semibold text-pine hover:bg-pine/10">Review applications</a>
            <a
              href={publicUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full px-4 py-2 text-sm font-semibold text-pine hover:bg-pine/10"
            >
              View public site ↗
            </a>
            <button onClick={logout} className="rounded-full bg-pine px-4 py-2 text-sm font-semibold text-cream hover:bg-leaf">
              Sign out
            </button>
          </div>
        </div>
      </header>

      {notice && (
        <div
          className={`fixed left-1/2 top-20 z-30 -translate-x-1/2 rounded-full px-6 py-3 text-sm font-semibold shadow-xl ${
            notice.kind === "ok" ? "bg-pine text-cream" : "bg-clay text-white"
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="mx-auto max-w-7xl px-6">
        {/* ── Share link ────────────────────────────────── */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-pine-deep px-5 py-3.5 text-cream">
          <p className="text-sm">
            Your vendor booking page:{" "}
            <span className="font-semibold text-amber-soft">freshairmarkets.app{publicUrl}</span>
          </p>
          <button
            onClick={() => {
              navigator.clipboard.writeText(`${window.location.origin}${publicUrl}`);
              flash("ok", "Link copied — share it with vendors.");
            }}
            className="rounded-full bg-white/10 px-4 py-1.5 text-xs font-semibold transition hover:bg-white/20"
          >
            Copy link
          </button>
        </div>

        {/* ── Stats ─────────────────────────────────────── */}
        <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Pending inquiries" value={String(pending.length)} accent={pending.length > 0} />
          <Stat label={`Vendors · ${weekend?.label ?? ""}`} value={String(weekendApproved.length)} />
          <Stat label={`Occupancy · ${weekend?.label ?? ""}`} value={`${occupancy}%`} />
          <Stat label="Booked revenue (all dates)" value={`$${revenue.toLocaleString()}`} />
        </div>

        {/* ── Weekend selector ──────────────────────────── */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-semibold text-ink/60">
            Viewing market date
            <select
              value={viewedWeekend}
              onChange={(event) => setViewedWeekend(event.target.value)}
              disabled={weekends.length === 0}
              className="rounded-xl bg-white px-4 py-2 text-pine ring-1 ring-pine/15"
            >
              {weekends.length === 0 && <option value="">No configured market dates</option>}
              {weekends.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
            </select>
          </label>
        </div>

        <div className="mt-6 grid gap-8 xl:grid-cols-[1fr_400px]">
          {/* ── Map editor ──────────────────────────────── */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="font-display text-2xl text-pine-deep">Map editor</h2>
                <p className="text-sm text-ink/60">
                  Drag booths to rearrange the market. Click a booth to edit price and label.
                </p>
              </div>
              <button
                onClick={addBooth}
                className="rounded-full bg-amber px-5 py-2.5 text-sm font-semibold text-white shadow transition hover:bg-clay"
              >
                + Add booth
              </button>
            </div>
            <MarketMap
              booths={boothsForMap}
              statusFor={statusFor}
              selectedId={selectedBooth?.id}
              onSelect={(b) => setSelectedBooth(b)}
              draggable
              onMove={moveBooth}
              showOccupants
            />

            {selectedBooth && (
              <BoothEditor
                key={selectedBooth.id}
                booth={selectedBooth}
                onSave={(patch) => updateBooth(selectedBooth.id, patch)}
                onDelete={() => removeBooth(selectedBooth.id)}
                onClose={() => setSelectedBooth(null)}
              />
            )}
          </section>

          {/* ── Verification board ──────────────────────── */}
          <section>
            <h2 className="font-display text-2xl text-pine-deep">Verification board</h2>
            <p className="text-sm text-ink/60">
              Approve or decline vendor inquiries. Approval locks the booth — double bookings are
              blocked automatically.
            </p>

            <div className="mt-4 space-y-3">
              {pending.length === 0 && (
                <div className="rounded-2xl border-2 border-dashed border-pine/15 bg-white/60 p-6 text-center text-sm text-ink/50">
                  No pending inquiries. New form submissions land here.
                </div>
              )}
              {pending.map((b) => (
                <article key={b.id} className="animate-rise rounded-2xl bg-white p-5 shadow-sm ring-1 ring-pine/10">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-pine-deep">{b.vendor.businessName}</h3>
                      <p className="text-sm text-ink/60">
                        {b.vendor.name} · {b.vendor.category}
                      </p>
                    </div>
                    <span className="rounded-full bg-amber/15 px-3 py-1 text-xs font-bold text-clay">
                      Booth {boothLabel(b.boothId)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-ink/70">
                    {b.dates.map(prettyDate).join(" · ")}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-pine">${b.totalPrice.toLocaleString()} total</p>
                  {b.message && <p className="mt-2 rounded-xl bg-parchment/70 p-3 text-sm italic text-ink/70">“{b.message}”</p>}
                  <p className="mt-2 text-xs text-ink/45">
                    {b.vendor.email}
                    {b.vendor.phone ? ` · ${b.vendor.phone}` : ""}
                  </p>
                  <div className="mt-4 flex gap-2">
                    <button
                      onClick={() => act(b.id, "approve")}
                      disabled={busyId === b.id}
                      className="flex-1 rounded-xl bg-pine py-2.5 text-sm font-semibold text-cream transition enabled:hover:bg-leaf disabled:opacity-50"
                    >
                      {busyId === b.id ? "…" : "Approve"}
                    </button>
                    <button
                      onClick={() => act(b.id, "reject")}
                      disabled={busyId === b.id}
                      className="flex-1 rounded-xl bg-white py-2.5 text-sm font-semibold text-clay ring-1 ring-clay/30 transition enabled:hover:bg-clay/10 disabled:opacity-50"
                    >
                      Decline
                    </button>
                  </div>
                </article>
              ))}
            </div>

            {/* ── Roster ─────────────────────────────────── */}
            <h2 className="mt-8 font-display text-2xl text-pine-deep">Vendor roster</h2>
            <div className="mt-3 space-y-2">
              {approved.length === 0 && (
                <p className="text-sm text-ink/50">No approved vendors yet.</p>
              )}
              {approved.map((b) => (
                <div key={b.id} className="flex items-center justify-between gap-3 rounded-xl bg-white px-4 py-3 text-sm shadow-sm ring-1 ring-pine/10">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-pine-deep">
                      {b.vendor.businessName}
                      <span className="ml-2 font-normal text-ink/50">{b.vendor.category}</span>
                    </p>
                    <p className="truncate text-xs text-ink/50">
                      Booth {boothLabel(b.boothId)} · {b.dates.length} day{b.dates.length === 1 ? "" : "s"} · ${b.totalPrice.toLocaleString()}
                    </p>
                  </div>
                  <button
                    onClick={() => act(b.id, "cancel")}
                    disabled={busyId === b.id}
                    className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-ink/50 ring-1 ring-ink/15 transition hover:text-clay hover:ring-clay/40"
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl p-4 shadow-sm ring-1 ${accent ? "bg-amber/10 ring-amber/30" : "bg-white ring-pine/10"}`}>
      <p className="text-xs font-semibold uppercase tracking-wider text-ink/50">{label}</p>
      <p className={`mt-1 font-display text-3xl ${accent ? "text-clay" : "text-pine-deep"}`}>{value}</p>
    </div>
  );
}

function BoothEditor({
  booth,
  onSave,
  onDelete,
  onClose,
}: {
  booth: BoothWithAvailability;
  onSave: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(booth.label);
  const [zone, setZone] = useState(booth.zone);
  const [price, setPrice] = useState(String(booth.pricePerDay));

  const field =
    "w-full rounded-xl border border-pine/20 bg-white px-3 py-2 text-sm outline-none focus:border-amber focus:ring-2 focus:ring-amber/30";

  return (
    <div className="animate-rise mt-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-pine/10">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-xl text-pine-deep">Edit booth {booth.label}</h3>
        <button onClick={onClose} className="rounded-full p-1.5 text-ink/40 hover:bg-parchment hover:text-ink">✕</button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <label className="text-xs font-semibold text-ink/60">
          Label
          <input className={`${field} mt-1`} value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="text-xs font-semibold text-ink/60">
          Zone
          <input className={`${field} mt-1`} value={zone} onChange={(e) => setZone(e.target.value)} />
        </label>
        <label className="text-xs font-semibold text-ink/60">
          $ / day
          <input className={`${field} mt-1`} type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
      </div>
      <div className="mt-4 flex gap-2">
        <button
          onClick={() => onSave({ label, zone, pricePerDay: Number(price) })}
          className="rounded-xl bg-pine px-5 py-2 text-sm font-semibold text-cream hover:bg-leaf"
        >
          Save
        </button>
        <button
          onClick={onDelete}
          className="rounded-xl px-4 py-2 text-sm font-semibold text-clay ring-1 ring-clay/30 hover:bg-clay/10"
        >
          Remove booth
        </button>
      </div>
    </div>
  );
}
