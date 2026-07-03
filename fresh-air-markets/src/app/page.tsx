import Link from "next/link";
import LandingDemoMap from "@/components/LandingDemoMap";
import { LogoMark } from "@/components/Logo";
import { PLANS } from "@/lib/plans";

const FEATURES = [
  {
    icon: "🗺️",
    title: "A visual map, not a spreadsheet",
    body: "Lay out your market exactly as it sits on the ground — rows, a U, an island of booths. Vendors click a spot and see it, instead of guessing from a list.",
  },
  {
    icon: "✅",
    title: "One vendor, one booth. Always.",
    body: "Every approval is checked against every other booking for that booth and date, atomically. Double-booking a spot is structurally impossible, not just a policy.",
  },
  {
    icon: "🖱️",
    title: "Drag-and-drop map editor",
    body: "Rearrange booths, rename zones, and reprice a spot in seconds. Your map updates live for every vendor browsing it.",
  },
  {
    icon: "💵",
    title: "Variable pricing, any cadence",
    body: "Corner booths, entrance rows, center islands — price each one differently. Vendors book a single day, a weekend, or a whole season.",
  },
  {
    icon: "📋",
    title: "A real verification board",
    body: "Inquiries land in one queue. Approve, decline, and see exactly who's holding which booth on which day — no email threads required.",
  },
  {
    icon: "🔗",
    title: "GoHighLevel built in",
    body: "Every inquiry, approval, and decline tags the vendor's contact in GHL automatically — plug it straight into your existing email and SMS workflows.",
  },
];

const STEPS = [
  {
    n: "1",
    title: "Sign up & get your map",
    body: "Create your account and Fresh Air generates a market map instantly — a ready-made layout you can drag into your exact footprint.",
  },
  {
    n: "2",
    title: "Share your booking link",
    body: "Every account gets a public page at freshairmarkets.app/m/your-market. Post it, email it, or link it from your own site — vendors book straight off the map.",
  },
  {
    n: "3",
    title: "Approve & grow",
    body: "Inquiries land on your verification board. Approve the ones you want, and your roster, occupancy, and revenue update in real time.",
  },
];

const FAQ = [
  {
    q: "Do I need a credit card to try it?",
    a: "No. Every plan starts with a 14-day free trial — full access, no card required. You'll get a license key the moment you sign up.",
  },
  {
    q: "Can vendors pay through Fresh Air?",
    a: "Fresh Air handles the inquiry-and-approval workflow; you collect payment however you already do (invoice, Venmo, Square) once a vendor is approved. This keeps things simple and keeps you in control of your own money.",
  },
  {
    q: "What happens after the trial?",
    a: "Pick a plan and your license stays active with no interruption to your market map or vendor data. If you don't upgrade, your dashboard moves to a read-only state until you do.",
  },
  {
    q: "Does every market get its own map?",
    a: "Yes — each account is its own private market with its own booths, bookings, and public booking page. Nothing is shared between markets.",
  },
  {
    q: "How does the GoHighLevel integration work?",
    a: "Add your GHL Private Integration token in settings and every inquiry, approval, and decline upserts the vendor as a tagged contact — ready for your existing automations.",
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen">
      {/* ── Nav ──────────────────────────────────────────── */}
      <nav className="sticky top-0 z-30 border-b border-pine/10 bg-cream/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <LogoMark size={30} />
            <span className="font-display text-xl text-pine-deep">Fresh Air</span>
          </Link>
          <div className="hidden items-center gap-8 text-sm font-semibold text-ink/70 md:flex">
            <a href="#features" className="hover:text-pine-deep">Features</a>
            <a href="#pricing" className="hover:text-pine-deep">Pricing</a>
            <a href="#faq" className="hover:text-pine-deep">FAQ</a>
            <a href={`/m/sunrise-market`} target="_blank" rel="noreferrer" className="hover:text-pine-deep">
              Live demo ↗
            </a>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/login" className="rounded-full px-4 py-2 text-sm font-semibold text-pine hover:bg-pine/10">
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-full bg-amber px-5 py-2 text-sm font-semibold text-white shadow transition hover:-translate-y-0.5 hover:bg-clay"
            >
              Start free trial
            </Link>
          </div>
        </div>
      </nav>

      {/* ── Hero ─────────────────────────────────────────── */}
      <header className="relative overflow-hidden bg-pine-deep text-cream">
        <div
          className="absolute inset-0 opacity-20"
          style={{
            background:
              "radial-gradient(60rem 30rem at 15% -10%, #f2b04c 0%, transparent 55%), radial-gradient(50rem 26rem at 95% 10%, #3a7d54 0%, transparent 60%)",
          }}
        />
        <div className="relative mx-auto grid max-w-7xl gap-12 px-6 py-16 md:py-24 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <div>
            <p className="animate-rise mb-4 inline-block rounded-full bg-white/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.25em] text-amber-soft">
              Booth rental software for farmers markets
            </p>
            <h1 className="animate-rise font-display text-5xl leading-[1.05] md:text-6xl" style={{ animationDelay: "80ms" }}>
              Run your market from a map, not a mess of spreadsheets.
            </h1>
            <p className="animate-rise mt-6 max-w-lg text-lg text-cream/80" style={{ animationDelay: "160ms" }}>
              Fresh Air gives every market operator a drag-and-drop visual map, a
              vendor inquiry-and-approval workflow, and a public booking page —
              with airtight one-vendor-per-booth enforcement, out of the box.
            </p>
            <div className="animate-rise mt-8 flex flex-wrap items-center gap-4" style={{ animationDelay: "240ms" }}>
              <Link
                href="/signup"
                className="rounded-full bg-amber px-7 py-3.5 font-semibold text-white shadow-lg transition hover:-translate-y-0.5 hover:bg-clay"
              >
                Start your 14-day free trial
              </Link>
              <a
                href={`/m/sunrise-market`}
                target="_blank"
                rel="noreferrer"
                className="rounded-full border border-cream/30 px-7 py-3.5 font-semibold text-cream transition hover:bg-white/10"
              >
                See a live market ↗
              </a>
            </div>
            <p className="animate-rise mt-5 text-sm text-cream/50" style={{ animationDelay: "280ms" }}>
              No credit card required · License key issued instantly
            </p>
          </div>
          <div className="animate-rise" style={{ animationDelay: "200ms" }}>
            <LandingDemoMap />
          </div>
        </div>
      </header>

      {/* ── Features ─────────────────────────────────────── */}
      <section id="features" className="mx-auto max-w-7xl px-6 py-20 md:py-28">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-clay">Everything you need</p>
          <h2 className="mt-3 font-display text-4xl text-pine-deep md:text-5xl">
            Built for the way markets actually run.
          </h2>
        </div>
        <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-pine/10 transition hover:-translate-y-1 hover:shadow-md"
            >
              <div className="text-3xl">{f.icon}</div>
              <h3 className="mt-4 font-display text-xl text-pine-deep">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink/70">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────── */}
      <section className="bg-parchment/70">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="font-display text-4xl text-pine-deep md:text-5xl">Live in one afternoon</h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-2xl bg-cream p-6 shadow-sm ring-1 ring-pine/10">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber font-display text-xl text-white">
                  {s.n}
                </div>
                <h3 className="mt-4 font-display text-xl text-pine-deep">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink/70">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────── */}
      <section id="pricing" className="mx-auto max-w-7xl px-6 py-20 md:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-clay">Pricing</p>
          <h2 className="mt-3 font-display text-4xl text-pine-deep md:text-5xl">One license per market.</h2>
          <p className="mt-4 text-ink/60">
            Every plan includes a full 14-day trial — pick the one that fits, upgrade any time.
          </p>
        </div>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {PLANS.map((p) => (
            <div
              key={p.id}
              className={`relative rounded-3xl p-8 shadow-sm ring-1 transition hover:-translate-y-1 ${
                p.highlight
                  ? "bg-pine-deep text-cream ring-pine-deep"
                  : "bg-white text-ink ring-pine/10"
              }`}
            >
              {p.highlight && (
                <span className="absolute -top-3 left-8 rounded-full bg-amber px-3 py-1 text-xs font-bold text-white">
                  MOST POPULAR
                </span>
              )}
              <h3 className={`font-display text-2xl ${p.highlight ? "text-cream" : "text-pine-deep"}`}>{p.name}</h3>
              <p className={`mt-1 text-sm ${p.highlight ? "text-cream/60" : "text-ink/50"}`}>{p.tagline}</p>
              <p className="mt-6">
                <span className="font-display text-4xl">{p.price}</span>
                <span className={p.highlight ? "text-cream/60" : "text-ink/50"}>{p.cadence}</span>
              </p>
              <ul className="mt-6 space-y-2.5 text-sm">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className={p.highlight ? "text-amber-soft" : "text-leaf"}>✓</span>
                    <span className={p.highlight ? "text-cream/85" : "text-ink/70"}>{f}</span>
                  </li>
                ))}
              </ul>
              <Link
                href={`/signup?plan=${p.id}`}
                className={`mt-8 block rounded-full px-5 py-3 text-center text-sm font-semibold shadow transition hover:-translate-y-0.5 ${
                  p.highlight ? "bg-amber text-white hover:bg-clay" : "bg-pine text-cream hover:bg-leaf"
                }`}
              >
                Start free trial
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────── */}
      <section id="faq" className="bg-parchment/70">
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2 className="font-display text-4xl text-pine-deep md:text-5xl">Questions, answered</h2>
          <div className="mt-8 space-y-3">
            {FAQ.map((item) => (
              <details key={item.q} className="group rounded-2xl bg-cream p-5 shadow-sm ring-1 ring-pine/10">
                <summary className="flex cursor-pointer list-none items-center justify-between font-semibold text-pine-deep">
                  {item.q}
                  <span className="ml-4 text-clay transition group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-ink/70">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────── */}
      <section className="bg-pine-deep">
        <div className="mx-auto max-w-4xl px-6 py-20 text-center text-cream">
          <h2 className="font-display text-4xl md:text-5xl">Give your market a map.</h2>
          <p className="mt-4 text-lg text-cream/70">
            Free for 14 days. Your license key and market map are ready the moment you sign up.
          </p>
          <Link
            href="/signup"
            className="mt-8 inline-block rounded-full bg-amber px-8 py-4 font-semibold text-white shadow-lg transition hover:-translate-y-0.5 hover:bg-clay"
          >
            Start your free trial
          </Link>
        </div>
      </section>

      <footer className="bg-pine-deep py-10 text-center text-sm text-cream/50">
        <p className="flex items-center justify-center gap-2">
          <LogoMark size={18} />
          Fresh Air Markets &amp; Events — booth rental software for farmers markets
        </p>
        <p className="mt-2">
          <Link href="/login" className="underline-offset-2 hover:underline">Market staff sign in</Link>
          <span className="mx-3 opacity-40">|</span>
          <a href={`/m/sunrise-market`} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
            Live demo market
          </a>
        </p>
      </footer>
    </main>
  );
}
