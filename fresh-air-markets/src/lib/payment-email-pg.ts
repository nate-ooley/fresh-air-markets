import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { DEMO_MARKET_ID } from "./seed";
import { PAYMENT_WINDOW_MS, validSquareCheckoutUrl } from "./square";
import {
  createVendorAccessToken, hashVendorAccessToken, vendorInvitationUrl,
  type VendorPaymentAccessConfig,
} from "./vendor-payment-access";
import { issueVendorPaymentAccessWithinTransaction } from "./vendor-payment-access-pg";
import {
  encryptPaymentEmailInvitation, decryptPaymentEmailInvitation, validatePaymentEmailSecret,
} from "./payment-email";
import {
  preflightPaymentEmail, sendPaymentEmail, verifyPaymentEmailReceipt, PaymentEmailDeliveryError,
  type PaymentEmailDeliveryConfig, type PaymentEmailMessage, type PaymentEmailAcceptedReceipt,
} from "./ghl-payment-email-delivery";

type Sql = ReturnType<typeof postgres>;
type QuerySql = Sql | postgres.TransactionSql;
let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent payment email storage is required");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}
const LEASE_MS = 120_000;
const MAX_PREPARE_ATTEMPTS = 5;
export type PaymentEmailState = "pending" | "preparing" | "send_started" | "accepted" | "delivered" | "failed" | "uncertain" | "cancelled";
export interface PaymentEmailStatus {
  id: string; status: PaymentEmailState; createdAt: string; sentAt?: string; safeError?: string; canRetryPreflight: boolean;
}
interface OutboxRow {
  id: string; market_id: string; application_id: string; reservation_id: string; reservation_revision: number;
  source_location_id: string; source_event_id: string; contact_id: string; opportunity_id: string;
  recipient_email: string; total_cents: number | string; payment_due_at: Date; invitation_hash: string;
  invitation_ciphertext: string | null; state: PaymentEmailState; prepare_attempts: number; receipt_attempts: number; receipt_failures: number;
  lease_id: string | null; lease_expires_at: Date | null; safe_error: string | null;
  provider_message_id: string | null; provider_conversation_id: string | null; provider_email_message_id: string | null;
  created_at: Date; sent_at: Date | null; send_started_at: Date | null;
}
interface EligibleRow {
  id: string; market_id: string; application_id: string; revision: number; state: string;
  payment_required: boolean; currency: string; total_cents: string | number;
  payment_due_at: Date | null; payment_request_sent_at: Date | null;
  source_location_id: string; source_event_id: string; contact_id: string; opportunity_id: string;
  recipient_email: unknown; order_status: string; order_environment: string; order_currency: string;
  order_total_cents: string | number; order_due_at: Date | null; order_sent_at: Date | null; checkout_url: string | null;
}
interface SharedConfig { marketId: string; accessConfig: VendorPaymentAccessConfig; deliveryConfig: PaymentEmailDeliveryConfig }
export interface QueuePaymentEmailInput extends SharedConfig { reservationId: string; actorAccountId: string; secret: string; now?: Date; retryPreflight?: boolean }
export type QueuePaymentEmailResult = { kind: "queued" | "existing"; notification: PaymentEmailStatus }
  | { kind: "forbidden" | "not_found" | "not_eligible" | "invalid_source" };

function validConfiguration(input: SharedConfig): boolean {
  return Boolean(input.marketId && input.marketId !== DEMO_MARKET_ID
    && input.marketId === input.accessConfig.marketId && input.marketId === input.deliveryConfig.marketId
    && input.accessConfig.portalOrigin === input.deliveryConfig.portalOrigin
    && ((input.deliveryConfig.mode === "qa" && input.accessConfig.environment === "sandbox")
      || (input.deliveryConfig.mode === "production" && input.accessConfig.environment === "production")));
}
function safeCode(value: unknown, fallback = "payment_email_unavailable"): string {
  return typeof value === "string" && /^payment_email_[a-z_]{1,80}$/.test(value) ? value : fallback;
}
function status(row: OutboxRow): PaymentEmailStatus {
  return { id: row.id, status: row.state, createdAt: row.created_at.toISOString(),
    canRetryPreflight: row.send_started_at === null && (row.state === "failed" || row.state === "cancelled"),
    ...(row.sent_at ? { sentAt: row.sent_at.toISOString() } : {}), ...(row.safe_error ? { safeError: safeCode(row.safe_error) } : {}) };
}
function recipient(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(email) ? email : null;
}

/** Identity comes from the agreement and source event bound by immutable finalization. */
async function eligibleSnapshot(sql: QuerySql, marketId: string, reservationId: string, lock = false): Promise<EligibleRow | null> {
  const [row] = await sql<EligibleRow[]>`
    SELECT r.id, r.market_id, r.application_id, r.revision, r.state, r.payment_required, r.currency, r.total_cents,
      r.payment_due_at, r.payment_request_sent_at, f.application_source_location_id AS source_location_id,
      f.application_source_event_id AS source_event_id, g.contact_id, g.opportunity_id, e.snapshot->>'email' AS recipient_email,
      p.status AS order_status, p.square_environment AS order_environment, p.expected_currency AS order_currency,
      p.expected_total_cents AS order_total_cents, p.payment_due_at AS order_due_at, p.payment_request_sent_at AS order_sent_at, p.checkout_url
    FROM fame_reservations r
    JOIN fame_reservation_finalizations f ON f.reservation_id = r.id AND f.market_id = r.market_id AND f.application_id = r.application_id
    JOIN fame_application_events e ON e.location_id = f.application_source_location_id AND e.event_id = f.application_source_event_id
      AND e.market_id = f.market_id AND e.application_id = f.application_id
    JOIN fame_agreement_completions g ON g.id = f.agreement_completion_id AND g.market_id = f.market_id
      AND g.application_id = f.application_id AND g.location_id = f.application_source_location_id
    LEFT JOIN fame_payment_orders p ON p.reservation_id = r.id AND p.market_id = r.market_id AND p.reservation_revision = r.revision
    WHERE r.id = ${reservationId} AND r.market_id = ${marketId}
    ${lock ? sql`FOR UPDATE OF r` : sql``}`;
  return row || null;
}
function isPayable(row: EligibleRow, config: VendorPaymentAccessConfig, now: Date): boolean {
  const due = row.payment_due_at?.valueOf();
  const sent = row.payment_request_sent_at?.valueOf();
  return config.allowCheckout && row.state === "payment_pending" && row.payment_required
    && row.order_status === "checkout_created" && row.order_environment === config.environment
    && row.currency === "USD" && row.order_currency === "USD" && Number.isSafeInteger(Number(row.total_cents))
    && Number(row.total_cents) > 0 && Number(row.total_cents) === Number(row.order_total_cents)
    && typeof due === "number" && typeof sent === "number" && due > now.valueOf() && due - sent === PAYMENT_WINDOW_MS
    && row.order_due_at?.valueOf() === due && row.order_sent_at?.valueOf() === sent
    && validSquareCheckoutUrl(row.checkout_url, config.environment);
}

export async function queuePaymentEmail(input: QueuePaymentEmailInput, sql: Sql = configuredClient()): Promise<QueuePaymentEmailResult> {
  if (input.actorAccountId !== input.marketId || !validConfiguration(input)) return { kind: "forbidden" };
  validatePaymentEmailSecret(input.secret);
  const now = input.now || new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("Invalid notification clock");
  return sql.begin(async tx => {
    const row = await eligibleSnapshot(tx, input.marketId, input.reservationId, true);
    if (!row) return { kind: "not_found" };
    // Locking the reservation serializes this unique event even across distinct manager requests.
    const [existing] = await tx<OutboxRow[]>`SELECT * FROM fame_payment_email_outbox
      WHERE market_id = ${input.marketId} AND reservation_id = ${input.reservationId} AND reservation_revision = ${row.revision}`;
    if (existing && !(input.retryPreflight === true && status(existing).canRetryPreflight)) {
      return { kind: "existing", notification: status(existing) };
    }
    if (!isPayable(row, input.accessConfig, now)) return { kind: "not_eligible" };
    if (existing && !matches(existing, row)) return { kind: "invalid_source" };
    const email = recipient(row.recipient_email);
    if (!email || row.source_location_id !== input.deliveryConfig.locationId
      || !row.contact_id || !row.opportunity_id
      || (input.deliveryConfig.mode === "qa" && !["lnooley@gmail.com", "nate@autocraftstudios.com"].includes(email))) {
      return { kind: "invalid_source" };
    }
    const id = existing?.id || randomUUID();
    const token = createVendorAccessToken();
    const hash = hashVendorAccessToken(token);
    const result = await issueVendorPaymentAccessWithinTransaction({ config: input.accessConfig,
      reservationId: input.reservationId, tokenHash: hash, now }, tx);
    if (result.kind !== "issued") return { kind: "not_eligible" };
    const ciphertext = encryptPaymentEmailInvitation(vendorInvitationUrl(input.accessConfig.portalOrigin, token), input.secret,
      { id, marketId: input.marketId, reservationId: input.reservationId, revision: row.revision, recipientEmail: email });
    if (existing) {
      const [retried] = await tx<OutboxRow[]>`UPDATE fame_payment_email_outbox SET state = 'pending', prepare_attempts = 0,
        invitation_hash = ${hash}, invitation_ciphertext = ${ciphertext}, safe_error = NULL,
        updated_at = ${now}, next_attempt_at = ${now}, lease_id = NULL, lease_expires_at = NULL
        WHERE id = ${id} AND send_started_at IS NULL AND state IN ('failed', 'cancelled') RETURNING *`;
      if (!retried) throw new Error("Notification retry was not committed");
      return { kind: "queued", notification: status(retried) };
    }
    const [queued] = await tx<OutboxRow[]>`INSERT INTO fame_payment_email_outbox
      (id, market_id, application_id, reservation_id, reservation_revision, source_location_id, source_event_id,
       contact_id, opportunity_id, recipient_email, total_cents, payment_due_at, invitation_hash, invitation_ciphertext,
       created_at, updated_at, next_attempt_at)
      VALUES (${id}, ${input.marketId}, ${row.application_id}, ${input.reservationId}, ${row.revision}, ${row.source_location_id},
       ${row.source_event_id}, ${row.contact_id}, ${row.opportunity_id}, ${email}, ${row.total_cents}, ${row.payment_due_at},
       ${hash}, ${ciphertext}, ${now}, ${now}, ${now}) RETURNING *`;
    return { kind: "queued", notification: status(queued) };
  }) as Promise<QueuePaymentEmailResult>;
}

export async function getPaymentEmailStatus(input: { marketId: string; reservationId: string; actorAccountId: string }, sql: Sql = configuredClient()): Promise<PaymentEmailStatus | null> {
  if (input.actorAccountId !== input.marketId || input.marketId === DEMO_MARKET_ID) return null;
  const [row] = await sql<OutboxRow[]>`SELECT n.* FROM fame_payment_email_outbox n
    JOIN fame_reservations r ON r.id = n.reservation_id AND r.market_id = n.market_id AND r.revision = n.reservation_revision
    WHERE n.market_id = ${input.marketId} AND n.reservation_id = ${input.reservationId}`;
  return row ? status(row) : null;
}

export interface DispatchPaymentEmailsInput extends SharedConfig {
  secret: string; now?: Date; limit?: number; notificationId?: string; transport?: typeof fetch;
}
export interface PaymentEmailDispatchReport {
  processed: number; accepted: number; delivered: number; failed: number; uncertain: number; cancelled: number; pending: number;
}
type Outcome = Exclude<keyof PaymentEmailDispatchReport, "processed">;

/** Claim only one bounded item; post-start crash recovery parks it permanently. */
async function claim(sql: Sql, input: DispatchPaymentEmailsInput, now: Date): Promise<OutboxRow | null> {
  return sql.begin(async tx => {
    const [row] = await tx<OutboxRow[]>`SELECT * FROM fame_payment_email_outbox
      WHERE market_id = ${input.marketId}
        ${input.notificationId ? tx`AND id = ${input.notificationId}` : tx``}
        AND state IN ('pending', 'preparing', 'send_started', 'accepted')
        AND next_attempt_at <= ${now} AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
      ORDER BY next_attempt_at, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!row) return null;
    if (row.state === "send_started") {
      const [parked] = await tx<OutboxRow[]>`UPDATE fame_payment_email_outbox SET state = 'uncertain',
        safe_error = 'payment_email_send_interrupted', lease_id = NULL, lease_expires_at = NULL, updated_at = ${now}
        WHERE id = ${row.id} RETURNING *`;
      return parked;
    }
    if (row.state !== "accepted" && row.prepare_attempts >= MAX_PREPARE_ATTEMPTS) {
      const [failed] = await tx<OutboxRow[]>`UPDATE fame_payment_email_outbox SET state = 'failed', invitation_ciphertext = NULL,
        safe_error = 'payment_email_preflight_exhausted', lease_id = NULL, lease_expires_at = NULL, updated_at = ${now}
        WHERE id = ${row.id} RETURNING *`;
      return failed;
    }
    const leaseId = randomUUID();
    const [claimed] = await tx<OutboxRow[]>`UPDATE fame_payment_email_outbox SET
      state = ${row.state === "accepted" ? "accepted" : "preparing"}, lease_id = ${leaseId},
      lease_expires_at = ${new Date(now.valueOf() + LEASE_MS)}, updated_at = ${now},
      prepare_attempts = prepare_attempts + ${row.state === "accepted" ? 0 : 1}
      WHERE id = ${row.id} RETURNING *`;
    return claimed;
  }) as Promise<OutboxRow | null>;
}

function message(row: OutboxRow, url: string): PaymentEmailMessage {
  return { id: row.id, marketId: row.market_id, applicationId: row.application_id, reservationId: row.reservation_id,
    revision: row.reservation_revision, locationId: row.source_location_id, contactId: row.contact_id,
    opportunityId: row.opportunity_id, recipientEmail: row.recipient_email, invitationUrl: url,
    totalCents: Number(row.total_cents), paymentDueAt: row.payment_due_at.toISOString() };
}
function matches(row: OutboxRow, current: EligibleRow | null): current is EligibleRow {
  return Boolean(current && current.application_id === row.application_id && current.revision === row.reservation_revision
    && current.source_location_id === row.source_location_id && current.source_event_id === row.source_event_id
    && current.contact_id === row.contact_id && current.opportunity_id === row.opportunity_id
    && recipient(current.recipient_email) === row.recipient_email && Number(current.total_cents) === Number(row.total_cents)
    && current.payment_due_at?.valueOf() === row.payment_due_at.valueOf());
}

async function checkSend(sql: Sql, row: OutboxRow, input: DispatchPaymentEmailsInput, now: Date, start: boolean): Promise<"ready" | "cancelled" | "lost"> {
  return sql.begin(async tx => {
    const current = await eligibleSnapshot(tx, row.market_id, row.reservation_id, true);
    const [owned] = await tx`SELECT id FROM fame_payment_email_outbox WHERE id = ${row.id} AND state = 'preparing'
      AND lease_id = ${row.lease_id} AND lease_expires_at > ${now} FOR UPDATE`;
    if (!owned) return "lost";
    const [invitation] = await tx`SELECT token_hash FROM fame_vendor_payment_invitations
      WHERE token_hash = ${row.invitation_hash} AND market_id = ${row.market_id} AND reservation_id = ${row.reservation_id}
        AND reservation_revision = ${row.reservation_revision} AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ${now}`;
    if (!validConfiguration(input) || !matches(row, current) || !isPayable(current, input.accessConfig, now) || !invitation) {
      await tx`UPDATE fame_payment_email_outbox SET state = 'cancelled', invitation_ciphertext = NULL,
        safe_error = 'payment_email_reservation_changed', lease_id = NULL, lease_expires_at = NULL, updated_at = ${now} WHERE id = ${row.id}`;
      return "cancelled";
    }
    if (!start) return "ready";
    // Commit this irreversible checkpoint before entering the provider POST. Never restore the secret or retry POST.
    await tx`UPDATE fame_payment_email_outbox SET state = 'send_started', invitation_ciphertext = NULL,
      send_started_at = ${now}, updated_at = ${now}, safe_error = NULL WHERE id = ${row.id}`;
    return "ready";
  }) as Promise<"ready" | "cancelled" | "lost">;
}

async function failPreflight(sql: Sql, row: OutboxRow, error: unknown, now: Date): Promise<Outcome> {
  const retry = error instanceof PaymentEmailDeliveryError && error.retryable && row.prepare_attempts < MAX_PREPARE_ATTEMPTS;
  const [updated] = await sql`UPDATE fame_payment_email_outbox SET state = ${retry ? "pending" : "failed"},
    invitation_ciphertext = ${retry ? row.invitation_ciphertext : null},
    safe_error = ${safeCode(error instanceof PaymentEmailDeliveryError ? error.code : null, "payment_email_preflight_failed")},
    next_attempt_at = ${new Date(now.valueOf() + Math.min(300_000, 15_000 * 2 ** row.prepare_attempts))},
    lease_id = NULL, lease_expires_at = NULL, updated_at = ${now}
    WHERE id = ${row.id} AND state = 'preparing' AND lease_id = ${row.lease_id} RETURNING id`;
  return !updated || retry ? "pending" : "failed";
}

async function pollReceipt(sql: Sql, row: OutboxRow, input: DispatchPaymentEmailsInput, now: Date): Promise<Outcome> {
  const receipt: PaymentEmailAcceptedReceipt = { messageId: row.provider_message_id!, conversationId: row.provider_conversation_id!, emailMessageId: row.provider_email_message_id! };
  let result;
  try { result = await verifyPaymentEmailReceipt({ id: row.id, marketId: row.market_id, locationId: row.source_location_id,
    contactId: row.contact_id, recipientEmail: row.recipient_email }, receipt, input.deliveryConfig, input.transport); }
  catch { result = { kind: "unavailable" as const, code: "payment_email_receipt_unavailable" }; }
  const verified = result.kind === "verified";
  const delivered = result.kind === "verified" && ["delivered", "opened", "read"].includes(result.status);
  const failed = result.kind === "verified" && ["failed", "undelivered"].includes(result.status);
  const sent = result.kind === "verified" && ["sent", "delivered", "opened", "read"].includes(result.status);
  const exhausted = !verified && row.receipt_failures + 1 >= 5;
  const [updated] = await sql`UPDATE fame_payment_email_outbox SET state = ${delivered ? "delivered" : failed ? "failed" : exhausted ? "uncertain" : "accepted"},
    safe_error = ${result.kind === "unavailable" ? safeCode(result.code) : failed ? "payment_email_delivery_failed" : null},
    receipt_attempts = receipt_attempts + 1,
    receipt_failures = ${verified ? 0 : Math.min(5, row.receipt_failures + 1)},
    sent_at = ${sent ? row.sent_at || now : row.sent_at}, delivered_at = ${delivered ? now : null},
    next_attempt_at = ${new Date(now.valueOf() + Math.min(300_000, 15_000 * 2 ** Math.min(row.receipt_attempts, 5)))},
    lease_id = NULL, lease_expires_at = NULL, updated_at = ${now}
    WHERE id = ${row.id} AND state = 'accepted' AND lease_id = ${row.lease_id} RETURNING id`;
  return updated ? delivered ? "delivered" : failed ? "failed" : exhausted ? "uncertain" : "accepted" : "pending";
}

/** At most five messages per request. Read-only preflights are retryable; POST is never retried. */
export async function dispatchPaymentEmails(input: DispatchPaymentEmailsInput, sql: Sql = configuredClient()): Promise<PaymentEmailDispatchReport> {
  if (!validConfiguration(input)) throw new Error("Payment email configuration does not match this market");
  validatePaymentEmailSecret(input.secret);
  const limit = Math.max(1, Math.min(5, Number.isSafeInteger(input.limit) ? input.limit! : 5));
  const clock = () => input.now || new Date();
  const report: PaymentEmailDispatchReport = { processed: 0, accepted: 0, delivered: 0, failed: 0, uncertain: 0, cancelled: 0, pending: 0 };
  for (let index = 0; index < limit; index++) {
    const row = await claim(sql, input, clock());
    if (!row) break;
    report.processed++;
    if (row.state === "uncertain" || row.state === "failed") { report[row.state]++; continue; }
    if (row.state === "accepted") { report[await pollReceipt(sql, row, input, clock())]++; continue; }
    const beforePreflight = await checkSend(sql, row, input, clock(), false);
    if (beforePreflight !== "ready") { report[beforePreflight === "cancelled" ? "cancelled" : "pending"]++; continue; }
    let prepared: PaymentEmailMessage;
    try {
      const url = decryptPaymentEmailInvitation(row.invitation_ciphertext!, input.secret, { id: row.id, marketId: row.market_id,
        reservationId: row.reservation_id, revision: row.reservation_revision, recipientEmail: row.recipient_email });
      prepared = message(row, url);
      // No POST is possible until the fresh DB check below. All provider preflight reads precede the transaction.
      await preflightPaymentEmail(prepared, input.deliveryConfig, input.transport, clock());
    } catch (error) { report[await failPreflight(sql, row, error, clock())]++; continue; }
    const beforePost = await checkSend(sql, row, input, clock(), true);
    if (beforePost !== "ready") { report[beforePost === "cancelled" ? "cancelled" : "pending"]++; continue; }
    let result;
    try { result = await sendPaymentEmail(prepared, input.deliveryConfig, input.transport, clock()); }
    catch { result = { kind: "uncertain" as const, code: "payment_email_send_unconfirmed" }; }
    const now = clock();
    const accepted = result.kind === "accepted";
    const [saved] = await sql`UPDATE fame_payment_email_outbox SET state = ${accepted ? "accepted" : "uncertain"},
      provider_message_id = ${result.kind === "accepted" ? result.messageId : null}, provider_conversation_id = ${result.kind === "accepted" ? result.conversationId : null},
      provider_email_message_id = ${result.kind === "accepted" ? result.emailMessageId : null},
      accepted_at = ${accepted ? now : null}, safe_error = ${result.kind === "uncertain" ? safeCode(result.code) : null},
      next_attempt_at = ${new Date(now.valueOf() + 15_000)}, lease_id = NULL, lease_expires_at = NULL, updated_at = ${now}
      WHERE id = ${row.id} AND state = 'send_started' AND lease_id = ${row.lease_id} RETURNING id`;
    report[saved && accepted ? "accepted" : "uncertain"]++;
  }
  return report;
}
