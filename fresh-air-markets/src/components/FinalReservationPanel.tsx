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
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_LABEL: Record<FinalReservationView["state"], string> = {
  held: "Reserved — payment request needed",
  payment_pending: "Awaiting payment",
  paid: "Paid",
  confirmed: "Confirmed",
  expired: "Expired",
  cancelled: "Cancelled",
  declined: "Declined",
  manual_review: "Manager attention required",
};

async function jsonBody(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function deadlineLabel(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York",
  }) + " Eastern";
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
  const [reservation, setReservation] = useState<FinalReservationView | null>(null);
  const [paymentOrder, setPaymentOrder] = useState<ReservationPaymentView | null>(null);
  const [invitation, setInvitation] = useState<VendorInvitationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"reserve" | "checkout" | "access" | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unavailable, setUnavailable] = useState<Array<{ date: string; reasons: string[] }>>([]);
  const [replaceLinkConfirmed, setReplaceLinkConfirmed] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");

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
    setInvitation(null);
    setCopyNotice("");
    setReplaceLinkConfirmed(false);
    try {
      const response = await fetch(endpoint, { headers: { Accept: "application/json" }, cache: "no-store", signal });
      const payload = await jsonBody(response);
      if (signal?.aborted || revision !== statusRead.current.revision) return;
      if (response.status === 401) { router.replace("/login"); return; }
      const data = reservationRecord(payload);
      if (!response.ok || !data || !(data.reservation === null || isFinalReservationView(data.reservation))) {
        setLoadError(reservationError(payload, "The saved reservation could not be checked. Reload its status before continuing."));
        return;
      }
      setReservation(data.reservation);
      setPaymentOrder(null);
    } catch {
      if (!signal?.aborted && revision === statusRead.current.revision) setLoadError("The saved reservation could not be checked. Reload its status before continuing.");
    } finally {
      if (!signal?.aborted && revision === statusRead.current.revision) {
        statusRead.current.pending = false;
        setLoading(false);
      }
    }
  }, [endpoint, router]);

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

  async function reserve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || statusRead.current.pending || loading || loadError || reservation) return;
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
      setReservation(data.reservation);
      setNotice(data.duplicate ? "This exact reservation was already saved. Its current status is shown below." : "The final reservation was saved. The total below was calculated from the approved dates and booth quantity.");
    } catch {
      setError("The reservation result could not be confirmed. Reload status or retry this exact selection; the same request key will be reused.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function checkout() {
    if (inFlight.current || statusRead.current.pending || loadError || !reservation || !reservation.paymentRequired
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
      setPaymentOrder(data.paymentOrder);
      if (data.paymentOrder.status === "checkout_created") {
        setReservation(current => current && ["held", "payment_pending"].includes(current.state)
          ? { ...current, state: "payment_pending" } : current);
      }
      setNotice(data.paymentOrder.status === "checkout_created"
        ? "The payment request is ready. Use Email payment link below to send it to the vendor."
        : "The saved payment request was retrieved. Reload reservation status to check the latest payment outcome.");
    } catch {
      setError("The payment request could not be confirmed. Retry this same reservation to retrieve its saved request without creating a second order.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const canCreateAccess = Boolean(reservation && (
    (!reservation.paymentRequired && reservation.state === "confirmed")
    || (reservation.paymentRequired && reservation.state === "paid")
    || (reservation.paymentRequired && ["held", "payment_pending"].includes(reservation.state) && paymentOrder?.status === "checkout_created")
  ));

  async function createAccess() {
    if (inFlight.current || statusRead.current.pending || loadError || !reservation || !canCreateAccess || !replaceLinkConfirmed) return;
    inFlight.current = true;
    setBusy("access");
    setError("");
    setNotice("");
    setInvitation(null);
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
      setInvitation(link);
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
      setReplaceLinkConfirmed(false);
    }
  }

  async function copyInvitation() {
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
          <p className="mt-2 text-sm leading-relaxed text-ink/65">Confirm the final selection after the agreement and required documents are approved. The reservation checks availability and calculates the total before saving.</p>
        </div>
        <button type="button" disabled={loading || Boolean(busy)} onClick={() => void load()} className="rounded-full border border-pine/20 px-4 py-2 text-xs font-semibold text-pine disabled:opacity-45">Reload reservation status</button>
      </div>

      {loading && <p role="status" className="mt-4 text-sm text-ink/60">Checking for a saved reservation…</p>}
      {loadError && <p role="alert" className="mt-4 rounded-xl bg-clay/10 p-4 text-sm text-clay">{loadError}</p>}

      {!loading && !loadError && !reservation && (
        <form onSubmit={reserve} className="mt-6 space-y-5">
          <fieldset disabled={disabled} className="space-y-5">
            <legend className="mb-3 text-sm font-bold text-pine-deep">Final manager decisions</legend>
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
              <p className="mt-1 text-xs leading-relaxed text-ink/60">35 Saturdays, October 3, 2026 through May 29, 2027. Requested dates are suggestions; confirm the final selection with the vendor.</p>
              {hasUnmappedRequestedDates && <p className="mt-3 rounded-xl bg-amber/15 p-3 text-sm text-clay">Some requested values do not match the confirmed calendar. Review the original request above and choose the final dates here.</p>}
              <label className="mt-3 flex items-start gap-3 rounded-xl border border-pine/20 bg-parchment/40 p-4 text-sm font-semibold text-pine-deep">
                <input type="checkbox" checked={form.fullSeason} onChange={event => edit({ fullSeason: event.target.checked, selectedDates: [] })} className="mt-0.5" />
                Full season — all 35 dates through Saturday, May 29, 2027
              </label>
              {!form.fullSeason && <div className="mt-3 grid max-h-80 grid-cols-1 gap-2 overflow-y-auto rounded-xl border border-pine/15 p-3 sm:grid-cols-2">
                {FRESH_AIR_SEASON_DATES.map(date => <label key={date} className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-pine-deep hover:bg-parchment/60">
                  <input type="checkbox" checked={form.selectedDates.includes(date)} onChange={event => edit({ selectedDates: event.target.checked ? [...form.selectedDates, date].sort() : form.selectedDates.filter(value => value !== date) })} />
                  {reservationDateLabel(date)}
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
            <p className="max-w-md text-xs leading-relaxed text-ink/60">Saving reserves the complete selected set if all checks pass. Payment is a separate action below. A saved reservation cannot be edited here.</p>
            <button type="submit" disabled={disabled} className={BUTTON}>{busy === "reserve" ? "Checking and reserving…" : "Check availability and reserve"}</button>
          </div>
        </form>
      )}

      {!loading && !loadError && reservation && (
        <div className="mt-6 space-y-5">
          <section className="rounded-2xl bg-parchment/60 p-5">
            <h3 className="font-semibold text-pine-deep">Saved final reservation</h3>
            <p className="mt-2 text-sm font-semibold text-pine">{STATE_LABEL[reservation.state]}</p>
            <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
              <div><dt className="text-ink/55">Total</dt><dd className="mt-1 text-2xl font-bold text-pine-deep">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(reservation.totalCents / 100)}</dd></div>
              <div><dt className="text-ink/55">Booths per date</dt><dd className="mt-1 font-semibold text-pine-deep">{reservation.finalBoothQuantity}</dd></div>
              <div className="col-span-2"><dt className="text-ink/55">Reserved dates ({reservation.finalDates.length})</dt><dd className="mt-1 text-pine-deep">{reservation.finalDates.map(reservationDateLabel).join(" · ")}</dd></div>
            </dl>
            {!reservation.paymentRequired && <p className="mt-4 text-sm text-pine">This nonprofit reservation has no payment due.</p>}
          </section>

          {reservation.paymentRequired && ["held", "payment_pending"].includes(reservation.state) && (
            <section className="rounded-2xl border border-pine/15 p-5">
              <h3 className="font-semibold text-pine-deep">Payment request</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink/65">The vendor has 48 hours from creation of the Square payment request. Repeating this action retrieves the same request and does not extend its deadline.</p>
              <button type="button" disabled={disabled} onClick={() => void checkout()} className={`${BUTTON} mt-4`}>{busy === "checkout" ? "Preparing payment request…" : paymentOrder || reservation.state === "payment_pending" ? "Retrieve payment request" : "Create payment request"}</button>
              {paymentOrder && <div role="status" className="mt-4 rounded-xl bg-pine/10 p-4 text-sm text-pine">
                <p>{paymentOrder.status === "checkout_created" ? "Payment request ready; payment has not been confirmed." : `Payment request status: ${paymentOrder.status.replaceAll("_", " ")}.`}</p>
                {paymentOrder.paymentDueAt && <p className="mt-1">Payment deadline: {deadlineLabel(paymentOrder.paymentDueAt)}</p>}
              </div>}
            </section>
          )}

          {canCreateAccess && (
            <section className="rounded-2xl border border-pine/15 p-5">
              <h3 className="font-semibold text-pine-deep">Email the payment link</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink/65">Emails the vendor their private reservation page with the total, their dates and the 48-hour deadline. The link is only for this vendor; anyone who has it can open this reservation. Sending again issues a fresh link and revokes the old one.</p>
              <label className="mt-4 flex items-start gap-3 text-sm text-ink/75">
                <input type="checkbox" checked={replaceLinkConfirmed} disabled={disabled} onChange={event => setReplaceLinkConfirmed(event.target.checked)} className="mt-0.5" />
                I understand that sending a link replaces any earlier link and signs the vendor out of existing sessions.
              </label>
              <button type="button" disabled={disabled || !replaceLinkConfirmed} onClick={() => void createAccess()} className={`${BUTTON} mt-4`}>{busy === "access" ? "Sending…" : invitation ? "Send a new payment link" : "Email payment link to vendor"}</button>
              {invitation && <div className="mt-4 rounded-xl bg-parchment/70 p-4">
                <label className="block text-sm font-semibold text-pine-deep">Private link (in case you need to send it another way)
                  <input type="text" readOnly value={invitation.invitationUrl} onFocus={event => event.target.select()} autoComplete="off" spellCheck={false} className={`${FIELD} font-mono text-xs`} />
                </label>
                <p className="mt-2 text-xs text-ink/60">Link expires {deadlineLabel(invitation.expiresAt)}. It is shown here only until this page reloads.</p>
                <button type="button" onClick={() => void copyInvitation()} className="mt-3 rounded-full border border-pine/20 px-4 py-2 text-sm font-semibold text-pine">Copy private link</button>
                {copyNotice && <p role="status" className="mt-2 text-xs text-pine">{copyNotice}</p>}
              </div>}
            </section>
          )}
        </div>
      )}

      {notice && <p role="status" className="mt-5 rounded-xl bg-pine/10 p-4 text-sm text-pine">{notice}</p>}
      {error && <div role="alert" className="mt-5 rounded-xl bg-clay/10 p-4 text-sm text-clay">
        <p>{error}</p>
        {unavailable.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5">{unavailable.map(row => <li key={row.date}>{reservationDateLabel(row.date)}: {row.reasons.join("; ")}</li>)}</ul>}
      </div>}
    </section>
  );
}
