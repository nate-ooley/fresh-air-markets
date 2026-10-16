import { cancelSquareInvoice, type SquareInvoiceConfig } from "./square-invoice";
import { markInstallmentCancelled, markInvoiceCancelled, type InvoiceRecord } from "./vendor-invoice-pg";

/**
 * Stops every payment of an invoice that Square hasn't been paid for (paid
 * ones stay), then records the invoice as cancelled. False when Square did
 * not confirm, in which case nothing is marked cancelled locally beyond the
 * payments Square did confirm.
 */
export async function cancelInvoiceAtSquare(square: SquareInvoiceConfig, marketId: string, invoice: InvoiceRecord): Promise<boolean> {
  const perPayment = invoice.squareInstallments.some(item => item.squareInvoiceId);
  const targets = perPayment
    ? invoice.squareInstallments.filter(item => item.squareInvoiceId && item.squareInvoiceVersion !== null && !item.cancelled && item.paidCents < item.amountCents)
      .map(item => ({ seq: item.seq as number | null, id: item.squareInvoiceId!, version: item.squareInvoiceVersion!, published: item.published }))
    : invoice.squareInvoiceId && invoice.squareInvoiceVersion !== null
      ? [{ seq: null, id: invoice.squareInvoiceId, version: invoice.squareInvoiceVersion, published: invoice.status === "open" }] : [];
  for (const target of targets) {
    try { await cancelSquareInvoice(square, target.id, target.version, target.published); }
    catch { return false; }
    if (target.seq !== null) await markInstallmentCancelled({ invoiceId: invoice.id, seq: target.seq });
  }
  await markInvoiceCancelled({ marketId, invoiceId: invoice.id });
  return true;
}
