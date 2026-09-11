import { squarePaymentRuntimeConfig, squareWebhookConfig } from "@/lib/square";
import {
  QA_SIGNER_HEADER,
  squareQaSignerAuthorization,
  squareQaSupportConfig,
  squareQaWebhookRollbackEventId,
} from "@/lib/square-qa-faults";
import { handleSquarePaymentWebhook } from "@/lib/square-webhook";
import { persistSquarePaymentWebhook } from "@/lib/square-webhook-pg";
import { notifyPaymentReceived } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Square's server-to-server payment receipt. This route never trusts a
 * browser redirect and never sends a CRM message. It verifies the exact raw
 * payload before decoding JSON, then delegates the atomic receipt/state
 * change to PostgreSQL.
 */
export async function POST(request: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return Response.json({ error: "Persistent Square payment storage is not configured." }, { status: 503 });
  }
  try {
    const qaSupport = squareQaSupportConfig(process.env);
    const qaSigner = squareQaSignerAuthorization(request.headers.get(QA_SIGNER_HEADER), qaSupport);
    if (qaSigner === "unauthorized") return Response.json({ error: "Unauthorized." }, { status: 401 });
    const checkout = squarePaymentRuntimeConfig(process.env);
    const webhook = squareWebhookConfig(process.env);
    const environment = checkout.environment;
    const identity = environment === "production"
      ? { merchantId: checkout.merchantId, locationId: checkout.locationId }
      : {};
    const qaRollbackEventId = squareQaWebhookRollbackEventId(qaSupport, qaSigner);
    return await handleSquarePaymentWebhook(
      request,
      webhook,
      async event => {
        const result = await persistSquarePaymentWebhook(
          event,
          qaRollbackEventId ? { environment, ...identity, qaRollbackEventId } : { environment, ...identity },
        );
        // The receipt is committed above; a confirmation email failure must not make Square retry it.
        const marketId = process.env.FAME_MARKET_ACCOUNT_ID?.trim();
        if (result.kind === "paid" && marketId) await notifyPaymentReceived({ squareOrderId: event.payment.orderId, marketId });
        return result;
      },
    );
  } catch {
    // Missing/malformed configuration is not a source error. Do not expose
    // credentials, expected URLs, or database diagnostics to the caller.
    return Response.json({ error: "Square payment processing is not configured." }, { status: 503 });
  }
}
