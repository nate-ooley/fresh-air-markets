/** Original market workflow statuses are opportunity fields, never pipeline stages. */
export const AGREEMENT_STATUS_FIELD = {
  name: "Vendor Agreement Status", values: ["Not Sent", "Sent", "Signed"],
} as const;
export const PAYMENT_STATUS_FIELD = {
  name: "Vendor Payment Status", values: ["Not Ready", "Ready for Payment", "Payment Sent", "Paid", "Payment Issue"],
} as const;

export class OpportunityStatusFieldError extends Error {
  readonly code = "ghl_field_mismatch";
  constructor() { super("HighLevel opportunity status field could not be verified."); }
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

/** GET /locations/:locationId/customFields/:id. Never resolve a field by display name alone. */
export function assertOpportunityStatusFieldMetadata(body: unknown, expected: {
  fieldId: string; locationId: string; name: string; values: readonly string[];
}): void {
  const field = object(object(body)?.customField);
  if (!field || field.id !== expected.fieldId || field.locationId !== expected.locationId
    || field.model !== "opportunity" || field.name !== expected.name || field.dataType !== "SINGLE_OPTIONS"
    || typeof field.fieldKey !== "string" || !/^opportunity\.[A-Za-z0-9_]+$/.test(field.fieldKey)
    || !Array.isArray(field.picklistOptions) || field.picklistOptions.some(value => typeof value !== "string")
    || expected.values.some(value => !(field.picklistOptions as unknown[]).includes(value))) {
    throw new OpportunityStatusFieldError();
  }
}

/** No coercion, key/name fallback, or first-match selection for ambiguous provider state. */
export function readOpportunityStatusField(opportunity: Record<string, unknown>, fieldId: string): string | null {
  const fields = opportunity.customFields;
  if (fields === undefined || fields === null) return null;
  if (!Array.isArray(fields)) throw new OpportunityStatusFieldError();
  const matches = fields.filter(value => object(value)?.id === fieldId);
  if (matches.length === 0) return null;
  if (matches.length !== 1 || typeof object(matches[0])?.fieldValue !== "string") throw new OpportunityStatusFieldError();
  return object(matches[0])!.fieldValue as string;
}
