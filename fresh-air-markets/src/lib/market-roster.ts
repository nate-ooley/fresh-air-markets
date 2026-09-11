import postgres from "postgres";
import { reviewIdentitySnapshot } from "./application-review-pg";

/**
 * Market roster: who is coming on each market date, how many booths they
 * hold, and whether they have paid. Built from final reservations (dates and
 * booth count per reservation), the finalization's vendor category, and the
 * application's latest identity snapshot. Read-only.
 */

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 2, prepare: false, connect_timeout: 5 });
  return client;
}

export type RosterStatus = "paid" | "confirmed" | "pending";
const STATUS_BY_STATE: Record<string, RosterStatus | undefined> = { paid: "paid", confirmed: "confirmed", held: "pending", payment_pending: "pending" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface RosterVendor {
  reservationId: string;
  applicationId: string;
  businessName: string;
  vendorName: string;
  email: string;
  phone: string;
  applicantType: "Vendor" | "Non-Profit Organization";
  category: string;
  booths: number;
  dates: string[];
  status: RosterStatus;
  totalCents: number;
  paymentDueAt: string | null;
}

interface RosterRow {
  reservation_id: string; application_id: string; state: string; final_booth_quantity: number; final_dates: unknown;
  total_cents: string | number; payment_due_at: Date | null; applicant_type: string | null; vendor_category: string | null; snapshot: unknown;
}

function datesOf(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((d): d is string => typeof d === "string" && DATE.test(d)))].sort() : [];
}

/** Every live reservation (paid, confirmed or awaiting payment) with its vendor. */
export async function loadMarketRoster(marketId: string, sql: Sql = configuredClient()): Promise<RosterVendor[]> {
  const rows = await sql<RosterRow[]>`
    SELECT r.id AS reservation_id, r.application_id, r.state, r.final_booth_quantity, r.final_dates, r.total_cents, r.payment_due_at,
           f.applicant_type, f.vendor_category,
           (SELECT e.snapshot FROM fame_application_events e
             WHERE e.application_id = r.application_id AND e.market_id = r.market_id
             ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS snapshot
    FROM fame_reservations r
    LEFT JOIN fame_reservation_finalizations f ON f.reservation_id = r.id AND f.market_id = r.market_id
    WHERE r.market_id = ${marketId} AND r.application_id IS NOT NULL
      AND r.state IN ('paid', 'confirmed', 'held', 'payment_pending')
    ORDER BY r.created_at`;
  const vendors: RosterVendor[] = [];
  for (const row of rows) {
    const status = STATUS_BY_STATE[row.state];
    if (!status) continue;
    const identity = reviewIdentitySnapshot(row.snapshot);
    const raw = (row.snapshot as { snapshot?: Record<string, unknown> } | null)?.snapshot;
    const phone = typeof raw?.phone === "string" ? raw.phone.slice(0, 40) : "";
    const applicantType = row.applicant_type === "Non-Profit Organization" || identity?.applicantType === "Non-Profit Organization" ? "Non-Profit Organization" : "Vendor";
    vendors.push({
      reservationId: row.reservation_id,
      applicationId: row.application_id,
      businessName: identity?.businessName ?? "(name unavailable)",
      vendorName: identity?.vendorName ?? "",
      email: identity?.email ?? "",
      phone,
      applicantType,
      category: row.vendor_category || identity?.category || "Uncategorized",
      booths: Number(row.final_booth_quantity),
      dates: datesOf(row.final_dates),
      status,
      totalCents: Number(row.total_cents),
      paymentDueAt: row.payment_due_at ? new Date(row.payment_due_at).toISOString() : null,
    });
  }
  return vendors;
}

export interface RosterGroup { category: string; vendors: RosterVendor[]; booths: number }
export interface DayRoster {
  date: string;
  confirmed: RosterGroup[];
  pending: RosterGroup[];
  totals: { confirmedVendors: number; confirmedBooths: number; pendingVendors: number; pendingBooths: number };
}

function grouped(vendors: RosterVendor[]): RosterGroup[] {
  const map = new Map<string, RosterVendor[]>();
  for (const vendor of vendors) map.set(vendor.category, [...(map.get(vendor.category) ?? []), vendor]);
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, members]) => ({
      category,
      vendors: [...members].sort((a, b) => a.businessName.localeCompare(b.businessName)),
      booths: members.reduce((sum, v) => sum + v.booths, 0),
    }));
}

/** The vendors on one date, split into confirmed (paid or no payment due) and still pending. */
export function rosterForDate(vendors: RosterVendor[], date: string): DayRoster {
  const onDate = vendors.filter(v => v.dates.includes(date));
  const confirmedList = onDate.filter(v => v.status !== "pending");
  const pendingList = onDate.filter(v => v.status === "pending");
  return {
    date,
    confirmed: grouped(confirmedList),
    pending: grouped(pendingList),
    totals: {
      confirmedVendors: confirmedList.length,
      confirmedBooths: confirmedList.reduce((s, v) => s + v.booths, 0),
      pendingVendors: pendingList.length,
      pendingBooths: pendingList.reduce((s, v) => s + v.booths, 0),
    },
  };
}

export interface SeasonDay { date: string; confirmedVendors: number; confirmedBooths: number; pendingBooths: number; capacity: number; openBooths: number }

/** Booth counts per market date across the season. */
export function seasonOverview(vendors: RosterVendor[], dates: readonly string[], capacity: number): SeasonDay[] {
  return dates.map(date => {
    const day = rosterForDate(vendors, date);
    return {
      date,
      confirmedVendors: day.totals.confirmedVendors,
      confirmedBooths: day.totals.confirmedBooths,
      pendingBooths: day.totals.pendingBooths,
      capacity,
      openBooths: Math.max(0, capacity - day.totals.confirmedBooths - day.totals.pendingBooths),
    };
  });
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

const STATUS_LABEL: Record<RosterStatus, string> = { paid: "Paid", confirmed: "Confirmed (no payment due)", pending: "Payment pending" };

/** Spreadsheet of one date's roster, confirmed first, grouped by category. */
export function rosterCsv(vendors: RosterVendor[], date: string): string {
  const day = rosterForDate(vendors, date);
  const lines = [["Market date", "Status", "Category", "Business", "Contact", "Email", "Phone", "Booths", "Type"].join(",")];
  for (const groups of [day.confirmed, day.pending]) {
    for (const group of groups) {
      for (const v of group.vendors) {
        lines.push([date, STATUS_LABEL[v.status], v.category, v.businessName, v.vendorName, v.email, v.phone, v.booths, v.applicantType].map(csvCell).join(","));
      }
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function validRosterDate(value: unknown, dates: readonly string[]): value is string {
  return typeof value === "string" && dates.includes(value);
}
