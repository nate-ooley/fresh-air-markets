"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { canOpenVendorCheckout, invitationFromFragment, parseVendorPaymentView, type VendorPaymentView } from "@/lib/vendor-payment-view";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const marketDate = (date: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const deadline = (date: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }).format(new Date(date));

export default function VendorPaymentPanel() {
  const invitation = useRef<string | null>(null);
  const initialized = useRef(false);
  const actionLock = useRef(false);
  const loadLock = useRef(false);
  const returnedRef = useRef(false);
  const [hasInvitation, setHasInvitation] = useState(false);
  const [reservation, setReservation] = useState<VendorPaymentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [returned, setReturned] = useState(false);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    if (loadLock.current || invitation.current) return;
    loadLock.current = true;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/vendor/payment", { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => null);
      const record = parseVendorPaymentView(data?.reservation);
      if (!response.ok || !record) {
        setReservation(null);
        setError(response.status === 401
          ? (returnedRef.current
            ? "Thanks for visiting Square. If your payment went through, a confirmation email is on its way. To see your reservation status here, open the private link from your payment email on this device."
            : "Open the private reservation link provided by the market. If you already used it on another device, ask the market for a new link.")
          : "Your reservation is temporarily unavailable. Please try again before making another payment.");
        return;
      }
      setReservation(record);
      setNow(Date.now());
    } catch {
      setReservation(null);
      setError("We could not check your reservation. Check your connection and try again.");
    } finally { loadLock.current = false; setLoading(false); }
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    invitation.current = invitationFromFragment(window.location.hash);
    const hadFragment = Boolean(window.location.hash);
    returnedRef.current = new URLSearchParams(window.location.search).get("returned") === "1";
    setReturned(returnedRef.current);
    // Clear bearer material before any fetch, navigation, or external checkout.
    window.history.replaceState(null, "", window.location.pathname);
    if (invitation.current) {
      setHasInvitation(true);
      setLoading(false);
    } else if (hadFragment) {
      setLoading(false);
      setError("This private link is incomplete. Please ask the market for a new link.");
    } else void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function openInvitation() {
    if (!invitation.current || actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/vendor/access", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: invitation.current }),
      });
      if (!response.ok) {
        if (response.status === 401) {
          invitation.current = null;
          setHasInvitation(false);
          setError("This link has expired, was replaced, or was already used. Please ask the market for a new private link.");
        } else setError("We could not open your reservation. Please try again.");
        return;
      }
      invitation.current = null;
      setHasInvitation(false);
      await load();
    } catch {
      setError("The connection was interrupted. Try opening this link again. If it was already used, ask the market for a new private link.");
    } finally { actionLock.current = false; setBusy(false); }
  }

  async function signOut() {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/vendor/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("Unavailable");
      setReservation(null);
      setError("You have signed out. Ask the market for a new private link when you need to return.");
    } catch { setError("We could not sign you out. Please try again."); }
    finally { actionLock.current = false; setBusy(false); }
  }

  const payable = reservation && canOpenVendorCheckout(reservation, now);
  const expired = reservation && (reservation.status === "expired" || (reservation.status === "pending" && reservation.paymentDueAt !== null && Date.parse(reservation.paymentDueAt) <= now));
  return (
    <main className="min-h-screen bg-cream px-5 py-8 sm:py-14">
      <div className="mx-auto max-w-2xl">
        <a href="https://freshairmarketsandevents.com" className="font-display text-2xl text-pine-deep">Fresh Air Markets &amp; Events</a>
        <section className="mt-7 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-pine/10 sm:p-10">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-leaf">Vendor reservation</p>
          <h1 className="mt-3 font-display text-4xl text-pine-deep">Your place at the market</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink/60">Review your approved market dates and reservation payment below.</p>

          {loading && <p role="status" className="mt-7 text-sm text-ink/60">Checking your reservation…</p>}
          {hasInvitation && <div className="mt-7 rounded-2xl bg-parchment p-5">
            <p className="text-sm text-pine">Open your private reservation on this device. Keep your link private.</p>
            <button onClick={() => void openInvitation()} disabled={busy} className="mt-4 rounded-full bg-pine px-6 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Opening…" : "Open my reservation"}</button>
          </div>}
          {error && <p role="alert" className="mt-6 rounded-2xl bg-clay/10 p-4 text-sm text-clay">{error}</p>}

          {!loading && reservation && <>
            {reservation.environment === "sandbox" && <p className="mt-6 rounded-2xl bg-amber/15 p-4 text-sm font-semibold text-clay">Test payment — this reservation uses Square Sandbox.</p>}
            {(reservation.status === "paid" || reservation.status === "confirmed") && <div role="status" className="mt-6 rounded-2xl bg-pine p-5 text-cream">
              <h2 className="font-display text-2xl">{reservation.status === "paid" ? "Payment received" : "Reservation confirmed"}</h2>
              <p className="mt-2 text-sm">{reservation.status === "paid" ? "Your payment has been confirmed and your market dates are reserved." : "No payment is required for this reservation."}</p>
            </div>}
            {expired && <p role="status" className="mt-6 rounded-2xl bg-clay/10 p-4 text-sm text-clay">Your payment window has ended. Contact the market to review availability before paying.</p>}
            {reservation.status === "unavailable" && <p role="status" className="mt-6 rounded-2xl bg-clay/10 p-4 text-sm text-clay">This reservation needs the market team’s attention. Payment is unavailable.</p>}
            {returned && reservation.status === "pending" && !expired && <p role="status" className="mt-6 rounded-2xl bg-parchment p-4 text-sm text-pine">We’re checking for Square’s payment confirmation. Returning from checkout does not confirm payment. Refresh your reservation before trying to pay again.</p>}
            <dl className="mt-7 grid grid-cols-2 gap-5 text-sm">
              <div><dt className="text-ink/55">Market dates</dt><dd className="mt-1 font-semibold text-pine">{reservation.dates.length}</dd></div>
              <div><dt className="text-ink/55">Booths per date</dt><dd className="mt-1 font-semibold text-pine">{reservation.boothsPerMarket}</dd></div>
              <div><dt className="text-ink/55">Per booth, per date</dt><dd className="mt-1 font-semibold text-pine">{money(reservation.rateCents)}</dd></div>
              <div><dt className="text-ink/55">Reservation total</dt><dd className="mt-1 text-xl font-bold text-pine">{money(reservation.totalCents)}</dd></div>
            </dl>
            <details className="mt-6 rounded-2xl border border-pine/15 p-4" open={reservation.dates.length < 5}>
              <summary className="cursor-pointer text-sm font-semibold text-pine">Your approved dates</summary>
              <ul className="mt-3 grid gap-2 text-sm text-ink/65 sm:grid-cols-2">{reservation.dates.map(date => <li key={date}>{marketDate(date)}</li>)}</ul>
            </details>
            {payable && <div className="mt-7 border-t border-pine/10 pt-6">
              <p className="text-sm text-pine">Payment due <strong>{deadline(reservation.paymentDueAt!)}</strong> (Eastern time).</p>
              <p className="mt-2 text-xs leading-relaxed text-ink/60">Your reservation has a 48-hour payment window. Square securely handles your payment details.</p>
              <a href={reservation.checkoutUrl!} rel="noreferrer" className="mt-5 block rounded-full bg-amber px-6 py-4 text-center font-bold text-white hover:bg-clay">Continue to Square · {money(reservation.totalCents)}</a>
            </div>}
          </>}
          {!loading && !hasInvitation && <div className="mt-7 flex flex-wrap items-center gap-4 border-t border-pine/10 pt-5">
            <button onClick={() => void load()} disabled={busy} className="text-sm font-semibold text-pine underline underline-offset-4 disabled:opacity-50">Refresh reservation</button>
            {reservation && <button onClick={() => void signOut()} disabled={busy} className="text-sm text-ink/55 underline underline-offset-4 disabled:opacity-50">Sign out</button>}
          </div>}
        </section>
        <p className="mt-6 text-center text-xs text-ink/50">North Port Farmer’s Market · Fresh Air Markets &amp; Events</p>
      </div>
    </main>
  );
}
