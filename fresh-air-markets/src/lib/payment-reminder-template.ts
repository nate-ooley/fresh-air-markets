/**
 * Staff-editable payment reminder. Pure and browser-safe: the roster card uses
 * it for the live preview and the server uses it to send, so what staff see is
 * exactly what each vendor receives.
 */

export const REMINDER_FIELDS = ["name", "business", "total", "dates", "link"] as const;
export type ReminderField = typeof REMINDER_FIELDS[number];
export type ReminderValues = Record<ReminderField, string>;

export const MAX_REMINDER_SUBJECT = 200;
export const MAX_REMINDER_MESSAGE = 5000;
export const REMINDER_SIGNATURE = ["— Fresh Air Markets & Events", "(941) 740-8866"];

export const DEFAULT_REMINDER_SUBJECT = "Reminder: payment request: North Port Farmer's Market reservation ({total})";
export const DEFAULT_REMINDER_MESSAGE = [
  "Hi {name},",
  "This is a reminder that your reservation for {dates} is waiting for payment. Total due: {total}.",
  "Pay securely through Square using your private link: {link}",
  "This link is only for you. Please pay within the next 48 hours: if we have not received your payment by then, your spot may be released to another vendor. Booth fees are non-refundable.",
].join("\n\n");

const LINK_LINE = "Pay securely through Square using your private link: {link}";

export function reminderMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function reminderDates(dates: string[]): string {
  if (!dates.length) return "your reserved market dates";
  return dates.map(iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })).join(", ");
}

function fill(template: string, values: ReminderValues): string {
  return template.replace(/\{(name|business|total|dates|link)\}/g, (_, key: ReminderField) => values[key]);
}

/** Validates staff input. Returns the cleaned subject and message, or a staff-readable problem. */
export function cleanReminderTemplate(subject: unknown, message: unknown): { subject: string; message: string } | { error: string } {
  if (typeof subject !== "string" || typeof message !== "string") return { error: "Write a subject and a message." };
  const cleanSubject = subject.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const cleanMessage = message.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (!cleanSubject) return { error: "The subject is empty." };
  if (!cleanMessage) return { error: "The message is empty." };
  if (cleanSubject.length > MAX_REMINDER_SUBJECT) return { error: `Keep the subject under ${MAX_REMINDER_SUBJECT} characters.` };
  if (cleanMessage.length > MAX_REMINDER_MESSAGE) return { error: `Keep the message under ${MAX_REMINDER_MESSAGE} characters.` };
  return { subject: cleanSubject, message: cleanMessage };
}

/**
 * The email one vendor gets: placeholders filled, paragraphs split on blank
 * lines. The private payment link is always included; if staff removed
 * {link}, the standard link line is added at the end.
 */
export function renderPaymentReminder(template: { subject: string; message: string }, values: ReminderValues): { subject: string; paragraphs: string[] } {
  const body = template.message.includes("{link}") ? template.message : `${template.message}\n\n${LINK_LINE}`;
  return {
    subject: fill(template.subject, values).replace(/[\r\n]+/g, " ").trim(),
    paragraphs: fill(body, values).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean),
  };
}
