"use client";

import { type FormEvent, useState } from "react";

const FIELD = "mt-1 w-full rounded-xl border border-navy/15 bg-white px-4 py-3 text-ink outline-none transition focus:border-sky focus:ring-2 focus:ring-sky/25";
const LABEL = "block text-xs font-semibold uppercase tracking-wide text-navy/60";

export function ContactForm() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    try {
      const response = await fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "Your message could not be sent.");
      setDone(true);
    } catch (err) { setError(err instanceof Error ? err.message : "Your message could not be sent."); }
    finally { setBusy(false); }
  };

  if (done) return <p className="rounded-2xl bg-sky/10 p-6 text-navy">Thanks! Your message is in. We&rsquo;ll get back to you soon.</p>;
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <label className={LABEL}>First Name<input name="firstName" required className={FIELD} /></label>
      <label className={LABEL}>Last Name<input name="lastName" className={FIELD} /></label>
      <label className={LABEL}>Email<input name="email" type="email" required className={FIELD} /></label>
      <label className={LABEL}>Phone<input name="phone" type="tel" className={FIELD} /></label>
      <label className={`${LABEL} sm:col-span-2`}>I am reaching out about
        <select name="topic" defaultValue="general" className={FIELD}>
          <option value="general">General Inquiry</option>
          <option value="vendor">Becoming a Vendor</option>
          <option value="nonprofit">Non-Profit Organization</option>
        </select>
      </label>
      <label className={`${LABEL} sm:col-span-2`}>Message<textarea name="message" required rows={4} className={FIELD} /></label>
      <input name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />
      {error && <p role="alert" className="text-sm text-clay sm:col-span-2">{error}</p>}
      <div className="sm:col-span-2">
        <button type="submit" disabled={busy} className="rounded-full bg-sky px-6 py-3 font-semibold text-white shadow hover:bg-navy disabled:opacity-50">{busy ? "Sending…" : "Send Message"}</button>
        <p className="mt-2 text-xs text-navy/50">Want to apply as a vendor? Use the <a href="/apply" className="underline">application form</a> instead.</p>
      </div>
    </form>
  );
}

export function SubscribeForm() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    const email = new FormData(event.currentTarget).get("email");
    try {
      const response = await fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "subscribe", email }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "Could not subscribe.");
      setDone(payload?.outcome === "exists" ? "You're already on the list." : "You're on the list!");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not subscribe."); }
    finally { setBusy(false); }
  };
  if (done) return <p className="text-navy">{done}</p>;
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
      <input name="email" type="email" required placeholder="you@example.com" className="flex-1 rounded-full border border-navy/15 bg-white px-5 py-3 outline-none focus:border-sky" />
      <button type="submit" disabled={busy} className="rounded-full bg-navy px-6 py-3 font-semibold text-white hover:bg-sky disabled:opacity-50">{busy ? "…" : "Subscribe"}</button>
      {error && <p role="alert" className="text-sm text-clay">{error}</p>}
    </form>
  );
}
