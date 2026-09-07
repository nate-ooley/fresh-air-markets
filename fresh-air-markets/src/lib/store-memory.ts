import { randomUUID } from "crypto";
import { Account, Booth, Booking, BoothWithAvailability, InquiryInput } from "./types";
import { ApproveResult, Store, decorateBooth } from "./store";
import { DEMO_MARKET_ID, DEMO_PASSWORD, defaultBooths, demoAccount, demoBookings } from "./seed";
import { hashPassword } from "./auth";

interface MemoryData {
  accounts: Account[];
  booths: Booth[];
  bookings: Booking[];
}

/** Survives Next.js HMR in dev; resets on cold start (demo mode only). */
function data(): MemoryData {
  const g = globalThis as typeof globalThis & { __marketData?: MemoryData };
  if (!g.__marketData) {
    g.__marketData = {
      accounts: [demoAccount(hashPassword(DEMO_PASSWORD))],
      booths: defaultBooths(DEMO_MARKET_ID, "demo"),
      bookings: demoBookings(),
    };
  }
  return g.__marketData;
}

export class MemoryStore implements Store {
  /* ── Accounts ────────────────────────────────────────── */

  async createAccount(account: Account): Promise<Account> {
    data().accounts.push(account);
    return account;
  }

  async getAccountByEmail(email: string): Promise<Account | null> {
    return data().accounts.find((a) => a.email === email.toLowerCase()) ?? null;
  }

  async getAccountById(id: string): Promise<Account | null> {
    return data().accounts.find((a) => a.id === id) ?? null;
  }

  async getAccountBySlug(slug: string): Promise<Account | null> {
    return data().accounts.find((a) => a.slug === slug) ?? null;
  }

  async slugExists(slug: string): Promise<boolean> {
    return data().accounts.some((a) => a.slug === slug);
  }

  async seedMarket(marketId: string): Promise<void> {
    data().booths.push(...defaultBooths(marketId, marketId.slice(0, 8)));
  }

  /* ── Booths & bookings ───────────────────────────────── */

  async getBooth(marketId: string, id: string): Promise<Booth | null> {
    return data().booths.find((b) => b.marketId === marketId && b.id === id && b.active) ?? null;
  }

  async boothsWithAvailability(marketId: string, dates: string[], admin: boolean): Promise<BoothWithAvailability[]> {
    const { booths, bookings } = data();
    return booths
      .filter((b) => b.marketId === marketId && b.active)
      .map((booth) => {
        const approved = bookings
          .filter((bk) => bk.boothId === booth.id && bk.status === "approved")
          .flatMap((bk) =>
            bk.dates.map((date) => ({
              date,
              businessName: bk.vendor.businessName,
              vendorName: bk.vendor.name,
              category: bk.vendor.category,
              bookingId: bk.id,
            })),
          );
        return decorateBooth(booth, approved, dates, admin);
      });
  }

  async createInquiry(marketId: string, input: InquiryInput, totalPrice: number): Promise<Booking> {
    const booking: Booking = {
      id: randomUUID(),
      boothId: input.boothId,
      marketId,
      status: "pending",
      dates: [...input.dates].sort(),
      totalPrice,
      message: input.message ?? "",
      createdAt: new Date().toISOString(),
      vendor: {
        id: randomUUID(),
        name: input.name,
        businessName: input.businessName,
        email: input.email,
        phone: input.phone,
        category: input.category,
      },
    };
    data().bookings.push(booking);
    return booking;
  }

  async listBookings(marketId: string): Promise<Booking[]> {
    return data()
      .bookings.filter((b) => b.marketId === marketId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getBooking(marketId: string, id: string): Promise<Booking | null> {
    return data().bookings.find((b) => b.marketId === marketId && b.id === id) ?? null;
  }

  async approveBooking(marketId: string, id: string): Promise<ApproveResult> {
    const booking = await this.getBooking(marketId, id);
    if (!booking) return { ok: false, conflicts: [] };
    if (!await this.getBooth(marketId, booking.boothId)) return { ok: false, conflicts: [] };
    // Recheck after the awaits: a cancellation/rejection may have arrived while
    // looking up the booth. Late approvals must not revive terminal decisions.
    if (booking.status !== "pending" && booking.status !== "approved") return { ok: false, conflicts: [] };
    if (booking.status === "approved") return { ok: true, booking, alreadyApproved: true };
    const conflicts = data()
      .bookings.filter((b) => b.marketId === marketId && b.id !== id && b.boothId === booking.boothId && b.status === "approved")
      .flatMap((b) =>
        b.dates
          .filter((d) => booking.dates.includes(d))
          .map((date) => ({ date, businessName: b.vendor.businessName })),
      );
    if (conflicts.length > 0) return { ok: false, conflicts };
    booking.status = "approved";
    return { ok: true, booking };
  }

  async setBookingStatus(marketId: string, id: string, status: "rejected" | "cancelled"): Promise<Booking | null> {
    const booking = await this.getBooking(marketId, id);
    if (!booking) return null;
    booking.status = status;
    return booking;
  }

  async updateBooth(marketId: string, id: string, patch: Partial<Booth>): Promise<Booth | null> {
    const booth = data().booths.find((b) => b.marketId === marketId && b.id === id);
    if (!booth) return null;
    Object.assign(booth, patch, { id: booth.id, marketId: booth.marketId });
    return booth;
  }

  async createBooth(booth: Booth): Promise<Booth> {
    data().booths.push(booth);
    return booth;
  }

  async deleteBooth(marketId: string, id: string): Promise<boolean> {
    const booth = data().booths.find((b) => b.marketId === marketId && b.id === id);
    if (!booth) return false;
    booth.active = false;
    return true;
  }
}
