import { randomUUID } from "node:crypto";
import postgres from "postgres";

/**
 * Outbound email for the portal's own notifications, sent through Resend's
 * HTTP API. Sending is best-effort and never throws into a request handler:
 * a failure is logged and the caller's database work stands. When
 * RESEND_API_KEY is absent every send is recorded as "skipped".
 */

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 2, prepare: false, connect_timeout: 5 });
  return client;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIMEOUT_MS = 8_000;

export interface EmailConfig {
  apiKey: string;
  from: string;
  staffEmail: string | null;
  replyTo: string | null;
}

/** Resend requires a verified domain for arbitrary senders; onboarding@resend.dev works for testing. */
export function readEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim() ?? "";
  if (!apiKey) return null;
  const from = env.EMAIL_FROM?.trim() || "Fresh Air Markets <onboarding@resend.dev>";
  const staffEmail = env.STAFF_NOTIFY_EMAIL?.trim().toLowerCase() || null;
  const replyTo = env.EMAIL_REPLY_TO?.trim() || null;
  return { apiKey, from, staffEmail: staffEmail && EMAIL.test(staffEmail) ? staffEmail : null, replyTo };
}

export function emailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readEmailConfig(env) !== null;
}

export interface OutboundEmail {
  kind: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  marketId: string;
  referenceId?: string;
}

export type SendEmailResult = { status: "sent"; id: string } | { status: "failed"; code: string } | { status: "skipped"; code: string };

export interface EmailTransport {
  (config: EmailConfig, email: OutboundEmail): Promise<SendEmailResult>;
}

/** Resend HTTP transport. Only the provider's id or a short error code is kept. */
export const resendTransport: EmailTransport = async (config, email) => {
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: config.from, to: [email.to], subject: email.subject, text: email.text,
        ...(email.html ? { html: email.html } : {}), ...(config.replyTo ? { reply_to: config.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null) as { id?: unknown; name?: unknown; message?: unknown } | null;
    if (response.ok && typeof body?.id === "string") return { status: "sent", id: body.id };
    const code = typeof body?.name === "string" ? body.name.slice(0, 64) : `http_${response.status}`;
    return { status: "failed", code };
  } catch {
    return { status: "failed", code: "request_unavailable" };
  }
};

async function log(sql: Sql, email: OutboundEmail, result: SendEmailResult): Promise<void> {
  try {
    await sql`INSERT INTO fame_email_log (id, market_id, kind, to_email, subject, status, provider_message_id, error_code, reference_id)
      VALUES (${randomUUID()}, ${email.marketId}, ${email.kind}, ${email.to.toLowerCase()}, ${email.subject.slice(0, 300)}, ${result.status},
              ${result.status === "sent" ? result.id : null}, ${result.status === "sent" ? "" : result.code}, ${email.referenceId ?? ""})`;
  } catch {
    // The log is an audit aid; a missing table (migration 024 not applied) must not break sending.
  }
}

/** Send one email and record the outcome. Never throws. */
export async function sendEmail(
  email: OutboundEmail,
  deps: { env?: NodeJS.ProcessEnv; transport?: EmailTransport; sql?: Sql } = {},
): Promise<SendEmailResult> {
  const config = readEmailConfig(deps.env ?? process.env);
  const to = email.to.trim().toLowerCase();
  let result: SendEmailResult;
  if (!EMAIL.test(to) || to.length > 254) result = { status: "skipped", code: "invalid_recipient" };
  else if (!config) result = { status: "skipped", code: "email_not_configured" };
  else result = await (deps.transport ?? resendTransport)(config, { ...email, to });
  let sql: Sql | undefined = deps.sql;
  if (!sql) { try { sql = configuredClient(); } catch { sql = undefined; } }
  if (sql) await log(sql, { ...email, to }, result);
  return result;
}

/** Staff copy of a notification, when a staff inbox is configured. */
export async function sendStaffEmail(
  email: Omit<OutboundEmail, "to">,
  deps: { env?: NodeJS.ProcessEnv; transport?: EmailTransport; sql?: Sql } = {},
): Promise<SendEmailResult> {
  const config = readEmailConfig(deps.env ?? process.env);
  if (!config?.staffEmail) return { status: "skipped", code: "staff_email_not_configured" };
  return sendEmail({ ...email, to: config.staffEmail }, deps);
}

/** Latest applicant email and display name from the stored application snapshot. */
export async function applicantContact(
  applicationId: string,
  marketId: string,
  sql: Sql = configuredClient(),
): Promise<{ email: string; name: string; businessName: string } | null> {
  const [row] = await sql<{ snapshot: unknown }[]>`
    SELECT snapshot FROM fame_application_events
    WHERE application_id = ${applicationId} AND market_id = ${marketId}
    ORDER BY created_at DESC LIMIT 1`;
  const envelope = row?.snapshot as { snapshot?: Record<string, unknown> } | undefined;
  const source = envelope?.snapshot;
  if (!source) return null;
  const email = typeof source.email === "string" ? source.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) return null;
  const first = typeof source.firstName === "string" ? source.firstName.trim() : "";
  const last = typeof source.lastName === "string" ? source.lastName.trim() : "";
  const name = [first, last].filter(Boolean).join(" ") || (typeof source.name === "string" ? source.name : "") || email;
  const businessName = [source.businessName, source.vendorBusinessName, source.orgName].find(v => typeof v === "string" && v.trim()) as string | undefined;
  return { email, name, businessName: businessName?.trim() ?? "" };
}
