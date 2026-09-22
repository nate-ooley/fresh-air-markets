import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { FRESH_AIR_SEASON_DATES } from "./fresh-air-season";
import { DEMO_MARKET_ID } from "./seed";
import { checkVendorBooking } from "./vendor-booking-rules";
import {
  FRESH_AIR_FINAL_RESERVATION_QUOTE_VERSION,
  finalReservationCheckoutDescription,
  finalReservationEligibilityReason,
  finalReservationSelectionFingerprint,
  preflightFinalReservation,
  validFinalReservationApplicationId,
  validFinalReservationIdempotencyKey,
  quoteFinalReservation,
  type FinalReservationEligibilityEvidence,
  type FinalReservationIneligibility,
  type ParsedFinalReservationSelection,
} from "./final-reservation";

type Sql = ReturnType<typeof postgres>;
type QuerySql = Sql | postgres.TransactionSql;

let client: Sql | undefined;

function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent final-reservation storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

export interface FreshAirFinalReservationConfig {
  marketId: string;
  seasonId: "2026-2027";
  boothCapacity: number;
  calendarDates: readonly string[];
  quoteVersion: string;
}

/**
 * Capacity has not been supplied by the source application or CRM contract.
 * Require the operator to set it privately instead of guessing from legacy
 * one-booth inquiries or a map layout.
 */
export function freshAirFinalReservationConfig(
  env: Record<string, string | undefined>,
): FreshAirFinalReservationConfig {
  const marketId = env.FAME_MARKET_ACCOUNT_ID?.trim() ?? "";
  const capacityValue = env.FAME_BOOTH_CAPACITY?.trim() ?? "";
  // The demo manager password is public. It must never own real applications
  // or become a payable market through a copied environment setting.
  if (marketId === DEMO_MARKET_ID) {
    throw new Error("Final reservations require a private market account.");
  }
  if (!marketId || env.FAME_SEASON_ID !== "2026-2027" || !/^[1-9]\d{0,3}$/.test(capacityValue)) {
    throw new Error("Final reservation configuration is incomplete.");
  }
  const boothCapacity = Number(capacityValue);
  if (!Number.isSafeInteger(boothCapacity) || boothCapacity < 1 || boothCapacity > 1000) {
    throw new Error("Final reservation booth capacity is invalid.");
  }
  return {
    marketId,
    seasonId: "2026-2027",
    boothCapacity,
    calendarDates: FRESH_AIR_SEASON_DATES,
    quoteVersion: FRESH_AIR_FINAL_RESERVATION_QUOTE_VERSION,
  };
}

interface ApplicationSeedRow {
  id: string;
  market_id: string;
  location_id: string;
  contact_id: string;
  season_id: string;
}

interface ApplicationRow extends ApplicationSeedRow {
  review_state: string;
  review_revision: number;
}

interface CurrentDocumentRow {
  id: string;
  kind: "insurance" | "food_license";
  version: number;
  review_revision: number;
  validation_state: string;
  review_state: string;
}

interface ExistingFinalizationRow {
  reservation_id: string;
  selection_fingerprint: string;
  idempotency_key: string;
  state: string;
  payment_required: boolean;
  total_cents: number | string;
  final_booth_quantity: number;
  final_dates: unknown;
  quote_version: string;
  created_at?: Date;
  withdrawn_at?: Date | null;
  withdrawal_note?: string | null;
}

/** States in which a booking still occupies its dates. */
const LIVE_RESERVATION_STATES = ["held", "payment_pending", "paid", "confirmed", "manual_review"] as const;

interface OccupancyRow {
  booths: number | string;
  food_trucks: number | string;
  food_truck_booths: number | string;
  nonprofits: number | string;
}

export interface FinalReservationRecord {
  id: string;
  /** The original hold may subsequently progress through the payment ledger. */
  state: "held" | "payment_pending" | "paid" | "confirmed" | "expired" | "cancelled" | "declined" | "manual_review";
  paymentRequired: boolean;
  totalCents: number;
  finalDates: string[];
  finalBoothQuantity: number;
  quoteVersion: string;
  createdAt?: string;
  withdrawnAt?: string | null;
  withdrawalNote?: string | null;
}

export type FinalReservationResult =
  | { kind: "created"; reservation: FinalReservationRecord }
  | { kind: "duplicate"; reservation: FinalReservationRecord }
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "overlap"; dates: string[] }
  | { kind: "invalid_selection" }
  | { kind: "not_eligible"; reason: FinalReservationIneligibility }
  | { kind: "unavailable"; availability: { date: string; available: boolean; reasons: string[] }[] };

/**
 * Read every booking for an application after a manager reloads; never
 * allocate or create checkout. `reservation` is the most recent booking that
 * has not been withdrawn (or the most recent one at all), kept for callers
 * written when a vendor could hold only one.
 */
export async function getFinalApplicationReservation(
  marketId: string,
  applicationId: string,
  sql: Sql = configuredClient(),
): Promise<{ reservation: FinalReservationRecord | null; reservations: FinalReservationRecord[] } | null> {
  if (!marketId || marketId === DEMO_MARKET_ID || !validFinalReservationApplicationId(applicationId)) return null;
  const [application] = await sql`SELECT id FROM fame_applications
    WHERE id = ${applicationId} AND market_id = ${marketId}`;
  if (!application) return null;
  const rows = await sql<ExistingFinalizationRow[]>`
    SELECT f.reservation_id, f.selection_fingerprint, f.idempotency_key,
      r.state, r.payment_required, r.total_cents, r.final_booth_quantity, r.final_dates, r.quote_version,
      r.created_at, r.withdrawn_at, r.withdrawal_note
    FROM fame_reservation_finalizations f
    JOIN fame_reservations r ON r.id = f.reservation_id AND r.market_id = f.market_id
      AND r.application_id = f.application_id
    WHERE f.market_id = ${marketId} AND f.application_id = ${applicationId}
    ORDER BY r.created_at, f.reservation_id`;
  const reservations = rows.map(row => {
    const record = recordFromExisting(row);
    if (!record) throw new Error("Stored final reservation is invalid.");
    return record;
  });
  const reservation = [...reservations].reverse().find(record => record.state !== "cancelled")
    ?? reservations[reservations.length - 1] ?? null;
  return { reservation, reservations };
}

export interface FinalReservationWriteInput {
  marketId: string;
  applicationId: string;
  actorAccountId: string;
  selection: ParsedFinalReservationSelection;
  config: FreshAirFinalReservationConfig;
  now?: Date;
}

function applicationIdentityKey(application: ApplicationSeedRow): string {
  return [application.market_id, application.location_id, application.contact_id, application.season_id].join("\u001f");
}

function asFinalDates(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(date => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date))) return null;
  return [...value].sort();
}

function recordFromExisting(row: ExistingFinalizationRow): FinalReservationRecord | null {
  const totalCents = Number(row.total_cents);
  const finalDates = asFinalDates(row.final_dates);
  if (!(["held", "payment_pending", "paid", "confirmed", "expired", "cancelled", "declined", "manual_review"] as const).includes(
    row.state as FinalReservationRecord["state"],
  )
    || !Number.isSafeInteger(totalCents)
    || !Number.isSafeInteger(Number(row.final_booth_quantity))
    || !finalDates) return null;
  return {
    id: row.reservation_id,
    state: row.state as FinalReservationRecord["state"],
    paymentRequired: row.payment_required,
    totalCents,
    finalDates,
    finalBoothQuantity: Number(row.final_booth_quantity),
    quoteVersion: row.quote_version,
    ...(row.created_at instanceof Date ? { createdAt: row.created_at.toISOString() } : {}),
    ...(row.withdrawn_at !== undefined ? { withdrawnAt: row.withdrawn_at instanceof Date ? row.withdrawn_at.toISOString() : null } : {}),
    ...(row.withdrawal_note !== undefined ? { withdrawalNote: row.withdrawal_note ?? null } : {}),
  };
}

/** Every booking already written for this application, locked for the transaction. */
async function existingFinalizationsForApplication(
  tx: QuerySql,
  marketId: string,
  applicationId: string,
): Promise<ExistingFinalizationRow[]> {
  return tx<ExistingFinalizationRow[]>`
    SELECT f.reservation_id, f.selection_fingerprint, f.idempotency_key,
           r.state, r.payment_required, r.total_cents, r.final_booth_quantity,
           r.final_dates, r.quote_version
    FROM fame_reservation_finalizations f
    JOIN fame_reservations r
      ON r.id = f.reservation_id AND r.market_id = f.market_id
    WHERE f.market_id = ${marketId} AND f.application_id = ${applicationId}
    ORDER BY r.created_at, f.reservation_id
    FOR UPDATE OF f, r`;
}

async function idempotencyAlreadyUsed(
  tx: QuerySql,
  marketId: string,
  idempotencyKey: string,
): Promise<boolean> {
  const [row] = await tx<{ reservation_id: string }[]>`
    SELECT reservation_id
    FROM fame_reservation_finalizations
    WHERE market_id = ${marketId} AND idempotency_key = ${idempotencyKey}
    FOR UPDATE`;
  return Boolean(row);
}

async function occupancyForDate(
  tx: QuerySql,
  marketId: string,
  date: string,
  excludeReservationId: string | null = null,
): Promise<{ date: string; booths: number; foodTrucks: number; foodTruckBooths: number; nonprofits: number }> {
  const [row] = await tx<OccupancyRow[]>`
    SELECT
      COALESCE(SUM(a.booth_quantity), 0)::int AS booths,
      COALESCE(COUNT(*) FILTER (WHERE f.vendor_category = 'Food Truck'), 0)::int AS food_trucks,
      COALESCE(SUM(a.booth_quantity) FILTER (WHERE f.vendor_category = 'Food Truck'), 0)::int AS food_truck_booths,
      COALESCE(COUNT(*) FILTER (WHERE f.applicant_type = 'Non-Profit Organization'), 0)::int AS nonprofits
    FROM fame_reservation_allocations a
    JOIN fame_reservations r
      ON r.id = a.reservation_id AND r.market_id = a.market_id
    JOIN fame_reservation_finalizations f
      ON f.reservation_id = a.reservation_id AND f.market_id = a.market_id
    WHERE a.market_id = ${marketId}
      AND a.market_date = ${date}::date
      AND r.state IN ('held', 'payment_pending', 'paid', 'confirmed', 'manual_review')
      AND (${excludeReservationId}::text IS NULL OR r.id <> ${excludeReservationId})`;
  return {
    date,
    booths: Number(row?.booths ?? 0),
    foodTrucks: Number(row?.food_trucks ?? 0),
    foodTruckBooths: Number(row?.food_truck_booths ?? 0),
    nonprofits: Number(row?.nonprofits ?? 0),
  };
}

function approvedCurrentDocument(
  documents: CurrentDocumentRow[],
  kind: CurrentDocumentRow["kind"],
): CurrentDocumentRow | null {
  const document = documents.find(candidate => (
    candidate.kind === kind
      && candidate.validation_state === "ready_for_review"
      && candidate.review_state === "approved"
      && Number.isSafeInteger(Number(candidate.version))
      && Number(candidate.version) >= 1
      && Number.isSafeInteger(Number(candidate.review_revision))
      && Number(candidate.review_revision) >= 1
  ));
  return document ?? null;
}

/**
 * Final CHECK→RESERVE boundary. It never calls Square, HighLevel, email, or a
 * browser URL. It locks the application, all target market dates, re-reads the
 * eligibility evidence and current allocation counts, then atomically writes
 * an immutable selection, date allocations, and the L18 reservation record.
 */
export async function reserveFinalApplication(
  input: FinalReservationWriteInput,
  sql: Sql = configuredClient(),
): Promise<FinalReservationResult> {
  if (!validFinalReservationApplicationId(input.applicationId)
    || !validFinalReservationIdempotencyKey(input.selection.idempotencyKey)
    || input.marketId !== input.actorAccountId
    || input.marketId !== input.config.marketId
  ) throw new Error("Final reservation identity is invalid.");
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("Final reservation requires a valid server time.");
  const fingerprint = finalReservationSelectionFingerprint(input.applicationId, input.selection);
  return sql.begin(async tx => {
    // Read enough identity to use the same app-level source lock as the
    // HighLevel handoff. Re-read it under the lock before considering approval.
    const [seed] = await tx<ApplicationSeedRow[]>`
      SELECT id, market_id, location_id, contact_id, season_id
      FROM fame_applications
      WHERE id = ${input.applicationId} AND market_id = ${input.marketId}`;
    if (!seed) return { kind: "not_found" };
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${applicationIdentityKey(seed)}, 0))`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`fame-final-reservation:${input.marketId}:${input.selection.idempotencyKey}`}, 0))`;

    const [application] = await tx<ApplicationRow[]>`
      SELECT id, market_id, location_id, contact_id, season_id, review_state, review_revision
      FROM fame_applications
      WHERE id = ${input.applicationId} AND market_id = ${input.marketId}
      FOR UPDATE`;
    if (!application) return { kind: "not_found" };
    if (application.season_id !== input.config.seasonId) return { kind: "not_eligible", reason: "application_not_approved" };

    // A vendor may hold several bookings in one season. A replay of an earlier
    // booking is answered with that booking; a different selection becomes a
    // new booking as long as it does not double-book a date the vendor already
    // holds (withdrawn, expired and declined bookings no longer count).
    const existing = await existingFinalizationsForApplication(tx, input.marketId, input.applicationId);
    const replay = existing.find(row => row.selection_fingerprint === fingerprint && row.idempotency_key === input.selection.idempotencyKey);
    if (replay) {
      const record = recordFromExisting(replay);
      if (!record) throw new Error("Stored final reservation is invalid.");
      return { kind: "duplicate", reservation: record };
    }
    if (await idempotencyAlreadyUsed(tx, input.marketId, input.selection.idempotencyKey)) return { kind: "conflict" };
    const heldDates = new Set(existing
      .filter(row => (LIVE_RESERVATION_STATES as readonly string[]).includes(row.state))
      .flatMap(row => asFinalDates(row.final_dates) ?? []));

    const [latestSource] = await tx<{ location_id: string; event_id: string }[]>`
      SELECT location_id, event_id
      FROM fame_application_events
      WHERE application_id = ${application.id}
        AND market_id = ${application.market_id}
        AND location_id = ${application.location_id}
      ORDER BY created_at DESC, event_id DESC
      LIMIT 1`;
    const [approvedReview] = await tx<{ id: string; source_event_id: string }[]>`
      SELECT id, source_event_id
      FROM fame_application_review_events
      WHERE application_id = ${application.id}
        AND market_id = ${application.market_id}
        AND to_state = 'approved'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`;
    const [agreement] = await tx<{ id: string }[]>`
      SELECT id
      FROM fame_agreement_completions
      WHERE application_id = ${application.id}
        AND market_id = ${application.market_id}
        AND season_id = ${application.season_id}
      FOR KEY SHARE`;
    const documents = await tx<CurrentDocumentRow[]>`
      SELECT id, kind, version, review_revision, validation_state, review_state
      FROM fame_application_documents
      WHERE application_id = ${application.id}
        AND market_id = ${application.market_id}
        AND is_current = TRUE
      FOR UPDATE`;
    const insurance = approvedCurrentDocument(documents, "insurance");
    const foodLicense = input.selection.foodLicenseRequired
      ? approvedCurrentDocument(documents, "food_license")
      : null;
    const ineligible = finalReservationEligibilityReason(
      {
        applicationApproved: application.review_state === "approved",
        approvedSourceIsCurrent: Boolean(latestSource?.event_id && latestSource.event_id === approvedReview?.source_event_id),
        agreementSigned: Boolean(agreement),
        insuranceApproved: Boolean(insurance),
        foodLicenseApproved: Boolean(foodLicense),
      } satisfies FinalReservationEligibilityEvidence,
      input.selection,
    );
    if (ineligible) return { kind: "not_eligible", reason: ineligible };
    // The eligibility check above makes these states unreachable unless a
    // corrupt row bypassed a type/database invariant; never write partial
    // provenance in that case.
    if (!latestSource || !approvedReview || !agreement || !insurance
      || (input.selection.foodLicenseRequired && !foodLicense)) {
      throw new Error("Final reservation eligibility evidence is incomplete.");
    }

    let preflight;
    try {
      // This first evaluation makes the canonical final dates available for
      // stable-order advisory locks. It is evaluated again after the locks.
      preflight = preflightFinalReservation(
        { dates: [...input.config.calendarDates], boothCapacity: input.config.boothCapacity },
        input.selection,
      );
    } catch {
      return { kind: "invalid_selection" };
    }
    const overlap = preflight.dates.filter(date => heldDates.has(date));
    if (overlap.length) return { kind: "overlap", dates: overlap };
    for (const date of preflight.dates) {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`fame-reservation-capacity:${input.marketId}:${date}`}, 0))`;
    }
    const occupancy = await Promise.all(preflight.dates.map(date => occupancyForDate(tx, input.marketId, date)));
    let quote;
    try {
      quote = quoteFinalReservation(
        { dates: [...input.config.calendarDates], boothCapacity: input.config.boothCapacity },
        input.selection,
        occupancy,
      );
    } catch {
      return { kind: "invalid_selection" };
    }
    if (!quote.allDatesAvailable) return { kind: "unavailable", availability: quote.availability };

    const reservationId = randomUUID();
    const paymentRequired = quote.paymentRequired;
    const state: FinalReservationRecord["state"] = paymentRequired ? "held" : "confirmed";
    const checkoutDescription = finalReservationCheckoutDescription(quote.dates, quote.boothsPerMarket);
    const [reservation] = await tx`
      INSERT INTO fame_reservations
        (id, market_id, application_id, revision, state, payment_required, currency,
         total_cents, checkout_description, quote_version, final_booth_quantity,
         final_dates, created_at, updated_at)
      VALUES
        (${reservationId}, ${application.market_id}, ${application.id}, 1, ${state},
         ${paymentRequired}, 'USD', ${quote.totalCents}, ${checkoutDescription},
         ${input.config.quoteVersion}, ${quote.boothsPerMarket},
         ${tx.json(quote.dates as unknown as Parameters<typeof tx.json>[0])}, ${now}, ${now})
      RETURNING id`;
    if (!reservation) throw new Error("Final reservation write failed.");
    await tx`
      INSERT INTO fame_reservation_finalizations
        (reservation_id, market_id, application_id, application_review_revision,
         application_review_event_id, application_source_location_id,
         application_source_event_id, agreement_completion_id,
         insurance_document_id, insurance_document_version,
         insurance_document_review_revision, food_license_document_id,
         food_license_document_version, food_license_document_review_revision,
         idempotency_key, selection_fingerprint,
         applicant_type, vendor_category, full_season, food_license_required, quote_tier,
         rate_cents, created_by_account_id, created_at)
      VALUES
        (${reservationId}, ${application.market_id}, ${application.id}, ${application.review_revision},
         ${approvedReview.id}, ${latestSource.location_id}, ${latestSource.event_id},
         ${agreement.id}, ${insurance.id}, ${insurance.version}, ${insurance.review_revision},
         ${foodLicense?.id ?? null}, ${foodLicense?.version ?? null}, ${foodLicense?.review_revision ?? null},
         ${input.selection.idempotencyKey}, ${fingerprint},
         ${input.selection.applicantType}, ${input.selection.vendorCategory},
         ${input.selection.fullSeason}, ${input.selection.foodLicenseRequired}, ${quote.tier}, ${quote.rateCents},
         ${input.actorAccountId}, ${now})`;
    for (const date of quote.dates) {
      await tx`
        INSERT INTO fame_reservation_allocations
          (reservation_id, market_id, market_date, booth_quantity, created_at)
        VALUES (${reservationId}, ${application.market_id}, ${date}::date,
                ${quote.boothsPerMarket}, ${now})`;
    }
    return {
      kind: "created",
      reservation: {
        id: reservationId,
        state,
        paymentRequired,
        totalCents: quote.totalCents,
        finalDates: quote.dates,
        finalBoothQuantity: quote.boothsPerMarket,
        quoteVersion: input.config.quoteVersion,
      },
    };
  });
}

export type ReopenReservationResult =
  | { kind: "reopened"; reservation: { id: string; state: "held"; finalDates: string[]; finalBoothQuantity: number; totalCents: number } }
  | { kind: "not_found" }
  | { kind: "not_expired"; state: string }
  | { kind: "unavailable"; unavailableDates: string[] };

/**
 * Gives an expired hold a second chance. The reservation keeps its dates,
 * booths, quote, revision and audit rows; only the state returns to "held"
 * with no deadline, so a fresh Square payment request (with a fresh 48-hour
 * window) can be created as a new attempt. Capacity is re-checked first because other vendors may
 * have taken the dates while the hold was expired.
 */
export async function reopenExpiredReservation(
  input: { marketId: string; reservationId: string; config: FreshAirFinalReservationConfig; now?: Date },
  sql: Sql = configuredClient(),
): Promise<ReopenReservationResult> {
  const now = input.now ?? new Date();
  return sql.begin(async tx => {
    const [row] = await tx<{ id: string; state: string; revision: number; final_dates: unknown; final_booth_quantity: number; total_cents: string | number; applicant_type: string; vendor_category: string }[]>`
      SELECT r.id, r.state, r.revision, r.final_dates, r.final_booth_quantity, r.total_cents, f.applicant_type, f.vendor_category
      FROM fame_reservations r
      JOIN fame_reservation_finalizations f ON f.reservation_id = r.id AND f.market_id = r.market_id
      WHERE r.id = ${input.reservationId} AND r.market_id = ${input.marketId}
      FOR UPDATE OF r`;
    if (!row) return { kind: "not_found" } as ReopenReservationResult;
    // "manual_review" is reached when a retried checkout could not be
    // completed; it is reopenable once no payment attempt is still live.
    if (row.state !== "expired" && row.state !== "manual_review") return { kind: "not_expired", state: row.state } as ReopenReservationResult;
    const [live] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM fame_payment_orders
      WHERE reservation_id = ${row.id} AND market_id = ${input.marketId} AND status NOT IN ('expired', 'failed', 'cancelled')`;
    if ((live?.n ?? 0) > 0) return { kind: "not_expired", state: row.state } as ReopenReservationResult;
    const dates = Array.isArray(row.final_dates) ? row.final_dates.filter((d): d is string => typeof d === "string").sort() : [];
    const booths = Number(row.final_booth_quantity);
    // Count everyone else: an expired row is already excluded, a manual-review row is not.
    const occupancy = [];
    for (const date of dates) occupancy.push(await occupancyForDate(tx, input.marketId, date, row.id));
    const check = checkVendorBooking(
      { dates: [...input.config.calendarDates], boothCapacity: input.config.boothCapacity },
      { applicantType: row.applicant_type as "Vendor" | "Non-Profit Organization", vendorCategory: row.vendor_category, selectedDates: dates, fullSeason: false, boothsPerMarket: booths },
      occupancy,
    );
    if (!check.allDatesAvailable) return { kind: "unavailable", unavailableDates: check.unavailableDates } as ReopenReservationResult;
    const [updated] = await tx<{ id: string }[]>`
      UPDATE fame_reservations
      SET state = 'held', payment_due_at = NULL, payment_request_sent_at = NULL, updated_at = ${now}
      WHERE id = ${row.id} AND market_id = ${input.marketId} AND state IN ('expired', 'manual_review')
      RETURNING id`;
    if (!updated) return { kind: "not_expired", state: row.state } as ReopenReservationResult;
    return { kind: "reopened", reservation: { id: updated.id, state: "held", finalDates: dates, finalBoothQuantity: booths, totalCents: Number(row.total_cents) } } as ReopenReservationResult;
  }) as Promise<ReopenReservationResult>;
}
