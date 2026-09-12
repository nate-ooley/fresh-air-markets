import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { FRESH_AIR_SEASON_DATES } from "./fresh-air-season";
import { persistApplicationHandoff } from "./application-handoff-pg";

/**
 * Portal-native vendor intake. The marketing site's application form posts
 * here; nothing leaves this app. Applications are written through the same
 * idempotent handoff writer the CRM path uses, with portal-generated contact
 * and opportunity identifiers, so every downstream gate (review, documents,
 * agreement, reservation, payment) works unchanged.
 */

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

export const VENDOR_AGREEMENT_VERSION = "portal-vendor-agreement-2026-2027-v1";
export const FULL_SEASON_LABEL = "Full Season (Oct 3 - May 29)";
/** Vendors may request several adjacent 10x10 booths per market day; staff confirm the final count. */
export const MAX_BOOTHS_PER_APPLICATION = 4;
export const VENDOR_CATEGORIES = [
  "Produce", "Baked Goods", "Prepared Food", "Food Truck", "Beverages", "Flowers & Plants",
  "Handmade & Crafts", "Art", "Jewelry", "Clothing & Accessories", "Health & Beauty",
  "Home & Garden", "Pet Products", "Services", "Other",
] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX = { name: 100, text: 200, phone: 40, message: 2000 };

export interface PortalIntakeConfig { marketId: string; locationId: string; seasonId: string }

export interface PortalApplicationInput {
  registrationType: "Vendor" | "Non-Profit Organization";
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  businessName: string;
  vendorCategory: string;
  otherCategory: string;
  fullSeason: boolean;
  dates: string[];
  booths: number;
  message: string;
  signatureName: string;
}

export type PortalApplicationValidation = { ok: true; input: PortalApplicationInput } | { ok: false; errors: string[] };

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function readPortalConfig(env: NodeJS.ProcessEnv = process.env): PortalIntakeConfig | null {
  const marketId = env.FAME_MARKET_ACCOUNT_ID?.trim() ?? "";
  const locationId = env.GHL_LOCATION_ID?.trim() || "portal";
  const seasonId = env.FAME_SEASON_ID?.trim() ?? "";
  if (!marketId || marketId === "demo-market" || !seasonId || !env.DATABASE_URL) return null;
  return { marketId, locationId, seasonId };
}

/** Field-by-field validation with human messages; nothing is normalized silently except whitespace. */
export function validatePortalApplication(body: Record<string, unknown>): PortalApplicationValidation {
  const errors: string[] = [];
  const type = body.registrationType === "Non-Profit Organization" ? "Non-Profit Organization"
    : body.registrationType === "Vendor" ? "Vendor" : null;
  if (!type) errors.push("Choose whether you are applying as a vendor or a non-profit.");
  const firstName = text(body.firstName, MAX.name);
  const lastName = text(body.lastName, MAX.name);
  const email = text(body.email, 254).toLowerCase();
  const phone = text(body.phone, MAX.phone);
  const businessName = text(body.businessName, MAX.text);
  const vendorCategory = text(body.vendorCategory, MAX.text);
  const otherCategory = text(body.otherCategory, MAX.text);
  const message = text(body.message, MAX.message);
  const signatureName = text(body.signatureName, MAX.text);
  const fullSeason = body.fullSeason === true;
  const booths = body.booths === undefined ? 1 : Number(body.booths);
  const rawDates = Array.isArray(body.dates) ? body.dates : [];
  const dates = [...new Set(rawDates.filter((d): d is string => typeof d === "string"))].sort();

  if (!firstName) errors.push("First name is required.");
  if (!lastName) errors.push("Last name is required.");
  if (!EMAIL.test(email)) errors.push("A valid email address is required.");
  if (phone.replace(/\D/g, "").length < 7) errors.push("A phone number is required so market staff can reach you.");
  if (!businessName) errors.push(type === "Non-Profit Organization" ? "Organization name is required." : "Business name is required.");
  if (type === "Vendor") {
    if (!(VENDOR_CATEGORIES as readonly string[]).includes(vendorCategory)) errors.push("Pick the category that best describes what you sell.");
    if (vendorCategory === "Other" && !otherCategory) errors.push("Tell us what you sell under \"Other\".");
    if (!fullSeason && dates.length === 0) errors.push("Choose the full season or at least one market Saturday.");
    if (dates.some(date => !(FRESH_AIR_SEASON_DATES as readonly string[]).includes(date))) errors.push("One or more selected dates are not market Saturdays this season.");
    if (!Number.isSafeInteger(booths) || booths < 1 || booths > MAX_BOOTHS_PER_APPLICATION) errors.push(`Choose between 1 and ${MAX_BOOTHS_PER_APPLICATION} booths.`);
  }
  if (type === "Non-Profit Organization" && !message) errors.push("Tell us about your organization's mission.");
  if (body.agreementAccepted !== true) errors.push("You must accept the Vendor Agreement to apply.");
  if (signatureName.length < 2) errors.push("Type your full name to sign the Vendor Agreement.");
  if (errors.length || !type) return { ok: false, errors };
  return { ok: true, input: { registrationType: type, firstName, lastName, email, phone, businessName, vendorCategory, otherCategory, fullSeason, dates, booths: type === "Vendor" ? booths : 1, message, signatureName } };
}

export interface SubmitPortalApplicationResult {
  status: "captured" | "duplicate";
  applicationId: string;
  agreementSigned: boolean;
}

/** Stable per applicant and season, so a resubmission updates the same application. */
export function portalContactId(email: string): string {
  return `portal:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32)}`;
}

export async function submitPortalApplication(
  input: PortalApplicationInput,
  config: PortalIntakeConfig,
  context: { clientIp?: string; userAgent?: string; invitedFrom?: string } = {},
  sql: Sql = configuredClient(),
): Promise<SubmitPortalApplicationResult> {
  const contactId = portalContactId(input.email);
  const opportunityId = `portal-opportunity:${contactId.slice(7)}:${config.seasonId}`;
  const signedAt = new Date().toISOString();
  const vendor = input.registrationType === "Vendor";
  const snapshot: Record<string, unknown> = {
    source: "portal-form",
    ...(context.invitedFrom ? { invitedFrom: context.invitedFrom } : {}),
    registrationType: vendor ? "Vendor" : "Non-Profit Organization",
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    ...(vendor
      ? { businessName: input.businessName, vendorCategory: input.vendorCategory, otherCategory: input.otherCategory,
          vendorDatesRequested: input.fullSeason ? [FULL_SEASON_LABEL] : input.dates, boothsRequested: input.booths, message: input.message }
      : { orgName: input.businessName, mission: input.message }),
    // The signing timestamp lives in fame_agreement_signatures so an identical
    // resubmission hashes to the same event and is recognized as a duplicate.
    agreementVersion: VENDOR_AGREEMENT_VERSION,
    agreementSignedBy: input.signatureName,
  };
  const body = { contactId, opportunityId, seasonId: config.seasonId, snapshot };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  // Identical resubmissions share one event; any change is a new source event.
  const eventId = `portal:${contactId.slice(7)}:${payloadHash.slice(0, 32)}`;
  const status = await persistApplicationHandoff({
    eventId, locationId: config.locationId, marketId: config.marketId, seasonId: config.seasonId,
    contactId, opportunityId, payloadHash, snapshot,
  }, sql);
  if (status === "conflict") throw new Error("Application event conflict.");

  return sql.begin(async tx => {
    const [application] = await tx<{ id: string; opportunity_id: string | null }[]>`
      SELECT id, opportunity_id FROM fame_applications
      WHERE market_id = ${config.marketId} AND location_id = ${config.locationId}
        AND contact_id = ${contactId} AND season_id = ${config.seasonId}
      FOR UPDATE`;
    if (!application) throw new Error("Application row missing after capture.");
    const [completed] = await tx<{ id: string }[]>`
      SELECT id FROM fame_agreement_completions WHERE application_id = ${application.id}`;
    if (completed) return { status, applicationId: application.id, agreementSigned: true };
    const signatureId = randomUUID();
    await tx`
      INSERT INTO fame_agreement_signatures
        (id, application_id, market_id, agreement_version, signer_name, signer_email, client_ip, user_agent, signed_at)
      VALUES (${signatureId}, ${application.id}, ${config.marketId}, ${VENDOR_AGREEMENT_VERSION}, ${input.signatureName},
              ${input.email}, ${(context.clientIp ?? "").slice(0, 64)}, ${(context.userAgent ?? "").slice(0, 300)}, ${signedAt})`;
    // The reservation gate reads fame_agreement_completions; the signature row is
    // the "document" and the template is this agreement version. No CRM outbox rows.
    await tx`
      INSERT INTO fame_agreement_completions
        (id, application_id, market_id, location_id, contact_id, opportunity_id, season_id,
         document_id, template_id, completion_event_id, completed_at)
      VALUES (${randomUUID()}, ${application.id}, ${config.marketId}, ${config.locationId}, ${contactId},
              ${application.opportunity_id ?? opportunityId}, ${config.seasonId}, ${signatureId},
              ${VENDOR_AGREEMENT_VERSION}, ${`portal-sign:${signatureId}`}, ${signedAt})`;
    return { status, applicationId: application.id, agreementSigned: true };
  });
}

export interface ContactMessageInput { firstName: string; lastName: string; email: string; phone: string; topic: "general" | "vendor" | "nonprofit"; message: string }

export function validateContactMessage(body: Record<string, unknown>): { ok: true; input: ContactMessageInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const topic = body.topic === "vendor" || body.topic === "nonprofit" || body.topic === "general" ? body.topic : null;
  const input = {
    firstName: text(body.firstName, MAX.name), lastName: text(body.lastName, MAX.name),
    email: text(body.email, 254).toLowerCase(), phone: text(body.phone, MAX.phone), message: text(body.message, 4000),
  };
  if (!topic) errors.push("Choose what your message is about.");
  if (!input.firstName) errors.push("First name is required.");
  if (!EMAIL.test(input.email)) errors.push("A valid email address is required.");
  if (!input.message) errors.push("Write a short message.");
  if (errors.length || !topic) return { ok: false, errors };
  return { ok: true, input: { ...input, topic } };
}

export async function saveContactMessage(input: ContactMessageInput, marketId: string, clientIp = "", sql: Sql = configuredClient()): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO fame_contact_messages (id, market_id, first_name, last_name, email, phone, topic, message, client_ip)
    VALUES (${id}, ${marketId}, ${input.firstName}, ${input.lastName}, ${input.email}, ${input.phone}, ${input.topic}, ${input.message}, ${clientIp.slice(0, 64)})`;
  return id;
}

export async function saveSubscriber(email: string, marketId: string, sql: Sql = configuredClient()): Promise<"added" | "exists"> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL.test(normalized) || normalized.length > 254) throw new Error("invalid_email");
  const rows = await sql`INSERT INTO fame_newsletter_subscribers (market_id, email) VALUES (${marketId}, ${normalized})
    ON CONFLICT DO NOTHING RETURNING email`;
  return rows.length ? "added" : "exists";
}

export interface ContactMessageRecord { id: string; firstName: string; lastName: string; email: string; phone: string; topic: string; message: string; createdAt: string; readAt: string | null }

export async function listContactMessages(marketId: string, sql: Sql = configuredClient(), limit = 200): Promise<ContactMessageRecord[]> {
  const rows = await sql<{ id: string; first_name: string; last_name: string; email: string; phone: string; topic: string; message: string; created_at: Date; read_at: Date | null }[]>`
    SELECT id, first_name, last_name, email, phone, topic, message, created_at, read_at
    FROM fame_contact_messages WHERE market_id = ${marketId} ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(r => ({ id: r.id, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone, topic: r.topic, message: r.message,
    createdAt: new Date(r.created_at).toISOString(), readAt: r.read_at ? new Date(r.read_at).toISOString() : null }));
}

export async function listSubscribers(marketId: string, sql: Sql = configuredClient(), limit = 1000): Promise<{ email: string; createdAt: string }[]> {
  const rows = await sql<{ email: string; created_at: Date }[]>`
    SELECT email, created_at FROM fame_newsletter_subscribers WHERE market_id = ${marketId} ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(r => ({ email: r.email, createdAt: new Date(r.created_at).toISOString() }));
}
