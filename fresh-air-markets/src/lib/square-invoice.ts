import { createHash } from "node:crypto";
import { SQUARE_API_VERSION, SQUARE_PRODUCTION_API_BASE, SQUARE_SANDBOX_API_BASE, type SquareEnvironment } from "./square";

/**
 * Square Invoices for staff-initiated billing: one payment or a monthly plan.
 * Square emails the vendor each payment request and its reminders. Only ids,
 * status and the public invoice URL come back from here; Square error bodies
 * are reduced to their documented codes so no private data is echoed.
 */

export interface SquareInvoiceConfig { environment: SquareEnvironment; accessToken: string; locationId: string }

export class SquareInvoiceError extends Error {
  constructor(public readonly step: string, public readonly status: number, public readonly codes: string[]) {
    super(`Square ${step} failed (${status}${codes.length ? `: ${codes.join(", ")}` : ""}).`);
  }
}

const SQUARE_ID = /^[A-Za-z0-9_:-]{1,192}$/;

function key(...parts: (string | number)[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 45);
}

async function call(config: SquareInvoiceConfig, step: string, path: string, body: unknown, transport: typeof fetch): Promise<Record<string, unknown>> {
  const base = config.environment === "sandbox" ? SQUARE_SANDBOX_API_BASE : SQUARE_PRODUCTION_API_BASE;
  let response: Response;
  try {
    response = await transport(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.accessToken}`, "Square-Version": SQUARE_API_VERSION, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new SquareInvoiceError(step, 0, ["NETWORK"]);
  }
  let data: unknown = null;
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const errors = (data as { errors?: { code?: unknown }[] } | null)?.errors;
    const codes = Array.isArray(errors) ? errors.map(e => e?.code).filter((c): c is string => typeof c === "string" && /^[A-Z_]{1,64}$/.test(c)).slice(0, 5) : [];
    throw new SquareInvoiceError(step, response.status, codes);
  }
  if (!data || typeof data !== "object") throw new SquareInvoiceError(step, response.status, ["MALFORMED_RESPONSE"]);
  return data as Record<string, unknown>;
}

/** Finds the Square customer with this email, or creates one. */
export async function ensureSquareCustomer(config: SquareInvoiceConfig, contact: { email: string; name: string; businessName: string; reference: string }, transport: typeof fetch = fetch): Promise<string> {
  const found = await call(config, "customer search", "/v2/customers/search", { limit: 1, query: { filter: { email_address: { exact: contact.email } } } }, transport);
  const existing = Array.isArray(found.customers) ? (found.customers[0] as { id?: unknown } | undefined)?.id : undefined;
  if (typeof existing === "string" && SQUARE_ID.test(existing)) return existing;
  const [given, ...rest] = contact.name.trim().split(/\s+/);
  const created = await call(config, "customer create", "/v2/customers", {
    idempotency_key: key("customer", config.environment, contact.email),
    email_address: contact.email,
    ...(given ? { given_name: given.slice(0, 100) } : {}),
    ...(rest.length ? { family_name: rest.join(" ").slice(0, 100) } : {}),
    ...(contact.businessName ? { company_name: contact.businessName.slice(0, 100) } : {}),
    reference_id: contact.reference.slice(0, 40),
  }, transport);
  const id = (created.customer as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string" || !SQUARE_ID.test(id)) throw new SquareInvoiceError("customer create", 200, ["MALFORMED_RESPONSE"]);
  return id;
}

export interface DraftInvoice { orderId: string; invoiceId: string; version: number }

/**
 * Creates the order and a DRAFT pay-in-full invoice for one payment. A plan
 * is several of these, one per month: Square only allows installment
 * invoices on its paid Invoices Plus plan. `scheduledAt` makes Square email
 * it on that day instead of at publish. Nothing reaches the vendor until
 * publish, so the caller can retire the old payment link in between.
 */
export async function createDraftSquareInvoice(config: SquareInvoiceConfig, input: {
  invoiceRowId: string; seq: number; customerId: string; description: string; title: string;
  amountCents: number; dueOn: string; scheduledAt: string | null;
}, transport: typeof fetch = fetch): Promise<DraftInvoice> {
  const reference = `${input.invoiceRowId.slice(0, 36)}-${input.seq}`;
  const order = await call(config, "order create", "/v2/orders", {
    idempotency_key: key("order", config.environment, input.invoiceRowId, input.seq),
    order: {
      location_id: config.locationId,
      customer_id: input.customerId,
      reference_id: reference.slice(0, 40),
      line_items: [{ name: input.description.slice(0, 500), quantity: "1", base_price_money: { amount: input.amountCents, currency: "USD" } }],
    },
  }, transport);
  const orderId = (order.order as { id?: unknown } | undefined)?.id;
  if (typeof orderId !== "string" || !SQUARE_ID.test(orderId)) throw new SquareInvoiceError("order create", 200, ["MALFORMED_RESPONSE"]);
  const invoice = await call(config, "invoice create", "/v2/invoices", {
    idempotency_key: key("invoice", config.environment, input.invoiceRowId, input.seq),
    invoice: {
      location_id: config.locationId,
      order_id: orderId,
      primary_recipient: { customer_id: input.customerId },
      delivery_method: "EMAIL",
      title: input.title.slice(0, 255),
      description: input.description.slice(0, 65536),
      accepted_payment_methods: { card: true, square_gift_card: false, bank_account: false, buy_now_pay_later: false, cash_app_pay: false },
      store_payment_method_enabled: true,
      ...(input.scheduledAt ? { scheduled_at: input.scheduledAt } : {}),
      payment_requests: [{
        request_type: "BALANCE", due_date: input.dueOn, tipping_enabled: false,
        reminders: [{ relative_scheduled_days: 1, message: "Your booth payment for the North Port Farmer's Market is now due." }],
      }],
    },
  }, transport);
  const created = invoice.invoice as { id?: unknown; version?: unknown } | undefined;
  if (typeof created?.id !== "string" || !SQUARE_ID.test(created.id) || typeof created.version !== "number") {
    throw new SquareInvoiceError("invoice create", 200, ["MALFORMED_RESPONSE"]);
  }
  return { orderId, invoiceId: created.id, version: created.version };
}

/** Sends the invoice; Square emails the vendor. */
export async function publishSquareInvoice(config: SquareInvoiceConfig, invoiceId: string, version: number, transport: typeof fetch = fetch): Promise<{ version: number; publicUrl: string | null; status: string }> {
  const data = await call(config, "invoice publish", `/v2/invoices/${encodeURIComponent(invoiceId)}/publish`, { version, idempotency_key: key("publish", config.environment, invoiceId, version) }, transport);
  const invoice = data.invoice as { version?: unknown; public_url?: unknown; status?: unknown } | undefined;
  const publicUrl = typeof invoice?.public_url === "string" && /^https:\/\/[a-z0-9.-]*square(up)?(sandbox)?\.(com|site|link)\//i.test(invoice.public_url) ? invoice.public_url : null;
  return { version: typeof invoice?.version === "number" ? invoice.version : version + 1, publicUrl, status: typeof invoice?.status === "string" ? invoice.status : "UNKNOWN" };
}

/** Stops a published invoice (or deletes a draft). Payments already made stay in Square. */
export async function cancelSquareInvoice(config: SquareInvoiceConfig, invoiceId: string, version: number, published: boolean, transport: typeof fetch = fetch): Promise<void> {
  if (published) {
    await call(config, "invoice cancel", `/v2/invoices/${encodeURIComponent(invoiceId)}/cancel`, { version }, transport);
    return;
  }
  const base = config.environment === "sandbox" ? SQUARE_SANDBOX_API_BASE : SQUARE_PRODUCTION_API_BASE;
  let response: Response;
  try {
    response = await transport(`${base}/v2/invoices/${encodeURIComponent(invoiceId)}?version=${version}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${config.accessToken}`, "Square-Version": SQUARE_API_VERSION, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new SquareInvoiceError("invoice delete", 0, ["NETWORK"]); }
  if (!response.ok && response.status !== 404) throw new SquareInvoiceError("invoice delete", response.status, []);
}
