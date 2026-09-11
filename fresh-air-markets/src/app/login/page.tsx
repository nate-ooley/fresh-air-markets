"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LogoMark } from "@/components/Logo";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      router.push("/dashboard");
      router.refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Sign in failed.");
      setBusy(false);
    }
  };

  const field =
    "mt-1 w-full rounded-xl border border-pine/20 bg-white px-4 py-3 outline-none transition focus:border-amber focus:ring-2 focus:ring-amber/30";

  return (
    <main className="flex min-h-screen items-center justify-center bg-pine-deep px-6 py-16">
      <div className="animate-rise w-full max-w-sm">
        <Link href="/" className="mb-6 flex items-center justify-center gap-2 text-cream/80 hover:text-cream">
          <LogoMark size={26} />
          <span className="font-display text-lg">Fresh Air</span>
        </Link>
        <form onSubmit={submit} className="rounded-3xl bg-cream p-8 shadow-2xl">
          <h1 className="font-display text-3xl text-pine-deep">Market staff sign in</h1>
          <p className="mt-1 text-sm text-ink/60">Manage your booths, approvals, and vendors.</p>

          <label className="mt-6 block text-xs font-semibold uppercase tracking-wide text-ink/50">
            Email
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={field}
            />
          </label>
          <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink/50">
            Password
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={field}
            />
          </label>

          {error && <p className="mt-3 text-sm font-medium text-clay">{error}</p>}
          <p className="mt-3 text-right text-xs">
            <Link href="/forgot-password" className="font-semibold text-pine hover:underline">Forgot your password?</Link>
          </p>

          <button
            type="submit"
            disabled={busy || !email || !password}
            className="mt-5 w-full rounded-xl bg-pine py-3 font-semibold text-cream transition enabled:hover:bg-leaf disabled:opacity-40"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>

          <p className="mt-6 text-center text-sm text-ink/60">
            Applying as a vendor?{" "}
            <Link href="/apply" className="font-semibold text-clay hover:underline">
              Start your application
            </Link>
          </p>
        </form>
      </div>
    </main>
  );
}
