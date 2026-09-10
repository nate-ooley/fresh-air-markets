import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { signingSecret } from "@/lib/auth-secret";
import { validSquareReservationId } from "@/lib/square-payment";
import { vendorPaymentAccessConfig, sameOriginVendorPost, readVendorAccessBody } from "@/lib/vendor-payment-access";
import { readPaymentEmailDeliveryConfig } from "@/lib/ghl-payment-email-delivery";
import { queuePaymentEmail, getPaymentEmailStatus, dispatchPaymentEmails } from "@/lib/payment-email-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
type Context = { params: Promise<{ id: string }> };

function configuration() {
  const accessConfig = vendorPaymentAccessConfig(process.env);
  const deliveryConfig = readPaymentEmailDeliveryConfig(process.env);
  const secret = signingSecret(process.env);
  if (!process.env.DATABASE_URL || secret.length < 32) throw new Error("Payment email configuration is incomplete.");
  return { accessConfig, deliveryConfig, secret };
}

export async function GET(_request: NextRequest, context: Context) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const { id: reservationId } = await context.params;
  if (!validSquareReservationId(reservationId)) return NextResponse.json({ error: "Invalid reservation ID." }, { status: 400, headers });
  try {
    const { accessConfig } = configuration();
    if (marketId !== accessConfig.marketId) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
    const notification = await getPaymentEmailStatus({ marketId, reservationId, actorAccountId: marketId });
    return NextResponse.json({ notification }, { headers });
  } catch {
    return NextResponse.json({ error: "Payment email delivery is not configured or is unavailable." }, { status: 503, headers });
  }
}

/** One deliberate manager action queues and attempts only this reservation's email. */
export async function POST(request: NextRequest, context: Context) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const { id: reservationId } = await context.params;
  if (!validSquareReservationId(reservationId)) return NextResponse.json({ error: "Invalid reservation ID." }, { status: 400, headers });
  let config;
  try { config = configuration(); }
  catch { return NextResponse.json({ error: "Payment email delivery is not configured or is unavailable." }, { status: 503, headers }); }
  if (marketId !== config.accessConfig.marketId || !sameOriginVendorPost(request, config.accessConfig.portalOrigin)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  }
  const body = await readVendorAccessBody(request);
  if (!body || (Object.keys(body).length && !(Object.keys(body).length === 1 && body.retryPreflight === true))) {
    return NextResponse.json({ error: "Use an empty JSON object or request a pre-send retry." }, { status: 400, headers });
  }
  try {
    const result = await queuePaymentEmail({ marketId, reservationId, actorAccountId: marketId, ...config,
      retryPreflight: body.retryPreflight === true });
    if (result.kind === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
    if (result.kind === "not_found") return NextResponse.json({ error: "Reservation not found." }, { status: 404, headers });
    if (result.kind === "not_eligible" || result.kind === "invalid_source") {
      return NextResponse.json({ error: "A current payable reservation and verified vendor details are required before emailing a payment link." }, { status: 409, headers });
    }
    if (!("notification" in result)) throw new Error("Unexpected email result");
    await dispatchPaymentEmails({ marketId, notificationId: result.notification.id, ...config, limit: 1 });
    const notification = await getPaymentEmailStatus({ marketId, reservationId, actorAccountId: marketId });
    return NextResponse.json({ notification }, { status: 202, headers });
  } catch {
    return NextResponse.json({ error: "Payment email status is unavailable. Check delivery before trying again." }, { status: 503, headers });
  }
}
