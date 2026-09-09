import { FRESH_AIR_SEASON_DATES } from "./fresh-air-season";
/** Browser-safe projection. No invitation, provider secret, or CRM data belongs here. */
export interface VendorPaymentView {
  dates: string[];
  boothsPerMarket: number;
  rateCents: number;
  totalCents: number;
  currency: "USD";
  quoteTier: "standard" | "consecutive" | "full-season" | "nonprofit";
  paymentRequired: boolean;
  paymentDueAt: string | null;
  status: "pending" | "paid" | "confirmed" | "expired" | "unavailable";
  checkoutUrl: string | null;
  environment: "sandbox" | "production" | null;
}

export function invitationFromFragment(fragment: string): string | null {
  if (!fragment.startsWith("#")) return null;
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const tokens = params.getAll("token");
  return [...params.keys()].length === 1 && tokens.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(tokens[0])
    ? tokens[0] : null;
}

export function trustedVendorCheckoutUrl(value: unknown, environment: unknown): value is string {
  if (typeof value !== "string" || !value || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.pathname === "/") return false;
    if (environment === "production") return ["square.link", "checkout.square.site"].includes(url.hostname);
    return environment === "sandbox" && (["sandbox.square.link"].includes(url.hostname)
      || (url.hostname === "connect.squareupsandbox.com" && url.pathname.startsWith("/v2/online-checkout/sandbox-testing-panel/")));
  } catch { return false; }
}

export function parseVendorPaymentView(value: unknown): VendorPaymentView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as VendorPaymentView;
  if (!Array.isArray(row.dates) || !row.dates.length || !row.dates.every(d => (FRESH_AIR_SEASON_DATES as readonly string[]).includes(d))
    || new Set(row.dates).size !== row.dates.length
    || !Number.isSafeInteger(row.boothsPerMarket) || row.boothsPerMarket < 1
    || !Number.isSafeInteger(row.rateCents) || row.rateCents < 0
    || !Number.isSafeInteger(row.totalCents) || row.totalCents < 0 || row.currency !== "USD"
    || !["standard", "consecutive", "full-season", "nonprofit"].includes(row.quoteTier)
    || typeof row.paymentRequired !== "boolean"
    || !["pending", "paid", "confirmed", "expired", "unavailable"].includes(row.status)
    || !["sandbox", "production", null].includes(row.environment)
    || !(row.paymentDueAt === null || (typeof row.paymentDueAt === "string" && Number.isFinite(Date.parse(row.paymentDueAt))))
    || !(row.checkoutUrl === null || trustedVendorCheckoutUrl(row.checkoutUrl, row.environment))) return null;
  const rates = { standard: 4000, consecutive: 3500, "full-season": 3000, nonprofit: 0 };
  if (row.rateCents !== rates[row.quoteTier] || row.totalCents !== row.dates.length * row.boothsPerMarket * row.rateCents
    || row.paymentRequired !== (row.quoteTier !== "nonprofit")
    || (row.paymentRequired && row.environment === null && row.status !== "unavailable")
    || (row.quoteTier === "full-season" && row.dates.length !== FRESH_AIR_SEASON_DATES.length)) return null;
  return row;
}

export function canOpenVendorCheckout(reservation: VendorPaymentView, now: number): boolean {
  return reservation.status === "pending" && reservation.paymentRequired && reservation.totalCents > 0
    && reservation.paymentDueAt !== null && Date.parse(reservation.paymentDueAt) > now
    && trustedVendorCheckoutUrl(reservation.checkoutUrl, reservation.environment);
}
