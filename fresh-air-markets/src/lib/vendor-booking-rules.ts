/** Fresh Air's reservation rules, independent of CRM and payment providers.
 * CHECK is advisory. Call again inside a database transaction at RESERVE.
 * Calendar and occupancy must come from trusted, market-scoped storage.
 */
export interface MarketCalendar {
  dates: string[];
  boothCapacity: number;
}

export interface BookingRequest {
  applicantType: "Vendor" | "Non-Profit Organization";
  vendorCategory: string;
  selectedDates: string[];
  fullSeason: boolean;
  boothsPerMarket: number;
}

export interface Occupancy {
  date: string;
  /** All booths held on the date, food trucks included. */
  booths: number;
  /** Food truck reservations on the date. */
  foodTrucks: number;
  /** Booths those food trucks hold; assumed one each when omitted. */
  foodTruckBooths?: number;
  nonprofits: number;
}

/** Food trucks have their own spaces, separate from the vendor booth count. */
export const FOOD_TRUCK_CAPACITY = 4;

export interface DocumentState {
  applicationStatus: string;
  agreementStatus: string;
  insuranceStatus: string;
  foodLicenseRequired: boolean | null;
  foodLicenseStatus: string;
}

export const FAME_VENDOR_CATEGORIES = [
  "Food Truck", "Entertainment", "Arts & Crafts", "Food Products", "Produce",
  "Florals & Plants", "Health & Personal Care", "Jewelry & Accessories", "Home Goods",
  "Clothing & Apparel", "Pet Products", "Coffee & Tea", "Baked Goods", "Other (please specify)",
] as const;

export function readyForDateSelection(state: DocumentState): boolean {
  return state.applicationStatus === "Approved"
    && state.agreementStatus === "Signed"
    && state.insuranceStatus === "Approved"
    && (state.foodLicenseRequired === true
      ? state.foodLicenseStatus === "Approved"
      : state.foodLicenseRequired === false && state.foodLicenseStatus === "Not Required");
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function integer(value: number, minimum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}.`);
  }
}

export function checkVendorBooking(
  calendar: MarketCalendar,
  request: BookingRequest,
  occupancy: Occupancy[],
) {
  if (!calendar.dates.length || calendar.dates.some(d => !isDate(d))) {
    throw new Error("A valid canonical market calendar is required.");
  }
  const calendarDates = [...new Set(calendar.dates)].sort();
  if (calendarDates.length !== calendar.dates.length) throw new Error("Duplicate calendar dates.");
  integer(calendar.boothCapacity, 1, "Booth capacity");
  integer(request.boothsPerMarket, 1, "Final booth quantity");
  if (typeof request.fullSeason !== "boolean") throw new Error("Full Season must be a boolean.");
  if (!["Vendor", "Non-Profit Organization"].includes(request.applicantType)) {
    throw new Error("A recognized applicant type is required.");
  }
  const category = request.vendorCategory.trim();
  if (request.applicantType === "Vendor" && !(FAME_VENDOR_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error("A recognized vendor category is required.");
  }
  // Reject ambiguous Full Season plus explicit selections rather than silently
  // interpreting a partially edited form as a full-season purchase.
  if (request.fullSeason && request.selectedDates.length) {
    throw new Error("Choose Full Season or individual dates, not both.");
  }
  if (new Set(request.selectedDates).size !== request.selectedDates.length) {
    throw new Error("Select each market date only once.");
  }
  const dates = request.fullSeason
    ? calendarDates
    : [...new Set(request.selectedDates)].sort();
  if (!dates.length || dates.some(d => !calendarDates.includes(d))) {
    throw new Error("Select dates from the configured market calendar.");
  }
  const isNonprofit = request.applicantType === "Non-Profit Organization";
  const isFoodTruck = category === "Food Truck";
  // Consecutive means adjacent entries in the market calendar, including any
  // scheduled holiday gaps. The whole selected set must be consecutive.
  const first = calendarDates.indexOf(dates[0]);
  const consecutive = dates.length >= 4
    && dates.every((d, i) => calendarDates[first + i] === d);
  const tier = isNonprofit ? "nonprofit" : request.fullSeason ? "full-season"
    : consecutive ? "consecutive" : "standard";
  const rateCents = isNonprofit ? 0 : request.fullSeason ? 3000 : consecutive ? 3500 : 4000;
  const totalCents = dates.length * rateCents * request.boothsPerMarket;
  if (!Number.isSafeInteger(totalCents)) throw new Error("Booking total is too large.");

  const byDate = new Map<string, Occupancy>();
  for (const row of occupancy) {
    if (!isDate(row.date) || byDate.has(row.date)) throw new Error("Invalid or duplicate occupancy date.");
    integer(row.booths, 0, "Occupied booths");
    integer(row.foodTrucks, 0, "Food truck count");
    if (row.foodTruckBooths !== undefined) integer(row.foodTruckBooths, 0, "Food truck booths");
    integer(row.nonprofits, 0, "Nonprofit count");
    byDate.set(row.date, row);
  }
  const availability = dates.map(date => {
    // Missing rows are unknown, never assumed to mean zero occupants.
    const current = byDate.get(date);
    if (!current) throw new Error(`Missing occupancy for ${date}.`);
    const reasons: string[] = [];
    // Vendor booths and food truck spaces are separate pools: a food truck
    // never takes a vendor booth, and vendor booths never take truck spaces.
    const vendorBooths = Math.max(0, current.booths - (current.foodTruckBooths ?? current.foodTrucks));
    if (!isFoodTruck && vendorBooths + request.boothsPerMarket > calendar.boothCapacity) reasons.push("Not enough booth spaces");
    if (isFoodTruck && current.foodTrucks >= FOOD_TRUCK_CAPACITY) reasons.push(`Food truck limit reached (${FOOD_TRUCK_CAPACITY})`);
    if (isNonprofit && current.nonprofits >= 1) reasons.push("Featured nonprofit slot filled (1)");
    return { date, available: reasons.length === 0, reasons };
  });
  return {
    dates, boothsPerMarket: request.boothsPerMarket, tier, rateCents, totalCents,
    paymentRequired: !isNonprofit,
    availability,
    allDatesAvailable: availability.every(d => d.available),
    availableDates: availability.filter(d => d.available).map(d => d.date),
    unavailableDates: availability.filter(d => !d.available).map(d => d.date),
    // The quote always covers the complete requested set; partial availability
    // requires an explicitly revised request and a fresh calculation.
    dateAvailabilityResult: availability.map(d => `${d.date}: ${d.available ? "Available" : d.reasons.join("; ")}`).join("\n"),
  };
}
