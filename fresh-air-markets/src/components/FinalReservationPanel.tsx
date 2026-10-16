"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FRESH_AIR_SEASON_DATES } from "@/lib/fresh-air-season";
import { FAME_VENDOR_CATEGORIES, checkVendorBooking } from "@/lib/vendor-booking-rules";
import SaturdayPicker from "./SaturdayPicker";
import { MAX_INSTALLMENTS, MIN_INSTALLMENTS, invoiceSendDate, planBilling, type Installment } from "@/lib/billing-plan";
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
/** Bookings whose Saturdays a manager may change in one step (nothing paid yet). */
const CHANGEABLE_STATES = new Set<FinalReservationView["state"]>(["held", "payment_pending", "expired"]);

/** Price for a set of Saturdays, using the same rule the server charges ($40, $35 when it includes 4+ in a row, $30 full season). */
function previewTotal(dates: string[], booths: number): number | null {
  if (!dates.length || !Number.isSafeInteger(booths) || booths < 1) return null;
  const fullSeason = FRESH_AIR_SEASON_DATES.every(date => dates.includes(date));
  try {
    const quote = checkVendorBooking(
      { dates: [...FRESH_AIR_SEASON_DATES], boothCapacity: 1000 },
      { applicantType: "Vendor", vendorCategory: FAME_VENDOR_CATEGORIES[0], selectedDates: fullSeason ? [] : [...dates].sort(), fullSeason, boothsPerMarket: booths },
      FRESH_AIR_SEASON_DATES.map(date => ({ date, booths: 0, foodTrucks: 0, nonprofits: 0 })),
    );
    return quote.totalCents;
  } catch { return null; }
}

function todayEastern(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

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

interface InvoiceInfo {
  id: string; reservationId: string; plan: "full" | "monthly"; status: "creating" | "open" | "paid" | "cancelled" | "failed";
  totalCents: number; paidCents: number; publicUrl: string | null; lastError: string | null; installments: (Installment & { paidCents?: number })[]; installmentsPaid: number; adjustmentReason: string;
}

function invoiceList(value: unknown): InvoiceInfo[] {
  const list = (value as { invoices?: unknown } | null)?.invoices;
  return Array.isArray(list) ? list.filter((item): item is InvoiceInfo => Boolean(item) && typeof item.id === "string" && typeof item.reservationId === "string" && Array.isArray(item.installments)) : [];
}

const INVOICE_STATUS: Record<InvoiceInfo["status"], string> = {
  creating: "Being sent", open: "Sent by Square, collecting", paid: "Paid in full", cancelled: "Cancelled", failed: "Not sent",
};

interface BalanceBooking { reservationId: string; chargeCents: number; discountCents: number; creditAppliedCents: number; paidCents: number; balanceCents: number }
interface BalanceLine { at: string; kind: string; label: string; amountCents: number; runningCents: number; adjustmentId?: string; voidable?: boolean }
interface BalanceView {
  bookings: BalanceBooking[]; lines: BalanceLine[]; creditAvailableCents: number;
  totals: { chargedCents: number; discountCents: number; creditCents: number; paidCents: number; owedCents: number };
}

function balanceView(value: unknown): BalanceView | null {
  const data = (value as { balance?: unknown } | null)?.balance as BalanceView | undefined;
  return data && Array.isArray(data.bookings) && Array.isArray(data.lines) && data.totals && typeof data.totals.owedCents === "number" ? data : null;
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

export default function FinalReservationPanel({ applicationId, sourceEventId, snapshot, deadlineEnforced = true }: {
  applicationId: string;
  sourceEventId: string;
  snapshot: ReservationPlanningSnapshot;
  /** False when unpaid bookings are not released on a timer; the wording then drops the 48-hour deadline. */
  deadlineEnforced?: boolean;
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
  const [busy, setBusy] = useState<"reserve" | "checkout" | "access" | "reopen" | "withdraw" | "change" | "bill" | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unavailable, setUnavailable] = useState<Array<{ date: string; reasons: string[] }>>([]);
  const [replaceLinkConfirmed, setReplaceLinkConfirmed] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const [addingDates, setAddingDates] = useState(false);
  const [withdrawNote, setWithdrawNote] = useState("");
  const [withdrawTarget, setWithdrawTarget] = useState<string | null>(null);
  const [changeTarget, setChangeTarget] = useState<string | null>(null);
  const [changeDates, setChangeDates] = useState<string[]>([]);
  const [changeBooths, setChangeBooths] = useState("1");
  const [changeNote, setChangeNote] = useState("");
  const [invoices, setInvoices] = useState<InvoiceInfo[]>([]);
  const [billingAvailable, setBillingAvailable] = useState(false);
  const [billTarget, setBillTarget] = useState<string | null>(null);
  const [billPlan, setBillPlan] = useState<"full" | "monthly">("full");
  const [billCount, setBillCount] = useState("3");
  const [billFirstDue, setBillFirstDue] = useState("");
  const [billAmount, setBillAmount] = useState("");
  const [billReason, setBillReason] = useState("");
  const [insuranceExpiresOn, setInsuranceExpiresOn] = useState<string | null>(null);
  const [bookingRequest, setBookingRequest] = useState<BookingRequestView | null>(null);
  const [declineNote, setDeclineNote] = useState("");
  const [declining, setDeclining] = useState(false);
  // Rolling balance, discounts and credits. Declared last so earlier state keeps its order.
  const [balance, setBalance] = useState<BalanceView | null>(null);
  const [discountTarget, setDiscountTarget] = useState<string | null>(null);
  const [discountMode, setDiscountMode] = useState<"amount" | "percent">("amount");
  const [discountValue, setDiscountValue] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const [creditOpen, setCreditOpen] = useState(false);
  const [creditAmount, setCreditAmount] = useState("");
  const [creditReason, setCreditReason] = useState("");
  const [billUseCredit, setBillUseCredit] = useState(false);
  const [billReplace, setBillReplace] = useState<string | null>(null);
  // Review-then-confirm steps for saving dates.
  const [addConfirming, setAddConfirming] = useState(false);
  const [changeConfirming, setChangeConfirming] = useState(false);

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
        const owed = await fetch(`/api/admin/applications/${encodeURIComponent(applicationId)}/balance`, { headers: { Accept: "application/json" }, cache: "no-store", signal });
        const body = await jsonBody(owed);
        if (!signal?.aborted && revision === statusRead.current.revision) setBalance(owed.ok ? balanceView(body) : null);
      } catch { /* the balance is optional; the rest of the panel still works */ }
      try {
        const billed = await fetch(`/api/admin/applications/${encodeURIComponent(applicationId)}/invoices`, { headers: { Accept: "application/json" }, cache: "no-store", signal });
        const body = await jsonBody(billed);
        if (!signal?.aborted && revision === statusRead.current.revision) {
          setInvoices(billed.ok ? invoiceList(body) : []);
          setBillingAvailable(billed.ok && (body as { available?: unknown } | null)?.available === true);
        }
      } catch { /* billing is optional; the rest of the panel still works */ }
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
    setAddConfirming(false);
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
    // First press shows the review; nothing is saved until "Confirm and save".
    if (!addConfirming) {
      const upcoming = { ...form, selectedDates: form.selectedDates.filter(date => date >= todayEastern()) };
      const checked = finalReservationRequest(upcoming, snapshot.requiresFinalDateConfirmation);
      if ("error" in checked) { setError(checked.error); return; }
      setForm(upcoming);
      setError("");
      setAddConfirming(true);
      return;
    }
    const request = finalReservationRequest(form, snapshot.requiresFinalDateConfirmation);
    if ("error" in request) { setError(request.error); setAddConfirming(false); return; }
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

  function startChange(reservation: FinalReservationView) {
    setChangeTarget(reservation.id);
    setChangeConfirming(false);
    // Saturdays that already happened stay on the booking and its bill; only upcoming ones can change.
    setChangeDates([...reservation.finalDates].sort());
    setChangeBooths(String(reservation.finalBoothQuantity));
    setChangeNote("");
    setWithdrawTarget(null);
    setError(""); setNotice("");
  }

  async function changeBookingDates(reservation: FinalReservationView) {
    const booths = Number(changeBooths);
    if (inFlight.current || statusRead.current.pending || loadError || !CHANGEABLE_STATES.has(reservation.state) || !changeDates.length) return;
    if (!Number.isSafeInteger(booths) || booths < 1 || booths > 10) { setError("Booths per Saturday must be between 1 and 10."); return; }
    inFlight.current = true;
    setBusy("change");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/reservations/${encodeURIComponent(reservation.id)}/change-dates`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ dates: [...changeDates].sort(), booths, note: changeNote.trim() }),
      });
      const payload = await jsonBody(response);
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok && response.status !== 503) { setError(reservationError(payload, "The dates could not be changed.")); return; }
      setChangeTarget(null);
      const delivery = (payload as { vendorNotification?: unknown } | null)?.vendorNotification;
      // Reload shows the withdrawn booking and the new one; it refuses to run while a write is in flight.
      inFlight.current = false;
      await load();
      if (!response.ok) setError(reservationError(payload, "The new dates are booked, but the payment link could not be sent. Use the buttons on the new booking."));
      else setNotice(delivery === "sent"
        ? "Dates changed. The old payment link was cancelled and the vendor was emailed their new dates and payment link."
        : "Dates changed and the old payment link was cancelled, but the email could not be sent. Use \"Email the payment link\" on the new booking.");
    } catch {
      setError("The dates could not be changed. Reload reservation status to see where it stands.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  function owedOn(reservation: FinalReservationView): number {
    return balance?.bookings?.find(item => item.reservationId === reservation.id)?.balanceCents ?? reservation.totalCents;
  }

  function startBilling(reservation: FinalReservationView, replaceInvoiceId: string | null = null) {
    setBillTarget(reservation.id);
    setBillReplace(replaceInvoiceId);
    setBillPlan("full");
    setBillCount("3");
    setBillFirstDue(todayEastern());
    setBillUseCredit(false);
    setBillAmount((owedOn(reservation) / 100).toFixed(2));
    setBillReason("");
    setChangeTarget(null); setWithdrawTarget(null); setError(""); setNotice("");
  }

  /** What this bill starts from: owed on the booking, less vendor credit when ticked. */
  function billBase(reservation: FinalReservationView): number {
    const owed = owedOn(reservation);
    return billUseCredit ? Math.max(0, owed - Math.min(balance?.creditAvailableCents ?? 0, owed)) : owed;
  }

  function billingRequest(reservation: FinalReservationView) {
    const cents = Math.round(Number(billAmount) * 100);
    const base = billBase(reservation);
    if (Number.isFinite(cents) && cents > base) return { error: `That's more than the ${money(base)} owed. To charge more, add dates instead.` };
    return planBilling({
      plan: billPlan, installments: Number(billCount), firstDueOn: billFirstDue,
      totalCents: Number.isFinite(cents) ? cents : NaN, reason: billReason,
      quotedCents: base, today: todayEastern(),
    });
  }

  async function sendInvoice(reservation: FinalReservationView) {
    if (inFlight.current || statusRead.current.pending || loadError) return;
    const planned = billingRequest(reservation);
    if ("error" in planned) { setError(planned.error); return; }
    const summary = planned.plan === "full"
      ? `one payment of ${money(planned.totalCents)} due ${reservationDateLabel(planned.installments[0].dueOn)}`
      : `${planned.installments.length} monthly payments totalling ${money(planned.totalCents)}, first due ${reservationDateLabel(planned.installments[0].dueOn)}`;
    if (!window.confirm(`${billReplace ? "The current invoice's unpaid payments will be cancelled and replaced. " : ""}Square will email this vendor ${planned.plan === "full" ? "an invoice" : "invoices"} for ${summary}. Their current payment link stops working. Send it?`)) return;
    inFlight.current = true;
    setBusy("bill"); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/admin/reservations/${encodeURIComponent(reservation.id)}/invoice`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ plan: planned.plan, installments: planned.installments.length, firstDueOn: planned.installments[0].dueOn, totalCents: planned.totalCents, reason: planned.reason, useCredit: billUseCredit, ...(billReplace ? { replaceInvoiceId: billReplace } : {}) }),
      });
      const payload = await jsonBody(response);
      if (response.status === 401) { router.replace("/login"); return; }
      inFlight.current = false;
      if (!response.ok) { await load(); setError(reservationError(payload, "The invoice could not be sent.")); return; }
      setBillTarget(null);
      await load();
      setNotice("Invoice sent. Square emailed the vendor and will send reminders; this page updates as payments arrive.");
    } catch {
      setError("The invoice could not be sent. Reload reservation status to see where it stands.");
    } finally { inFlight.current = false; setBusy(null); }
  }

  async function cancelInvoice(invoice: InvoiceInfo) {
    if (inFlight.current || statusRead.current.pending || loadError) return;
    if (!window.confirm("Cancel this Square invoice? Square stops collecting and sending reminders. Payments already made stay recorded.")) return;
    inFlight.current = true;
    setBusy("bill"); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/admin/invoices/${encodeURIComponent(invoice.id)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}" });
      const payload = await jsonBody(response);
      if (response.status === 401) { router.replace("/login"); return; }
      inFlight.current = false;
      await load();
      if (!response.ok) setError(reservationError(payload, "The invoice could not be cancelled."));
      else setNotice("Invoice cancelled. You can send a new payment link or a new invoice from the booking card.");
    } catch {
      setError("The invoice could not be cancelled. Reload reservation status and try again.");
    } finally { inFlight.current = false; setBusy(null); }
  }

  async function postAdjustment(url: string, body: unknown, done: string) {
    if (inFlight.current || statusRead.current.pending || loadError) return false;
    inFlight.current = true;
    setBusy("bill"); setError(""); setNotice("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
      const payload = await jsonBody(response);
      if (response.status === 401) { router.replace("/login"); return false; }
      inFlight.current = false;
      if (!response.ok) { setError(reservationError(payload, "That change could not be saved.")); return false; }
      await load();
      setNotice(done);
      return true;
    } catch { setError("That change could not be saved. Reload and try again."); return false; }
    finally { inFlight.current = false; setBusy(null); }
  }

  async function saveDiscount(reservation: FinalReservationView) {
    const value = Number(discountValue);
    if (!Number.isFinite(value) || value <= 0) { setError("Enter a discount above zero."); return; }
    if (!discountReason.trim()) { setError("Say why (kept on record)."); return; }
    const body = discountMode === "percent" ? { percent: value, reason: discountReason } : { amountCents: Math.round(value * 100), reason: discountReason };
    if (await postAdjustment(`/api/admin/reservations/${encodeURIComponent(reservation.id)}/discount`, body, "Discount saved. Bill the vendor with \"Bill this vendor\" so they pay the new amount.")) setDiscountTarget(null);
  }

  async function saveCredit() {
    const value = Number(creditAmount);
    if (!Number.isFinite(value) || value <= 0) { setError("Enter a credit above zero."); return; }
    if (!creditReason.trim()) { setError("Say why (kept on record)."); return; }
    if (await postAdjustment(`/api/admin/applications/${encodeURIComponent(applicationId)}/credit`, { amountCents: Math.round(value * 100), reason: creditReason }, "Credit added to the vendor's balance. Tick \"Use vendor credit\" when you bill a booking.")) {
      setCreditOpen(false); setCreditAmount(""); setCreditReason("");
    }
  }

  async function undoAdjustment(line: BalanceLine) {
    if (!line.adjustmentId || !window.confirm(`Undo "${line.label}"? It stays on record as undone.`)) return;
    await postAdjustment(`/api/admin/adjustments/${encodeURIComponent(line.adjustmentId)}/void`, {}, "Undone.");
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
        ? (deadlineEnforced
          ? "Confirmed. The dates are booked and the vendor was emailed their payment link (48 hours to pay)."
          : "Confirmed. The dates are booked and the vendor was emailed their payment link.")
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

      {!loading && !loadError && balance && (balance.bookings?.length > 0 || balance.totals?.creditCents > 0) && (
        <section className="mt-6 rounded-2xl border border-pine/15 bg-white p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold text-pine-deep">Balance</h3>
            <p className={`text-lg font-bold ${balance.totals.owedCents > 0 ? "text-clay" : "text-pine"}`}>{balance.totals.owedCents >= 0 ? `${money(balance.totals.owedCents)} owed` : `${money(-balance.totals.owedCents)} in credit`}</p>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><dt className="text-ink/55">Booked</dt><dd className="font-semibold text-pine-deep">{money(balance.totals.chargedCents)}</dd></div>
            <div><dt className="text-ink/55">Discounts</dt><dd className="font-semibold text-pine-deep">{money(balance.totals.discountCents)}</dd></div>
            <div><dt className="text-ink/55">Credits</dt><dd className="font-semibold text-pine-deep">{money(balance.totals.creditCents)}{balance.creditAvailableCents > 0 ? ` (${money(balance.creditAvailableCents)} unused)` : ""}</dd></div>
            <div><dt className="text-ink/55">Paid</dt><dd className="font-semibold text-pine-deep">{money(balance.totals.paidCents)}</dd></div>
          </dl>
          {balance.lines.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-ink/50"><tr><th className="py-1 pr-3">Date</th><th className="py-1 pr-3">What</th><th className="py-1 pr-3 text-right">Amount</th><th className="py-1 pr-3 text-right">Balance</th><th /></tr></thead>
                <tbody>
                  {balance.lines.map((line, index) => (
                    <tr key={`${line.at}-${index}`} className="border-t border-pine/10 align-top">
                      <td className="py-2 pr-3 whitespace-nowrap text-ink/60">{new Date(line.at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}</td>
                      <td className="py-2 pr-3 text-ink/80">{line.label}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">{line.amountCents === 0 ? "—" : line.amountCents > 0 ? money(line.amountCents) : `−${money(-line.amountCents)}`}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap font-semibold text-pine-deep">{money(line.runningCents)}</td>
                      <td className="py-2 text-right">{line.adjustmentId && line.voidable && <button type="button" disabled={disabled} onClick={() => void undoAdjustment(line)} className="text-xs font-semibold text-clay underline underline-offset-4">Undo</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!creditOpen && <button type="button" disabled={disabled} onClick={() => { setCreditOpen(true); setError(""); setNotice(""); }} className={`${QUIET_BUTTON} mt-4`}>Add a credit</button>}
          {creditOpen && <div className="mt-4 flex flex-wrap items-end gap-3 text-sm">
            <label className="font-semibold text-pine-deep">Credit ($)
              <input type="number" min={0.01} step="0.01" value={creditAmount} disabled={disabled} onChange={event => setCreditAmount(event.target.value)} className={`${FIELD} w-32`} />
            </label>
            <label className="min-w-64 flex-1 font-semibold text-pine-deep">Why (kept on record)
              <input type="text" maxLength={300} value={creditReason} disabled={disabled} onChange={event => setCreditReason(event.target.value)} placeholder="Example: Rain-out on Oct 10" className={FIELD} />
            </label>
            <button type="button" disabled={disabled} onClick={() => void saveCredit()} className={BUTTON}>Save credit</button>
            <button type="button" disabled={disabled} onClick={() => setCreditOpen(false)} className={QUIET_BUTTON}>Cancel</button>
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
                {(() => {
                  const owed = balance?.bookings?.find(item => item.reservationId === reservation.id);
                  if (!owed || (!owed.discountCents && !owed.creditAppliedCents && !owed.paidCents)) return null;
                  return <p className="mt-3 text-sm text-pine-deep">Owed on this booking: <strong>{money(owed.balanceCents)}</strong> <span className="text-ink/60">({money(owed.chargeCents)}{owed.discountCents ? ` − ${money(owed.discountCents)} discount` : ""}{owed.creditAppliedCents ? ` − ${money(owed.creditAppliedCents)} credit` : ""}{owed.paidCents ? ` − ${money(owed.paidCents)} paid` : ""})</span></p>;
                })()}
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

                {reservation.paymentRequired && ["held", "payment_pending"].includes(reservation.state) && (balance?.bookings?.find(item => item.reservationId === reservation.id)?.discountCents || balance?.bookings?.find(item => item.reservationId === reservation.id)?.creditAppliedCents) && !invoices.some(item => item.reservationId === reservation.id && (item.status === "open" || item.status === "creating")) ? (
                  <p className="mt-5 rounded-2xl bg-amber/15 p-4 text-sm text-clay">This booking's price was changed, so the full-price payment link is turned off. Use "Bill this vendor" to send the new amount.</p>
                ) : null}
                {reservation.paymentRequired && ["held", "payment_pending"].includes(reservation.state) && !invoices.some(item => item.reservationId === reservation.id && (item.status === "open" || item.status === "creating")) && !(balance?.bookings?.find(item => item.reservationId === reservation.id)?.discountCents || balance?.bookings?.find(item => item.reservationId === reservation.id)?.creditAppliedCents) && (
                  <section className="mt-5 rounded-2xl border border-pine/15 bg-white/60 p-5">
                    <h4 className="font-semibold text-pine-deep">Payment request</h4>
                    <p className="mt-2 text-sm leading-relaxed text-ink/65">{deadlineEnforced
                      ? "The vendor has 48 hours from creation of the Square payment request. Repeating this action retrieves the same request and does not extend its deadline."
                      : "The payment link stays open until the vendor pays or you withdraw this booking. Nothing is released automatically. Repeating this action retrieves the same request."}</p>
                    <button type="button" disabled={disabled} onClick={() => void checkout(reservation)} className={`${BUTTON} mt-4`}>{busy === "checkout" ? "Preparing payment request…" : paymentOrder || reservation.state === "payment_pending" ? "Retrieve payment request" : "Create payment request"}</button>
                    {paymentOrder && <div role="status" className="mt-4 rounded-xl bg-pine/10 p-4 text-sm text-pine">
                      <p>{paymentOrder.status === "checkout_created" ? "Payment request ready; payment has not been confirmed." : `Payment request status: ${paymentOrder.status.replaceAll("_", " ")}.`}</p>
                      {paymentOrder.paymentDueAt && <p className="mt-1">{deadlineEnforced ? "Payment deadline" : "Asked to pay by"}: {deadlineLabel(paymentOrder.paymentDueAt)}{deadlineEnforced ? "" : " (not a cut-off; the link still works after this)"}</p>}
                    </div>}
                  </section>
                )}

                {canCreateAccess(reservation) && !invoices.some(item => item.reservationId === reservation.id && (item.status === "open" || item.status === "creating")) && !(balance?.bookings?.find(item => item.reservationId === reservation.id)?.discountCents || balance?.bookings?.find(item => item.reservationId === reservation.id)?.creditAppliedCents) && (
                  <section className="mt-5 rounded-2xl border border-pine/15 bg-white/60 p-5">
                    <h4 className="font-semibold text-pine-deep">Email the payment link</h4>
                    <p className="mt-2 text-sm leading-relaxed text-ink/65">Emails the vendor their private reservation page with the total and their dates{deadlineEnforced ? " and the 48-hour deadline" : ", and asks them to pay within 48 hours"}. The link is only for this vendor; anyone who has it can open this reservation. Sending again issues a fresh link and revokes the old one.</p>
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

                {(() => {
                  const invoice = invoices.find(item => item.reservationId === reservation.id) ?? null;
                  const live = invoice && (invoice.status === "open" || invoice.status === "creating");
                  const canBill = billingAvailable && reservation.paymentRequired && (reservation.state === "held" || reservation.state === "payment_pending") && (!live || billTarget === reservation.id);
                  if (!invoice && !canBill) return null;
                  const billing = billTarget === reservation.id;
                  const planned = billing ? billingRequest(reservation) : null;
                  const amountCents = Math.round(Number(billAmount) * 100);
                  const base = billing ? billBase(reservation) : 0;
                  const creditAvailable = balance?.creditAvailableCents ?? 0;
                  return (
                    <section className="mt-5 rounded-2xl border border-amber/40 bg-white/60 p-5">
                      <h4 className="font-semibold text-pine-deep">Bill with a Square invoice</h4>
                      {invoice && invoice.status !== "cancelled" && (
                        <div className="mt-3 rounded-xl bg-parchment/70 p-4 text-sm">
                          <p className="font-semibold text-pine-deep">{INVOICE_STATUS[invoice.status]} · {invoice.plan === "full" ? "one payment" : `${invoice.installments.length} monthly payments`}</p>
                          <p className="mt-1 text-pine">Paid {money(invoice.paidCents)} of {money(invoice.totalCents)}{invoice.plan === "monthly" ? ` (${invoice.installmentsPaid} of ${invoice.installments.length} payments)` : ""}</p>
                          {invoice.adjustmentReason && <p className="mt-1 text-xs text-ink/60">Amount changed from the booking price: {invoice.adjustmentReason}</p>}
                          <ul className="mt-2 space-y-1 text-xs text-ink/70">
                            {invoice.installments.map(item => <li key={item.seq}>{(item.paidCents ?? 0) >= item.amountCents || (item.paidCents === undefined && item.seq <= invoice.installmentsPaid) ? "✓ Paid: " : ""}{money(item.amountCents)} due {reservationDateLabel(item.dueOn)}</li>)}
                          </ul>
                          {invoice.status === "failed" && invoice.lastError && <p className="mt-2 text-xs text-clay">{invoice.lastError}</p>}
                          <div className="mt-3 flex flex-wrap gap-3">
                            {invoice.publicUrl && <a href={invoice.publicUrl} target="_blank" rel="noreferrer" className="text-sm font-semibold text-pine underline underline-offset-4">Open the invoice in Square</a>}
                            {live && billTarget !== reservation.id && <button type="button" disabled={disabled} onClick={() => startBilling(reservation, invoice.id)} className={QUIET_BUTTON}>Change amount</button>}
                            {live && <button type="button" disabled={disabled} onClick={() => void cancelInvoice(invoice)} className={QUIET_BUTTON}>Cancel invoice</button>}
                          </div>
                        </div>
                      )}
                      {canBill && !billing && <>
                        <p className="mt-2 text-sm leading-relaxed text-ink/65">Have Square email the vendor an invoice instead of the payment link: one payment, or a monthly plan. Square sends reminders and this page shows each payment as it arrives.</p>
                        <button type="button" disabled={disabled} onClick={() => startBilling(reservation)} className={`${QUIET_BUTTON} mt-4`}>Bill this vendor</button>
                      </>}
                      {canBill && billing && <div className="mt-4 space-y-3 text-sm">
                        {billReplace && <p className="rounded-xl bg-amber/15 p-3 text-clay">Changing the amount cancels this invoice's unpaid payments and sends new ones. Payments already made stay on the balance.</p>}
                        {creditAvailable > 0 && <label className="flex items-center gap-2"><input type="checkbox" checked={billUseCredit} disabled={disabled} onChange={event => { setBillUseCredit(event.target.checked); const owed = owedOn(reservation); setBillAmount(((event.target.checked ? owed - Math.min(creditAvailable, owed) : owed) / 100).toFixed(2)); }} /> Use vendor credit ({money(Math.min(creditAvailable, owedOn(reservation)))} available)</label>}
                        <div className="flex flex-wrap gap-4">
                          <label className="flex items-center gap-2"><input type="radio" checked={billPlan === "full"} disabled={disabled} onChange={() => setBillPlan("full")} /> Pay in full</label>
                          <label className="flex items-center gap-2"><input type="radio" checked={billPlan === "monthly"} disabled={disabled} onChange={() => setBillPlan("monthly")} /> Monthly plan</label>
                        </div>
                        <div className="flex flex-wrap gap-4">
                          {billPlan === "monthly" && <label className="font-semibold text-pine-deep">Payments
                            <select value={billCount} disabled={disabled} onChange={event => setBillCount(event.target.value)} className={`${FIELD} w-24`}>
                              {Array.from({ length: MAX_INSTALLMENTS - MIN_INSTALLMENTS + 1 }, (_, i) => i + MIN_INSTALLMENTS).map(n => <option key={n} value={n}>{n}</option>)}
                            </select>
                          </label>}
                          <label className="font-semibold text-pine-deep">{billPlan === "monthly" ? "First payment due" : "Due"}
                            <input type="date" value={billFirstDue} min={todayEastern()} disabled={disabled} onChange={event => setBillFirstDue(event.target.value)} className={`${FIELD} w-44`} />
                          </label>
                          <label className="font-semibold text-pine-deep">Amount ($)
                            <input type="number" min={1} step="0.01" value={billAmount} disabled={disabled} onChange={event => setBillAmount(event.target.value)} className={`${FIELD} w-32`} />
                          </label>
                        </div>
                        {Number.isFinite(amountCents) && amountCents < base && (
                          <label className="block font-semibold text-pine-deep">Why is it less than the {money(base)} owed? (saved as a discount on the balance, not shown to the vendor)
                            <input type="text" value={billReason} maxLength={300} disabled={disabled} onChange={event => setBillReason(event.target.value)} placeholder="Example: 10% discount agreed with Thomas" className={FIELD} />
                          </label>
                        )}
                        {planned && ("error" in planned
                          ? <p className="text-xs text-clay">{planned.error}</p>
                          : <div className="rounded-xl bg-parchment/70 p-3">
                            <p className="font-semibold text-pine-deep">Square will send {planned.installments.length === 1 ? "one invoice" : `${planned.installments.length} separate invoices`}:</p>
                            <ul className="mt-1 space-y-1 text-ink/75">{planned.installments.map(item => {
                              const sendOn = invoiceSendDate(item.dueOn, todayEastern());
                              return <li key={item.seq}>{money(item.amountCents)} due {reservationDateLabel(item.dueOn)} · emailed {sendOn ? reservationDateLabel(sendOn) : "right away"}</li>;
                            })}</ul>
                          </div>)}
                        <div className="flex flex-wrap gap-3">
                          <button type="button" disabled={disabled || !planned || "error" in planned} onClick={() => void sendInvoice(reservation)} className={BUTTON}>{busy === "bill" ? "Sending…" : "Send invoice"}</button>
                          <button type="button" disabled={disabled} onClick={() => { setBillTarget(null); setBillReplace(null); }} className={QUIET_BUTTON}>Cancel</button>
                        </div>
                      </div>}
                    </section>
                  );
                })()}

                {(reservation.state === "held" || reservation.state === "payment_pending") && reservation.paymentRequired && billingAvailable && !invoices.some(item => item.reservationId === reservation.id && (item.status === "open" || item.status === "creating")) && (
                  <section className="mt-5 rounded-2xl border border-pine/15 bg-white/60 p-5">
                    <h4 className="font-semibold text-pine-deep">Discount this booking</h4>
                    {discountTarget !== reservation.id && <>
                      <p className="mt-2 text-sm leading-relaxed text-ink/65">Lower this booking's price by an amount or a percent. It shows on the vendor's balance; bill them with "Bill this vendor" so they pay the new amount.</p>
                      <button type="button" disabled={disabled} onClick={() => { setDiscountTarget(reservation.id); setDiscountMode("amount"); setDiscountValue(""); setDiscountReason(""); setError(""); setNotice(""); }} className={`${QUIET_BUTTON} mt-4`}>Add a discount</button>
                    </>}
                    {discountTarget === reservation.id && <div className="mt-3 space-y-3 text-sm">
                      <div className="flex flex-wrap gap-4">
                        <label className="flex items-center gap-2"><input type="radio" checked={discountMode === "amount"} disabled={disabled} onChange={() => setDiscountMode("amount")} /> Dollar amount</label>
                        <label className="flex items-center gap-2"><input type="radio" checked={discountMode === "percent"} disabled={disabled} onChange={() => setDiscountMode("percent")} /> Percent of {money(reservation.totalCents)}</label>
                      </div>
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="font-semibold text-pine-deep">{discountMode === "percent" ? "Percent (%)" : "Amount ($)"}
                          <input type="number" min={0.01} step="0.01" value={discountValue} disabled={disabled} onChange={event => setDiscountValue(event.target.value)} className={`${FIELD} w-32`} />
                        </label>
                        <p className="pb-3 text-pine-deep">New price: <strong>{(() => { const v = Number(discountValue); const cut = discountMode === "percent" ? Math.round(reservation.totalCents * v / 100) : Math.round(v * 100); return Number.isFinite(cut) && cut > 0 ? money(Math.max(0, owedOn(reservation) - cut)) : "—"; })()}</strong></p>
                      </div>
                      <label className="block font-semibold text-pine-deep">Why (kept on record, not shown to the vendor)
                        <input type="text" maxLength={300} value={discountReason} disabled={disabled} onChange={event => setDiscountReason(event.target.value)} placeholder="Example: Returning vendor, 10% off" className={FIELD} />
                      </label>
                      <div className="flex flex-wrap gap-3">
                        <button type="button" disabled={disabled} onClick={() => void saveDiscount(reservation)} className={BUTTON}>Save discount</button>
                        <button type="button" disabled={disabled} onClick={() => setDiscountTarget(null)} className={QUIET_BUTTON}>Cancel</button>
                      </div>
                    </div>}
                  </section>
                )}

                {CHANGEABLE_STATES.has(reservation.state) && reservation.paymentRequired && !invoices.some(item => item.reservationId === reservation.id && (item.status === "open" || item.status === "creating")) && !(balance?.bookings?.find(item => item.reservationId === reservation.id)?.discountCents || balance?.bookings?.find(item => item.reservationId === reservation.id)?.creditAppliedCents) && (() => {
                  const changing = changeTarget === reservation.id;
                  const otherHeld = new Set(liveReservations.filter(item => item.id !== reservation.id).flatMap(item => item.finalDates));
                  const today = todayEastern();
                  const total = changing ? previewTotal(changeDates, Number(changeBooths)) : null;
                  return (
                    <section className="mt-5 rounded-2xl border border-pine/15 bg-white/60 p-5">
                      <h4 className="font-semibold text-pine-deep">Change dates</h4>
                      <p className="mt-2 text-sm leading-relaxed text-ink/65">Move this unpaid booking to other Saturdays in one step. The old payment link is cancelled and the vendor gets one email with their new dates, new total and a new payment link.</p>
                      {!changing && <button type="button" disabled={disabled} onClick={() => startChange(reservation)} className={`${QUIET_BUTTON} mt-4`}>Change dates</button>}
                      {changing && <div className="mt-4">
                        <p className="text-sm font-semibold text-pine-deep">New Saturdays ({changeDates.length} picked)</p>
                        {reservation.finalDates.some(date => date < today) && <p className="mt-1 text-xs text-ink/60">{reservation.finalDates.filter(date => date < today).map(reservationDateLabel).join(", ")} already happened. {reservation.finalDates.filter(date => date < today).length === 1 ? "It stays" : "They stay"} on the booking and the bill.</p>}
                        <div className="mt-2">
                          <SaturdayPicker dates={FRESH_AIR_SEASON_DATES} today={today} booked={reservation.finalDates} selected={changeDates}
                            onChange={next => { setChangeDates(next); setChangeConfirming(false); }}
                            blockedReason={date => otherHeld.has(date) ? "Other booking" : uninsured(date) ? "After insurance" : null}
                            disabled={disabled || changeConfirming} />
                        </div>
                        <div className="mt-3 flex flex-wrap items-end gap-4">
                          <label className="text-sm font-semibold text-pine-deep">Booths per Saturday
                            <input type="number" min={1} max={10} value={changeBooths} disabled={disabled} onChange={event => setChangeBooths(event.target.value)} className={`${FIELD} w-24`} />
                          </label>
                          <p className="pb-3 text-sm text-pine-deep">New total: <strong>{total === null ? "—" : money(total)}</strong> <span className="text-ink/55">(was {money(reservation.totalCents)})</span></p>
                        </div>
                        <label className="mt-3 block text-sm font-semibold text-pine-deep">Note to the vendor (optional)
                          <textarea value={changeNote} disabled={disabled} maxLength={500} rows={2} onChange={event => setChangeNote(event.target.value)} placeholder="Example: As we discussed on the phone, here are your October dates." className={FIELD} />
                        </label>
                        {!changeConfirming && <div className="mt-3 flex flex-wrap gap-3">
                          <button type="button" disabled={disabled || !changeDates.length} onClick={() => { setError(""); setChangeConfirming(true); }} className={BUTTON}>Review changes</button>
                          <button type="button" disabled={disabled} onClick={() => setChangeTarget(null)} className={QUIET_BUTTON}>Cancel</button>
                        </div>}
                        {changeConfirming && (() => {
                          const adding = changeDates.filter(date => !reservation.finalDates.includes(date));
                          const removing = reservation.finalDates.filter(date => !changeDates.includes(date));
                          return (
                            <div role="region" aria-label="Confirm date change" className="mt-4 rounded-2xl border-2 border-pine bg-parchment/70 p-4 text-sm">
                              <h5 className="font-semibold text-pine-deep">Confirm the new dates</h5>
                              {adding.length > 0 && <p className="mt-2 text-pine-deep">Adding: {adding.map(reservationDateLabel).join(" · ")}</p>}
                              {removing.length > 0 && <p className="mt-1 text-clay">Removing: {removing.map(reservationDateLabel).join(" · ")}</p>}
                              {!adding.length && !removing.length && <p className="mt-2 text-ink/70">Same Saturdays; booths per Saturday change to {changeBooths}.</p>}
                              <p className="mt-1 text-pine-deep">New total: <strong>{total === null ? "—" : money(total)}</strong> (was {money(reservation.totalCents)})</p>
                              <p className="mt-2 text-xs text-ink/60">Saving cancels the old payment link and emails the vendor their new dates and a new payment link.</p>
                              <div className="mt-3 flex flex-wrap gap-3">
                                <button type="button" disabled={disabled || !changeDates.length} onClick={() => void changeBookingDates(reservation)} className={BUTTON}>{busy === "change" ? "Saving…" : "Confirm and save"}</button>
                                <button type="button" disabled={disabled} onClick={() => setChangeConfirming(false)} className={QUIET_BUTTON}>Go back</button>
                              </div>
                            </div>
                          );
                        })()}
                      </div>}
                    </section>
                  );
                })()}

                {WITHDRAWABLE_STATES.has(reservation.state) && !invoices.some(item => item.reservationId === reservation.id && (item.status === "open" || item.status === "creating")) && (
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
              <p className="mt-1 text-xs leading-relaxed text-ink/60">35 Saturdays, October 3, 2026 through May 29, 2027. Requested dates are suggestions; confirm the final selection with the vendor.{reservations.length ? " This booking is priced on its own dates: $40 per Saturday, $35 when it includes 4 or more Saturdays in a row." : ""}</p>
              {hasUnmappedRequestedDates && <p className="mt-3 rounded-xl bg-amber/15 p-3 text-sm text-clay">Some requested values do not match the confirmed calendar. Review the original request above and choose the final dates here.</p>}
              {insuranceExpiresOn && !fullSeasonCovered && <p className="mt-3 rounded-xl bg-amber/15 p-3 text-sm text-clay">Their certificate of insurance expires {reservationDateLabel(insuranceExpiresOn)}. Saturdays after that are greyed out until a renewed certificate is approved.</p>}
              {heldDates.size === 0 && fullSeasonCovered && todayEastern() <= FRESH_AIR_SEASON_DATES[0] && <label className="mt-3 flex items-start gap-3 rounded-xl border border-pine/20 bg-parchment/40 p-4 text-sm font-semibold text-pine-deep">
                <input type="checkbox" checked={form.fullSeason} onChange={event => edit({ fullSeason: event.target.checked, selectedDates: [] })} className="mt-0.5" />
                Full season — all 35 dates through Saturday, May 29, 2027
              </label>}
              {!form.fullSeason && <div className="mt-3">
                <SaturdayPicker dates={FRESH_AIR_SEASON_DATES} today={todayEastern()} booked={[...heldDates]} lockBooked
                  selected={[...heldDates, ...form.selectedDates.filter(date => !heldDates.has(date))]}
                  onChange={next => edit({ selectedDates: next.filter(date => !heldDates.has(date)) })}
                  blockedReason={date => uninsured(date) ? "After insurance" : null} disabled={disabled || addConfirming} />
              </div>}
              <p className="mt-2 text-xs font-semibold text-pine">{form.fullSeason ? 35 : form.selectedDates.filter(date => date >= todayEastern()).length} market dates selected</p>
              {snapshot.requiresFinalDateConfirmation && <label className="mt-4 flex items-start gap-3 rounded-xl bg-amber/15 p-4 text-sm text-clay">
                <input required type="checkbox" checked={form.finalDatesConfirmed} onChange={event => edit({ finalDatesConfirmed: event.target.checked })} className="mt-0.5" />
                <span>The earlier request referred to May 27. I have confirmed the final dates with the vendor, including Saturday, May 29, 2027 when selected.</span>
              </label>}
            </fieldset>
          </fieldset>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-pine/10 pt-5">
            <p className="max-w-md text-xs leading-relaxed text-ink/60">Saving reserves the complete selected set if all checks pass. Payment is a separate action below. A saved booking cannot be edited; withdraw it and add new dates instead.</p>
            <div className="flex flex-wrap gap-3">
              {reservations.length > 0 && addingDates && <button type="button" disabled={disabled} onClick={() => { setAddingDates(false); setAddConfirming(false); }} className={QUIET_BUTTON}>Cancel</button>}
              {!addConfirming && <button type="submit" disabled={disabled} className={BUTTON}>Review booking</button>}
            </div>
          </div>
          {addConfirming && (() => {
            const chosen = form.fullSeason ? [...FRESH_AIR_SEASON_DATES] : form.selectedDates;
            const booths = Number(form.boothsPerMarket);
            const total = form.applicantType === "Non-Profit Organization" ? 0 : previewTotal(chosen, booths);
            return (
              <div role="region" aria-label="Confirm booking" className="rounded-2xl border-2 border-pine bg-parchment/70 p-5">
                <h4 className="font-semibold text-pine-deep">Confirm this booking</h4>
                <p className="mt-2 text-sm text-pine-deep">{booths} booth{booths === 1 ? "" : "s"} on {chosen.length} Saturday{chosen.length === 1 ? "" : "s"}: {chosen.map(reservationDateLabel).join(" · ")}</p>
                <p className="mt-1 text-sm text-pine-deep">Price: <strong>{total === null ? "checked on save" : money(total)}</strong></p>
                <p className="mt-2 text-xs text-ink/60">Saving reserves these dates if there is still room. You send the payment request next.</p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <button type="submit" disabled={disabled} className={BUTTON}>{busy === "reserve" ? "Saving…" : "Confirm and save"}</button>
                  <button type="button" disabled={disabled} onClick={() => setAddConfirming(false)} className={QUIET_BUTTON}>Go back</button>
                </div>
              </div>
            );
          })()}
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
