import { createHash } from "node:crypto";

/**
 * Adapter for HighLevel's native Workflow "Webhook" action. That action posts
 * the contact's standard fields in snake_case, custom fields keyed by their
 * display name, `location.id`, `workflow.id`, and any Custom Data key/values
 * configured on the action. This module normalizes that shape into the exact
 * handoff envelope the portal already validates and stores; it never reaches
 * HighLevel itself and never trusts the payload for market, season or secret.
 */

export interface HighLevelWorkflowIntakeConfig {
  locationId: string;
  seasonId: string;
}

export interface MappedApplicationHandoff {
  eventId: string;
  contactId: string;
  opportunityId?: string;
  locationId: string;
  seasonId: string;
  snapshot: Record<string, unknown>;
}

const ID = /^[A-Za-z0-9:_-]{1,192}$/;
const MAX_TEXT = 2000;

/** "Vendor Business Name" → "vendorbusinessname"; used to match display-name keys. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_TEXT ? trimmed : null;
}

function idValue(value: unknown): string | null {
  const candidate = text(value);
  return candidate && ID.test(candidate) ? candidate : null;
}

/**
 * Snapshot keys the review step understands, each with the HighLevel field
 * names (normalized) that may carry the value. Custom Data keys on the
 * workflow action use the exact camelCase names and win over field names.
 */
const FIELD_ALIASES: Record<string, readonly string[]> = {
  firstName: ["firstname", "first_name"],
  lastName: ["lastname", "last_name"],
  name: ["fullname", "full_name", "name", "contactname"],
  email: ["email", "emailaddress"],
  phone: ["phone", "phonenumber"],
  registrationType: ["registrationtype", "applicanttype", "applyingas", "iamapplyingas", "vendortype"],
  businessName: ["businessname", "vendorbusinessname", "companyname", "company"],
  orgName: ["orgname", "organizationname", "nonprofitorgname", "nonprofitorganizationname", "nonprofitname"],
  vendorCategory: ["vendorcategory", "category", "productcategory"],
  otherCategory: ["othercategory", "vendorcategoryother", "otherpleasespecify"],
  vendorDatesRequested: ["vendordatesrequested", "datesrequested", "requesteddates", "selecteddates", "marketdates", "dates"],
  message: ["message", "details", "description", "tellusaboutyourbusiness", "aboutyourbusiness", "notes"],
  mission: ["mission", "nonprofitmission", "organizationmission"],
};

function collectSources(body: Record<string, unknown>): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [];
  const customData = objectValue(body.customData);
  if (customData) sources.push(customData);
  sources.push(body);
  for (const nested of ["contact", "triggerData", "form", "submission", "customFields", "custom_fields"]) {
    const value = objectValue(body[nested]);
    if (value) sources.push(value);
  }
  return sources;
}

function lookup(sources: Record<string, unknown>[], aliases: readonly string[]): unknown {
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (aliases.includes(normalizeKey(key)) && value !== null && value !== undefined && value !== "") return value;
    }
  }
  return undefined;
}

/** Multi-select fields arrive as arrays or comma/semicolon/newline separated text. */
function listValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map(text).filter((item): item is string => Boolean(item));
    return items.length ? items : undefined;
  }
  const single = text(value);
  if (!single) return undefined;
  // A single full-season label contains no separator; date lists are split.
  const items = single.split(/\s*[;\n]\s*|\s*,\s*(?=(?:Full Season|Sat|Sun|Fri|Mon|Tue|Wed|Thu|\d{4}-\d{2}-\d{2}))/).map(item => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function registrationType(value: unknown): string | undefined {
  const raw = text(value)?.toLowerCase();
  if (!raw) return undefined;
  if (raw.includes("non")) return "Non-Profit";
  if (raw.includes("vendor") || raw.includes("business")) return "Vendor";
  return text(value) ?? undefined;
}

/**
 * Map one HighLevel workflow webhook body to the handoff envelope. Returns null
 * when the contact or location cannot be identified; the caller answers 400.
 */
export function mapHighLevelWorkflowApplication(
  value: unknown,
  config: HighLevelWorkflowIntakeConfig,
): MappedApplicationHandoff | null {
  const body = objectValue(value);
  if (!body) return null;
  const sources = collectSources(body);
  const location = objectValue(body.location);
  const locationId = idValue(lookup(sources, ["locationid", "location_id"])) ?? idValue(location?.id);
  const contactId = idValue(lookup(sources, ["contactid", "contact_id"])) ?? idValue(objectValue(body.contact)?.id);
  if (!contactId || locationId !== config.locationId) return null;

  const opportunity = objectValue(body.opportunity);
  const opportunityId = idValue(lookup(sources, ["opportunityid", "opportunity_id"]))
    ?? idValue(opportunity?.id)
    // Opportunity-triggered workflows post the opportunity's own `id` beside `opportunity_name`.
    ?? (text(body.opportunity_name) ? idValue(body.id) : null);

  const snapshot: Record<string, unknown> = { source: "highlevel-workflow" };
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    const raw = lookup(sources, aliases);
    if (raw === undefined) continue;
    if (key === "vendorDatesRequested") { const list = listValue(raw); if (list) snapshot[key] = list; continue; }
    if (key === "registrationType") { const type = registrationType(raw); if (type) snapshot[key] = type; continue; }
    const asText = text(raw);
    if (asText) snapshot[key] = asText;
  }
  if (!snapshot.registrationType) snapshot.registrationType = snapshot.orgName && !snapshot.businessName ? "Non-Profit" : "Vendor";
  if (typeof body.date_created === "string") snapshot.contactCreatedAt = body.date_created;
  const workflow = objectValue(body.workflow);
  if (workflow?.id) snapshot.workflowId = text(workflow.id);
  // Keep the complete original body for audit; the review reads only the normalized keys above.
  snapshot.raw = body;

  // HighLevel sends no event ID. Derive one from the contact and the normalized
  // content so an exact re-delivery is a duplicate and a changed submission is
  // a new source event for the same application.
  const fingerprintSource = { ...snapshot };
  delete fingerprintSource.raw;
  delete fingerprintSource.contactCreatedAt;
  const explicitEventId = idValue(lookup([objectValue(body.customData) ?? {}], ["eventid"]));
  const eventId = explicitEventId
    ?? `hl:${contactId}:${createHash("sha256").update(JSON.stringify(fingerprintSource)).digest("hex").slice(0, 32)}`;

  return {
    eventId,
    contactId,
    ...(opportunityId ? { opportunityId } : {}),
    locationId: config.locationId,
    seasonId: idValue(lookup([objectValue(body.customData) ?? {}], ["seasonid"])) ?? config.seasonId,
    snapshot,
  };
}
