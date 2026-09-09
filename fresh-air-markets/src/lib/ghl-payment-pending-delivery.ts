import type { PaymentPendingSyncMessage } from "./payment-pending-sync-pg";
import { PaymentPaidDeliveryError, readPaymentPaidDeliveryConfig, readExactPaymentContact,
  readExactPaymentOpportunity, requestPaymentStage, type PaymentPaidDeliveryConfig } from "./ghl-payment-paid-delivery";

export type PaymentPendingDeliveryConfig = PaymentPaidDeliveryConfig;
/** Reuses the same explicit opt-in, exact tenant/pipeline and QA routing fences. */
export function readPaymentPendingDeliveryConfig(env: Record<string, string | undefined>): PaymentPendingDeliveryConfig {
  return readPaymentPaidDeliveryConfig(env);
}

export async function deliverPaymentPendingToGhl(job: PaymentPendingSyncMessage, config: PaymentPendingDeliveryConfig,
  transport: typeof fetch = fetch, now?: Date): Promise<void> {
  const clock = () => now || new Date();
  if (job.marketId !== config.marketId || job.seasonId !== config.seasonId || job.locationId !== config.locationId
    || job.squareEnvironment !== config.squareEnvironment
    || ![job.contactId, job.opportunityId, job.paymentOrderId, job.reservationId, job.agreementCompletionId, job.squareOrderId]
      .every(id => /^[A-Za-z0-9_-]{1,192}$/.test(id))
    || !Number.isInteger(job.reservationRevision) || job.reservationRevision < 1
    || !Number.isFinite(Date.parse(job.paymentDueAt)) || Date.parse(job.paymentDueAt) <= clock().valueOf()) {
    throw new PaymentPaidDeliveryError("ghl_identity_mismatch");
  }
  await readExactPaymentContact(job, config, transport);
  const before = await readExactPaymentOpportunity(job, config, transport);
  if (before.pipelineStageId === config.pendingStageId) return;
  // Confirmed or any manually moved stage is never regressed. Only the exact
  // Agreement Signed source is eligible for this transition.
  if (before.pipelineStageId !== config.agreementCompletedStageId) throw new PaymentPaidDeliveryError("ghl_stage_diverged");
  await readExactPaymentContact(job, config, transport);
  // Deadline may pass while the three read-only provider requests are in flight.
  // Defer; the next eligibility check cancels this expired job without mutation.
  if (Date.parse(job.paymentDueAt) <= clock().valueOf()) throw new PaymentPaidDeliveryError("ghl_unavailable");
  await requestPaymentStage(config, transport, `/opportunities/${encodeURIComponent(job.opportunityId)}`, {
    method: "PUT", body: JSON.stringify({ pipelineStageId: config.pendingStageId }),
  });
  const after = await readExactPaymentOpportunity(job, config, transport);
  if (after.pipelineStageId !== config.pendingStageId) throw new PaymentPaidDeliveryError("ghl_stage_diverged");
}
