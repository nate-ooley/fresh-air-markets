export const GHL_OPPORTUNITY_FIELD_CONTRACT = "ghl_opportunity_fields_v1" as const;

export interface OpportunityFieldValue { fieldId: string; fieldValue: string }
export interface OpportunityFieldExpectation {
  locationId: string;
  contactId: string;
  opportunityId: string;
  pipelineId: string;
  fields: OpportunityFieldValue[];
}
export interface GhlOpportunityFieldProof extends OpportunityFieldExpectation {
  deliveryContract: typeof GHL_OPPORTUNITY_FIELD_CONTRACT;
}
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,192}$/.test(value);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A provider stage receipt, arbitrary JSON or mismatched field ID is not proof. */
export function verifiedOpportunityFields(value: unknown, expected: OpportunityFieldExpectation): value is GhlOpportunityFieldProof {
  const proof = record(value);
  if (!proof || proof.deliveryContract !== GHL_OPPORTUNITY_FIELD_CONTRACT
    || Object.keys(proof).sort().join(",") !== "contactId,deliveryContract,fields,locationId,opportunityId,pipelineId"
    || !["locationId", "contactId", "opportunityId", "pipelineId"].every(key => identifier(proof[key]) && proof[key] === expected[key as keyof OpportunityFieldExpectation])
    || !Array.isArray(proof.fields) || proof.fields.length !== expected.fields.length || proof.fields.length < 1 || proof.fields.length > 8
    || new Set(expected.fields.map(field => field.fieldId)).size !== expected.fields.length) return false;
  const seen = new Set<string>();
  return proof.fields.every(value => {
    const field = record(value);
    if (!field || Object.keys(field).sort().join(",") !== "fieldId,fieldValue" || !identifier(field.fieldId)
      || typeof field.fieldValue !== "string" || !field.fieldValue || field.fieldValue.length > 128 || /[\r\n\0]/.test(field.fieldValue)
      || seen.has(field.fieldId)) return false;
    seen.add(field.fieldId);
    return expected.fields.some(wanted => wanted.fieldId === field.fieldId && wanted.fieldValue === field.fieldValue);
  });
}

/** Call only after provider readback; this constructs no independent evidence. */
export function makeOpportunityFieldProof(identity: Omit<OpportunityFieldExpectation, "fields">,
  fields: OpportunityFieldValue[]): GhlOpportunityFieldProof {
  return { deliveryContract: GHL_OPPORTUNITY_FIELD_CONTRACT, ...identity, fields: fields.map(field => ({ ...field })) };
}
