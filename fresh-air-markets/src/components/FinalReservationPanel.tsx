"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FRESH_AIR_SEASON_DATES } from "@/lib/fresh-air-season";
import { FAME_VENDOR_CATEGORIES } from "@/lib/vendor-booking-rules";
import {
  finalReservationRequest,
  isFinalReservationView,
  isReservationPaymentView,
  requestedReservationDates,
  reservationDateLabel,
  reservationError,
  reservationRecord,
  unavailableReservationDates,
  vendorInvitationView,
  type FinalReservationForm,
  type FinalReservationView,
  type ReservationPaymentView,
  type ReservationPlanningSnapshot,
  type VendorInvitationView,
} from "@/lib/final-reservation-ui";

const FIELD = "mt-2 w-full rounded-xl border border-pine/20 bg-white px-3 py-3 text-sm font-normal text-ink outline-none focus:border-amber focus:ring-2 focus:ring-amber/25 disabled:opacity-50";
const BUTTON = "rounded-full bg-pine px-5 py-3 text-sm font-semibold text-cream enabled:hover:bg-leaf disabled:cursor-not-allowed disabled:opacity-45";
const QUIET_BUTTON = "rounded-full border border-pine/20 px-4 py-2 text-sm font-semibold text-pine disabled:opacity-45";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_LABEL: Record<FinalReservationView["state"], string> = {
  held: "Reserved — payment request needed",
  payment_pending: "Awaiting payment",
  paid: "Paid",
  confirmed: "Confirmed",
  expired: "Expired",
  cancelled: "Withdrawn",
  declined: "Declined",
  manual_review: "Manager attention required",
};
const LAST_MARKET_DATE = FRESH_AIR_SEASON_DATES[FRESH_AIR_SEASON_DATES.length - 1];
/** Bookings that still occupy their dates. */
const LIVE_STATES = new Set<FinalReservationView["state"]>(["held", "payment_pending", "paid", "confirmed", "manual_review"]);
/** Bookings a manager may withdraw (nothing paid yet). */
const WITHDRAWABLE_STATES = new Set<FinalReservationView["state"]>(["held", "payment_pending", "expired", "manual_review"]);

async function jsonBody(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function deadlineLabel(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York",
  }) + " Eastern";
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

async function attemptKey(material: string, attempts: Map<string, string>): Promise<string> {
  const current = attempts.get(material);
  if (current) return current;
  let key = crypto.randomUUID();
  try {
    // Keep only a fingerprint and random retry key in session storage. Never
    // store applicant identity, planning decisions, or private invitation URLs.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    const storageKey = `fame-final-reservation:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
    const saved = sessionStorage.getItem(storageKey);
    if (saved && UUID_V4.test(saved)) key = saved;
    else sessionStorage.setItem(storageKey, key);
  } catch {
    // Explicit retries in this mounted view still use the same in-memory key.
  }
  attempts.set(material, key);
  return key;
}

interface BookingRequestView { id: string; dates: string[]; booths: number; vendorNote: string; createdAt: string }

function bookingRequestView(value: unknown): BookingRequestView | null {
  const data = reservationRecord(value);
  if (!data || typeof data.id !== "string" || !Array.isArray(data.dates) || typeof data.booths !== "number") return null;
  return { id: data.id, dates: data.dates.filter((d): d is string => typeof d === "string"), booths: data.booths, vendorNote: typeof data.vendorNote === "string" ? data.vendorNote : "", createdAt: typeof data.createdAt === "string" ? data.createdAt : "" };
}

function reservationList(payload: Record<string, unknown> | null): FinalReservationView[] | null {
  if (!payload) return null;
  if (Array.isArray(payload.reservations)) {
    return payload.reservations.every(isFinalReservationView) ? payload.reservations : null;
  }
  if (payload.reservation === null) return [];
  return isFinalReservationView(payload.reservation) ? [payload.reservation] : null;
}

export default function FinalReservationPanel({ applicationId, sourceEventId, snapshot }: {
  applicationId: string;
  sourceEventId: string;
  snapshot: ReservationPlanningSnapshot;
}) {
  const router = useRouter();
  const attempts = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const statusRead = useRef({ revision: 0, pending: true });
  const [form, setForm] = useState<FinalReservationForm>(() => ({
    applicantType: "",
    vendorCategory: (FAME_VENDOR_CATEGORIES as readonly string[]).includes(snapshot.category) ? snapshot.category : "",
    selectedDates: snapshot.fullSeason ? [] : requestedReservationDates(snapshot.dates),
    fullSeason: snapshot.fullSeason,
    boothsPerMarket: String(Number.isSafeInteger(snapshot.boothsRequested) && (snapshot.boothsRequested as number) >= 1 ? snapshot.boothsRequested : 1),
    foodLicenseDecision: "",
    finalDatesConfirmed: false,
  }));
  const [reservations, setReservations] = useState<FinalReservationView[]>([]);
  const [paymentOrders, setPaymentOrders] = useState<Record<string, ReservationPaymentView>>({});
  const [invitations, setInvitations] = useState<Record<string, VendorInvitationView>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"reserve" | "checkout" | "access" | "reopen" | "withdraw" | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unavailable, setUnavailable] = useState<Array<{ date: string; reasons: string[] }>>([]);
  const [replaceLinkConfirmed, setReplaceLinkConfirmed] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const [addingDates, setAddingDates] = useState(false);
  const [withdrawNote, setWithdrawNote] = useState("");
  const [withdrawTarget, setWithdrawTarget] = useState<string | null>(null);
  const [insuranceExpiresOn, setInsuranceExpiresOn] = useState<string | null>(null);
  const [bookingRequest, setBookingRequest] = useState<BookingRequestView | null>(null);
  const [declineNote, setDeclineNote] = useState("");
  const [declining, setDeclining] = useState(false);

  const endpoint = `/api/admin/applications/${encodeURIComponent(applicationId)}/reserve`;
  const load = useCallback(async (signal?: AbortSignal) => {
    if (inFlight.current) return;
    const revision = ++statusRead.current.revision;
    statusRead.current.pending = true;
    setLoading(true);
    setLoadError("");
    setError("");
    setNotice("");
    setUnavailable([]);
    setInvitations({});
    setCopyNotice("");
    setReplaceLinkConfirmed(null);
    setAddingDates(false);
    setWithdrawTarget(null);
    try {
      const response = await fetch(endpoint, { headers: { Accept: "application/json" }, cache: "no-store", signal });
      const payload = await jsonBody(response);
      if (signal?.aborted || revision !== statusRead.current.revision) return;
      if (response.status === 401) { router.replace("/login"); return; }
      const list = reservationList(reservationRecord(payload));
      if (!response.ok || !list) {
        setLoadError(reservationError(payload, "The saved reservation could not be checked. Reload its status before continuing."));
        return;
      }
      setReservations(list);
      setPaymentOrders({});
      const expiry = reservationRecord(payload)?.insuranceExpiresOn;
      const expiresOn = typeof expiry === "string" ? expiry : null;
      setInsuranceExpiresOn(expiresOn);
      // The form was seeded from the vendor's request before the expiry was
      // known; drop what the certificate does not cover so nothing is stuck checked.
      if (expiresOn) {
        setForm(current => ({
          ...current,
          selectedDates: current.selectedDates.filter(date => date <= expiresOn),
          fullSeason: current.fullSeason && expiresOn >= LAST_MARKET_DATE,
        }));
      }
      try {
        const pending = await fetch(`/api/admin/applications/${encodeURIComponent(applicationId)}/booking-request`, { headers: { Accept: "application/json" }, cache: "no-store", signal });
        const body = reservationRecord(await jsonBody(pending));
        if (!signal?.aborted && revision === statusRead.current.revision) setBookingRequest(pending.ok ? bookingRequestView(body?.pendingRequest) : null);
      } catch { /* the request card is optional; the rest of the panel still works */ }
    } catch {
      if (!signal?.aborted && revision === statusRead.current.revision) setLoadError("The saved reservation could not be checked. Reload its status before continuing.");
    } finally {
      if (!signal?.aborted && revision === statusRead.current.revision) {
        statusRead.current.pending = false;
        setLoading(false);
      }
    }
  }, [endpoint, router, applicationId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function edit(patch: Partial<FinalReservationForm>) {
    setForm(current => ({ ...current, ...patch }));
    setError("");
    setNotice("");
    setUnavailable([]);
  }

  function replaceReservation(id: string, patch: Partial<FinalReservationView>) {
    setReservations(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
  }

  const liveReservations = reservations.filter(item => LIVE_STATES.has(item.state));
  const heldDates = new Set(liveReservations.flatMap(item => item.finalDates));
  const uninsured = (date: string) => Boolean(insuranceExpiresOn && date > insuranceExpiresOn);
  const fullSeasonCovered = !insuranceExpiresOn || insuranceExpiresOn >= LAST_MARKET_DATE;
  const showForm = addingDates || liveReservations.length === 0;

  async function reserve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || statusRead.current.pending || loading || loadError || !showForm) return;
    const request = finalReservationRequest(form, snapshot.requiresFinalDateConfirmation);
    if ("error" in request) { setError(request.error); return; }
    inFlight.current = true;
    setBusy("reserve");
    setError("");
    setNotice("");
    setUnavailable([]);
    try {
      const key = await attemptKey(JSON.stringify([applicationId, sourceEventId, request.body]), attempts.current);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": key },
        body: JSON.stringify(request.body),
      });
      const payload = await jsonBody(response);
      if (response.status === 401) { router.replace("/login"); return; }
      const data = reservationRecord(payload);
      if (!response.ok || !isFinalReservationView(data?.reservation) || typeof data?.duplicate !== "boolean") {
        setError(reservationError(payload, "The reservation result could not be confirmed. Reload status or retry this exact selection."));
        setUnavailable(unavailableReservationDates(payload));
        return;
      }
      const saved = data.reservation;
      setReservations(current => current.some(item => item.id === saved.id)
        ? current.map(item => item.id === saved.id ? saved : item)
        : [...current, saved]);
      setAddingDates(false);
      setNotice(data.duplicate ? "This exact booking was already saved. Its current status is shown below." : "The booking was saved. The total below was calculated from the approved dates and booth quantity.");
    } catch {
      setError("The reservation result could not be confirmed. Reload status or retry this exact selection; the same request key will be reused.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function reopen(reservation: FinalReservationView) {
    if (inFlight.current || statusRead.current.pending || loadError || !["expired", "manual_review"].includes(reservation.state)) return;
    inFlight.current = true;
    setBusy("reopen");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/reservations/${encodeURIComponent(reservation.id)}/reopen`, {
        method: "POST", headers: { Accept: "application/json" },
      });
      const payload = await jsonBody(response);
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok) {
        setError(reservationError(payload, "The hold could not be reopened."));
        return;
      }
      setPaymentOrders(current => { const next = { ...current }; delete next[reservation.id]; return next; });
      setInvitations(current => { const next = { ...current }; delete next[reservation.id]; return next; });
      replaceReservation(reservation.id, { state: "held" });
      setNotice("The hold is open again with the same dates, booths and price. Create a new payment request, then email the payment link.");
    } catch {
      setError("The hold could not be reopened. Reload reservation status and try again.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function checkout(reservation: FinalReservationView) {
    if (inFlight.current || statusRead.current.pending || loadError || !reservation.paymentRequired
      || !["held", "payment_pending"].includes(reservation.state)) return;
    inFlight.current = true;
    setBusy("checkout");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/reservations/${encodeURIComponent(reservation.id)}/checkout`, {
        method: "POST", headers: { Accept: "application/json" },
      });
      const payload = await jsonBody(response);
      if (response.status === 401) { router.replace("/login"); return; }
      if (response.status === 202) {
        setNotice("The payment request is still being prepared. Use Retrieve payment request to check again; nothing is retried automatically.");
        return;
      }
      const data = reservationRecord(payload);
      if (!response.ok || !isReservationPaymentView(data?.paymentOrder)) {
        setError(reservationError(payload, "The payment request could not be confirmed. Retry this same reservation to retrieve its saved request."));
        return;
      }
      const order = data.paymentOrder;
      setPaymentOrders(current => ({ ...current, [reservation.id]: order }));
      if (order.status === "checkout_created" && ["held", "payment_pending"].includes(reservation.state)) {
        replaceReservation(reservation.id, { state: "payment_pending" });
      }
      setNotice(order.status === "checkout_created"
        ? "The payment request is ready. Use Email payment link below to send it to the vendor."
        : "The saved payment request was retrieved. Reload reservation status to check the latest payment outcome.");
    } catch {
      setError("The payment request could not be confirmed. Retry this same reservation to retrieve its saved request without creating a second order.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  function canCreateAccess(reservation: FinalReservationView): boolean {
    const order = paymentOrders[reservation.id];
    return (!reservation.paymentRequired && reservation.state === "confirmed")
      || (reservation.paymentRequired && reservation.state === "paid")
      || (reservation.paymentRequired && ["held", "payment_pending"].includes(reservation.state) && order?.status === "checkout_created");
  }

  async function createAccess(reservation: FinalReservationView) {
    if (inFlight.current || statusRead.current.pending || loadError || !canCreateAccess(reservation) || replaceLinkConfirmed !== reservation.id) return;
    inFlight.current = true;
    setBusy("access");
    setError("");
    setNotice("");
    setInvitations(current => { const next = { ...current }; delete next[reservation.id]; return next; });
    setCopyNotice("");
    try {
      const response = await fetch(`/api/admin/reservations/${encodeURIComponent(reservation.id)}/access`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}",
      });
      const payload = await jsonBody(response);
      if (response.status === 401) { router.replace("/login"); return; }
      const link = vendorInvitationView(payload);
      if (!response.ok || !link) {
        setError(reservationError(payload, "The private link could not be confirmed. Creating another link replaces any link from this attempt."));
        return;
      }
      setInvitations(current => ({ ...current, [reservation.id]: link }));
      const delivery = (payload as { vendorNotification?: unknown } | null)?.vendorNotification;
      setNotice(delivery === "sent"
        ? "The payment link was emailed to the vendor. Any earlier links were revoked."
        : delivery === "failed"
          ? "The link was created but the email could not be sent. Copy the link below and send it to the vendor yourself."
          : "The link was created. Email is not configured, so copy the link below and send it to the vendor yourself.");
    } catch {
      setError("The private link could not be confirmed. Creating another link replaces any link from this attempt.");
    } finally {
      inFlight.current = false;
      setBusy(null);
      setReplaceLinkConfirmed(null);
    }
  }

  async function withdraw(reservation: FinalReservationView) {
    const note = withdrawNote.trim();
    if (inFlight.current || statusRead.current.pending || loadError || !WITHDRAWABLE_STATES.has(reservation.state) || !note) return;
    inFlight.current = true;
    setBusy("withdraw");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/reservations/${encodeURIComponent(reservation.id)}/withdraw`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ note }),
      });
      const payload = await jsonBody(response);
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok) {
        setError(reservationError(payload, "The booking could not be withdrawn."));
        return;
      }
      setPaymentOrders(current => { const next = { ...current }; delete next[reservation.id]; return next; });
      setInvitations(current => { const next = { ...current }; delete next[reservation.id]; return next; });
      replaceReservation(reservation.id, { state: "cancelled" });
      setWithdrawTarget(null);
      setWithdrawNote("");
      const delivery = (payload as { vendorNotification?: unknown } | null)?.vendorNotification;
      setNotice(delivery === "sent"
        ? "The booking was withdrawn, its payment link cancelled and the dates released. The vendor was emailed a confirmation."
        : "The booking was withdrawn, its payment link cancelled and the dates released. The confirmation email could not be sent, so let the vendor know yourself.");
    } catch {
      setError("The booking could not be withdrawn. Reload reservation status and try again.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function confirmRequest(request: BookingRequestView) {
    if (inFlight.current || statusRead.current.pending || loadError) return;
    inFlight.current = true;
    setBusy("reserve");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/booking-requests/${encodeURIComponent(request.id)}/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}",
      });
      const payload = await jsonBody(response);
      if (response.status === 401) { router.replace("/login"); return; }
      const data = reservationRecord(payload);
      if (isFinalReservationView(data?.reservation)) {
        const saved = data.reservation;
        setReservations(current => current.some(item => item.id === saved.id) ? current.map(item => item.id === saved.id ? saved : item) : [...current, saved]);
        if (isReservationPaymentView(data?.paymentOrder)) {
          const order = data.paymentOrder;
          setPaymentOrders(current => ({ ...current, [saved.id]: order }));
        }
      }
      if (!response.ok) {
        setError(reservationError(payload, "The request could not be confirmed."));
        if (isFinalReservationView(data?.reservation)) setBookingRequest(null);
        return;
      }
      setBookingRequest(null);
      const delivery = data?.vendorNotification;
      setNotice(delivery === "sent"
        ? "Confirmed. The dates are booked and the vendor was emailed their payment link (48 hours to pay)."
        : delivery === "not_sent" && data?.paymentOrder === null
          ? "Confirmed. This nonprofit booking has nothing to pay."
          : "Confirmed and the payment request is ready, but the email could not be sent. Use Email payment link below.");
    } catch {
      setError("The request could not be confirmed. Reload reservation status to see what was saved.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function declineRequest(request: BookingRequestView) {
    const note = declineNote.trim();
    if (inFlight.current || statusRead.current.pending || loadError || !note) return;
    inFlight.current = true;
    setBusy("withdraw");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/booking-requests/${encodeURIComponent(request.id)}/decline`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ note }),
      });
      const payload = await jsonBody(response);
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok) { setError(reservationError(payload, "The request could not be declined.")); return; }
      setBookingRequest(null);
      setDeclining(false);
      setDeclineNote("");
      setNotice((payload as { vendorNotification?: unknown } | null)?.vendorNotification === "sent"
        ? "Request declined and the vendor was emailed your note."
        : "Request declined. The email could not be sent, so let the vendor know yourself.");
    } catch {
      setError("The request could not be declined. Reload and try again.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function copyInvitation(reservation: FinalReservationView) {
    const invitation = invitations[reservation.id];
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.invitationUrl);
      setCopyNotice("Private link copied.");
    } catch {
      setCopyNotice("Select the link below and copy it manually.");
    }
  }

  const disabled = loading || Boolean(loadError) || Boolean(busy);
  const mappedRequestedCount = requestedReservationDates(snapshot.dates).length;
  const hasUnmappedRequestedDates = !snapshot.fullSeason && snapshot.dates.length > mappedRequestedCount;

  return (
    <section aria-labelledby="final-reservation-title" className="mt-8 border-t border-pine/15 pt-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="final-reservation-title" className="font-display text-2xl text-pine-deep">Reserve dates and request payment</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink/65">Confirm the final selection after the agreement and required documents are approved. A vendor can hold more than one booking in a season; each booking has its own payment link and is priced on its own dates.</p>
        </div>
        <button type="button" disabled={loading || Boolean(busy)} onClick={() => void load()} className="rounded-full border border-pine/20 px-4 py-2 text-xs font-semibold text-pine disabled:opacity-45">Reload reservation status</button>
      </div>

      {loading && <p role="status" className="mt-4 text-sm text-ink/60">Checking for saved bookings…</p>}
      {loadError && <p role="alert" className="mt-4 rounded-xl bg-clay/10 p-4 text-sm text-clay">{loadError}</p>}

      {!loading && !loadError && bookingRequest && (
        <section className="mt-6 rounded-2xl border-2 border-amber bg-amber/10 p-5">
          <h3 className="font-semibold text-pine-deep">The vendor asked for more dates</h3>
          <p className="mt-2 text-sm text-pine-deep">{bookingRequest.booths} booth{bookingRequest.booths === 1 ? "" : "s"} on {bookingRequest.dates.map(reservationDateLabel).join(" · ")}{bookingRequest.createdAt ? ` (asked ${deadlineLabel(bookingRequest.createdAt)})` : ""}</p>
          {bookingRequest.vendorNote && <p className="mt-2 text-sm text-ink/70">Their note: {bookingRequest.vendorNote}</p>}
          <p className="mt-3 text-sm leading-relaxed text-ink/65">Confirm books exactly these dates and booths (type, category and food-license decision carry over from their last booking, or from their application if this is their first), creates the Square payment request and emails them the link, all in one go.</p>
          {!declining && <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" disabled={disabled} onClick={() => void confirmRequest(bookingRequest)} className={BUTTON}>{busy === "reserve" ? "Confirming…" : "Confirm and send payment link"}</button>
            <button type="button" disabled={disabled} onClick={() => { setDeclining(true); setDeclineNote(""); }} className={QUIET_BUTTON}>Decline</button>
          </div>}
          {declining && <div className="mt-4">
            <label className="block text-sm font-semibold text-pine-deep">Why? (sent to the vendor)
              <textarea value={declineNote} disabled={disabled} maxLength={1000} rows={2} onChange={event => setDeclineNote(event.target.value)} placeholder="Example: Those Saturdays are full; Nov 14 and Nov 28 are open if you'd like them." className={FIELD} />
            </label>
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" disabled={disabled || !declineNote.trim()} onClick={() => void declineRequest(bookingRequest)} className={BUTTON}>{busy === "withdraw" ? "Declining…" : "Send decline"}</button>
              <button type="button" disabled={disabled} onClick={() => { setDeclining(false); setDeclineNote(""); }} className={QUIET_BUTTON}>Back</button>
            </div>
          </div>}
        </section>
      )}

      {!loading && !loadError && reservations.length > 0 && (
        <div className="mt-6 space-y-5">
          {reservations.map((reservation, index) => {
            const paymentOrder = paymentOrders[reservation.id] ?? null;
            const invitation = invitations[reservation.id] ?? null;
            const withdrawing = withdrawTarget === reservation.id;
            return (
              <article key={reservation.id} className={`rounded-2xl border p-5 ${reservation.state === "cancelled" ? "border-pine/10 bg-parchment/30 opacity-80" : "border-pine/15 bg-parchment/60"}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-semibold text-pine-deep">{reservations.length > 1 ? `Booking ${index + 1}` : "Saved final reservation"}</h3>
                  <p className="text-sm font-semibold text-pine">{STATE_LABEL[reservation.state]}</p>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
                  <div><dt className="text-ink/55">Total</dt><dd className="mt-1 text-2xl font-bold text-pine-deep">{money(reservation.totalCents)}</dd></div>
                  <div><dt className="text-ink/55">Booths per date</dt><dd className="mt-1 font-semibold text-pine-deep">{reservation.finalBoothQuantity}</dd></div>
                  <div className="col-span-2"><dt className="text-ink/55">Reserved dates ({reservation.finalDates.length})</dt><dd className="mt-1 text-pine-deep">{reservation.finalDates.map(reservationDateLabel).join(" · ")}</dd></div>
                </dl>
                {!reservation.paymentRequired && reservation.state !== "cancelled" && <p className="mt-4 text-sm text-pine">This nonprofit reservation has no payment due.</p>}
                {reservation.state === "cancelled" && <p className="mt-4 text-sm text-ink/65">Withdrawn{reservation.withdrawnAt ? ` ${deadlineLabel(reservation.withdrawnAt)}` : ""}. The dates were released and its payment link no longer works.{reservation.withdrawalNote ? ` Note: ${reservation.withdrawalNote}` : ""}</p>}

                {reservation.paymentRequired && (reservation.state === "expired" || reservation.state === "manual_review") && (
                  <section className="mt-5 rounded-2xl border border-clay/30 bg-clay/5 p-5">
                    <h4 className="font-semibold text-pine-deep">{reservation.state === "expired" ? "Payment window expired" : "Payment request needs attention"}</h4>
                    <p className="mt-2 text-sm leading-relaxed text-ink/65">{reservation.state === "expired"
                      ? "The vendor did not pay within 48 hours, so these dates were released. If they still want them and the dates have room, reopen the hold and send a new payment request. Dates, booths and price stay the same."
                      : "The last payment request could not be completed. If the dates still have room, reopen the hold and create a new payment request. Dates, booths and price stay the same."}</p>
                    <button type="button" disabled={disabled} onClick={() => void reopen(reservation)} className={`${BUTTON} mt-4`}>{busy === "reopen" ? "Reopening…" : "Reopen this hold"}</button>
                  </section>
                )}

                {reservation.paymentRequired && ["held", "payment_pending"].includes(reservation.state) && (
                  <section className="mt-5 rounded-2xl border border-pine/15 bg-white/60 p-5">
                    <h4 className="font-semibold text-pine-deep">Payment request</h4>
                    <p className="mt-2 text-sm leading-relaxed text-ink/65">The vendor has 48 hours from creation of the Square payment request. Repeating this action retrieves the same request and does not extend its deadline.</p>
                    <button type="button" disabled={disabled} onClick={() => void checkout(reservation)} className={`${BUTTON} mt-4`}>{busy === "checkout" ? "Preparing payment request…" : paymentOrder || reservation.state === "payment_pending" ? "Retrieve payment request" : "Create payment request"}</button>
                    {paymentOrder && <div role="status" className="mt-4 rounded-xl bg-pine/10 p-4 text-sm text-pine">
                      <p>{paymentOrder.status === "checkout_created" ? "Payment request ready; payment has not been confirmed." : `Payment request status: ${paymentOrder.status.replaceAll("_", " ")}.`}</p>
                      {paymentOrder.paymentDueAt && <p className="mt-1">Payment deadline: {deadlineLabel(paymentOrder.paymentDueAt)}</p>}
                    </div>}
                  </section>
                )}

                {canCreateAccess(reservation) && (
                  <section className="mt-5 rounded-2xl border border-pine/15 bg-white/60 p-5">
                    <h4 className="font-semibold text-pine-deep">Email the payment link</h4>
                    <p className="mt-2 text-sm leading-relaxed text-ink/65">Emails the vendor their private reservation page with the total, their dates and the 48-hour deadline. The link is only for this vendor; anyone who has it can open this reservation. Sending again issues a fresh link and revokes the old one.</p>
                    <label className="mt-4 flex items-start gap-3 text-sm text-ink/75">
                      <input type="checkbox" checked={replaceLinkConfirmed === reservation.id} disabled={disabled} onChange={event => setReplaceLinkConfirmed(event.target.checked ? reservation.id : null)} className="mt-0.5" />
                      I understand that sending a link replaces any earlier link and signs the vendor out of existing sessions.
                    </label>
                    <button type="button" disabled={disabled || replaceLinkConfirmed !== reservation.id} onClick={() => void createAccess(reservation)} className={`${BUTTON} mt-4`}>{busy === "access" ? "Sending…" : invitation ? "Send a new payment link" : "Email payment link to vendor"}</button>
                    {invitation && <div className="mt-4 rounded-xl bg-parchment/70 p-4">
                      <label className="block text-sm font-semibold text-pine-deep">Private link (in case you need to send it another way)
                        <input type="text" readOnly value={invitation.invitationUrl} onFocus={event => event.target.select()} autoComplete="off" spellCheck={false} className={`${FIELD} font-mono text-xs`} />
                      </label>
                      <p className="mt-2 text-xs text-ink/60">Link expires {deadlineLabel(invitation.expiresAt)}. It is shown here only until this page reloads.</p>
                      <button type="button" onClick={() => void copyInvitation(reservation)} className="mt-3 rounded-full border border-pine/20 px-4 py-2 text-sm font-semibold text-pine">Copy private link</button>
                      {copyNotice && <p role="status" className="mt-2 text-xs text-pine">{copyNotice}</p>}
                    </div>}
                  </section>
                )}

                {WITHDRAWABLE_STATES.has(reservation.state) && (
                  <section className="mt-5 rounded-2xl border border-pine/15 bg-white/60 p-5">
                    <h4 className="font-semibold text-pine-deep">Withdraw this booking</h4>
                    <p className="mt-2 text-sm leading-relaxed text-ink/65">Use this when the vendor no longer wants these dates or wants different ones. It cancels the payment link, releases the dates and emails the vendor. Their application, agreement and documents stay on file, so you can add new dates right after.</p>
                    {!withdrawing && <button type="button" disabled={disabled} onClick={() => { setWithdrawTarget(reservation.id); setWithdrawNote(""); setError(""); setNotice(""); }} className={`${QUIET_BUTTON} mt-4`}>Withdraw this booking</button>}
                    {withdrawing && <div className="mt-4">
                      <label className="block text-sm font-semibold text-pine-deep">Why is it being withdrawn? (sent to the vendor)
                        <textarea value={withdrawNote} disabled={disabled} maxLength={500} rows={2} onChange={event => setWithdrawNote(event.target.value)} placeholder="Example: You asked on 9/20 to switch to spring dates only." className={FIELD} />
                      </label>
                      <div className="mt-3 flex flex-wrap gap-3">
                        <button type="button" disabled={disabled || !withdrawNote.trim()} onClick={() => void withdraw(reservation)} className={BUTTON}>{busy === "withdraw" ? "Withdrawing…" : "Confirm withdrawal"}</button>
                        <button type="button" disabled={disabled} onClick={() => { setWithdrawTarget(null); setWithdrawNote(""); }} className={QUIET_BUTTON}>Keep the booking</button>
                      </div>
                    </div>}
                  </section>
                )}
              </article>
            );
          })}

          {!showForm && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-pine/25 p-5">
              <p className="text-sm text-ink/65">Vendor wants more Saturdays? Add another booking with its own payment link. Dates already held are shown but cannot be chosen twice.</p>
              <button type="button" disabled={disabled} onClick={() => { setAddingDates(true); edit({ selectedDates: [], fullSeason: false }); }} className={QUIET_BUTTON}>Add dates</button>
            </div>
          )}
        </div>
      )}

      {!loading && !loadError && showForm && (
        <form onSubmit={reserve} className="mt-6 space-y-5">
          <fieldset disabled={disabled} className="space-y-5">
            <legend className="mb-3 text-sm font-bold text-pine-deep">{reservations.length ? "Add dates: final manager decisions" : "Final manager decisions"}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm font-semibold text-pine-deep">Applicant type
                <select required value={form.applicantType} onChange={event => edit({ applicantType: event.target.value as FinalReservationForm["applicantType"] })} className={FIELD}>
                  <option value="">Choose the final type</option>
                  <option value="Vendor">Vendor</option>
                  <option value="Non-Profit Organization">Non-Profit Organization</option>
                </select>
              </label>
              {form.applicantType === "Vendor" && (
                <label className="block text-sm font-semibold text-pine-deep">Vendor category
                  <select required value={form.vendorCategory} onChange={event => edit({ vendorCategory: event.target.value })} className={FIELD}>
                    <option value="">Choose the final category</option>
                    {FAME_VENDOR_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}
                  </select>
                </label>
              )}
              <label className="block text-sm font-semibold text-pine-deep">Booths per market date
                <input required type="number" min="1" max="1000" step="1" inputMode="numeric" value={form.boothsPerMarket} onChange={event => edit({ boothsPerMarket: event.target.value })} className={FIELD} />
              </label>
            </div>
            <fieldset>
              <legend className="text-sm font-semibold text-pine-deep">Food-license decision</legend>
              <p className="mt-1 text-xs text-ink/60">Record the manager’s decision for this application. Insurance is required in either case.</p>
              <div className="mt-3 flex flex-wrap gap-5 text-sm text-pine-deep">
                <label className="flex items-center gap-2"><input required type="radio" name="food-license-decision" value="required" checked={form.foodLicenseDecision === "required"} onChange={() => edit({ foodLicenseDecision: "required" })} />Required</label>
                <label className="flex items-center gap-2"><input type="radio" name="food-license-decision" value="not_required" checked={form.foodLicenseDecision === "not_required"} onChange={() => edit({ foodLicenseDecision: "not_required" })} />Not required</label>
              </div>
            </fieldset>
            <fieldset>
              <legend className="text-sm font-semibold text-pine-deep">Final market dates</legend>
              <p className="mt-1 text-xs leading-relaxed text-ink/60">35 Saturdays, October 3, 2026 through May 29, 2027. Requested dates are suggestions; confirm the final selection with the vendor.{reservations.length ? " This booking is priced on its own dates: $40 per Saturday, $35 when it covers 4 or more Saturdays in a row." : ""}</p>
              {hasUnmappedRequestedDates && <p className="mt-3 rounded-xl bg-amber/15 p-3 text-sm text-clay">Some requested values do not match the confirmed calendar. Review the original request above and choose the final dates here.</p>}
              {insuranceExpiresOn && !fullSeasonCovered && <p className="mt-3 rounded-xl bg-amber/15 p-3 text-sm text-clay">Their certificate of insurance expires {reservationDateLabel(insuranceExpiresOn)}. Saturdays after that are greyed out until a renewed certificate is approved.</p>}
              {heldDates.size === 0 && fullSeasonCovered && <label className="mt-3 flex items-start gap-3 rounded-xl border border-pine/20 bg-parchment/40 p-4 text-sm font-semibold text-pine-deep">
                <input type="checkbox" checked={form.fullSeason} onChange={event => edit({ fullSeason: event.target.checked, selectedDates: [] })} className="mt-0.5" />
                Full season — all 35 dates through Saturday, May 29, 2027
              </label>}
              {!form.fullSeason && <div className="mt-3 grid max-h-80 grid-cols-1 gap-2 overflow-y-auto rounded-xl border border-pine/15 p-3 sm:grid-cols-2">
                {FRESH_AIR_SEASON_DATES.map(date => <label key={date} className={`flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-parchment/60 ${heldDates.has(date) || uninsured(date) ? "text-ink/40" : "text-pine-deep"}`}>
                  <input type="checkbox" disabled={heldDates.has(date) || uninsured(date)} checked={form.selectedDates.includes(date)} onChange={event => edit({ selectedDates: event.target.checked ? [...form.selectedDates, date].sort() : form.selectedDates.filter(value => value !== date) })} />
                  {reservationDateLabel(date)}{heldDates.has(date) ? " (already booked)" : uninsured(date) ? " (after insurance expires)" : ""}
                </label>)}
              </div>}
              <p className="mt-2 text-xs font-semibold text-pine">{form.fullSeason ? 35 : form.selectedDates.length} market dates selected</p>
              {snapshot.requiresFinalDateConfirmation && <label className="mt-4 flex items-start gap-3 rounded-xl bg-amber/15 p-4 text-sm text-clay">
                <input required type="checkbox" checked={form.finalDatesConfirmed} onChange={event => edit({ finalDatesConfirmed: event.target.checked })} className="mt-0.5" />
                <span>The earlier request referred to May 27. I have confirmed the final dates with the vendor, including Saturday, May 29, 2027 when selected.</span>
              </label>}
            </fieldset>
          </fieldset>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-pine/10 pt-5">
            <p className="max-w-md text-xs leading-relaxed text-ink/60">Saving reserves the complete selected set if all checks pass. Payment is a separate action below. A saved booking cannot be edited; withdraw it and add new dates instead.</p>
            <div className="flex flex-wrap gap-3">
              {reservations.length > 0 && addingDates && <button type="button" disabled={disabled} onClick={() => setAddingDates(false)} className={QUIET_BUTTON}>Cancel</button>}
              <button type="submit" disabled={disabled} className={BUTTON}>{busy === "reserve" ? "Checking and reserving…" : "Check availability and reserve"}</button>
            </div>
          </div>
        </form>
      )}

      {notice && <p role="status" className="mt-5 rounded-xl bg-pine/10 p-4 text-sm text-pine">{notice}</p>}
      {error && <div role="alert" className="mt-5 rounded-xl bg-clay/10 p-4 text-sm text-clay">
        <p>{error}</p>
        {unavailable.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5">{unavailable.map(row => <li key={row.date}>{reservationDateLabel(row.date)}: {row.reasons.join("; ")}</li>)}</ul>}
      </div>}
    </section>
  );
}
