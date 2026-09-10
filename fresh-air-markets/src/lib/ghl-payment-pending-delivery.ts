import type { PaymentPendingSyncMessage } from "./payment-pending-sync-pg";
import { PaymentPaidDeliveryError, readPaymentPaidDeliveryConfig, readExactPaymentContact,
  readExactPaymentOpportunity, requestPaymentStage, verifyPaymentStatusFieldMetadata, requireSignedPaymentOpportunity, paymentStatusProof, type PaymentPaidDeliveryConfig } from "./ghl-payment-paid-delivery";

import { OpportunityStatusFieldError } from "./ghl-opportunity-status-fields";
import type { GhlOpportunityFieldProof } from "./ghl-opportunity-field-proof";

export type PaymentPendingDeliveryConfig = PaymentPaidDeliveryConfig;
/** Reuses the same explicit opt-in, exact tenant/pipeline and QA routing fences. */
export function readPaymentPendingDeliveryConfig(env: Record<string, string | undefined>): PaymentPendingDeliveryConfig {
  return readPaymentPaidDeliveryConfig(env);
}

export async function deliverPaymentPendingToGhl(job: PaymentPendingSyncMessage, config: PaymentPendingDeliveryConfig,
  transport: typeof fetch = fetch, now?: Date): Promise<GhlOpportunityFieldProof> {
  const clock = () => now || new Date();
  if (job.marketId !== config.marketId || job.seasonId !== config.seasonId || job.locationId !== config.locationId
    || job.squareEnvironment !== config.squareEnvironment
    || ![job.contactId, job.opportunityId, job.paymentOrderId, job.reservationId, job.agreementCompletionId, job.squareOrderId]
      .every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,192}$/.test(id))
    || !Number.isInteger(job.reservationRevision) || job.reservationRevision < 1
    || !Number.isFinite(Date.parse(job.paymentDueAt)) || Date.parse(job.paymentDueAt) <= clock().valueOf()) {
    throw new PaymentPaidDeliveryError("ghl_identity_mismatch");
  }
  await readExactPaymentContact(job, config, transport);
  const before = await readExactPaymentOpportunity(job, config, transport);
  await verifyPaymentStatusFieldMetadata(config, transport);
  const current = requireSignedPaymentOpportunity(before, config);
  if (current === "Ready for Payment") return paymentStatusProof(job, config, "Ready for Payment");
  // A missing value is not proof of Not Ready. Sent, Paid and Payment Issue must never regress.
  if (current !== "Not Ready") throw new OpportunityStatusFieldError();
  await readExactPaymentContact(job, config, transport);
  // Deadline may pass while the read-only provider requests are in flight.
  // Defer; the next eligibility check cancels this expired job without mutation.
  if (Date.parse(job.paymentDueAt) <= clock().valueOf()) throw new PaymentPaidDeliveryError("ghl_unavailable");
  await requestPaymentStage(config, transport, `/opportunities/${encodeURIComponent(job.opportunityId)}`, {
    method: "PUT", body: JSON.stringify({ customFields: [{ id: config.paymentStatusFieldId, fieldValue: "Ready for Payment" }] }),
  });
  const after = await readExactPaymentOpportunity(job, config, transport);
  if (requireSignedPaymentOpportunity(after, config) !== "Ready for Payment") throw new OpportunityStatusFieldError();
  return paymentStatusProof(job, config, "Ready for Payment");
}
