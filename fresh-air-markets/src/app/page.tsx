import Link from "next/link";
import { LogoMark } from "@/components/Logo";

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-pine-deep px-6 py-16">
      <section className="w-full max-w-xl rounded-3xl bg-cream p-8 shadow-2xl sm:p-12">
        <div className="mb-8 flex items-center gap-3 text-pine-deep">
          <LogoMark size={36} />
          <span className="font-display text-xl">Fresh Air Markets &amp; Events</span>
        </div>
        <h1 className="font-display text-4xl text-pine-deep">Join us at the market</h1>
        <p className="mt-4 text-lg text-ink/70">Apply to become a vendor or participate as a nonprofit at the North Port Farmer&apos;s Market.</p>
        <Link href="/apply" className="mt-8 block rounded-xl bg-amber px-6 py-4 text-center font-semibold text-white">Start your vendor application</Link>
        <p className="mt-6 text-sm text-ink/70">Already applied? Follow the instructions in your application emails. Please do not submit another application.</p>
        <div className="mt-8 flex flex-wrap gap-6 border-t border-pine/15 pt-6 text-sm">
          <a href="https://freshairmarketsandevents.com" className="text-pine-deep underline">Visit the market website</a>
          <Link href="/login" className="text-pine-deep underline">Market staff sign in</Link>
        </div>
      </section>
    </main>
  );
}
