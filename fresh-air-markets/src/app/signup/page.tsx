"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { PLANS, isPlan } from "@/lib/plans";
import { Plan } from "@/lib/types";
import { LogoMark } from "@/components/Logo";

function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const initialPlan = params.get("plan");
  const [plan, setPlan] = useState<Plan>(isPlan(initialPlan ?? "") ? (initialPlan as Plan) : "pro");
  const [form, setForm] = useState({ ownerName: "", email: "", password: "", marketName: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, plan }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      router.push("/dashboard");
      router.refresh();
    } else {
      setError(data.error ?? "Sign up failed.");
      setBusy(false);
    }
  };

  const field =
    "mt-1 w-full rounded-xl border border-pine/20 bg-white px-4 py-3 outline-none transition focus:border-amber focus:ring-2 focus:ring-amber/30";

  return (
    <main className="min-h-screen bg-pine-deep px-6 py-16">
      <div className="animate-rise mx-auto max-w-md">
        <Link href="/" className="mb-6 flex items-center justify-center gap-2 text-cream/80 hover:text-cream">
          <LogoMark size={26} />
          <span className="font-display text-lg">Fresh Air</span>
        </Link>
        <form onSubmit={submit} className="rounded-3xl bg-cream p-8 shadow-2xl">
          <h1 className="font-display text-3xl text-pine-deep">Start your free trial</h1>
          <p className="mt-1 text-sm text-ink/60">
            14 days, full access, no card required. Your market map is ready the moment you sign up.
          </p>

          <div className="mt-5 grid grid-cols-3 gap-2">
            {PLANS.map((p) => (
              <button
                type="button"
                key={p.id}
                onClick={() => setPlan(p.id)}
                className={`rounded-xl border-2 px-2 py-3 text-center transition ${
                  plan === p.id ? "border-amber bg-amber/10" : "border-pine/15 hover:border-pine/30"
                }`}
              >
                <p className="text-xs font-bold text-pine-deep">{p.name}</p>
                <p className="text-[11px] text-ink/50">{p.price}{p.cadence}</p>
              </button>
            ))}
          </div>

          <label className="mt-5 block text-xs font-semibold uppercase tracking-wide text-ink/50">
            Your name
            <input required value={form.ownerName} className={field}
              onChange={(e) => setForm({ ...form, ownerName: e.target.value })} />
          </label>
          <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink/50">
            Market name
            <input required placeholder="e.g. Riverside Farmers Market" value={form.marketName} className={field}
              onChange={(e) => setForm({ ...form, marketName: e.target.value })} />
          </label>
          <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink/50">
            Email
            <input required type="email" value={form.email} className={field}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink/50">
            Password
            <input required type="password" minLength={8} value={form.password} className={field}
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <span className="mt-1 block text-[11px] font-normal normal-case text-ink/40">At least 8 characters.</span>
          </label>

          {error && <p className="mt-3 text-sm font-medium text-clay">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="mt-6 w-full rounded-xl bg-amber py-3 font-semibold text-white shadow transition enabled:hover:bg-clay disabled:opacity-40"
          >
            {busy ? "Creating your market…" : "Create my account & license"}
          </button>

          <p className="mt-6 text-center text-sm text-ink/60">
            Already have an account?{" "}
            <Link href="/login" className="font-semibold text-clay hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </main>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
