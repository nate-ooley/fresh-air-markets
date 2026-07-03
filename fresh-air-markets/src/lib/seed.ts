import { Account, Booth, Booking } from "./types";
import { upcomingWeekends } from "./dates";

/**
 * Default market layout: a big U (left arm, entrance row, right arm)
 * with a double island of booths in the center. Coordinates live in a
 * 1200 x 820 SVG viewBox; operators can drag booths anywhere.
 *
 * `prefix` namespaces booth ids per market so layouts from different
 * accounts never collide.
 */
export function defaultBooths(marketId: string, prefix: string): Booth[] {
  const booths: Booth[] = [];
  const id = (label: string) => `${prefix}-${label.toLowerCase()}`;

  // Left arm of the U — A1..A6 (top to bottom)
  for (let i = 0; i < 6; i++) {
    booths.push({
      id: id(`A${i + 1}`), marketId, label: `A${i + 1}`, zone: "West Row",
      x: 70, y: 120 + i * 88, w: 80, h: 72,
      pricePerDay: i === 0 || i === 5 ? 55 : 45, active: true,
    });
  }

  // Right arm of the U — C1..C6 (top to bottom)
  for (let i = 0; i < 6; i++) {
    booths.push({
      id: id(`C${i + 1}`), marketId, label: `C${i + 1}`, zone: "East Row",
      x: 1050, y: 120 + i * 88, w: 80, h: 72,
      pricePerDay: i === 0 || i === 5 ? 55 : 45, active: true,
    });
  }

  // Bottom of the U (main entrance promenade) — B1..B8
  for (let i = 0; i < 8; i++) {
    booths.push({
      id: id(`B${i + 1}`), marketId, label: `B${i + 1}`, zone: "Entrance Promenade",
      x: 200 + i * 110, y: 690, w: 92, h: 72,
      pricePerDay: i === 0 || i === 7 ? 65 : 55, active: true,
    });
  }

  // Center island, two back-to-back rows — D1..D5 and E1..E5
  for (let i = 0; i < 5; i++) {
    booths.push({
      id: id(`D${i + 1}`), marketId, label: `D${i + 1}`, zone: "Center Island",
      x: 296 + i * 126, y: 250, w: 104, h: 76,
      pricePerDay: 60, active: true,
    });
    booths.push({
      id: id(`E${i + 1}`), marketId, label: `E${i + 1}`, zone: "Center Island",
      x: 296 + i * 126, y: 330, w: 104, h: 76,
      pricePerDay: 60, active: true,
    });
  }

  return booths;
}

/* ── Demo tenant: powers the live demo on the marketing site ── */

export const DEMO_MARKET_ID = "demo-market";
export const DEMO_SLUG = "sunrise-market";
export const DEMO_EMAIL = "demo@freshairmarkets.app";
export const DEMO_PASSWORD = "sunrise-demo";

/** passwordHash is for DEMO_PASSWORD ("sunrise-demo"), computed at seed time by the store. */
export function demoAccount(passwordHash: string): Account {
  return {
    id: DEMO_MARKET_ID,
    email: DEMO_EMAIL,
    passwordHash,
    ownerName: "Demo Operator",
    marketName: "Sunrise Farmers Market",
    slug: DEMO_SLUG,
    plan: "pro",
    licenseKey: "FAM-DEMO-DEMO-DEMO",
    licenseStatus: "active",
    trialEndsAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    createdAt: new Date().toISOString(),
  };
}

/** Demo bookings so the demo market has life before real inquiries arrive. */
export function demoBookings(): Booking[] {
  const weekends = upcomingWeekends();
  const w0 = weekends[0]?.dates.map((d) => d.date) ?? [];
  const w1 = weekends[1]?.dates.map((d) => d.date) ?? [];
  const now = new Date().toISOString();
  const boothId = (label: string) => `demo-${label}`;

  const mk = (
    id: string, booth: string, status: Booking["status"], dates: string[],
    price: number, name: string, businessName: string, email: string, category: string,
  ): Booking => ({
    id, boothId: boothId(booth), marketId: DEMO_MARKET_ID, status, dates,
    totalPrice: price, createdAt: now, message: "",
    vendor: { id: `v-${id}`, name, businessName, email, phone: "555-0100", category },
  });

  return [
    mk("demo-1", "a1", "approved", w0, 55 * w0.length,
      "Rosa Alvarez", "Sunrise Farms", "rosa@sunrisefarms.example", "Produce"),
    mk("demo-2", "d3", "approved", [...w0, ...w1], 60 * (w0.length + w1.length),
      "Marcus Lee", "Golden Crust Bakery", "marcus@goldencrust.example", "Baked Goods"),
    mk("demo-3", "b4", "approved", w0, 55 * w0.length,
      "Priya Patel", "Bloom & Stem", "priya@bloomstem.example", "Flowers & Plants"),
    mk("demo-4", "b1", "pending", w1, 65 * w1.length,
      "Jake Thompson", "Smoky J's BBQ", "jake@smokyjs.example", "Prepared Food"),
  ];
}
