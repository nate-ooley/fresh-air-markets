"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_REMINDER_MESSAGE, DEFAULT_REMINDER_SUBJECT, MAX_REMINDER_MESSAGE, MAX_REMINDER_SUBJECT, REMINDER_FIELDS, REMINDER_SIGNATURE,
  cleanReminderTemplate, reminderDates, reminderMoney, renderPaymentReminder, type ReminderField,
} from "@/lib/payment-reminder-template";

interface Unpaid { reservationId: string; business: string; name: string; email: string; state: string; totalCents: number; dates: string[]; booths: number }
interface Result { reservationId: string; business: string; totalCents: number; outcome: "sent" | "skipped" | "failed"; detail: string }

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const STATE: Record<string, string> = { held: "reserved, no payment link yet", payment_pending: "payment link sent, not paid", expired: "earlier payment window lapsed" };
const FIELD_HELP: Record<ReminderField, string> = { name: "vendor's name", business: "business name", total: "amount due", dates: "their Saturdays", link: "private payment link" };
const DRAFT_KEY = "fame-payment-reminder-draft";
const PREVIEW_LINK = "[their private payment link]";
const INPUT = "mt-1 w-full rounded-xl border border-pine/20 bg-white px-3 py-2 text-sm text-ink outline-none focus:border-leaf focus:ring-2 focus:ring-leaf/20";

function readDraft(): { subject: string; message: string } | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? "null");
    return value && typeof value.subject === "string" && typeof value.message === "string" ? value : null;
  } catch { return null; }
}
function saveDraft(subject: string, message: string) {
  try {
    if (subject === DEFAULT_REMINDER_SUBJECT && message === DEFAULT_REMINDER_MESSAGE) window.localStorage.removeItem(DRAFT_KEY);
    else window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ subject, message }));
  } catch { /* the draft is a convenience only */ }
}

/**
 * Staff: see who still owes, tick the vendors to remind, edit the email, see
 * exactly what each vendor will get, then send.
 */
export default function PaymentRemindersCard() {
  const [unpaid, setUnpaid] = useState<Unpaid[] | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [subject, setSubject] = useState(DEFAULT_REMINDER_SUBJECT);
  const [message, setMessage] = useState(DEFAULT_REMINDER_MESSAGE);
  const [previewId, setPreviewId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/payments/reminders", { cache: "no-store", headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => null);
      if (response.ok && Array.isArray(payload?.unpaid)) setUnpaid(payload.unpaid);
    } catch { /* the roster still works without this card */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const draft = readDraft();
    if (draft) { setSubject(draft.subject); setMessage(draft.message); }
  }, []);
  useEffect(() => { if (open) saveDraft(subject, message); }, [open, subject, message]);

  const chosen = useMemo(() => (unpaid ?? []).filter(row => selected.has(row.reservationId)), [unpaid, selected]);
  const previewRow = chosen.find(row => row.reservationId === previewId) ?? chosen[0] ?? null;
  const preview = useMemo(() => {
    if (!previewRow) return null;
    return renderPaymentReminder({ subject, message }, {
      name: previewRow.name || previewRow.business, business: previewRow.business || previewRow.name,
      total: reminderMoney(previewRow.totalCents), dates: reminderDates(previewRow.dates), link: PREVIEW_LINK,
    });
  }, [previewRow, subject, message]);

  const start = () => {
    setResults(null); setError("");
    setSelected(new Set((unpaid ?? []).map(row => row.reservationId)));
    setOpen(true);
  };
  const toggle = (id: string) => setSelected(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const insertField = (field: ReminderField) => {
    const token = `{${field}}`;
    const area = messageRef.current;
    if (!area) { setMessage(current => current + token); return; }
    const startAt = area.selectionStart ?? message.length;
    const endAt = area.selectionEnd ?? message.length;
    setMessage(message.slice(0, startAt) + token + message.slice(endAt));
    window.requestAnimationFrame(() => { area.focus(); area.setSelectionRange(startAt + token.length, startAt + token.length); });
  };
  const resetWording = () => { setSubject(DEFAULT_REMINDER_SUBJECT); setMessage(DEFAULT_REMINDER_MESSAGE); };

  const send = async () => {
    if (busy || !chosen.length) return;
    const template = cleanReminderTemplate(subject, message);
    if ("error" in template) { setError(template.error); return; }
    if (!window.confirm(`Send this email to ${chosen.length} vendor${chosen.length === 1 ? "" : "s"}? Each gets a fresh private payment link; earlier links for that booking stop working.`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/payments/reminders", {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ reservationIds: chosen.map(row => row.reservationId), subject: template.subject, message: template.message }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(payload?.results)) { setError(typeof payload?.error === "string" ? payload.error : "The reminders could not be sent."); return; }
      setResults(payload.results);
      setOpen(false);
      await load();
    } catch { setError("The reminders could not be sent. Check your connection and try again."); }
    finally { setBusy(false); }
  };

  if (!unpaid) return null;
  const allChosen = unpaid.length > 0 && chosen.length === unpaid.length;
  return (
    <section className="mt-6 rounded-2xl border border-pine/15 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-pine-deep">Waiting on payment</h2>
          <p className="mt-1 text-sm text-ink/65">{unpaid.length ? `${unpaid.length} vendor${unpaid.length === 1 ? "" : "s"}, ${money(unpaid.reduce((sum, row) => sum + row.totalCents, 0))} outstanding. Payment links stay open until the vendor pays or you withdraw the booking.` : "Everyone with a booking has paid."}</p>
        </div>
        {unpaid.length > 0 && !open && <button type="button" onClick={start} className="rounded-full bg-pine px-5 py-2 text-sm font-semibold text-cream hover:bg-leaf">Email payment reminders…</button>}
      </div>

      {!open && unpaid.length > 0 && !results && (
        <ul className="mt-4 divide-y divide-pine/10 text-sm">
          {unpaid.map(row => <li key={row.reservationId} className="flex flex-wrap justify-between gap-2 py-2"><span className="font-semibold text-pine-deep">{row.business || "(name unavailable)"}</span><span className="text-ink/65">{money(row.totalCents)} · {STATE[row.state] ?? row.state}</span></li>)}
        </ul>
      )}

      {open && (
        <div className="mt-5 grid gap-6 lg:grid-cols-2">
          <div>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-pine-deep">1. Who gets it ({chosen.length} of {unpaid.length})</h3>
              <button type="button" onClick={() => setSelected(allChosen ? new Set() : new Set(unpaid.map(row => row.reservationId)))} className="text-xs font-semibold text-pine underline underline-offset-4">{allChosen ? "Clear all" : "Select all"}</button>
            </div>
            <ul className="mt-2 max-h-72 divide-y divide-pine/10 overflow-y-auto rounded-xl border border-pine/15 text-sm">
              {unpaid.map(row => (
                <li key={row.reservationId}>
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-parchment/50">
                    <input type="checkbox" checked={selected.has(row.reservationId)} onChange={() => toggle(row.reservationId)} className="mt-1" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-pine-deep">{row.business || "(name unavailable)"}</span>
                      <span className="block text-xs text-ink/60">{row.name}{row.email ? ` · ${row.email}` : ""}</span>
                    </span>
                    <span className="shrink-0 text-right text-xs text-ink/65">{money(row.totalCents)}<br />{STATE[row.state] ?? row.state}</span>
                  </label>
                </li>
              ))}
            </ul>

            <h3 className="mt-5 text-sm font-semibold text-pine-deep">2. The email</h3>
            <label className="mt-2 block text-xs font-semibold uppercase tracking-wide text-ink/55">Subject
              <input type="text" value={subject} maxLength={MAX_REMINDER_SUBJECT} onChange={event => setSubject(event.target.value)} className={INPUT} />
            </label>
            <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-ink/55">Message
              <textarea ref={messageRef} value={message} maxLength={MAX_REMINDER_MESSAGE} rows={11} onChange={event => setMessage(event.target.value)} className={`${INPUT} font-sans normal-case tracking-normal`} />
            </label>
            <p className="mt-2 text-xs text-ink/60">Leave a blank line between paragraphs. Click to insert something that fills in for each vendor:</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {REMINDER_FIELDS.map(field => (
                <button key={field} type="button" onClick={() => insertField(field)} title={FIELD_HELP[field]} className="rounded-full border border-pine/20 px-3 py-1 text-xs text-pine hover:bg-parchment">{`{${field}}`} <span className="text-ink/50">{FIELD_HELP[field]}</span></button>
              ))}
            </div>
            {!message.includes("{link}") && <p className="mt-2 text-xs text-clay">{"{link}"} isn't in the message, so the standard payment-link line will be added at the end.</p>}
            <button type="button" onClick={resetWording} className="mt-3 text-xs font-semibold text-pine underline underline-offset-4">Reset to the standard wording</button>
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-pine-deep">3. Preview: exactly what they get</h3>
              {chosen.length > 1 && (
                <select value={previewRow?.reservationId ?? ""} onChange={event => setPreviewId(event.target.value)} className="rounded-lg border border-pine/20 bg-white px-2 py-1 text-xs text-ink">
                  {chosen.map(row => <option key={row.reservationId} value={row.reservationId}>{row.business || row.name}</option>)}
                </select>
              )}
            </div>
            {preview && previewRow ? (
              <div className="mt-2 rounded-xl border border-pine/15 bg-cream/60 p-4 text-sm">
                <p className="text-xs text-ink/55">To: {previewRow.email || "(no email on file)"}</p>
                <p className="mt-1 font-semibold text-pine-deep">{preview.subject}</p>
                <div className="mt-3 space-y-3 whitespace-pre-line leading-relaxed text-ink/80">
                  {preview.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
                  <p className="text-ink/55">{REMINDER_SIGNATURE.join("\n")}</p>
                </div>
              </div>
            ) : <p className="mt-2 rounded-xl border border-dashed border-pine/20 p-4 text-sm text-ink/55">Tick at least one vendor to see the preview.</p>}
            <p className="mt-2 text-xs text-ink/55">Each vendor's own link is created when you send. Sending replaces any earlier link for that booking.</p>

            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" disabled={busy || !chosen.length} onClick={() => void send()} className="rounded-full bg-pine px-5 py-2 text-sm font-semibold text-cream enabled:hover:bg-leaf disabled:opacity-45">{busy ? "Sending…" : `Send to ${chosen.length} vendor${chosen.length === 1 ? "" : "s"}`}</button>
              <button type="button" disabled={busy} onClick={() => { setOpen(false); setError(""); }} className="rounded-full border border-pine/20 px-5 py-2 text-sm font-semibold text-pine disabled:opacity-45">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {results && (
        <ul role="status" className="mt-4 divide-y divide-pine/10 text-sm">
          {results.map(row => <li key={row.reservationId} className="flex flex-wrap justify-between gap-2 py-2"><span className="font-semibold text-pine-deep">{row.business || "(name unavailable)"}{row.totalCents ? ` · ${money(row.totalCents)}` : ""}</span><span className={row.outcome === "sent" ? "text-pine" : "text-clay"}>{row.detail}</span></li>)}
        </ul>
      )}
      {error && <p role="alert" className="mt-4 rounded-xl bg-clay/10 p-3 text-sm text-clay">{error}</p>}
    </section>
  );
}
