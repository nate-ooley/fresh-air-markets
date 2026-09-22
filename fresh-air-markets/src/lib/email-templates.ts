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

function uploadLine(link: string | null | undefined, lead: string): string {
  return link
    ? `${lead} Upload it here (PDF, PNG or JPEG; the link works for 14 days): ${link}`
    : `${lead} Reply to this email with it as a PDF, PNG or JPEG.`;
}

export function applicationReceivedEmail(input: { name: string; businessName: string; resubmission?: boolean; uploadLink?: string | null }): EmailContent {
  if (input.resubmission) {
    return { subject: `We received your updated ${MARKET} application`, ...wrap([
      `Hi ${input.name},`,
      `Thanks for the update${input.businessName ? ` for ${input.businessName}` : ""}. Market staff will look at your revised application and reply to this email address with a decision.`,
      uploadLine(input.uploadLink, "If you still need to send your certificate of insurance or food license:"),
      "Once approved, we'll confirm your dates and booth count and send a payment request, due within 48 hours.",
    ]) };
  }
  return { subject: `We received your ${MARKET} application`, ...wrap([
    `Hi ${input.name},`,
    `Thanks for applying to the ${MARKET}${input.businessName ? ` with ${input.businessName}` : ""}. Market staff review every application and will reply to this email address with a decision.`,
    uploadLine(input.uploadLink, "If you didn't attach your certificate of insurance (and food license, if you sell food) on the confirmation page:"),
    "If approved, we'll confirm your dates and booth count and send a payment request. Payment is due within 48 hours of that request.",
  ]) };
}

export function applicationApprovedEmail(input: { name: string; businessName: string; documentsOnFile?: boolean; uploadLink?: string | null }): EmailContent {
  return { subject: `Your ${MARKET} application is approved`, ...wrap([
    `Hi ${input.name},`,
    `Good news: your application${input.businessName ? ` for ${input.businessName}` : ""} has been approved.`,
    input.documentsOnFile
      ? "We have the documents you uploaded with your application. Once market staff have checked them we'll confirm your market dates and booth count and send your payment request."
      : uploadLine(input.uploadLink, "Next step: we need your certificate of insurance and, if you sell food, your food license or permit."),
    ...(input.documentsOnFile ? [] : ["Once those are approved we'll confirm your market dates and booth count and send your payment request."]),
  ]) };
}

export function applicationChangesRequestedEmail(input: { name: string; reason: string; uploadLink?: string | null }): EmailContent {
  return { subject: `Your ${MARKET} application needs a small change`, ...wrap([
    `Hi ${input.name},`,
    "We reviewed your application and need one thing before we can approve it:",
    input.reason,
    ...(input.uploadLink ? [`If it's a document (certificate of insurance, food license), upload it here; the link works for 14 days: ${input.uploadLink}`] : []),
    "If it's a detail on the application, submit the application again with the corrected details, or reply to this email.",
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

function bookMoreLine(link: string | null | undefined): string[] {
  return link ? [`Want more Saturdays this season? Pick them here and we'll send a payment link; your insurance and agreement stay on file: ${link}`] : [];
}

export function bookingWithdrawnEmail(input: { name: string; dates: string[]; note?: string; bookMoreLink?: string | null }): EmailContent {
  const list = input.dates.length ? input.dates.map(day).join(", ") : "your reserved market dates";
  return { subject: `Booking withdrawn: ${MARKET}`, ...wrap([
    `Hi ${input.name},`,
    `As requested, we've withdrawn your booking for ${list}. No payment is due for these dates and any earlier payment link no longer works.`,
    ...(input.note ? [input.note] : []),
    input.bookMoreLink
      ? `Your application stays on file for the season. To book different dates, choose them here and we'll send a new payment link: ${input.bookMoreLink}`
      : "Your application stays on file for the season. If you'd like to book different dates, just reply to this email or call us and we'll send a new payment link.",
  ]) };
}

export function bookingRequestReceivedEmail(input: { name: string; dates: string[]; booths: number }): EmailContent {
  return { subject: `We got your date request: ${MARKET}`, ...wrap([
    `Hi ${input.name},`,
    `Thanks! You asked for ${input.booths} booth${input.booths === 1 ? "" : "s"} on ${input.dates.map(day).join(", ")}.`,
    "Market staff will confirm the dates and email you a secure Square payment link, usually within a day or two. Nothing is reserved until you pay; payment is due within 48 hours of that email.",
  ]) };
}

export function bookingRequestDeclinedEmail(input: { name: string; dates: string[]; note: string; bookMoreLink?: string | null }): EmailContent {
  return { subject: `About your date request: ${MARKET}`, ...wrap([
    `Hi ${input.name},`,
    `We couldn't confirm your request for ${input.dates.map(day).join(", ")}.`,
    input.note,
    ...bookMoreLine(input.bookMoreLink),
  ]) };
}

export function staffBookingRequestEmail(input: { name: string; businessName: string; email: string; dates: string[]; booths: number; note: string; applicationId: string; origin: string }): EmailContent {
  return { subject: `Date request: ${input.businessName} (${input.dates.length} Saturday${input.dates.length === 1 ? "" : "s"})`, ...wrap([
    `${input.name} (${input.businessName}, ${input.email}) asked for ${input.booths} booth${input.booths === 1 ? "" : "s"} on ${input.dates.map(day).join(", ")}.`,
    ...(input.note ? [`Their note: ${input.note}`] : []),
    `Confirm or decline it here (confirming reserves the dates and emails the payment link): ${input.origin}/applications/${input.applicationId}`,
  ]) };
}

export function applicationWithdrawnEmail(input: { name: string; businessName: string; note?: string }): EmailContent {
  return { subject: `Application withdrawn: ${MARKET}`, ...wrap([
    `Hi ${input.name},`,
    `As requested, we've withdrawn ${input.businessName}'s application for this season. Any unpaid booking and payment link have been cancelled.`,
    ...(input.note ? [input.note] : []),
    "If this was a mistake or you change your mind, reply to this email or call us and we'll get you back in.",
  ]) };
}

export function paymentReceivedEmail(input: { name: string; totalCents: number; bookMoreLink?: string | null }): EmailContent {
  return { subject: `Payment received: ${MARKET}`, ...wrap([
    `Hi ${input.name},`,
    `We received your payment of ${money(input.totalCents)}. Your booth is confirmed.`,
    "You'll receive your booth assignment, market map, and Vendor Pass before your first market day, plus a reminder with setup instructions a few days ahead. Setup begins at 6:30 AM; booths must be ready by 8:00 AM.",
    ...bookMoreLine(input.bookMoreLink),
  ]) };
}

export function staffNewApplicationEmail(input: { name: string; businessName: string; email: string; phone?: string; type: string; applicationId: string; origin: string; resubmission?: boolean }): EmailContent {
  const who = `${input.name} (${input.email}${input.phone ? `, ${input.phone}` : ""})`;
  if (input.resubmission) {
    return { subject: `Updated ${input.type.toLowerCase()} application: ${input.businessName || input.name}`, ...wrap([
      `${who} sent an updated application${input.businessName ? ` for ${input.businessName}` : ""} after changes were requested. It is ready for a new decision.`,
      `Review it: ${input.origin}/applications/${input.applicationId}`,
    ]) };
  }
  return { subject: `New ${input.type.toLowerCase()} application: ${input.businessName || input.name}`, ...wrap([
    `${who} applied${input.businessName ? ` as ${input.businessName}` : ""}.`,
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

export function staffInvitationEmail(input: { name: string; marketName: string; link: string; days: number }): EmailContent {
  return { subject: `You're invited to manage ${input.marketName} on Fresh Air Markets`, ...wrap([
    `Hi ${input.name},`,
    `You've been added to the market staff for ${input.marketName}. Choose your password and start reviewing applications here: ${input.link}`,
    `The link works once and expires in ${input.days} days. After that, ask the market owner for a new invitation.`,
  ]) };
}

export function applicationInvitationEmail(input: { name: string; businessName: string; fullSeason: boolean; dates: string[]; link: string; reminder?: boolean }): EmailContent {
  const wanted = input.fullSeason ? "the full season" : input.dates.length ? input.dates.map(day).join(", ") : "your market dates";
  return { subject: `${input.reminder ? "Reminder: finish" : "Finish"} your ${MARKET} vendor application`, ...wrap([
    `Hi ${input.name || "there"},`,
    input.reminder
      ? `We haven't received your ${MARKET} application yet${input.businessName ? ` for ${input.businessName}` : ""}. Booth spaces are filling up for the season, and we'd love to have you. Everything is done on our new website, and it only takes a couple of minutes.`
      : `Thanks for your interest in the ${MARKET}${input.businessName ? ` with ${input.businessName}` : ""}. We've moved vendor applications to our new website, and we need a few things from you to hold your spot.`,
    `Use this personal link to finish your application. Your details and the dates you asked for (${wanted}) are already filled in: ${input.link}`,
    "Please check your details, choose how many booths you need, sign the vendor agreement, and attach your certificate of insurance (PDF, PNG or JPEG). It takes about two minutes.",
    "Once market staff approve your application, we'll confirm your dates and email you a secure Square payment link. Payment is due within 48 hours of that email.",
  ]) };
}

export function documentUploadLinkEmail(input: { name: string; businessName: string; link: string }): EmailContent {
  return { subject: `Upload your documents for the ${MARKET}`, ...wrap([
    `Hi ${input.name},`,
    `Here is your personal link to upload your certificate of insurance and, if you sell food or drinks, your food license or permit${input.businessName ? ` for ${input.businessName}` : ""}: ${input.link}`,
    "PDF, PNG or JPEG up to 10 MB. The link works for 14 days and you can come back to add a second file. Once market staff approve your documents we'll confirm your dates and send your payment request.",
  ]) };
}
