import { squareCheckoutConfig, squareWebhookConfig } from "@/lib/square";
import { handleSquarePaymentWebhook } from "@/lib/square-webhook";
import { persistSquarePaymentWebhook } from "@/lib/square-webhook-pg";

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
    const checkout = squareCheckoutConfig(process.env);
    const webhook = squareWebhookConfig(process.env);
    // The only wired payment flow is Sandbox. A production configuration must
    // receive an explicit launch implementation rather than processing live
    // events through this test workflow.
    const environment = checkout.environment;
    if (environment !== "sandbox") {
      return Response.json({ error: "Square production webhook processing is not enabled." }, { status: 503 });
    }
    return await handleSquarePaymentWebhook(
      request,
      webhook,
      event => persistSquarePaymentWebhook(event, { environment }),
    );
  } catch {
    // Missing/malformed configuration is not a source error. Do not expose
    // credentials, expected URLs, or database diagnostics to the caller.
    return Response.json({ error: "Square payment processing is not configured." }, { status: 503 });
  }
}
