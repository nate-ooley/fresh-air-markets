/**
 * Plain-text-first email templates for the vendor pipeline. Every template
 * returns subject/text/html; wording is intentionally short and edit-friendly.
 */

const MARKET = "North Port Farmer's Market";
const ORG = "Fresh Air Markets & Events";
const PHONE = "(941) 740-8866";

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "long", timeStyle: "short" });
}
function day(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
function escape(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string));
}
function wrap(paragraphs: string[]): { text: string; html: string } {
  const text = `${paragraphs.join("\n\n")}\n\n— ${ORG}\n${PHONE}`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#241f18;max-width:560px">
${paragraphs.map(p => `<p>${escape(p).replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>`).join("\n")}
<p style="color:#666">— ${ORG}<br>${PHONE}</p></div>`;
  return { text, html };
}

export interface EmailContent { subject: string; text: string; html: string }

export function applicationReceivedEmail(input: { name: string; businessName: string }): EmailContent {
  return { subject: `We received your ${MARKET} application`, ...wrap([
    `Hi ${input.name},`,
    `Thanks for applying to the ${MARKET}${input.businessName ? ` with ${input.businessName}` : ""}. Market staff review every application and will reply to this email address with a decision.`,
    "If approved, we'll ask for any required documents (such as proof of insurance), confirm your dates and booth count, and send a payment request. Payment is due within 48 hours of that request.",
  ]) };
}

export function applicationApprovedEmail(input: { name: string; businessName: string }): EmailContent {
  return { subject: `Your ${MARKET} application is approved`, ...wrap([
    `Hi ${input.name},`,
    `Good news: your application${input.businessName ? ` for ${input.businessName}` : ""} has been approved.`,
    "Next step: reply to this email with your certificate of insurance (PDF, PNG or JPEG) and, if you sell food, your food license or permit. Once those are approved we'll confirm your market dates and booth count and send your payment request.",
  ]) };
}

export function applicationChangesRequestedEmail(input: { name: string; reason: string }): EmailContent {
  return { subject: `Your ${MARKET} application needs a small change`, ...wrap([
    `Hi ${input.name},`,
    "We reviewed your application and need one thing before we can approve it:",
    input.reason,
    "Reply to this email with the update, or submit the application again with the corrected details.",
  ]) };
}

export function applicationDeclinedEmail(input: { name: string; reason: string }): EmailContent {
  return { subject: `About your ${MARKET} application`, ...wrap([
    `Hi ${input.name},`,
    "Thank you for applying. We're not able to offer you a booth this season.",
    input.reason,
    "We appreciate your interest and hope to see you at the market.",
  ]) };
}

export function paymentRequestEmail(input: { name: string; totalCents: number; dueAt: string; dates: string[]; booths: number; link: string }): EmailContent {
  const list = input.dates.length ? input.dates.map(day).join(", ") : "your reserved market dates";
  return { subject: `Payment request: ${MARKET} reservation (${money(input.totalCents)})`, ...wrap([
    `Hi ${input.name},`,
    `Your reservation is ready: ${input.booths} booth${input.booths === 1 ? "" : "s"} for ${list}. Total due: ${money(input.totalCents)}.`,
    `Pay securely through Square using your private link: ${input.link}`,
    `This link is only for you and expires ${when(input.dueAt)} (Eastern). Unpaid reservations are released after that time. Booth fees are non-refundable.`,
  ]) };
}

export function paymentReceivedEmail(input: { name: string; totalCents: number }): EmailContent {
  return { subject: `Payment received: ${MARKET}`, ...wrap([
    `Hi ${input.name},`,
    `We received your payment of ${money(input.totalCents)}. Your booth is confirmed.`,
    "You'll receive your booth assignment, market map, and Vendor Pass before your first market day, plus a reminder with setup instructions a few days ahead. Setup begins at 6:30 AM; booths must be ready by 8:00 AM.",
  ]) };
}

export function staffNewApplicationEmail(input: { name: string; businessName: string; email: string; type: string; applicationId: string; origin: string }): EmailContent {
  return { subject: `New ${input.type.toLowerCase()} application: ${input.businessName || input.name}`, ...wrap([
    `${input.name} (${input.email}) applied${input.businessName ? ` as ${input.businessName}` : ""}.`,
    `Review it: ${input.origin}/applications/${input.applicationId}`,
  ]) };
}

export function staffPaymentReceivedEmail(input: { name: string; businessName: string; totalCents: number; applicationId: string; origin: string }): EmailContent {
  return { subject: `Paid: ${input.businessName || input.name} (${money(input.totalCents)})`, ...wrap([
    `${input.name}${input.businessName ? ` (${input.businessName})` : ""} paid ${money(input.totalCents)} through Square.`,
    `Application: ${input.origin}/applications/${input.applicationId}`,
  ]) };
}

export function staffContactMessageEmail(input: { name: string; email: string; phone: string; topic: string; message: string; origin: string }): EmailContent {
  return { subject: `Website message from ${input.name} (${input.topic})`, ...wrap([
    `${input.name} <${input.email}>${input.phone ? `, ${input.phone}` : ""} wrote:`,
    input.message,
    `All messages: ${input.origin}/messages`,
  ]) };
}

export function passwordResetEmail(input: { name: string; link: string; minutes: number }): EmailContent {
  return { subject: `Reset your ${ORG} staff password`, ...wrap([
    `Hi ${input.name},`,
    `Someone asked to reset the password for your market staff account. Use this link within ${input.minutes} minutes: ${input.link}`,
    `The link works once. If you did not ask for this, ignore this email and your password stays the same.`,
  ]) };
}
