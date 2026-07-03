export type BoothStatus = "available" | "partial" | "rented";

export interface Booth {
  id: string;
  marketId: string;
  label: string;
  zone: string;
  x: number;
  y: number;
  w: number;
  h: number;
  pricePerDay: number;
  active: boolean;
}

export type BookingStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface Vendor {
  id: string;
  name: string;
  businessName: string;
  email: string;
  phone: string;
  category: string;
}

export interface Booking {
  id: string;
  boothId: string;
  marketId: string;
  vendor: Vendor;
  status: BookingStatus;
  dates: string[]; // YYYY-MM-DD
  totalPrice: number;
  message: string;
  createdAt: string; // ISO
}

/** Booth enriched with availability for a set of dates (public map). */
export interface BoothWithAvailability extends Booth {
  bookedDates: string[]; // approved dates within the queried range
  status: BoothStatus;
  /** Present only in admin responses. */
  occupants?: { date: string; vendorName: string; businessName: string; category: string; bookingId: string }[];
}

export interface InquiryInput {
  boothId: string;
  name: string;
  businessName: string;
  email: string;
  phone: string;
  category: string;
  dates: string[];
  message?: string;
}

export type Plan = "starter" | "pro" | "season";
export type LicenseStatus = "trial" | "active" | "expired";

/** A SaaS customer: one account = one market operator = one market. */
export interface Account {
  id: string;
  email: string;
  passwordHash: string;
  ownerName: string;
  marketName: string;
  slug: string;
  plan: Plan;
  licenseKey: string;
  licenseStatus: LicenseStatus;
  trialEndsAt: string; // ISO
  createdAt: string; // ISO
}

/** Account shape safe to send to the browser. */
export type PublicAccount = Omit<Account, "passwordHash">;

export function toPublicAccount(a: Account): PublicAccount {
  const { passwordHash: _passwordHash, ...pub } = a;
  return pub;
}

export const VENDOR_CATEGORIES = [
  "Produce",
  "Baked Goods",
  "Prepared Food",
  "Dairy & Eggs",
  "Meat & Seafood",
  "Flowers & Plants",
  "Crafts & Artisan",
  "Beverages",
  "Wellness",
  "Other",
] as const;
