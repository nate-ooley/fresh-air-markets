import { NextRequest, NextResponse } from "next/server";
import { adminGate } from "@/lib/admin-gate";
import { squarePaymentRuntimeConfig } from "@/lib/square";
import { cancelSquareInvoice } from "@/lib/square-invoice";
import { getInvoice, invoiceView, markInstallmentCancelled, markInvoiceCancelled } from "@/lib/vendor-invoice-pg";

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
  let setup;
  try { setup = squarePaymentRuntimeConfig(process.env); }
  catch { return NextResponse.json({ error: "Square is not configured." }, { status: 503, headers }); }
  const square = { environment: setup.environment, accessToken: setup.accessToken, locationId: setup.locationId };
  // Stop every payment Square hasn't been paid for yet; paid ones stay as they are.
  const targets = invoice.squareInstallments.length && invoice.squareInstallments.some(item => item.squareInvoiceId)
    ? invoice.squareInstallments.filter(item => item.squareInvoiceId && item.squareInvoiceVersion !== null && !item.cancelled && item.paidCents < item.amountCents)
      .map(item => ({ seq: item.seq as number | null, id: item.squareInvoiceId!, version: item.squareInvoiceVersion!, published: item.published }))
    : invoice.squareInvoiceId && invoice.squareInvoiceVersion !== null
      ? [{ seq: null, id: invoice.squareInvoiceId, version: invoice.squareInvoiceVersion, published: invoice.status === "open" }] : [];
  for (const target of targets) {
    try { await cancelSquareInvoice(square, target.id, target.version, target.published); }
    catch {
      return NextResponse.json({ error: "Square did not confirm every payment was cancelled, so some may still be collecting. Try again, or cancel them in the Square app." }, { status: 503, headers });
    }
    if (target.seq !== null) await markInstallmentCancelled({ invoiceId: invoice.id, seq: target.seq });
  }
  await markInvoiceCancelled({ marketId: gated.marketId, invoiceId: id });
  return NextResponse.json({ invoice: { ...invoiceView(invoice), status: "cancelled" } }, { headers });
}
