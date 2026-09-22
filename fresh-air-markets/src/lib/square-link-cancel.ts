import { deleteSquarePaymentLink, retrieveSquareOrderForRetirement, squarePaymentRuntimeConfig } from "./square";

/**
 * Cancels a hosted Square payment link for a manager withdrawal and returns
 * "cancelled" only with proof: Square's delete response names the exact
 * order as cancelled, or, when the link is already gone, RetrieveOrder shows
 * that order CANCELED. Anything else is "unproven" (the order may have been
 * paid), and the caller must not release the dates.
 */
export type CancelLink = (link: { paymentLinkId: string; squareOrderId: string }) => Promise<"cancelled" | "unproven">;

export function squareLinkCanceller(env: NodeJS.ProcessEnv = process.env, transport: typeof fetch = fetch): CancelLink | undefined {
  let config;
  try { config = squarePaymentRuntimeConfig(env); } catch { return undefined; }
  return async ({ paymentLinkId, squareOrderId }) => {
    const deleted = await deleteSquarePaymentLink(config, paymentLinkId, transport);
    if (deleted.kind === "deleted" && deleted.cancelledOrderId === squareOrderId) return "cancelled";
    const order = await retrieveSquareOrderForRetirement(config, squareOrderId, transport);
    return order.orderId === squareOrderId && order.state === "CANCELED" ? "cancelled" : "unproven";
  };
}
