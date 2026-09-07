import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { squareSandboxSetupConfig, verifySquareSandboxSetup } from "@/lib/square";
import { dispatchSquareSandboxCheckout, validSquareReservationId } from "@/lib/square-payment";
import { postgresSquarePaymentCheckoutStore } from "@/lib/square-payment-pg";
import { squareQaCheckoutTransport, squareQaSupportConfig } from "@/lib/square-qa-faults";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function responseForOrder(status: 200 | 201, order: {
  id: string;
  checkoutUrl: string | null;
  paymentDueAt: string | null;
  status: string;
}) {
  return NextResponse.json({
    paymentOrder: {
      id: order.id,
      checkoutUrl: order.checkoutUrl,
      paymentDueAt: order.paymentDueAt,
      status: order.status,
    },
  }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Authenticated manager action. This path accepts no price, quantity, vendor,
 * reservation revision, or redirect URL from the request. It can create only
 * a Sandbox hosted link for an already-committed, market-scoped reservation.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "Persistent payment storage is not configured." }, { status: 503 });
  }
  const { id: reservationId } = await params;
  if (!validSquareReservationId(reservationId)) {
    return NextResponse.json({ error: "Invalid reservation ID." }, { status: 400 });
  }

  let qaSupport;
  try {
    qaSupport = squareQaSupportConfig(process.env);
    // While a checkout fault is armed, block every other checkout rather than
    // accidentally creating a real Sandbox link for a different QA record.
    if (qaSupport?.fault?.kind === "checkout" && qaSupport.fault.reservationId !== reservationId) {
      return NextResponse.json({ error: "Square checkout is unavailable. Retry the same reservation." }, { status: 503 });
    }
  } catch {
    // A copied QA control in a non-Preview/Sandbox environment is a hard
    // configuration failure. Do not disclose the setting or continue.
    return NextResponse.json({ error: "Square Sandbox checkout is not configured." }, { status: 503 });
  }

  let setup;
  try {
    setup = squareSandboxSetupConfig(process.env);
  } catch {
    return NextResponse.json({ error: "Square Sandbox checkout is not configured." }, { status: 503 });
  }

  let identity;
  try {
    // These are read-only Sandbox identity/location checks. An operator must
    // not be able to create an order under a stale or foreign location.
    identity = await verifySquareSandboxSetup(setup);
  } catch {
    return NextResponse.json({ error: "Square Sandbox identity verification is unavailable." }, { status: 503 });
  }

  try {
    const transport = squareQaCheckoutTransport(qaSupport?.fault ?? null, reservationId);
    const input = {
      marketId,
      reservationId,
      square: {
        environment: "sandbox" as const,
        accessToken: setup.accessToken,
        locationId: identity.locationId,
        merchantId: identity.merchantId,
      },
      store: postgresSquarePaymentCheckoutStore,
    };
    const result = await dispatchSquareSandboxCheckout(transport ? { ...input, transport } : input);
    if (result.kind === "created") return responseForOrder(201, result.order);
    if (result.kind === "existing") return responseForOrder(200, result.order);
    if (result.kind === "not_found") return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
    if (result.kind === "in_progress") {
      return NextResponse.json({ status: "checkout_pending", paymentOrderId: result.paymentOrderId }, {
        status: 202, headers: { "Cache-Control": "no-store", "Retry-After": "5" },
      });
    }
    if (result.kind === "retry_scheduled") {
      return NextResponse.json({ error: "Square checkout is temporarily unavailable. Retry this reservation." }, {
        status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "15" },
      });
    }
    if (result.kind === "failed") {
      return NextResponse.json({ error: "Square checkout needs manager review before retrying." }, { status: 409 });
    }
    const message = result.reason === "nonprofit"
      ? "This nonprofit reservation does not require a Square payment."
      : result.reason === "expired"
        ? "This reservation's payment window has expired."
        : "This reservation cannot create a Square checkout.";
    return NextResponse.json({ error: message }, { status: 409 });
  } catch {
    return NextResponse.json({ error: "Square checkout is unavailable. Retry the same reservation." }, {
      status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "15" },
    });
  }
}
