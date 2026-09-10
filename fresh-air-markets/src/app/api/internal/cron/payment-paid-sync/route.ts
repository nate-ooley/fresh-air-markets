import { cronAuthorized, cronSecretConfigured } from "@/lib/cron-auth";
import { dispatchPaymentPaidSync } from "@/lib/payment-paid-sync-pg";
import { deliverPaymentPaidToGhl, readPaymentPaidDeliveryConfig } from "@/lib/ghl-payment-paid-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "private, no-store" };
  if (!cronSecretConfigured(process.env.CRON_SECRET)) return Response.json({ error: "Payment sync scheduler is not configured." }, { status: 503, headers });
  if (!cronAuthorized(request, process.env.CRON_SECRET)) return Response.json({ error: "Unauthorized." }, { status: 401, headers });
  if (process.env.GHL_PAYMENT_SYNC_ENABLED !== "true") return Response.json({ enabled: false }, { headers });
  try {
    const config = readPaymentPaidDeliveryConfig(process.env);
    if (!process.env.DATABASE_URL) throw new Error("Storage unavailable.");
    const result = await dispatchPaymentPaidSync(job => deliverPaymentPaidToGhl(job, config), config, { limit: 1 });
    return Response.json(result, { headers });
  } catch {
    return Response.json({ error: "Payment status sync is unavailable." }, { status: 503, headers });
  }
}
