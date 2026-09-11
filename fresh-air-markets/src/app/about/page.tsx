import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = { title: "Our Story — Fresh Air Markets & Events" };

const VALUES = [
  "Supporting local artisans and small businesses",
  "Family-friendly outdoor shopping experiences",
  "Curated vendor selections for quality and variety",
  "Fostering community connections in Southwest Florida",
];

export default function AboutPage() {
  return (
    <div className="bg-cream text-ink">
      <SiteHeader />
      <main>
        <section className="relative isolate overflow-hidden">
          <Image src="/site/produce.png" alt="" fill priority className="object-cover" sizes="100vw" />
          <div className="absolute inset-0 bg-navy/75" />
          <div className="relative mx-auto max-w-4xl px-5 py-20 text-center text-white">
            <h1 className="font-display text-4xl sm:text-6xl">Our Story</h1>
            <p className="mt-5 text-lg text-white/85">Building stronger communities through vibrant outdoor markets and local connections.</p>
          </div>
        </section>
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-16 lg:grid-cols-2">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-sky">Community</p>
            <h2 className="mt-2 font-display text-3xl text-navy sm:text-4xl">First &amp; Foremost</h2>
            <p className="mt-4 text-ink/75">Fresh Air Markets and Events was founded on a simple idea: local communities thrive when people have a place to gather, connect, and support one another. We are dedicated to bringing people together through curated outdoor shopping experiences.</p>
            <p className="mt-4 text-ink/75">We organize local markets, vendor events, and community gatherings that celebrate local makers, artisans, and small businesses. By providing a platform for these talented individuals, we help stimulate the local economy while creating memorable experiences for families and friends.</p>
            <ul className="mt-6 space-y-2">{VALUES.map(v => <li key={v} className="rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-navy/10">✅ <span className="ml-1">{v}</span></li>)}</ul>
          </div>
          <Image src="/site/market.png" alt="Outdoor community market" width={1408} height={768} className="rounded-3xl shadow-xl" sizes="(min-width: 1024px) 50vw, 100vw" />
        </section>
        <section className="bg-navy py-16 text-white">
          <div className="mx-auto max-w-3xl px-5 text-center">
            <h2 className="font-display text-3xl">Our Mission</h2>
            <p className="mt-5 text-xl italic text-white/85">&ldquo;To create vibrant, welcoming spaces where local businesses can flourish and neighbors can connect, fostering a stronger, more united community in Southwest Florida.&rdquo;</p>
            <Link href="/apply" className="mt-8 inline-block rounded-full bg-sky px-8 py-3 font-semibold text-white hover:bg-white hover:text-navy">Join us as a vendor</Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
