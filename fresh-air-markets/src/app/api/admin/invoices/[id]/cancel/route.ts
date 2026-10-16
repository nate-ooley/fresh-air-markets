import { NextRequest, NextResponse } from "next/server";
import { adminGate } from "@/lib/admin-gate";
import { cancelInvoiceAtSquare } from "@/lib/invoice-cancel";
import { squarePaymentRuntimeConfig } from "@/lib/square";
import { getInvoice, invoiceView } from "@/lib/vendor-invoice-pg";

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
  const done = await cancelInvoiceAtSquare({ environment: setup.environment, accessToken: setup.accessToken, locationId: setup.locationId }, gated.marketId, invoice).catch(() => false);
  if (!done) return NextResponse.json({ error: "Square did not confirm every payment was cancelled, so some may still be collecting. Try again, or cancel them in the Square app." }, { status: 503, headers });
  return NextResponse.json({ invoice: { ...invoiceView(invoice), status: "cancelled" } }, { headers });
}
