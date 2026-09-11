import { cronAuthorized, cronSecretConfigured } from "@/lib/cron-auth";
import { signingSecret } from "@/lib/auth-secret";
import { vendorPaymentAccessConfig } from "@/lib/vendor-payment-access";
import { readPaymentEmailDeliveryConfig } from "@/lib/ghl-payment-email-delivery";
import { dispatchPaymentEmails } from "@/lib/payment-email-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (!cronSecretConfigured(process.env.CRON_SECRET)) return Response.json({ error: "Scheduler unavailable." }, { status: 503, headers });
  if (!cronAuthorized(request, process.env.CRON_SECRET)) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  // Outbound email is optional; staff copy payment links when it is off.
  if (process.env.GHL_PAYMENT_EMAIL_ENABLED !== "true") return Response.json({ enabled: false }, { headers });
  try {
    const accessConfig = vendorPaymentAccessConfig(process.env);
    const deliveryConfig = readPaymentEmailDeliveryConfig(process.env);
    const secret = signingSecret(process.env);
    if (!process.env.DATABASE_URL || secret.length < 32) throw new Error("Unavailable");
    const result = await dispatchPaymentEmails({ marketId: accessConfig.marketId, accessConfig, deliveryConfig, secret, limit: 1 });
    return Response.json(result, { headers });
  } catch { return Response.json({ error: "Payment email recovery is unavailable." }, { status: 503, headers }); }
}
