import { FRESH_AIR_SEASON_DATES } from "./fresh-air-season";
import { FAME_VENDOR_CATEGORIES } from "./vendor-booking-rules";

export interface ReservationPlanningSnapshot {
  applicantType: string;
  category: string;
  dates: string[];
  fullSeason: boolean;
  requiresFinalDateConfirmation: boolean;
}

export interface FinalReservationForm {
  applicantType: "" | "Vendor" | "Non-Profit Organization";
  vendorCategory: string;
  selectedDates: string[];
  fullSeason: boolean;
  boothsPerMarket: string;
  foodLicenseDecision: "" | "required" | "not_required";
  finalDatesConfirmed: boolean;
}

export interface FinalReservationView {
  id: string;
  state: "held" | "payment_pending" | "paid" | "confirmed" | "expired" | "cancelled" | "declined" | "manual_review";
  paymentRequired: boolean;
  totalCents: number;
  finalDates: string[];
  finalBoothQuantity: number;
  quoteVersion: string;
}

export interface ReservationPaymentView {
  id: string;
  checkoutUrl: string | null;
  paymentDueAt: string | null;
  status: string;
}

export interface VendorInvitationView {
  invitationUrl: string;
  expiresAt: string;
}

const SEASON_DATES = new Set<string>(FRESH_AIR_SEASON_DATES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(["held", "payment_pending", "paid", "confirmed", "expired", "cancelled", "declined", "manual_review"]);
const PAYMENT_STATES = new Set(["pending_checkout", "processing_checkout", "checkout_created", "expiry_pending", "paid", "expired", "cancelled", "manual_review", "failed"]);

export function reservationDateLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/** Suggest only exact canonical values. In particular, never move May 27 to May 29. */
export function requestedReservationDates(values: string[]): string[] {
  const labels = new Map(FRESH_AIR_SEASON_DATES.map(date => [reservationDateLabel(date), date]));
  const result = values.flatMap(value => {
    const trimmed = value.trim();
    if (SEASON_DATES.has(trimmed)) return [trimmed];
    const date = labels.get(trimmed);
    return date ? [date] : [];
  });
  return [...new Set(result)].sort();
}

/** UI validation improves feedback; the server independently rechecks every field. */
export function finalReservationRequest(form: FinalReservationForm, requiresFinalDateConfirmation: boolean):
  | { error: string }
  | { body: {
    applicantType: "Vendor" | "Non-Profit Organization";
    vendorCategory: string;
    selectedDates: string[];
    fullSeason: boolean;
    boothsPerMarket: number;
    foodLicenseRequired: boolean;
  } } {
  if (!form.applicantType) return { error: "Choose the final applicant type." };
  if (form.applicantType === "Vendor" && !(FAME_VENDOR_CATEGORIES as readonly string[]).includes(form.vendorCategory)) {
    return { error: "Choose the final vendor category." };
  }
  if (!/^[1-9]\d{0,3}$/.test(form.boothsPerMarket) || Number(form.boothsPerMarket) > 1000) {
    return { error: "Enter a whole number of booths from 1 to 1,000." };
  }
  if (!form.foodLicenseDecision) return { error: "Record whether a food license is required." };
  if (requiresFinalDateConfirmation && !form.finalDatesConfirmed) {
    return { error: "Confirm the corrected final dates with the vendor before reserving." };
  }
  if (!form.fullSeason && (!form.selectedDates.length || form.selectedDates.some(date => !SEASON_DATES.has(date)))) {
    return { error: "Choose at least one date from the confirmed market calendar." };
  }
  if (new Set(form.selectedDates).size !== form.selectedDates.length) return { error: "Choose each market date only once." };
  return { body: {
    applicantType: form.applicantType,
    vendorCategory: form.applicantType === "Non-Profit Organization" ? "Non-Profit Organization" : form.vendorCategory,
    selectedDates: form.fullSeason ? [] : [...form.selectedDates].sort(),
    fullSeason: form.fullSeason,
    boothsPerMarket: Number(form.boothsPerMarket),
    foodLicenseRequired: form.foodLicenseDecision === "required",
  } };
}

export function reservationRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function isFinalReservationView(value: unknown): value is FinalReservationView {
  const data = reservationRecord(value);
  return typeof data?.id === "string" && UUID.test(data.id)
    && typeof data.state === "string" && STATES.has(data.state)
    && typeof data.paymentRequired === "boolean"
    && typeof data.totalCents === "number" && Number.isSafeInteger(data.totalCents) && data.totalCents >= 0
    && (data.paymentRequired ? data.totalCents > 0 : data.totalCents === 0)
    && typeof data.finalBoothQuantity === "number" && Number.isSafeInteger(data.finalBoothQuantity)
    && data.finalBoothQuantity >= 1 && data.finalBoothQuantity <= 1000
    && Array.isArray(data.finalDates) && data.finalDates.length > 0 && data.finalDates.length <= 35
    && data.finalDates.every(date => typeof date === "string" && SEASON_DATES.has(date))
    && new Set(data.finalDates).size === data.finalDates.length
    && typeof data.quoteVersion === "string" && Boolean(data.quoteVersion);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

export function isReservationPaymentView(value: unknown): value is ReservationPaymentView {
  const data = reservationRecord(value);
  return typeof data?.id === "string" && UUID.test(data.id)
    && (data.checkoutUrl === null || typeof data.checkoutUrl === "string")
    && (data.paymentDueAt === null || isTimestamp(data.paymentDueAt))
    && typeof data.status === "string" && PAYMENT_STATES.has(data.status);
}

/** Validate a private server-built link before exposing it for copying. Never persist its token. */
export function vendorInvitationView(value: unknown): VendorInvitationView | null {
  const data = reservationRecord(value);
  if (typeof data?.invitationUrl !== "string" || typeof data.invitationToken !== "string" || !isTimestamp(data.expiresAt)) return null;
  try {
    const url = new URL(data.invitationUrl);
    const token = new URLSearchParams(url.hash.slice(1)).get("token");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/vendor/payment"
      || url.search || !token || token !== data.invitationToken) return null;
    return { invitationUrl: data.invitationUrl, expiresAt: data.expiresAt };
  } catch {
    return null;
  }
}

export function reservationError(value: unknown, fallback: string): string {
  const data = reservationRecord(value);
  const reasons: Record<string, string> = {
    application_not_approved: "The latest application submission must be approved before reserving. Reload the application and review its current submission.",
    agreement_not_signed: "The vendor agreement has not been recorded as signed for this application.",
    insurance_not_approved: "The current insurance document must be validated and approved before reserving.",
    food_license_not_approved: "A food license is required. The current food-license document must be validated and approved before reserving.",
  };
  if (typeof data?.eligibility === "string" && reasons[data.eligibility]) return reasons[data.eligibility];
  return typeof data?.error === "string" && data.error.trim() ? data.error : fallback;
}

export function unavailableReservationDates(value: unknown): Array<{ date: string; reasons: string[] }> {
  const data = reservationRecord(value);
  if (!Array.isArray(data?.availability)) return [];
  return data.availability.flatMap(item => {
    const row = reservationRecord(item);
    return typeof row?.date === "string" && SEASON_DATES.has(row.date) && row.available === false
      && Array.isArray(row.reasons) && row.reasons.every(reason => typeof reason === "string")
      ? [{ date: row.date, reasons: row.reasons as string[] }]
      : [];
  });
}
