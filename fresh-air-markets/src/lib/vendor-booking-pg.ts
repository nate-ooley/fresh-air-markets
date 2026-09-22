import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { reviewIdentitySnapshot } from "./application-review-pg";
import { currentInsuranceExpiry, datesAfterInsuranceExpiry, seasonOccupancy, type FreshAirFinalReservationConfig } from "./final-reservation-pg";
import { FRESH_AIR_SEASON_DATES } from "./fresh-air-season";
import { FAME_VENDOR_CATEGORIES, checkVendorBooking, type Occupancy } from "./vendor-booking-rules";

/**
 * "Book more dates": a vendor with an approved application asks for more
 * Saturdays from a personal link. Nothing here reserves capacity or touches
 * Square; a request waits for staff, who confirm it (which writes the booking
 * and sends the payment link) or decline it with a note.
 */

type Sql = ReturnType<typeof postgres>;
type QuerySql = Sql | postgres.TransactionSql;

let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent booking storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_BOOTHS_PER_REQUEST = 4;
const LIVE_STATES = ["held", "payment_pending", "paid", "confirmed", "manual_review"] as const;

export interface VendorBookingProfile {
  /** What the last booking recorded; the reservation form's defaults otherwise. */
  applicantType: "Vendor" | "Non-Profit Organization";
  vendorCategory: string;
  foodLicenseRequired: boolean;
  boothsPerMarket: number;
  /** True when a staff booking already fixed type/category/license for this vendor. */
  fromBooking: boolean;
}

export interface VendorBookingDay {
  date: string;
  /** Room for this vendor's category and booth count. */
  available: boolean;
  /** Held or paid by this vendor already. */
  booked: boolean;
  /** Market day already happened. */
  past: boolean;
  /** After the certificate of insurance on file expires. */
  uninsured: boolean;
}

export interface VendorBookingSummary {
  id: string;
  state: string;
  dates: string[];
  booths: number;
  totalCents: number;
}

export interface BookingRequestRecord {
  id: string;
  applicationId: string;
  dates: string[];
  booths: number;
  vendorNote: string;
  status: "pending" | "confirmed" | "declined" | "withdrawn";
  reservationId: string | null;
  staffNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface VendorBookingOverview {
  applicationId: string;
  businessName: string;
  vendorName: string;
  email: string;
  /** Approved, current submission, insurance approved: may ask for dates. */
  eligible: boolean;
  reasons: string[];
  profile: VendorBookingProfile;
  insuranceExpiresOn: string | null;
  bookings: VendorBookingSummary[];
  pendingRequest: BookingRequestRecord | null;
  days: VendorBookingDay[];
}

function dates(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((d): d is string => typeof d === "string" && DATE.test(d)))].sort() : [];
}

function requestRecord(row: {
  id: string; application_id: string; requested_dates: unknown; booths_per_market: number; vendor_note: string; status: string;
  reservation_id: string | null; staff_note: string | null; created_at: Date; decided_at: Date | null;
}): BookingRequestRecord {
  return {
    id: row.id, applicationId: row.application_id, dates: dates(row.requested_dates), booths: Number(row.booths_per_market),
    vendorNote: row.vendor_note, status: row.status as BookingRequestRecord["status"], reservationId: row.reservation_id,
    staffNote: row.staff_note, createdAt: new Date(row.created_at).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
  };
}

async function profileFor(sql: QuerySql, marketId: string, applicationId: string, snapshot: ReturnType<typeof reviewIdentitySnapshot>): Promise<VendorBookingProfile> {
  const [last] = await sql<{ applicant_type: string; vendor_category: string; food_license_required: boolean; final_booth_quantity: number }[]>`
    SELECT f.applicant_type, f.vendor_category, f.food_license_required, r.final_booth_quantity
    FROM fame_reservation_finalizations f
    JOIN fame_reservations r ON r.id = f.reservation_id AND r.market_id = f.market_id
    WHERE f.market_id = ${marketId} AND f.application_id = ${applicationId}
    ORDER BY r.created_at DESC LIMIT 1`;
  if (last) {
    return {
      applicantType: last.applicant_type === "Non-Profit Organization" ? "Non-Profit Organization" : "Vendor",
      vendorCategory: last.vendor_category, foodLicenseRequired: last.food_license_required,
      boothsPerMarket: Math.min(MAX_BOOTHS_PER_REQUEST, Math.max(1, Number(last.final_booth_quantity) || 1)), fromBooking: true,
    };
  }
  const applicantType = snapshot?.applicantType === "Non-Profit Organization" ? "Non-Profit Organization" : "Vendor";
  const category = (FAME_VENDOR_CATEGORIES as readonly string[]).includes(snapshot?.category ?? "") ? snapshot!.category : "Other (please specify)";
  return {
    applicantType, vendorCategory: applicantType === "Vendor" ? category : "Non-Profit Organization", foodLicenseRequired: false,
    boothsPerMarket: Math.min(MAX_BOOTHS_PER_REQUEST, Math.max(1, snapshot?.boothsRequested ?? 1)), fromBooking: false,
  };
}

/** Everything the vendor page and the staff card need, computed for one application. */
export async function vendorBookingOverview(
  input: { marketId: string; applicationId: string; config: FreshAirFinalReservationConfig; today: string },
  sql: Sql = configuredClient(),
): Promise<VendorBookingOverview | null> {
  if (!UUID.test(input.applicationId)) return null;
  const [application] = await sql<{ id: string; review_state: string; location_id: string }[]>`
    SELECT id, review_state, location_id FROM fame_applications WHERE id = ${input.applicationId} AND market_id = ${input.marketId}`;
  if (!application) return null;
  const [latest] = await sql<{ event_id: string; snapshot: unknown }[]>`
    SELECT event_id, snapshot FROM fame_application_events
    WHERE application_id = ${application.id} AND market_id = ${input.marketId} AND location_id = ${application.location_id}
    ORDER BY created_at DESC, event_id DESC LIMIT 1`;
  const [approval] = await sql<{ source_event_id: string }[]>`
    SELECT source_event_id FROM fame_application_review_events
    WHERE application_id = ${application.id} AND market_id = ${input.marketId} AND to_state = 'approved'
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  const [agreement] = await sql<{ id: string }[]>`
    SELECT id FROM fame_agreement_completions WHERE application_id = ${application.id} AND market_id = ${input.marketId} LIMIT 1`;
  const [insurance] = await sql<{ id: string }[]>`
    SELECT id FROM fame_application_documents
    WHERE application_id = ${application.id} AND market_id = ${input.marketId}
      AND kind = 'insurance' AND is_current AND validation_state = 'ready_for_review' AND review_state = 'approved' LIMIT 1`;
  const snapshot = reviewIdentitySnapshot(latest?.snapshot);
  const reasons: string[] = [];
  if (application.review_state !== "approved" || !latest || approval?.source_event_id !== latest.event_id) reasons.push("application_not_approved");
  if (!agreement) reasons.push("agreement_not_signed");
  if (!insurance) reasons.push("insurance_not_approved");
  const profile = await profileFor(sql, input.marketId, application.id, snapshot);
  const insuranceExpiresOn = await currentInsuranceExpiry(sql, input.marketId, application.id);
  const rows = await sql<{ id: string; state: string; final_dates: unknown; final_booth_quantity: number; total_cents: string | number }[]>`
    SELECT r.id, r.state, r.final_dates, r.final_booth_quantity, r.total_cents
    FROM fame_reservations r
    JOIN fame_reservation_finalizations f ON f.reservation_id = r.id AND f.market_id = r.market_id
    WHERE r.market_id = ${input.marketId} AND r.application_id = ${application.id}
    ORDER BY r.created_at`;
  const bookings = rows.map(row => ({ id: row.id, state: row.state, dates: dates(row.final_dates), booths: Number(row.final_booth_quantity), totalCents: Number(row.total_cents) }));
  const booked = new Set(bookings.filter(b => (LIVE_STATES as readonly string[]).includes(b.state)).flatMap(b => b.dates));
  const [pending] = await sql`
    SELECT id, application_id, requested_dates, booths_per_market, vendor_note, status, reservation_id, staff_note, created_at, decided_at
    FROM fame_booking_requests WHERE market_id = ${input.marketId} AND application_id = ${application.id} AND status = 'pending'`;
  const occupancy = await seasonOccupancy(sql, input.marketId, input.config.calendarDates);
  const calendar = { dates: [...input.config.calendarDates], boothCapacity: input.config.boothCapacity };
  const days = input.config.calendarDates.map(date => {
    let available = false;
    try {
      const check = checkVendorBooking(calendar, {
        applicantType: profile.applicantType, vendorCategory: profile.vendorCategory, selectedDates: [date], fullSeason: false, boothsPerMarket: profile.boothsPerMarket,
      }, occupancy);
      available = check.allDatesAvailable;
    } catch { available = false; }
    return { date, available, booked: booked.has(date), past: date < input.today, uninsured: datesAfterInsuranceExpiry([date], insuranceExpiresOn).length > 0 };
  });
  return {
    applicationId: application.id,
    businessName: snapshot?.businessName ?? "",
    vendorName: snapshot?.vendorName ?? "",
    email: snapshot?.email ?? "",
    eligible: reasons.length === 0,
    reasons,
    profile,
    insuranceExpiresOn,
    bookings,
    pendingRequest: pending ? requestRecord(pending as Parameters<typeof requestRecord>[0]) : null,
    days,
  };
}

export type CreateBookingRequestResult =
  | { kind: "created"; request: BookingRequestRecord }
  | { kind: "not_found" }
  | { kind: "not_eligible"; reasons: string[] }
  | { kind: "already_pending"; request: BookingRequestRecord }
  | { kind: "invalid"; problems: string[] };

/** The vendor asks for dates. Validated against the calendar, their bookings, insurance and room. */
export async function createBookingRequest(
  input: { marketId: string; applicationId: string; dates: unknown; booths: unknown; note: unknown; config: FreshAirFinalReservationConfig; today: string; now?: Date },
  sql: Sql = configuredClient(),
): Promise<CreateBookingRequestResult> {
  const overview = await vendorBookingOverview({ marketId: input.marketId, applicationId: input.applicationId, config: input.config, today: input.today }, sql);
  if (!overview) return { kind: "not_found" };
  if (!overview.eligible) return { kind: "not_eligible", reasons: overview.reasons };
  if (overview.pendingRequest) return { kind: "already_pending", request: overview.pendingRequest };
  const problems: string[] = [];
  const wanted = Array.isArray(input.dates) ? dates(input.dates) : [];
  if (!Array.isArray(input.dates) || !wanted.length) problems.push("Choose at least one Saturday.");
  if (Array.isArray(input.dates) && wanted.length !== input.dates.length) problems.push("Choose each Saturday once, as a date.");
  const booths = Number(input.booths);
  if (!Number.isInteger(booths) || booths < 1 || booths > MAX_BOOTHS_PER_REQUEST) problems.push(`Booths per Saturday must be 1 to ${MAX_BOOTHS_PER_REQUEST}.`);
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (typeof input.note !== "string" && input.note !== undefined && input.note !== null) problems.push("The note must be text.");
  if (note.length > 1000) problems.push("Keep the note under 1,000 characters.");
  const byDate = new Map(overview.days.map(day => [day.date, day]));
  for (const date of wanted) {
    const day = byDate.get(date);
    if (!day) { problems.push(`${date} is not a market Saturday this season.`); continue; }
    if (day.past) problems.push(`${date} has already happened.`);
    else if (day.booked) problems.push(`${date} is already in one of your bookings.`);
    else if (day.uninsured) problems.push(`${date} is after your insurance certificate expires (${overview.insuranceExpiresOn}).`);
  }
  if (problems.length) return { kind: "invalid", problems };
  // Room is re-checked for the booth count actually asked for.
  const occupancy = await seasonOccupancy(sql, input.marketId, wanted);
  let full: string[] = [];
  try {
    const check = checkVendorBooking({ dates: [...input.config.calendarDates], boothCapacity: input.config.boothCapacity }, {
      applicantType: overview.profile.applicantType, vendorCategory: overview.profile.vendorCategory, selectedDates: wanted, fullSeason: false, boothsPerMarket: booths,
    }, occupancy);
    full = check.unavailableDates;
  } catch { return { kind: "invalid", problems: ["These dates could not be checked. Try again."] }; }
  if (full.length) return { kind: "invalid", problems: full.map(date => `${date} no longer has room for ${booths} booth${booths === 1 ? "" : "s"}.`) };
  const now = input.now ?? new Date();
  const id = randomUUID();
  try {
    const [row] = await sql`
      INSERT INTO fame_booking_requests (id, market_id, application_id, requested_dates, booths_per_market, vendor_note, created_at, updated_at)
      VALUES (${id}, ${input.marketId}, ${input.applicationId}, ${sql.json(wanted as unknown as Parameters<typeof sql.json>[0])}, ${booths}, ${note}, ${now}, ${now})
      RETURNING id, application_id, requested_dates, booths_per_market, vendor_note, status, reservation_id, staff_note, created_at, decided_at`;
    return { kind: "created", request: requestRecord(row as Parameters<typeof requestRecord>[0]) };
  } catch (error) {
    // Two clicks at once: the partial unique index keeps one open request.
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      const again = await vendorBookingOverview({ marketId: input.marketId, applicationId: input.applicationId, config: input.config, today: input.today }, sql);
      if (again?.pendingRequest) return { kind: "already_pending", request: again.pendingRequest };
    }
    throw error;
  }
}

/** Open requests across the market, newest first, with vendor identity for the staff list. */
export async function listPendingBookingRequests(marketId: string, sql: Sql = configuredClient()): Promise<(BookingRequestRecord & { businessName: string; vendorName: string })[]> {
  const rows = await sql`
    SELECT q.id, q.application_id, q.requested_dates, q.booths_per_market, q.vendor_note, q.status, q.reservation_id, q.staff_note, q.created_at, q.decided_at,
           (SELECT e.snapshot FROM fame_application_events e WHERE e.application_id = q.application_id AND e.market_id = q.market_id
             ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS snapshot
    FROM fame_booking_requests q
    WHERE q.market_id = ${marketId} AND q.status = 'pending'
    ORDER BY q.created_at DESC`;
  return rows.map(row => {
    const identity = reviewIdentitySnapshot(row.snapshot);
    return { ...requestRecord(row as Parameters<typeof requestRecord>[0]), businessName: identity?.businessName ?? "", vendorName: identity?.vendorName ?? "" };
  });
}

export async function getBookingRequest(marketId: string, requestId: string, sql: Sql = configuredClient()): Promise<BookingRequestRecord | null> {
  if (!UUID.test(requestId)) return null;
  const [row] = await sql`
    SELECT id, application_id, requested_dates, booths_per_market, vendor_note, status, reservation_id, staff_note, created_at, decided_at
    FROM fame_booking_requests WHERE id = ${requestId} AND market_id = ${marketId}`;
  return row ? requestRecord(row as Parameters<typeof requestRecord>[0]) : null;
}

/** Staff settle a request. `confirmed` needs the booking it became. */
export async function settleBookingRequest(
  input: { marketId: string; requestId: string; status: "confirmed" | "declined"; reservationId?: string; staffNote?: string; actorAccountId: string; now?: Date },
  sql: Sql = configuredClient(),
): Promise<{ kind: "settled"; request: BookingRequestRecord } | { kind: "not_found" } | { kind: "not_pending"; status: string }> {
  const now = input.now ?? new Date();
  return sql.begin(async tx => {
    const [row] = await tx<{ id: string; status: string }[]>`
      SELECT id, status FROM fame_booking_requests WHERE id = ${input.requestId} AND market_id = ${input.marketId} FOR UPDATE`;
    if (!row) return { kind: "not_found" } as const;
    if (row.status !== "pending") return { kind: "not_pending", status: row.status } as const;
    const [updated] = await tx`
      UPDATE fame_booking_requests
      SET status = ${input.status}, reservation_id = ${input.reservationId ?? null}, staff_note = ${input.staffNote?.trim().slice(0, 1000) || null},
          decided_at = ${now}, decided_by_account_id = ${input.actorAccountId}, updated_at = ${now}
      WHERE id = ${row.id}
      RETURNING id, application_id, requested_dates, booths_per_market, vendor_note, status, reservation_id, staff_note, created_at, decided_at`;
    return { kind: "settled", request: requestRecord(updated as Parameters<typeof requestRecord>[0]) } as const;
  });
}

/** Today's date in the market's time zone (Eastern), YYYY-MM-DD. */
export function marketToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export { FRESH_AIR_SEASON_DATES };
