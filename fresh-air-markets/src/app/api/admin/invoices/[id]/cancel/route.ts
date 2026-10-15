import { NextRequest, NextResponse } from "next/server";
import { adminGate } from "@/lib/admin-gate";
import { squarePaymentRuntimeConfig } from "@/lib/square";
import { cancelSquareInvoice } from "@/lib/square-invoice";
import { getInvoice, invoiceView, markInvoiceCancelled } from "@/lib/vendor-invoice-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Staff stop a Square invoice or plan. Payments already made stay recorded and in Square. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await adminGate(request);
  if ("error" in gated) return gated.error;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid invoice ID." }, { status: 400, headers });
  let invoice;
  try { invoice = await getInvoice(gated.marketId, id); }
  catch { return NextResponse.json({ error: "Billing is unavailable right now." }, { status: 503, headers }); }
  if (!invoice) return NextResponse.json({ error: "Invoice not found." }, { status: 404, headers });
  if (invoice.status !== "open" && invoice.status !== "creating") return NextResponse.json({ error: `This invoice is already ${invoice.status}.` }, { status: 409, headers });
  if (invoice.squareInvoiceId && invoice.squareInvoiceVersion !== null) {
    try {
      const setup = squarePaymentRuntimeConfig(process.env);
      await cancelSquareInvoice({ environment: setup.environment, accessToken: setup.accessToken, locationId: setup.locationId }, invoice.squareInvoiceId, invoice.squareInvoiceVersion, invoice.status === "open");
    } catch {
      return NextResponse.json({ error: "Square did not confirm the invoice was cancelled, so it may still be collecting. Try again, or cancel it in the Square app." }, { status: 503, headers });
    }
  }
  await markInvoiceCancelled({ marketId: gated.marketId, invoiceId: id });
  return NextResponse.json({ invoice: { ...invoiceView(invoice), status: "cancelled" } }, { headers });
}
