/** HighLevel payment emails are submitted once by the durable outbox owner.
 * This adapter never retries a POST or claims inbox delivery from acceptance. */
import { readOpportunityStatusField, assertOpportunityStatusFieldMetadata,
  AGREEMENT_STATUS_FIELD, PAYMENT_STATUS_FIELD } from "./ghl-opportunity-status-fields";
import { makeOpportunityFieldProof, type GhlOpportunityFieldProof } from "./ghl-opportunity-field-proof";
import { productionPortalHostAllowed } from "./square";
const BASE = "https://services.leadconnectorhq.com";
const LOCATION = "aooAnUXF0COePorBo7wL";
const ID = /^[A-Za-z0-9:_-]{1,192}$/;
const MAILBOX = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const QA_RECIPIENTS = new Set(["lnooley@gmail.com", "nate@autocraftstudios.com"]);
const TIMEOUT_MS = 5_000;

export interface PaymentEmailMessage {
  id: string;
  marketId: string;
  applicationId: string;
  reservationId: string;
  revision: number;
  contactId: string;
  locationId: string;
  opportunityId: string;
  recipientEmail: string;
  invitationUrl: string;
  totalCents: number;
  paymentDueAt: string;
}

export interface PaymentEmailDeliveryConfig {
  apiToken: string;
  locationId: string;
  marketId: string;
  pipelineId: string;
  approvedStageId: string;
  agreementStatusFieldId: string;
  paymentStatusFieldId: string;
  fromEmail: string;
  portalOrigin: string;
  mode: "qa" | "production";
}

export class PaymentEmailDeliveryError extends Error {
  constructor(public readonly code: string, public readonly retryable = false) {
    super("Payment email delivery could not be verified.");
    this.name = "PaymentEmailDeliveryError";
  }
}

function mailbox(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 254 || value.trim() !== value || !MAILBOX.test(value)) return null;
  const local = value.slice(0, value.indexOf("@"));
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return value.toLowerCase();
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function identifier(value: unknown): value is string { return typeof value === "string" && ID.test(value); }

/** Disabled until both deployment configuration and QA recipient routing are explicit. */
export function readPaymentEmailDeliveryConfig(env: Record<string, string | undefined>): PaymentEmailDeliveryConfig {
  const mode = env.GHL_PAYMENT_DELIVERY_MODE;
  const apiToken = env.GHL_API_TOKEN?.trim() ?? "";
  const marketId = env.FAME_MARKET_ACCOUNT_ID?.trim() ?? "";
  const locationId = env.GHL_LOCATION_ID?.trim() ?? "";
  const pipelineId = (mode === "qa" ? env.GHL_QA_APPLICATION_PIPELINE_ID : env.GHL_APPLICATION_PIPELINE_ID)?.trim() ?? "";
  const approvedStageId = env.GHL_APPLICATION_APPROVED_STAGE_ID?.trim() ?? "";
  const agreementStatusFieldId = env.GHL_AGREEMENT_STATUS_FIELD_ID?.trim() ?? "";
  const paymentStatusFieldId = env.GHL_PAYMENT_STATUS_FIELD_ID?.trim() ?? "";
  const fromEmail = mailbox(env.GHL_PAYMENT_EMAIL_FROM);
  const portalOrigin = env.FAME_VENDOR_PORTAL_ORIGIN ?? "";
  if (env.GHL_PAYMENT_EMAIL_ENABLED !== "true" || env.VERCEL !== "1"
    || apiToken.length < 16 || /[\r\n\0]/.test(apiToken)
    || !identifier(marketId) || marketId === "demo-market" || locationId !== LOCATION
    || ![pipelineId, approvedStageId, agreementStatusFieldId, paymentStatusFieldId].every(identifier)
    || agreementStatusFieldId === paymentStatusFieldId || !fromEmail) {
    throw new PaymentEmailDeliveryError("payment_email_config_missing");
  }
  let origin: URL;
  try { origin = new URL(portalOrigin); } catch { throw new PaymentEmailDeliveryError("payment_email_config_missing"); }
  if (origin.protocol !== "https:" || origin.origin !== portalOrigin || origin.username || origin.password || origin.port) {
    throw new PaymentEmailDeliveryError("payment_email_config_missing");
  }
  if (mode === "qa") {
    if (env.VERCEL_ENV !== "preview" || env.SQUARE_ENVIRONMENT !== "sandbox"
      || env.SQUARE_ALLOW_LIVE_PAYMENTS !== "false" || env.GHL_PAYMENT_QA_ROUTING_VERIFIED !== "true"
      || !origin.hostname.endsWith(".vercel.app") || !identifier(env.GHL_APPLICATION_PIPELINE_ID)
      || pipelineId === env.GHL_APPLICATION_PIPELINE_ID) {
      throw new PaymentEmailDeliveryError("payment_email_config_missing");
    }
  } else if (mode === "production") {
    if (env.VERCEL_ENV !== "production" || env.SQUARE_ENVIRONMENT !== "production"
      || env.SQUARE_ALLOW_LIVE_PAYMENTS !== "true" || !productionPortalHostAllowed(origin.hostname)
      || Object.entries(env).some(([key, value]) => value?.trim()
        && (key.startsWith("SQUARE_QA_") || key.startsWith("GHL_PAYMENT_QA_") || key === "GHL_QA_APPLICATION_PIPELINE_ID"))) {
      throw new PaymentEmailDeliveryError("payment_email_config_missing");
    }
  } else { throw new PaymentEmailDeliveryError("payment_email_config_missing"); }
  return { apiToken, locationId, marketId, pipelineId, approvedStageId, agreementStatusFieldId, paymentStatusFieldId, fromEmail, portalOrigin, mode };
}

function validateMessage(message: PaymentEmailMessage, config: PaymentEmailDeliveryConfig, now: Date, requireFuture: boolean): void {
  if ([message.id, message.applicationId, message.reservationId, message.contactId, message.opportunityId].some(value => !identifier(value))
    || message.marketId !== config.marketId || message.locationId !== config.locationId
    || !Number.isSafeInteger(message.revision) || message.revision < 1
    || !Number.isSafeInteger(message.totalCents) || message.totalCents < 1
    || !Number.isFinite(now.valueOf())) throw new PaymentEmailDeliveryError("payment_email_message_invalid");
  const recipient = mailbox(message.recipientEmail);
  if (!recipient || (config.mode === "qa" && !QA_RECIPIENTS.has(recipient))) {
    throw new PaymentEmailDeliveryError("payment_email_recipient_blocked");
  }
  const due = new Date(message.paymentDueAt);
  if (!Number.isFinite(due.valueOf()) || due.toISOString() !== message.paymentDueAt
    || (requireFuture && due <= now)) throw new PaymentEmailDeliveryError("payment_email_deadline_invalid");
  let url: URL;
  try { url = new URL(message.invitationUrl); } catch { throw new PaymentEmailDeliveryError("payment_email_link_invalid"); }
  const token = url.hash.slice(7);
  if (url.origin !== config.portalOrigin || url.pathname !== "/vendor/payment" || url.search
    || url.username || url.password || !url.hash.startsWith("#token=")
    || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, "base64url").toString("base64url") !== token
    || url.toString() !== message.invitationUrl) throw new PaymentEmailDeliveryError("payment_email_link_invalid");
}

async function request(config: PaymentEmailDeliveryConfig, path: string, init: RequestInit, transport: typeof fetch): Promise<Response> {
  return transport(BASE + path, { ...init, redirect: "error", headers: {
    Authorization: `Bearer ${config.apiToken}`, Version: "v3", Accept: "application/json",
    ...(["POST", "PUT"].includes(init.method || "") ? { "Content-Type": "application/json" } : {}),
  }, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function read(config: PaymentEmailDeliveryConfig, path: string, transport: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try { response = await request(config, path, { method: "GET" }, transport); }
  catch { throw new PaymentEmailDeliveryError("payment_email_provider_unavailable", true); }
  if (!response.ok) throw new PaymentEmailDeliveryError("payment_email_provider_rejected", response.status === 429 || response.status >= 500);
  try {
    const body = object(await response.json());
    if (body) return body;
  } catch { /* Only bounded codes leave this adapter. */ }
  throw new PaymentEmailDeliveryError("payment_email_provider_invalid", true);
}

async function exactEmailContact(message: Pick<PaymentEmailMessage, "contactId" | "locationId" | "recipientEmail">,
  config: PaymentEmailDeliveryConfig, transport: typeof fetch): Promise<void> {
  const contact = object((await read(config, `/contacts/${encodeURIComponent(message.contactId)}`, transport)).contact);
  if (!contact || contact.id !== message.contactId || contact.locationId !== message.locationId
    || mailbox(contact.email) !== mailbox(message.recipientEmail)) throw new PaymentEmailDeliveryError("payment_email_contact_mismatch");
}

async function exactEmailOpportunity(message: Pick<PaymentEmailMessage, "contactId" | "locationId" | "opportunityId">,
  config: PaymentEmailDeliveryConfig, transport: typeof fetch, verifyMetadata = true): Promise<Record<string, unknown>> {
  for (const [fieldId, descriptor] of verifyMetadata ? [[config.agreementStatusFieldId, AGREEMENT_STATUS_FIELD], [config.paymentStatusFieldId, PAYMENT_STATUS_FIELD]] as const : []) {
    const metadata = await read(config, `/locations/${encodeURIComponent(config.locationId)}/customFields/${encodeURIComponent(fieldId)}`, transport);
    try { assertOpportunityStatusFieldMetadata(metadata, { fieldId, locationId: config.locationId, ...descriptor }); }
    catch { throw new PaymentEmailDeliveryError("payment_email_field_mapping_invalid"); }
  }
  const opportunity = object((await read(config, `/opportunities/${encodeURIComponent(message.opportunityId)}`, transport)).opportunity);
  if (!opportunity || opportunity.id !== message.opportunityId || opportunity.contactId !== message.contactId
    || opportunity.locationId !== message.locationId || opportunity.pipelineId !== config.pipelineId) {
    throw new PaymentEmailDeliveryError("payment_email_opportunity_mismatch");
  }
  if (opportunity.pipelineStageId !== config.approvedStageId || opportunity.status !== "open") {
    throw new PaymentEmailDeliveryError("payment_email_stage_diverged");
  }
  return opportunity;
}
function fieldValue(opportunity: Record<string, unknown>, fieldId: string): string | null {
  try { return readOpportunityStatusField(opportunity, fieldId); }
  catch { throw new PaymentEmailDeliveryError("payment_email_field_mapping_invalid"); }
}

/** Call before committing send_started. This function cannot send or change a CRM record. */
export async function preflightPaymentEmail(message: PaymentEmailMessage, config: PaymentEmailDeliveryConfig,
  transport: typeof fetch = fetch, now = new Date()): Promise<void> {
  validateMessage(message, config, now, true);
  await exactEmailContact(message, config, transport);
  const opportunity = await exactEmailOpportunity(message, config, transport);
  if (fieldValue(opportunity, config.agreementStatusFieldId) !== "Signed"
    || fieldValue(opportunity, config.paymentStatusFieldId) !== "Ready for Payment") throw new PaymentEmailDeliveryError("payment_email_status_diverged");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}

function contents(message: PaymentEmailMessage, config: PaymentEmailDeliveryConfig) {
  const subject = `${config.mode === "qa" ? "[TEST] " : ""}Fresh Air Markets payment request — ${message.id}`;
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(message.totalCents / 100);
  const due = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "full", timeStyle: "short" }).format(new Date(message.paymentDueAt));
  const intro = config.mode === "qa" ? "This is a test payment request. Square Sandbox does not collect real money.\n\n" : "";
  const messageText = `${intro}Your approved reservation is ready for payment.\nAmount due: ${amount}\nPayment deadline: ${due} (Eastern time).\nYour payment window is 48 hours from the original payment request; this email does not extend it.\n\nOpen your private reservation and pay securely through Square:\n${message.invitationUrl}\n\nKeep this private link for your own use.\nReference: ${message.id}`;
  const html = `<p>${escapeHtml(intro + "Your approved reservation is ready for payment.")}</p><p>Amount due: <strong>${amount}</strong><br>Payment deadline: ${escapeHtml(due)} (Eastern time).</p><p>Your payment window is 48 hours from the original payment request; this email does not extend it.</p><p><a href="${escapeHtml(message.invitationUrl)}">Open your private reservation and pay securely through Square</a></p><p>Keep this private link for your own use.</p><p>Reference: ${escapeHtml(message.id)}</p>`;
  return { subject, message: messageText, html };
}

export interface PaymentEmailAcceptedReceipt { messageId: string; conversationId: string; emailMessageId: string }
export type PaymentEmailSendResult = ({ kind: "accepted" } & PaymentEmailAcceptedReceipt) | { kind: "uncertain"; code: string };

/** Root must durably record send_started before calling. A call issues at most one POST.
 * Every ambiguous/rejected response remains uncertain: there is no provider idempotency contract. */
export async function sendPaymentEmail(message: PaymentEmailMessage, config: PaymentEmailDeliveryConfig,
  transport: typeof fetch = fetch, now = new Date()): Promise<PaymentEmailSendResult> {
  validateMessage(message, config, now, true);
  try {
    const response = await request(config, "/conversations/messages", { method: "POST", body: JSON.stringify({
      type: "Email", contactId: message.contactId, emailTo: mailbox(message.recipientEmail), emailFrom: config.fromEmail,
      status: "pending", ...contents(message, config),
    }) }, transport);
    if (!response.ok) return { kind: "uncertain", code: "payment_email_send_unconfirmed" };
    const body = object(await response.json());
    if (!body || !identifier(body.messageId) || !identifier(body.conversationId) || !identifier(body.emailMessageId)) {
      return { kind: "uncertain", code: "payment_email_receipt_missing" };
    }
    return { kind: "accepted", messageId: body.messageId, conversationId: body.conversationId, emailMessageId: body.emailMessageId };
  } catch { return { kind: "uncertain", code: "payment_email_send_unconfirmed" }; }
}

export type PaymentEmailProviderStatus = "pending" | "sent" | "delivered" | "opened" | "read" | "failed" | "undelivered";
export type PaymentEmailReceiptResult = ({ kind: "verified"; status: PaymentEmailProviderStatus } & PaymentEmailAcceptedReceipt)
  | { kind: "unavailable"; code: string };
export type PaymentEmailReceiptContext = Pick<PaymentEmailMessage, "id" | "marketId" | "locationId" | "contactId" | "recipientEmail">;
export type PaymentEmailSentContext = PaymentEmailReceiptContext & Pick<PaymentEmailMessage, "opportunityId">;

/** Called only after exact provider sent evidence is committed. Its caller owns
 * the same reservation advisory lock as Paid; this writes no stage or email. */
export async function deliverPaymentEmailSentToGhl(message: PaymentEmailSentContext, evidence: PaymentEmailReceiptResult,
  config: PaymentEmailDeliveryConfig, transport: typeof fetch = fetch): Promise<GhlOpportunityFieldProof> {
  const recipient = mailbox(message.recipientEmail);
  if (evidence.kind !== "verified" || !["sent", "delivered", "opened", "read"].includes(evidence.status)
    || ![evidence.messageId, evidence.conversationId, evidence.emailMessageId, message.id, message.contactId, message.opportunityId].every(identifier)
    || message.marketId !== config.marketId || message.locationId !== config.locationId || !recipient
    || (config.mode === "qa" && !QA_RECIPIENTS.has(recipient))) throw new PaymentEmailDeliveryError("payment_email_sent_evidence_invalid");
  await exactEmailContact(message, config, transport);
  let opportunity = await exactEmailOpportunity(message, config, transport);
  if (fieldValue(opportunity, config.agreementStatusFieldId) !== "Signed") throw new PaymentEmailDeliveryError("payment_email_status_diverged");
  const before = fieldValue(opportunity, config.paymentStatusFieldId);
  if (!["Ready for Payment", "Payment Sent", "Paid"].includes(before || "")) throw new PaymentEmailDeliveryError("payment_email_status_diverged");
  if (before === "Ready for Payment") {
    await exactEmailContact(message, config, transport);
    let response: Response;
    try { response = await request(config, `/opportunities/${encodeURIComponent(message.opportunityId)}`, {
      method: "PUT", body: JSON.stringify({ customFields: [{ id: config.paymentStatusFieldId, fieldValue: "Payment Sent" }] }),
    }, transport); } catch { throw new PaymentEmailDeliveryError("payment_email_sent_sync_unavailable", true); }
    if (!response.ok) throw new PaymentEmailDeliveryError("payment_email_sent_sync_rejected", response.status === 429 || response.status >= 500);
    opportunity = await exactEmailOpportunity(message, config, transport, false);
  }
  const payment = fieldValue(opportunity, config.paymentStatusFieldId);
  if (fieldValue(opportunity, config.agreementStatusFieldId) !== "Signed" || !["Payment Sent", "Paid"].includes(payment || "")) {
    throw new PaymentEmailDeliveryError("payment_email_status_diverged");
  }
  return makeOpportunityFieldProof({ locationId: message.locationId, contactId: message.contactId,
    opportunityId: message.opportunityId, pipelineId: config.pipelineId }, [
    { fieldId: config.agreementStatusFieldId, fieldValue: "Signed" },
    { fieldId: config.paymentStatusFieldId, fieldValue: payment! },
  ]);
}

/** Read-back proves provider evidence only; even delivered is not independent inbox verification. */
export async function verifyPaymentEmailReceipt(message: PaymentEmailReceiptContext, receipt: PaymentEmailAcceptedReceipt,
  config: PaymentEmailDeliveryConfig, transport: typeof fetch = fetch): Promise<PaymentEmailReceiptResult> {
  // Receipt polling intentionally requires no invitation token or encrypted email body.
  const recipient = mailbox(message.recipientEmail);
  if (!identifier(message.id) || !identifier(message.contactId) || message.marketId !== config.marketId
    || message.locationId !== config.locationId || !recipient || (config.mode === "qa" && !QA_RECIPIENTS.has(recipient))) {
    return { kind: "unavailable", code: "payment_email_message_invalid" };
  }
  if (![receipt.messageId, receipt.conversationId, receipt.emailMessageId].every(identifier)) {
    return { kind: "unavailable", code: "payment_email_receipt_missing" };
  }
  try {
    const email = await read(config, `/conversations/messages/email/${encodeURIComponent(receipt.emailMessageId)}`, transport);
    const to = email.to;
    const noCopies = [email.cc, email.bcc].every(value => value === undefined || (Array.isArray(value) && value.length === 0));
    if (email.id !== receipt.emailMessageId || email.threadId !== receipt.messageId || email.conversationId !== receipt.conversationId
      || email.locationId !== message.locationId || email.contactId !== message.contactId || email.direction !== "outbound"
      || !Array.isArray(to) || to.length !== 1 || mailbox(to[0]) !== mailbox(message.recipientEmail) || !noCopies
      || email.subject !== `${config.mode === "qa" ? "[TEST] " : ""}Fresh Air Markets payment request — ${message.id}`
      || typeof email.body !== "string" || !email.body.includes(`Reference: ${message.id}`)) {
      return { kind: "unavailable", code: "payment_email_receipt_mismatch" };
    }
    const statuses: readonly unknown[] = ["pending", "sent", "delivered", "opened", "read", "failed", "undelivered"];
    if (!statuses.includes(email.status)) return { kind: "unavailable", code: "payment_email_status_unknown" };
    return { kind: "verified", status: email.status as PaymentEmailProviderStatus, ...receipt };
  } catch (error) {
    return { kind: "unavailable", code: error instanceof PaymentEmailDeliveryError ? error.code : "payment_email_provider_unavailable" };
  }
}
