import { createHash } from "node:crypto";
import {
  FAME_VENDOR_CATEGORIES,
  checkVendorBooking,
  type BookingRequest,
  type MarketCalendar,
  type Occupancy,
} from "./vendor-booking-rules";
import { validApplicationId } from "./application-review";

/**
 * This version binds a committed reservation to the confirmed 2026–2027
 * calendar and the server-side $30/$35/$40 quote rules. Changing it requires a
 * new reviewed final-reservation implementation, never a browser value.
 */
export const FRESH_AIR_FINAL_RESERVATION_QUOTE_VERSION = "fresh-air-2026-2027-v1";
export const MAX_FINAL_RESERVATION_DATES = 35;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type FinalReservationApplicantType = "Vendor" | "Non-Profit Organization";

/**
 * This is the manager's final planning decision, not an application snapshot
 * or an amount supplied by a browser. The PostgreSQL transaction recalculates
 * every date, category limit, rate, and total before it persists anything.
 */
export interface ParsedFinalReservationSelection {
  applicantType: FinalReservationApplicantType;
  vendorCategory: string;
  selectedDates: string[];
  fullSeason: boolean;
  boothsPerMarket: number;
  /** Thomas's required / Not Required decision, recorded with the final hold. */
  foodLicenseRequired: boolean;
  idempotencyKey: string;
}

export interface FinalReservationEligibilityEvidence {
  applicationApproved: boolean;
  approvedSourceIsCurrent: boolean;
  agreementSigned: boolean;
  insuranceApproved: boolean;
  foodLicenseApproved: boolean;
}

export type FinalReservationIneligibility =
  | "application_not_approved"
  | "agreement_not_signed"
  | "insurance_not_approved"
  | "food_license_not_approved";

export function validFinalReservationIdempotencyKey(value: string | null): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

export function validFinalReservationApplicationId(value: string): boolean {
  return validApplicationId(value);
}

function validSelectedDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value);
}

/**
 * Deliberately reject price, reservation ID, and identity fields. The path and
 * signed-in manager bind identity; RESERVE derives quote fields from storage.
 */
export function parseFinalReservationSelection(
  body: Record<string, unknown>,
  idempotencyKey: string | null,
): ParsedFinalReservationSelection | null {
  if (!validFinalReservationIdempotencyKey(idempotencyKey)) return null;
  const allowed = new Set([
    "applicantType", "vendorCategory", "selectedDates", "fullSeason",
    "boothsPerMarket", "foodLicenseRequired",
  ]);
  if (Object.keys(body).some(key => !allowed.has(key))) return null;
  if (body.applicantType !== "Vendor" && body.applicantType !== "Non-Profit Organization") return null;
  if (typeof body.vendorCategory !== "string") return null;
  const vendorCategory = body.vendorCategory.trim();
  if (!vendorCategory || vendorCategory.length > 128) return null;
  if (!Array.isArray(body.selectedDates)
    || body.selectedDates.length > MAX_FINAL_RESERVATION_DATES
    || !body.selectedDates.every(validSelectedDate)) return null;
  const selectedDates = [...body.selectedDates].sort();
  if (new Set(selectedDates).size !== selectedDates.length) return null;
  const boothsPerMarket = body.boothsPerMarket;
  if (typeof body.fullSeason !== "boolean"
    || typeof boothsPerMarket !== "number"
    || !Number.isSafeInteger(boothsPerMarket)
    || boothsPerMarket < 1
    || boothsPerMarket > 1000
    || typeof body.foodLicenseRequired !== "boolean") return null;
  // Keep the stored category compatible with the occupancy rule. The complete
  // rule is checked again inside the transaction with the configured calendar.
  if (body.applicantType === "Vendor"
    && !(FAME_VENDOR_CATEGORIES as readonly string[]).includes(vendorCategory)) return null;
  return {
    applicantType: body.applicantType,
    vendorCategory,
    selectedDates,
    fullSeason: body.fullSeason,
    boothsPerMarket,
    foodLicenseRequired: body.foodLicenseRequired,
    idempotencyKey,
  };
}

export function finalReservationEligibilityReason(
  evidence: FinalReservationEligibilityEvidence,
  selection: Pick<ParsedFinalReservationSelection, "foodLicenseRequired">,
): FinalReservationIneligibility | null {
  if (!evidence.applicationApproved || !evidence.approvedSourceIsCurrent) return "application_not_approved";
  if (!evidence.agreementSigned) return "agreement_not_signed";
  if (!evidence.insuranceApproved) return "insurance_not_approved";
  if (selection.foodLicenseRequired && !evidence.foodLicenseApproved) return "food_license_not_approved";
  return null;
}

/** Stable, private audit key for an exact manager retry. */
export function finalReservationSelectionFingerprint(
  applicationId: string,
  selection: ParsedFinalReservationSelection,
): string {
  return createHash("sha256").update(JSON.stringify([
    applicationId,
    selection.applicantType,
    selection.vendorCategory,
    selection.selectedDates,
    selection.fullSeason,
    selection.boothsPerMarket,
    selection.foodLicenseRequired,
  ])).digest("hex");
}

export function finalReservationBookingRequest(
  selection: ParsedFinalReservationSelection,
): BookingRequest {
  return {
    applicantType: selection.applicantType,
    vendorCategory: selection.vendorCategory,
    selectedDates: selection.selectedDates,
    fullSeason: selection.fullSeason,
    boothsPerMarket: selection.boothsPerMarket,
  };
}

/** Runs the shared quote/capacity rules with only server-configured calendar data. */
export function quoteFinalReservation(
  calendar: MarketCalendar,
  selection: ParsedFinalReservationSelection,
  occupancy: Occupancy[],
) {
  return checkVendorBooking(calendar, finalReservationBookingRequest(selection), occupancy);
}

/**
 * CHECK-only quote used to derive the exact dates that must be locked. It is
 * deliberately populated with zero rows only to satisfy the rule engine's
 * complete-inventory contract; RESERVE re-runs the quote with locked database
 * counts immediately before it writes anything.
 */
export function preflightFinalReservation(
  calendar: MarketCalendar,
  selection: ParsedFinalReservationSelection,
) {
  return quoteFinalReservation(
    calendar,
    selection,
    calendar.dates.map(date => ({ date, booths: 0, foodTrucks: 0, nonprofits: 0 })),
  );
}

/** Do not put vendor names, emails, or caller-provided prices in Square metadata. */
export function finalReservationCheckoutDescription(dates: string[], boothsPerMarket: number): string {
  const dateLabel = dates.length === 1 ? "market date" : "market dates";
  const boothLabel = boothsPerMarket === 1 ? "booth" : "booths";
  return `Fresh Air Market reservation: ${dates.length} ${dateLabel}, ${boothsPerMarket} ${boothLabel}`;
}
