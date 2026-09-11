"use client";

import { useState } from "react";
import Link from "next/link";
import { LogoMark } from "@/components/Logo";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setMessage(data.message ?? "If that email belongs to a market staff account, a reset link is on its way.");
      else setError(data.error ?? "We could not start a password reset. Please try again.");
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally { setBusy(false); }
  };

  const field = "mt-1 w-full rounded-xl border border-pine/20 bg-white px-4 py-3 outline-none transition focus:border-amber focus:ring-2 focus:ring-amber/30";

  return (
    <main className="flex min-h-screen items-center justify-center bg-pine-deep px-6 py-16">
      <div className="animate-rise w-full max-w-sm">
        <Link href="/" className="mb-6 flex items-center justify-center gap-2 text-cream/80 hover:text-cream">
          <LogoMark size={26} />
          <span className="font-display text-lg">Fresh Air</span>
        </Link>
        <form onSubmit={submit} className="rounded-3xl bg-cream p-8 shadow-2xl">
          <h1 className="font-display text-3xl text-pine-deep">Reset your password</h1>
          <p className="mt-1 text-sm text-ink/60">Enter the email you sign in with. We’ll send a link that works for 30 minutes.</p>
          <label className="mt-6 block text-xs font-semibold uppercase tracking-wide text-ink/50">
            Email
            <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
          </label>
          {message && <p role="status" className="mt-4 rounded-xl bg-pine/10 p-3 text-sm text-pine">{message}</p>}
          {error && <p role="alert" className="mt-3 text-sm font-medium text-clay">{error}</p>}
          <button type="submit" disabled={busy || !email} className="mt-5 w-full rounded-xl bg-pine py-3 font-semibold text-cream transition enabled:hover:bg-leaf disabled:opacity-40">
            {busy ? "Sending…" : "Email me a reset link"}
          </button>
          <p className="mt-6 text-center text-sm text-ink/60">
            <Link href="/login" className="font-semibold text-clay hover:underline">Back to sign in</Link>
          </p>
        </form>
      </div>
    </main>
  );
}
