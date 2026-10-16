import { NextRequest, NextResponse } from "next/server";
import { adminGate } from "@/lib/admin-gate";
import { invoiceSendDate, planBilling } from "@/lib/billing-plan";
import { applicantContact } from "@/lib/email";
import { readInquiryBody } from "@/lib/inquiry-body";
import { retireCheckoutLinks } from "@/lib/reservation-withdraw-pg";
import { squarePaymentRuntimeConfig, verifySquareIdentity } from "@/lib/square";
import { SquareInvoiceError, cancelSquareInvoice, createDraftSquareInvoice, ensureSquareCustomer, publishSquareInvoice, type SquareInvoiceConfig } from "@/lib/square-invoice";
import { squareLinkCanceller } from "@/lib/square-link-cancel";
import { validSquareReservationId } from "@/lib/square-payment";
import { marketToday } from "@/lib/vendor-booking-pg";
import { beginInvoice, invoiceView, markInstallmentPublished, markInvoiceFailed, markInvoiceOpen, readBillingQuote, recordInstallmentDraft } from "@/lib/vendor-invoice-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };

const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** Plain words for the Square refusals staff are most likely to hit. */
function squareProblem(error: unknown): string {
  if (!(error instanceof SquareInvoiceError)) return "Square could not create the invoice. Nothing was sent to the vendor; try again.";
  const codes = error.codes;
  const detail = ` (Square: ${error.step}, ${error.status}${codes.length ? ` ${codes.join(", ")}` : ""})`;
  if (codes.includes("INSUFFICIENT_SCOPES") || error.status === 401) return `The site's Square connection isn't allowed to create invoices. The Square access settings need updating before billing will work. Nothing was sent to the vendor.${detail}`;
  // Pay-in-full invoices work on every Square plan; installments are a paid Square Invoices feature.
  if (error.status === 403 || codes.some(code => /SUBSCRIPTION|NOT_ENABLED|UNSUPPORTED|FEATURE|FORBIDDEN/.test(code))) return `Square says this account can't send that kind of invoice. Monthly plans may need Square's Invoices Plus upgrade; "Pay in full" still works. Nothing was sent to the vendor.${detail}`;
  if (codes.includes("INVALID_EMAIL_ADDRESS")) return "Square rejected the vendor's email address. Fix it on their application, then try again.";
  if (error.status === 0) return "Square didn't answer. Nothing was sent to the vendor; try again in a minute.";
  return `Square refused the invoice (${error.step}${codes.length ? `: ${codes.join(", ")}` : `, ${error.status}`}). Nothing was sent to the vendor.`;
}

/**
 * Staff bill an unpaid booking through a Square invoice: one payment or a
 * monthly plan, optionally a different amount with a recorded reason. The
 * invoice is drafted first, the old payment link is retired (proved by
 * Square), and only then is the invoice published so Square emails it.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await adminGate(request);
  if ("error" in gated) return gated.error;
  const { marketId } = gated;
  const { id } = await params;
  if (!validSquareReservationId(id)) return NextResponse.json({ error: "Invalid reservation ID." }, { status: 400, headers });
  const decoded = await readInquiryBody(request);
  if ("status" in decoded) return NextResponse.json({ error: decoded.error }, { status: decoded.status, headers });

  let quoted;
  try { quoted = await readBillingQuote(marketId, id); }
  catch { return NextResponse.json({ error: "Billing is unavailable right now." }, { status: 503, headers }); }
  if (quoted === null) return NextResponse.json({ error: "Reservation not found." }, { status: 404, headers });
  const body = decoded.body;
  const request_ = planBilling({ plan: body.plan, installments: body.installments, firstDueOn: body.firstDueOn, totalCents: body.totalCents, reason: body.reason, quotedCents: quoted, today: marketToday() });
  if ("error" in request_) return NextResponse.json({ error: request_.error }, { status: 400, headers });

  let square: SquareInvoiceConfig;
  try {
    const setup = squarePaymentRuntimeConfig(process.env);
    const identity = await verifySquareIdentity(setup);
    square = { environment: setup.environment, accessToken: setup.accessToken, locationId: identity.locationId };
  } catch { return NextResponse.json({ error: "Square is not reachable right now. Nothing was sent; try again." }, { status: 503, headers }); }

  let begun;
  try { begun = await beginInvoice({ marketId, reservationId: id, request: request_, environment: square.environment, actorAccountId: marketId }); }
  catch { return NextResponse.json({ error: "Billing is unavailable right now. Nothing was sent; try again." }, { status: 503, headers }); }
  if (begun.kind === "unavailable") return NextResponse.json({ error: "Billing by invoice isn't switched on yet (its database update hasn't been applied). Nothing was sent." }, { status: 503, headers });
  if (begun.kind === "not_found") return NextResponse.json({ error: "Reservation not found." }, { status: 404, headers });
  if (begun.kind === "already_open") return NextResponse.json({ error: "This booking already has an open Square invoice. Cancel it first to bill differently.", invoice: invoiceView(begun.invoice) }, { status: 409, headers });
  if (begun.kind === "not_billable") {
    return NextResponse.json({ error: begun.state === "paid" || begun.state === "confirmed" ? "This booking is already paid."
      : begun.state === "nonprofit" ? "Nonprofit bookings have nothing to pay."
        : begun.state === "expired" ? "This booking's hold lapsed. Reopen it first, then bill it."
          : `This booking is ${begun.state.replace("_", " ")} and can't be billed.` }, { status: 409, headers });
  }
  const invoice = begun.invoice;
  const target = begun.target;
  const fail = async (message: string, status = 503) => {
    await markInvoiceFailed({ invoiceId: invoice.id, error: message }).catch(() => null);
    return NextResponse.json({ error: message }, { status, headers });
  };

  // 1. A Square customer and one DRAFT pay-in-full invoice per payment (nothing is emailed yet).
  const today = marketToday();
  const payments = invoice.squareInstallments;
  const count = payments.length;
  const needsDraft = payments.filter(item => !item.squareInvoiceId);
  if (needsDraft.length) {
    const contact = await applicantContact(target.applicationId, marketId).catch(() => null);
    if (!contact) return fail("This vendor has no usable email address on file, so Square can't send them an invoice.", 409);
    try {
      const customerId = invoice.squareCustomerId ?? await ensureSquareCustomer(square, { email: contact.email, name: contact.name, businessName: contact.businessName, reference: target.applicationId });
      for (const item of needsDraft) {
        const sendOn = invoiceSendDate(item.dueOn, today);
        const draft = await createDraftSquareInvoice(square, {
          invoiceRowId: invoice.id, seq: item.seq, customerId,
          title: count === 1 ? "North Port Farmer's Market booth reservation" : `North Port Farmer's Market booth reservation: payment ${item.seq} of ${count}`,
          description: `${count === 1 ? "" : `Payment ${item.seq} of ${count}. `}${target.booths} booth${target.booths === 1 ? "" : "s"} on ${target.dates.map(day).join(", ")}.`,
          amountCents: item.amountCents, dueOn: item.dueOn,
          // Later payments go out a few days before they are due, about 9am Eastern.
          scheduledAt: sendOn ? `${sendOn}T13:00:00Z` : null,
        });
        await recordInstallmentDraft({ invoiceId: invoice.id, seq: item.seq, customerId, orderId: draft.orderId, squareInvoiceId: draft.invoiceId, version: draft.version });
        Object.assign(item, { squareOrderId: draft.orderId, squareInvoiceId: draft.invoiceId, squareInvoiceVersion: draft.version });
      }
    } catch (error) {
      // Drafts are never seen by the vendor; remove the ones made so far.
      for (const item of payments) if (item.squareInvoiceId && !item.published && item.squareInvoiceVersion !== null) await cancelSquareInvoice(square, item.squareInvoiceId, item.squareInvoiceVersion, false).catch(() => null);
      return fail(squareProblem(error));
    }
  }

  // 2. Retire the old payment link so the vendor can't pay twice.
  let retired;
  try { retired = await retireCheckoutLinks({ marketId, reservationId: id, cancelLink: squareLinkCanceller(process.env) }); }
  catch { retired = { kind: "square_unavailable" as const }; }
  if (retired.kind !== "retired") {
    for (const item of payments) if (item.squareInvoiceId && !item.published && item.squareInvoiceVersion !== null) await cancelSquareInvoice(square, item.squareInvoiceId, item.squareInvoiceVersion, false).catch(() => null);
    const message = retired.kind === "cancellation_unproven"
      ? `Square could not confirm the old payment link was cancelled; the vendor may already have paid. Check order ${retired.squareOrderId} in Square. No invoice was sent.`
      : retired.kind === "link_closing" || retired.kind === "checkout_in_progress"
        ? "Square is working on this booking's payment link right now. Try again in a minute. No invoice was sent."
        : retired.kind === "not_billable" ? "This booking changed while you were billing it. Reload the page. No invoice was sent."
          : "Square did not confirm the old payment link was cancelled. No invoice was sent; try again.";
    return fail(message, retired.kind === "square_unavailable" ? 503 : 409);
  }

  // 3. Publish each payment: Square emails the first now and schedules the rest.
  let firstUrl: string | null = null;
  for (const item of payments) {
    if (item.published) continue;
    try {
      const published = await publishSquareInvoice(square, item.squareInvoiceId!, item.squareInvoiceVersion!);
      await markInstallmentPublished({ invoiceId: invoice.id, seq: item.seq, version: published.version, publicUrl: published.publicUrl });
      if (item.seq === 1) firstUrl = published.publicUrl;
    } catch (error) {
      // Drafts stay; a retry publishes the rest. The old link is already retired.
      const sent = payments.filter(other => other.published || other.seq < item.seq).length;
      return NextResponse.json({ error: `${squareProblem(error)} ${sent ? `${sent} of ${count} payments were already sent or scheduled. ` : ""}The old payment link was already cancelled; click "Send invoice" again to finish.` }, { status: 503, headers });
    }
  }
  await markInvoiceOpen({ invoiceId: invoice.id, publicUrl: firstUrl });
  return NextResponse.json({ invoice: { ...invoiceView(invoice), status: "open", publicUrl: firstUrl } }, { status: 201, headers });
}
