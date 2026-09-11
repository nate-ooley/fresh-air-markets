"use client";

import Link from "next/link";
import { type FormEvent, useMemo, useState } from "react";

const FIELD = "mt-1 w-full rounded-xl border border-navy/15 bg-white px-4 py-3 text-ink outline-none transition focus:border-sky focus:ring-2 focus:ring-sky/25";
const LABEL = "block text-xs font-semibold uppercase tracking-wide text-navy/60";

interface Props { dates: string[]; categories: readonly string[]; fullSeasonLabel: string }

function dateLabel(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export default function ApplyForm({ dates, categories, fullSeasonLabel }: Props) {
  const [type, setType] = useState<"Vendor" | "Non-Profit Organization">("Vendor");
  const [fullSeason, setFullSeason] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"captured" | "duplicate" | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const vendor = type === "Vendor";
  const months = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const iso of dates) {
      const key = new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
      groups.set(key, [...(groups.get(key) ?? []), iso]);
    }
    return [...groups.entries()];
  }, [dates]);

  const toggle = (iso: string) => setSelected(current => { const next = new Set(current); if (next.has(iso)) next.delete(iso); else next.add(iso); return next; });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setErrors([]);
    const form = new FormData(event.currentTarget);
    const body = {
      registrationType: type,
      firstName: form.get("firstName"), lastName: form.get("lastName"), email: form.get("email"), phone: form.get("phone"),
      businessName: form.get("businessName"), vendorCategory: vendor ? category : "", otherCategory: form.get("otherCategory") ?? "",
      fullSeason: vendor && fullSeason, dates: vendor && !fullSeason ? [...selected] : [],
      message: form.get("message"), agreementAccepted: form.get("agreementAccepted") === "on", signatureName: form.get("signatureName"),
      website: form.get("website"),
    };
    try {
      const response = await fetch("/api/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setErrors(Array.isArray(payload?.errors) ? payload.errors : [typeof payload?.error === "string" ? payload.error : "Your application could not be submitted."]); return; }
      setDone(payload?.status === "duplicate" ? "duplicate" : "captured");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch { setErrors(["Your application could not be submitted. Please try again."]); }
    finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-navy/10">
        <h2 className="font-display text-3xl text-navy">{done === "duplicate" ? "We already have this application" : "Application received"}</h2>
        <p className="mt-3 text-ink/70">
          {done === "duplicate"
            ? "Nothing changed since your last submission, so we kept your original application on file."
            : "Thank you! Market staff will review your application and reply by email with a decision. If approved, you'll be asked for any required documents, then you'll confirm your dates and receive a payment request."}
        </p>
        <Link href="/" className="mt-6 inline-block rounded-full bg-sky px-6 py-3 font-semibold text-white">Back to the market</Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-8 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-navy/10 sm:p-8">
      <fieldset>
        <legend className={LABEL}>I am applying as</legend>
        <div className="mt-2 flex gap-3">
          {(["Vendor", "Non-Profit Organization"] as const).map(option => (
            <button key={option} type="button" onClick={() => setType(option)} aria-pressed={type === option}
              className={`rounded-full px-5 py-2 text-sm font-semibold transition ${type === option ? "bg-navy text-white" : "bg-navy/5 text-navy hover:bg-navy/10"}`}>{option}</button>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className={LABEL}>First Name<input name="firstName" required maxLength={100} className={FIELD} /></label>
        <label className={LABEL}>Last Name<input name="lastName" required maxLength={100} className={FIELD} /></label>
        <label className={LABEL}>Email<input name="email" type="email" required maxLength={254} className={FIELD} /></label>
        <label className={LABEL}>Phone<input name="phone" type="tel" maxLength={40} className={FIELD} /></label>
        <label className={`${LABEL} sm:col-span-2`}>{vendor ? "Business Name" : "Organization Name"}<input name="businessName" required maxLength={200} className={FIELD} /></label>
        {vendor && (
          <>
            <label className={LABEL}>What do you sell?
              <select value={category} onChange={e => setCategory(e.target.value)} required className={FIELD}>
                <option value="">Choose a category</option>
                {categories.map(item => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            {category === "Other" && <label className={LABEL}>Describe your products<input name="otherCategory" required maxLength={200} className={FIELD} /></label>}
          </>
        )}
      </div>

      {vendor && (
        <fieldset>
          <legend className={LABEL}>Which Saturdays would you like?</legend>
          <label className="mt-3 flex items-center gap-3 rounded-2xl bg-sky/10 p-4 text-navy">
            <input type="checkbox" checked={fullSeason} onChange={e => setFullSeason(e.target.checked)} className="h-5 w-5" />
            <span><span className="font-semibold">{fullSeasonLabel}</span> — $30 per week, every market Saturday</span>
          </label>
          {!fullSeason && (
            <div className="mt-4 space-y-4">
              <p className="text-sm text-ink/60">$40 per week, or $35 per week when you book 4 or more consecutive Saturdays. Final dates are confirmed with you after approval.</p>
              {months.map(([month, isos]) => (
                <div key={month}>
                  <p className="text-sm font-semibold text-navy">{month}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {isos.map(iso => (
                      <button key={iso} type="button" onClick={() => toggle(iso)} aria-pressed={selected.has(iso)}
                        className={`rounded-full px-3 py-1.5 text-sm transition ${selected.has(iso) ? "bg-sky text-white" : "bg-navy/5 text-navy hover:bg-navy/10"}`}>{dateLabel(iso).replace(/, \d{4}$/, "")}</button>
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-sm text-navy">{selected.size} Saturday{selected.size === 1 ? "" : "s"} selected</p>
            </div>
          )}
        </fieldset>
      )}

      <label className={LABEL}>{vendor ? "Tell us about your business" : "Tell us about your organization and its mission"}
        <textarea name="message" required={!vendor} rows={4} maxLength={2000} className={FIELD} />
      </label>

      <fieldset className="rounded-2xl border border-navy/10 bg-parchment/40 p-5">
        <legend className="px-2 font-semibold text-navy">Vendor Agreement</legend>
        <p className="text-sm text-ink/70">
          Please read the <Link href="/agreement" target="_blank" className="underline">Vendor Agreement</Link>. It covers setup times, booth rules, fees, the 48-hour payment window and the no-refund policy.
        </p>
        <label className="mt-3 flex items-start gap-3 text-sm text-ink">
          <input type="checkbox" name="agreementAccepted" required className="mt-1 h-5 w-5" />
          <span>I have read and agree to the Vendor Agreement, and I understand that typing my name below is my electronic signature.</span>
        </label>
        <label className={`${LABEL} mt-4`}>Type your full name to sign<input name="signatureName" required minLength={2} maxLength={200} className={`${FIELD} font-display text-lg`} placeholder="Your full legal name" /></label>
      </fieldset>

      <input name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />
      {errors.length > 0 && (
        <ul role="alert" className="list-disc space-y-1 rounded-2xl bg-clay/10 p-4 pl-8 text-sm text-clay">{errors.map(e => <li key={e}>{e}</li>)}</ul>
      )}
      <button type="submit" disabled={busy} className="w-full rounded-full bg-sky px-6 py-4 text-lg font-semibold text-white shadow hover:bg-navy disabled:opacity-50 sm:w-auto">{busy ? "Submitting…" : "Submit Application"}</button>
    </form>
  );
}
