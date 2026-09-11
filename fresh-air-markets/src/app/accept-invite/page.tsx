"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LogoMark } from "@/components/Logo";

const MIN_LENGTH = 12;

export default function AcceptInvitePage() {
  const token = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const match = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
    token.current = match ? match[1] : null;
    window.history.replaceState(null, "", window.location.pathname);
    if (!token.current) setError("This invitation link is incomplete. Open the link from your email again, or ask the market owner for a new one.");
    setReady(true);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.current) return;
    if (password.length < MIN_LENGTH) { setError(`Use at least ${MIN_LENGTH} characters.`); return; }
    if (password !== confirm) { setError("The two passwords do not match."); return; }
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/auth/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.current, password }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setDone(true); token.current = null; }
      else setError(data.error?.replace("reset link", "invitation link") ?? "We could not set your password. Please try again.");
    } catch { setError("We could not reach the server. Check your connection and try again."); }
    finally { setBusy(false); }
  };

  const field = "mt-1 w-full rounded-xl border border-pine/20 bg-white px-4 py-3 outline-none transition focus:border-amber focus:ring-2 focus:ring-amber/30";
  return (
    <main className="flex min-h-screen items-center justify-center bg-pine-deep px-6 py-16">
      <div className="animate-rise w-full max-w-sm">
        <Link href="/" className="mb-6 flex items-center justify-center gap-2 text-cream/80 hover:text-cream"><LogoMark size={26} /><span className="font-display text-lg">Fresh Air</span></Link>
        <form onSubmit={submit} className="rounded-3xl bg-cream p-8 shadow-2xl">
          <h1 className="font-display text-3xl text-pine-deep">Join the market staff</h1>
          {done ? <>
            <p role="status" className="mt-4 rounded-xl bg-pine/10 p-3 text-sm text-pine">Your account is ready. Sign in with your email and the password you just chose.</p>
            <Link href="/login" className="mt-5 block w-full rounded-xl bg-pine py-3 text-center font-semibold text-cream transition hover:bg-leaf">Go to sign in</Link>
          </> : <>
            <p className="mt-1 text-sm text-ink/60">Choose a password of at least {MIN_LENGTH} characters. This link works once and expires 7 days after it was sent.</p>
            <label className="mt-6 block text-xs font-semibold uppercase tracking-wide text-ink/50">Password
              <input type="password" required autoFocus autoComplete="new-password" minLength={MIN_LENGTH} value={password} onChange={e => setPassword(e.target.value)} className={field} disabled={!ready || !token.current} />
            </label>
            <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink/50">Confirm password
              <input type="password" required autoComplete="new-password" minLength={MIN_LENGTH} value={confirm} onChange={e => setConfirm(e.target.value)} className={field} disabled={!ready || !token.current} />
            </label>
            {error && <p role="alert" className="mt-3 text-sm font-medium text-clay">{error}</p>}
            <button type="submit" disabled={busy || !ready || !token.current || !password || !confirm} className="mt-5 w-full rounded-xl bg-pine py-3 font-semibold text-cream transition enabled:hover:bg-leaf disabled:opacity-40">{busy ? "Saving…" : "Set password and join"}</button>
          </>}
        </form>
      </div>
    </main>
  );
}
