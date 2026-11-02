"use client";

import { useCallback, useEffect, useState } from "react";

interface Note { id: string; body: string; authorName: string; createdAt: string }

const MAX = 2000;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });

/** Private market-manager notes on a vendor, available whatever stage they're at. */
export default function VendorNotesPanel({ applicationId }: { applicationId: string }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/api/admin/applications/${encodeURIComponent(applicationId)}/notes`;

  const load = useCallback(async () => {
    try {
      const response = await fetch(endpoint, { cache: "no-store", headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => null);
      if (response.ok && Array.isArray(payload?.notes)) { setNotes(payload.notes); setError(""); }
      else setError(typeof payload?.error === "string" ? payload.error : "Notes could not be loaded.");
    } catch { setError("Notes could not be loaded. Check your connection."); }
  }, [endpoint]);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (busy || !draft.trim()) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ body: draft }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(typeof payload?.error === "string" ? payload.error : "The note could not be saved."); return; }
      setDraft("");
      await load();
    } catch { setError("The note could not be saved. Check your connection and try again."); }
    finally { setBusy(false); }
  };

  const remove = async (note: Note) => {
    if (busy || !window.confirm("Remove this note?")) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/admin/vendor-notes/${encodeURIComponent(note.id)}/remove`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(typeof payload?.error === "string" ? payload.error : "The note could not be removed."); return; }
      await load();
    } catch { setError("The note could not be removed. Check your connection and try again."); }
    finally { setBusy(false); }
  };

  return (
    <section aria-labelledby="vendor-notes-title" className="mt-8 rounded-3xl border border-pine/15 bg-white p-5">
      <h2 id="vendor-notes-title" className="font-display text-2xl text-pine-deep">Manager notes</h2>
      <p className="mt-1 text-sm text-ink/65">Private to market staff. Vendors never see these.</p>
      <textarea value={draft} rows={3} maxLength={MAX} disabled={busy} onChange={event => setDraft(event.target.value)} placeholder="Example: Called 11/2, prefers the end spot near the food trucks."
        className="mt-3 w-full rounded-2xl border border-pine/20 bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-amber focus:ring-2 focus:ring-amber/25" />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-xs text-ink/45">{draft.length}/{MAX}</span>
        <button type="button" disabled={busy || !draft.trim()} onClick={() => void add()} className="rounded-full bg-pine px-5 py-2 text-sm font-semibold text-cream enabled:hover:bg-leaf disabled:opacity-45">{busy ? "Saving…" : "Save note"}</button>
      </div>
      {error && <p role="alert" className="mt-3 rounded-xl bg-clay/10 p-3 text-sm text-clay">{error}</p>}
      {notes === null && !error && <p role="status" className="mt-4 text-sm text-ink/55">Loading notes…</p>}
      {notes !== null && notes.length === 0 && <p className="mt-4 text-sm text-ink/55">No notes yet.</p>}
      {notes !== null && notes.length > 0 && (
        <ul className="mt-4 space-y-3">
          {notes.map(note => (
            <li key={note.id} className="rounded-2xl bg-parchment/60 p-4 text-sm">
              <p className="whitespace-pre-line text-ink/85">{note.body}</p>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ink/55">
                <span>{note.authorName} · {when(note.createdAt)}</span>
                <button type="button" disabled={busy} onClick={() => void remove(note)} className="font-semibold text-clay underline underline-offset-4 disabled:opacity-45">Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
