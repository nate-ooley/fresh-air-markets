import Image from "next/image";
import Link from "next/link";
import { ContactForm, SubscribeForm } from "@/components/ContactForm";
import { InfoPills, MARKET, SiteFooter, SiteHeader } from "@/components/SiteChrome";

const PERKS = [
  { title: "High Visibility", body: "Connect directly with the North Port community in a vibrant, engaging setting." },
  { title: "Community Focus", body: "Join a supportive network of fellow local entrepreneurs, makers, and charities." },
  { title: "Featured Non-Profits", body: "Every week we highlight a different non-profit to share their mission with the community." },
];

export default function HomePage() {
  return (
    <div className="bg-cream text-ink">
      <SiteHeader />
      <main>
        <section className="relative isolate overflow-hidden">
          <Image src="/site/market.png" alt="Outdoor community market" fill priority className="object-cover" sizes="100vw" />
          <div className="absolute inset-0 bg-navy/70" />
          <div className="relative mx-auto flex max-w-4xl flex-col items-center px-5 py-20 text-center text-white sm:py-28">
            <Image src="/site/logo.png" alt="Fresh Air Markets & Events" width={160} height={160} className="rounded-2xl bg-white p-2 shadow-xl" priority />
            <h1 className="mt-8 font-display text-4xl leading-tight sm:text-6xl">{MARKET.market} Opens {MARKET.opening}</h1>
            <p className="mt-5 max-w-2xl text-lg text-white/85">Join us every Saturday from 9am to 1pm at the corner of US 41 &amp; Sumter in North Port for vibrant outdoor shopping, local vendors, food trucks, and live entertainment.</p>
            <div className="mt-8"><InfoPills /></div>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link href="/apply" className="rounded-full bg-sky px-6 py-3 font-semibold text-white shadow-lg hover:bg-white hover:text-navy">Register to Be a Vendor →</Link>
              <a href="#contact" className="rounded-full bg-white/15 px-6 py-3 font-semibold text-white ring-1 ring-white/40 hover:bg-white/25">Contact Us</a>
            </div>
            <div className="mt-4 flex gap-4 text-sm text-white/80">
              <a href={`tel:${MARKET.phoneHref}`} className="underline">Call Now</a>
              <a href={`sms:${MARKET.phoneHref}`} className="underline">Text Us</a>
            </div>
          </div>
        </section>

        <section id="vendors" className="mx-auto max-w-6xl px-5 py-16 sm:py-24">
          <div className="grid items-center gap-10 lg:grid-cols-2">
            <div>
              <h2 className="font-display text-3xl text-navy sm:text-4xl">Register to Be a Vendor or Non-Profit</h2>
              <p className="mt-4 text-lg text-ink/70">Are you a local maker, artisan, food truck, or small business owner? Join our weekly {MARKET.market} — opening {MARKET.opening}, every Saturday from 9am to 1pm at the corner of US 41 &amp; Sumter. Enjoy food trucks on site, live entertainment, and a featured non-profit each week!</p>
              <div className="mt-6"><InfoPills /></div>
              <div className="mt-8 grid gap-4 sm:grid-cols-3">
                {PERKS.map(perk => (
                  <div key={perk.title} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-navy/10">
                    <p className="font-semibold text-navy">{perk.title}</p>
                    <p className="mt-2 text-sm text-ink/65">{perk.body}</p>
                  </div>
                ))}
              </div>
              <Link href="/apply" className="mt-8 inline-block rounded-full bg-navy px-6 py-3 font-semibold text-white hover:bg-sky">Apply Now</Link>
            </div>
            <Image src="/site/vendors.png" alt="Farmer's market vendors" width={1408} height={768} className="rounded-3xl shadow-xl" sizes="(min-width: 1024px) 50vw, 100vw" />
          </div>
        </section>

        <section className="bg-navy/5 py-14">
          <div className="mx-auto max-w-3xl px-5 text-center">
            <h2 className="font-display text-3xl text-navy">Stay in the Loop</h2>
            <p className="mt-3 text-ink/70">Sign up to get the latest updates, vendor announcements, and market schedules delivered straight to your inbox.</p>
            <div className="mt-6"><SubscribeForm /></div>
          </div>
        </section>

        <section id="contact" className="mx-auto max-w-6xl px-5 py-16 sm:py-24">
          <div className="grid gap-10 lg:grid-cols-5">
            <div className="lg:col-span-2">
              <h2 className="font-display text-3xl text-navy sm:text-4xl">Get in Touch</h2>
              <p className="mt-4 text-ink/70">Whether you&rsquo;re interested in becoming a vendor, registering as a non-profit, or just want to say hello, we&rsquo;d love to hear from you!</p>
              <div className="mt-8 space-y-6">
                <div><p className="font-semibold text-navy">Call or Text Us</p><p className="mt-1 text-lg">{MARKET.phone}</p>
                  <p className="text-sm"><a href={`tel:${MARKET.phoneHref}`} className="underline">Call</a> • <a href={`sms:${MARKET.phoneHref}`} className="underline">Text</a></p></div>
                <div><p className="font-semibold text-navy">Email Us</p><p className="mt-1 text-sm text-ink/70">Use the form and we&rsquo;ll reply by email.</p></div>
              </div>
              <Image src="/site/produce.png" alt="Fresh produce" width={1408} height={768} className="mt-8 hidden rounded-3xl shadow-lg lg:block" sizes="40vw" />
            </div>
            <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-navy/10 sm:p-8 lg:col-span-3">
              <h3 className="font-display text-2xl text-navy">Apply to Be a Vendor or Just Say Hello</h3>
              <p className="mt-2 text-sm text-ink/65">Ready to join us as a vendor? <Link href="/apply" className="font-semibold text-sky underline">Start your application</Link>. Have a question? Fill out the form below and we&rsquo;ll get back to you soon.</p>
              <div className="mt-6"><ContactForm /></div>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
