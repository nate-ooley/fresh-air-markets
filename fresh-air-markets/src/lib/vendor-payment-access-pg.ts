import postgres from "postgres";
import { DEMO_MARKET_ID } from "./seed";
import { FRESH_AIR_SEASON_DATES } from "./fresh-air-season";
import { PAYMENT_WINDOW_MS, validSquareCheckoutUrl } from "./square";
import {
  VENDOR_INVITATION_MS, VENDOR_SESSION_MS,
  type VendorPaymentAccessConfig, type VendorPaymentAccessStore, type VendorPaymentView,
  type VendorInvitationIssueResult, type VendorInvitationExchangeResult,
} from "./vendor-payment-access";

type Sql = ReturnType<typeof postgres>;
type QuerySql = Sql | postgres.TransactionSql;
let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent vendor payment access storage is required");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

interface AccessSnapshot {
  id: string;
  revision: number;
  state: string;
  payment_required: boolean;
  currency: string;
  total_cents: string | number;
  final_booth_quantity: number;
  final_dates: unknown;
  payment_due_at: Date | null;
  payment_request_sent_at: Date | null;
  quote_tier: string;
  rate_cents: number;
  order_status: string | null;
  order_environment: string | null;
  order_currency: string | null;
  order_total_cents: string | number | null;
  order_due_at: Date | null;
  order_sent_at: Date | null;
  checkout_url: string | null;
  payment_id: string | null;
  payment_status: string | null;
}

/** The join requires the committed audit row, exact market and exact revision. */
async function snapshot(sql: QuerySql, config: VendorPaymentAccessConfig, reservationId: string, lock = false): Promise<AccessSnapshot | null> {
  if (config.marketId === DEMO_MARKET_ID) return null;
  const result = await sql<AccessSnapshot[]>`
    SELECT r.id, r.revision, r.state, r.payment_required, r.currency, r.total_cents,
           r.final_booth_quantity, r.final_dates, r.payment_due_at, r.payment_request_sent_at,
           f.quote_tier, f.rate_cents, p.status AS order_status,
           p.square_environment AS order_environment, p.expected_currency AS order_currency,
           p.expected_total_cents AS order_total_cents, p.payment_due_at AS order_due_at,
           p.payment_request_sent_at AS order_sent_at, p.checkout_url,
           p.payment_id, p.payment_status
    FROM fame_reservations r
    JOIN fame_reservation_finalizations f
      ON f.reservation_id = r.id AND f.market_id = r.market_id AND f.application_id = r.application_id
    LEFT JOIN fame_payment_orders p
      ON p.reservation_id = r.id AND p.market_id = r.market_id AND p.reservation_revision = r.revision
    WHERE r.id = ${reservationId} AND r.market_id = ${config.marketId}
    ${lock ? sql`FOR UPDATE OF r` : sql``}`;
  return result[0] || null;
}

function epoch(value: Date | null): number {
  return value instanceof Date ? value.valueOf() : NaN;
}

/** Whitelist only immutable reservation data; lifecycle gates decide whether a link can be exposed. */
function paymentView(row: AccessSnapshot, config: VendorPaymentAccessConfig, now: Date): VendorPaymentView | null {
  const dates = row.final_dates;
  const quantity = Number(row.final_booth_quantity);
  const total = Number(row.total_cents);
  const rate = Number(row.rate_cents);
  const rates: Record<string, number> = { standard: 4000, consecutive: 3500, "full-season": 3000, nonprofit: 0 };
  if (!Array.isArray(dates) || !dates.length || dates.length > 35
    || !dates.every(date => typeof date === "string" && (FRESH_AIR_SEASON_DATES as readonly string[]).includes(date))
    || new Set(dates).size !== dates.length || !Number.isSafeInteger(quantity) || quantity < 1
    || !Number.isSafeInteger(total) || total < 0 || rates[row.quote_tier] !== rate
    || total !== dates.length * quantity * rate || row.currency !== "USD") return null;
  const view: VendorPaymentView = {
    dates: [...dates].sort(), boothsPerMarket: quantity, rateCents: rate, totalCents: total,
    currency: "USD", quoteTier: row.quote_tier as VendorPaymentView["quoteTier"],
    paymentRequired: row.payment_required, paymentDueAt: null,
    status: "unavailable", checkoutUrl: null, environment: null,
  };
  if (!row.payment_required) {
    if (row.quote_tier !== "nonprofit" || total !== 0) return null;
    view.status = row.state === "confirmed" ? "confirmed" : "unavailable";
    return view;
  }
  if (row.quote_tier === "nonprofit" || total <= 0) return null;
  const due = epoch(row.payment_due_at);
  const sent = epoch(row.payment_request_sent_at);
  if (row.order_environment !== config.environment || row.order_currency !== "USD"
    || Number(row.order_total_cents) !== total || !Number.isFinite(due) || !Number.isFinite(sent)
    || due - sent !== PAYMENT_WINDOW_MS || epoch(row.order_due_at) !== due || epoch(row.order_sent_at) !== sent) {
    return view;
  }
  view.environment = config.environment;
  view.paymentDueAt = new Date(due).toISOString();
  if (row.state === "paid" && row.order_status === "paid" && row.payment_id && row.payment_status === "COMPLETED") {
    view.status = "paid";
  } else if (["expired", "expiry_pending"].includes(row.order_status || "") || row.state === "expired"
    || (row.state === "payment_pending" && row.order_status === "checkout_created" && due <= now.valueOf())) {
    view.status = "expired";
  } else if (row.state === "payment_pending" && row.order_status === "checkout_created" && due > now.valueOf()
    && config.allowCheckout && validSquareCheckoutUrl(row.checkout_url, config.environment)) {
    view.status = "pending";
    view.checkoutUrl = row.checkout_url;
  }
  return view;
}

function usableForInvitation(view: VendorPaymentView | null): view is VendorPaymentView {
  return view?.status === "pending" || view?.status === "confirmed" || view?.status === "paid";
}

export async function issueVendorPaymentAccess(
  input: Parameters<VendorPaymentAccessStore["issue"]>[0], sql: Sql = configuredClient(),
): Promise<VendorInvitationIssueResult> {
  if (!/^[a-f0-9]{64}$/.test(input.tokenHash) || !Number.isFinite(input.now.valueOf())) throw new Error("Invalid access issue input");
  return sql.begin(async tx => {
    // Every issuance/exchange takes the same reservation lock first. Rotating
    // a link therefore cannot race a consumed invitation into a live session.
    const row = await snapshot(tx, input.config, input.reservationId, true);
    if (!row) return { kind: "not_found" };
    const view = paymentView(row, input.config, input.now);
    if (!usableForInvitation(view)) return { kind: "not_eligible" };
    const expires = view.status === "pending"
      ? new Date(Math.min(input.now.valueOf() + VENDOR_INVITATION_MS, Date.parse(view.paymentDueAt!)))
      : new Date(input.now.valueOf() + VENDOR_SESSION_MS);
    await tx`UPDATE fame_vendor_payment_sessions SET revoked_at = ${input.now}
      WHERE market_id = ${input.config.marketId} AND reservation_id = ${input.reservationId} AND revoked_at IS NULL`;
    await tx`UPDATE fame_vendor_payment_invitations SET revoked_at = ${input.now}
      WHERE market_id = ${input.config.marketId} AND reservation_id = ${input.reservationId} AND revoked_at IS NULL`;
    await tx`INSERT INTO fame_vendor_payment_invitations
      (token_hash, market_id, reservation_id, reservation_revision, created_at, expires_at)
      VALUES (${input.tokenHash}, ${input.config.marketId}, ${input.reservationId}, ${row.revision}, ${input.now}, ${expires})`;
    return { kind: "issued", expiresAt: expires.toISOString() };
  }) as Promise<VendorInvitationIssueResult>;
}

export async function exchangeVendorPaymentAccess(
  input: Parameters<VendorPaymentAccessStore["exchange"]>[0], sql: Sql = configuredClient(),
): Promise<VendorInvitationExchangeResult> {
  if (!/^[a-f0-9]{64}$/.test(input.invitationHash) || !/^[a-f0-9]{64}$/.test(input.sessionHash)
    || input.invitationHash === input.sessionHash || !Number.isFinite(input.now.valueOf())) return { kind: "invalid" };
  return sql.begin(async tx => {
    const [locator] = await tx<{ reservation_id: string }[]>`
      SELECT reservation_id FROM fame_vendor_payment_invitations
      WHERE token_hash = ${input.invitationHash} AND market_id = ${input.config.marketId}`;
    if (!locator) return { kind: "invalid" };
    const row = await snapshot(tx, input.config, locator.reservation_id, true);
    if (!row) return { kind: "invalid" };
    const [invitation] = await tx<{ reservation_revision: number; expires_at: Date; consumed_at: Date | null; revoked_at: Date | null }[]>`
      SELECT reservation_revision, expires_at, consumed_at, revoked_at FROM fame_vendor_payment_invitations
      WHERE token_hash = ${input.invitationHash} AND market_id = ${input.config.marketId} FOR UPDATE`;
    if (!invitation || invitation.reservation_revision !== row.revision || invitation.consumed_at || invitation.revoked_at
      || epoch(invitation.expires_at) <= input.now.valueOf()) return { kind: "invalid" };
    const view = paymentView(row, input.config, input.now);
    // A paid webhook can arrive between issuance and the vendor opening the
    // link. Permit that receipt, but never revive an expired/cancelled checkout.
    if (!usableForInvitation(view)) return { kind: "invalid" };
    const expires = new Date(input.now.valueOf() + VENDOR_SESSION_MS);
    await tx`UPDATE fame_vendor_payment_invitations SET consumed_at = ${input.now} WHERE token_hash = ${input.invitationHash}`;
    await tx`INSERT INTO fame_vendor_payment_sessions
      (token_hash, invitation_hash, market_id, reservation_id, reservation_revision, created_at, expires_at)
      VALUES (${input.sessionHash}, ${input.invitationHash}, ${input.config.marketId}, ${locator.reservation_id}, ${row.revision}, ${input.now}, ${expires})`;
    return { kind: "exchanged", expiresAt: expires.toISOString() };
  }) as Promise<VendorInvitationExchangeResult>;
}

export async function readVendorPaymentAccess(
  input: Parameters<VendorPaymentAccessStore["read"]>[0], sql: Sql = configuredClient(),
): Promise<VendorPaymentView | null> {
  if (!/^[a-f0-9]{64}$/.test(input.sessionHash) || !Number.isFinite(input.now.valueOf())) return null;
  return sql.begin(async tx => {
    const [session] = await tx<{ reservation_id: string; reservation_revision: number }[]>`
      SELECT s.reservation_id, s.reservation_revision FROM fame_vendor_payment_sessions s
      JOIN fame_vendor_payment_invitations i ON i.token_hash = s.invitation_hash
        AND i.market_id = s.market_id AND i.reservation_id = s.reservation_id AND i.reservation_revision = s.reservation_revision
      WHERE s.token_hash = ${input.sessionHash} AND s.market_id = ${input.config.marketId}
        AND s.expires_at > ${input.now} AND s.revoked_at IS NULL AND i.revoked_at IS NULL AND i.consumed_at IS NOT NULL`;
    if (!session) return null;
    const row = await snapshot(tx, input.config, session.reservation_id);
    if (!row || row.revision !== session.reservation_revision) return null;
    // Check revocation again after the projection read so a concurrent rotate
    // cannot return a new session after its authorization was already removed.
    const [active] = await tx`SELECT token_hash FROM fame_vendor_payment_sessions
      WHERE token_hash = ${input.sessionHash} AND revoked_at IS NULL AND expires_at > ${input.now}`;
    return active ? paymentView(row, input.config, input.now) : null;
  }) as Promise<VendorPaymentView | null>;
}

export async function revokeVendorPaymentAccess(
  input: Parameters<VendorPaymentAccessStore["revoke"]>[0], sql: Sql = configuredClient(),
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(input.sessionHash)) return;
  await sql`UPDATE fame_vendor_payment_sessions SET revoked_at = ${input.now}
    WHERE token_hash = ${input.sessionHash} AND market_id = ${input.config.marketId} AND revoked_at IS NULL`;
}

export const postgresVendorPaymentAccessStore: VendorPaymentAccessStore = {
  issue: issueVendorPaymentAccess, exchange: exchangeVendorPaymentAccess,
  read: readVendorPaymentAccess, revoke: revokeVendorPaymentAccess,
};
