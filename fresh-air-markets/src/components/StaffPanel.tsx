"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface StaffUser { id: string; email: string; name: string; role: "owner" | "manager"; status: "invited" | "active" | "removed"; createdAt: string }
interface Directory { staff: StaffUser[]; me: { userId: string | null; role: "owner" | "manager" } }

export default function StaffPanel() {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/admin/staff", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? "Staff accounts are unavailable."); return; }
      setDirectory(data);
    } catch { setError("Staff accounts are unavailable."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch("/api/admin/staff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? "The invitation could not be created."); return; }
      setName(""); setEmail("");
      setNotice(data.invitation === "sent"
        ? `Invitation emailed to ${data.staff.email}. It works for 7 days.`
        : `The invitation was created but the email did not go out. Send this link to ${data.staff.email} yourself: ${data.inviteUrl}`);
      await load();
    } catch { setError("The invitation could not be created."); }
    finally { setBusy(false); }
  };

  const remove = async (user: StaffUser) => {
    if (!window.confirm(`Remove ${user.name || user.email}? They will be signed out and can no longer sign in.`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch(`/api/admin/staff/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? "Could not remove this person."); return; }
      setNotice(`${user.name || user.email} no longer has access.`);
      await load();
    } catch { setError("Could not remove this person."); }
    finally { setBusy(false); }
  };

  const owner = directory?.me.role === "owner";
  const field = "mt-1 w-full rounded-xl border border-pine/20 bg-white px-4 py-3 outline-none transition focus:border-amber focus:ring-2 focus:ring-amber/30";
  return (
    <main className="min-h-screen bg-parchment/50 pb-16">
      <header className="border-b border-pine/10 bg-cream/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-leaf">Market staff</p>
            <h1 className="font-display text-2xl text-pine-deep">Staff accounts</h1>
          </div>
          <nav className="flex items-center gap-4 text-sm font-semibold text-pine">
            <Link href="/applications" className="hover:underline">Applications</Link>
            <Link href="/roster" className="hover:underline">Roster</Link>
            <Link href="/messages" className="hover:underline">Messages</Link>
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-6 py-8">
        {error && <p role="alert" className="mb-6 rounded-2xl bg-clay/10 p-4 text-sm text-clay">{error}</p>}
        {notice && <p role="status" className="mb-6 break-words rounded-2xl bg-pine/10 p-4 text-sm text-pine">{notice}</p>}
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-pine/10">
          <h2 className="font-semibold text-pine-deep">People who can sign in</h2>
          {!directory ? <p className="mt-3 text-sm text-ink/60">Loading…</p> : (
            <ul className="mt-4 divide-y divide-pine/10">
              {directory.staff.map(user => (
                <li key={user.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <p className="font-semibold text-pine-deep">{user.name || user.email}{user.id === directory.me.userId && <span className="ml-2 text-xs font-normal text-ink/50">(you)</span>}</p>
                    <p className="text-ink/60">{user.email}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="rounded-full bg-parchment px-3 py-1 text-xs font-semibold uppercase tracking-wide text-pine">{user.role}</span>
                    {user.status === "invited" && <span className="rounded-full bg-amber/15 px-3 py-1 text-xs font-semibold text-clay">Invitation pending</span>}
                    {owner && user.role !== "owner" && user.id !== directory.me.userId && (
                      <button type="button" onClick={() => void remove(user)} disabled={busy} className="text-xs font-semibold text-clay underline underline-offset-4 disabled:opacity-50">Remove</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        {owner && (
          <form onSubmit={invite} className="mt-6 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-pine/10">
            <h2 className="font-semibold text-pine-deep">Invite a market manager</h2>
            <p className="mt-1 text-sm text-ink/60">They get an email with a link to choose their own password. The link works for 7 days.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-ink/50">Name
                <input required value={name} onChange={e => setName(e.target.value)} className={field} />
              </label>
              <label className="block text-xs font-semibold uppercase tracking-wide text-ink/50">Email
                <input type="email" required value={email} onChange={e => setEmail(e.target.value)} className={field} />
              </label>
            </div>
            <button type="submit" disabled={busy || !name || !email} className="mt-5 rounded-full bg-pine px-6 py-3 text-sm font-semibold text-cream transition enabled:hover:bg-leaf disabled:opacity-40">{busy ? "Sending…" : "Send invitation"}</button>
          </form>
        )}
        {directory && !owner && <p className="mt-6 text-sm text-ink/60">Only the market owner can invite or remove staff.</p>}
      </div>
    </main>
  );
}
