import { Account, Booth, Booking, BoothWithAvailability, InquiryInput } from "./types";

export type ApproveResult =
  | { ok: true; booking: Booking; alreadyApproved?: boolean }
  | { ok: false; conflicts: { date: string; businessName: string }[] };

export interface Store {
  /* ── Accounts (one account = one market) ─────────────── */
  createAccount(account: Account): Promise<Account>;
  getAccountByEmail(email: string): Promise<Account | null>;
  getAccountById(id: string): Promise<Account | null>;
  getAccountBySlug(slug: string): Promise<Account | null>;
  slugExists(slug: string): Promise<boolean>;
  /** Populate a fresh account's market with the default booth layout. */
  seedMarket(marketId: string): Promise<void>;

  /* ── Booths & bookings, always scoped to a market ────── */
  getBooth(marketId: string, id: string): Promise<Booth | null>;
  boothsWithAvailability(marketId: string, dates: string[], admin: boolean): Promise<BoothWithAvailability[]>;
  createInquiry(marketId: string, input: InquiryInput, totalPrice: number): Promise<Booking>;
  listBookings(marketId: string): Promise<Booking[]>;
  getBooking(marketId: string, id: string): Promise<Booking | null>;
  /** Approve verifies nobody else holds any of the requested booth-dates. */
  approveBooking(marketId: string, id: string): Promise<ApproveResult>;
  setBookingStatus(marketId: string, id: string, status: "rejected" | "cancelled"): Promise<Booking | null>;
  updateBooth(marketId: string, id: string, patch: Partial<Booth>): Promise<Booth | null>;
  createBooth(booth: Booth): Promise<Booth>;
  deleteBooth(marketId: string, id: string): Promise<boolean>;
}

export function isDemoMode(): boolean {
  return !process.env.DATABASE_URL;
}

let store: Store | null = null;

export async function getStore(): Promise<Store> {
  if (store) return store;
  if (isDemoMode()) {
    const { MemoryStore } = await import("./store-memory");
    store = new MemoryStore();
  } else {
    const { PgStore } = await import("./store-pg");
    store = new PgStore();
  }
  return store;
}

/** Turn a market name into a URL slug; store layer handles collisions. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "market"
  );
}

/** Shared availability math used by both backends. */
export function decorateBooth(
  booth: Booth,
  approved: { date: string; businessName: string; vendorName: string; category: string; bookingId: string }[],
  queryDates: string[],
  admin: boolean,
): BoothWithAvailability {
  const inRange = approved.filter((a) => queryDates.includes(a.date));
  const bookedDates = [...new Set(inRange.map((a) => a.date))].sort();
  const status =
    bookedDates.length === 0 ? "available" : bookedDates.length >= queryDates.length ? "rented" : "partial";
  const result: BoothWithAvailability = { ...booth, bookedDates, status };
  if (admin) {
    result.occupants = inRange.map((a) => ({
      date: a.date, vendorName: a.vendorName, businessName: a.businessName,
      category: a.category, bookingId: a.bookingId,
    }));
  }
  return result;
}
