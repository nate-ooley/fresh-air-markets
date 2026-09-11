import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { InfoPills, MARKET, SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = { title: "Become a Vendor — Fresh Air Markets & Events" };

const WHY = [
  "Direct access to the North Port community every Saturday",
  "High foot traffic in a prime location at US 41 & Sumter",
  "Food trucks and live entertainment draw crowds weekly",
  "Featured social media promotion for our vendors",
  "Supportive network of fellow local makers and entrepreneurs",
  "Affordable booth fees with seasonal discounts available",
];
const REQUIREMENTS = [
  { title: "What to Bring", items: [
    "Your own 10x10 tent or canopy (weights recommended)",
    "Tables and chairs for your booth setup",
    "All necessary permits and licenses for your product type",
    "Your printed Vendor Pass for each market day (emailed after approval & payment)",
    "A positive, community-focused attitude!",
  ] },
  { title: "Schedule & Setup", items: [
    `Market runs every Saturday, ${MARKET.hours}`,
    "Vendor setup begins at 6:30 AM",
    "All booths must be fully set up by 8:00 AM",
    "Breakdown begins at 1:00 PM, no early departures",
  ] },
  { title: "Fees & Payment", items: [
    "$40 per booth per week — standard rate",
    "$35 per booth per week — when booking 4+ consecutive weeks",
    "$30 per booth per week — full season (Oct/Nov through Saturday, May 29)",
    "Need more room? Request up to 4 side-by-side booths on your application",
    "Non-profit exhibitor booths are free of charge",
    "After your application is approved, your vendor agreement is signed, required documents are approved, and your dates and booths are reserved, payment is due within 48 hours of the payment request",
  ] },
];
const STEPS = [
  { title: "Fill Out the Application", body: "Complete the vendor application. Tell us about your business, what you sell, and which dates you'd like to join us. You'll sign the Vendor Agreement as part of the form." },
  { title: "Receive Approval & Provide Documents", body: "We review your application and respond with an approval decision. If approved, send any requested documents, such as proof of insurance, for review." },
  { title: "Confirm Dates & Complete Checkout", body: "After required documents are approved, your final market dates and booth quantity are confirmed. Once your dates and booths are reserved and you receive your payment request, complete checkout within 48 hours." },
  { title: "Get Your Confirmation", body: "Once payment is processed, you'll receive a confirmation with your booth assignment and market map, a copy of your signed vendor agreement, and your Vendor Pass for each registered weekend." },
  { title: "Market Day Reminders", body: "A few days before each market you're registered for, you'll receive a reminder with setup instructions, vendor rules and guidelines, and any other important info to help your day go smoothly." },
];
const FAQ = [
  { q: "How do I become a vendor at the North Port Farmer's Market?", a: "Submit the online application. We review it, reply with a decision, collect any required documents, confirm your dates, and send a payment request. Once paid, you're on the schedule." },
  { q: "What types of vendors do you accept?", a: "Local makers, artisans, farmers and growers, bakers, prepared-food vendors, food trucks, and small businesses. Every application is reviewed to keep the market varied and high quality." },
  { q: "How much does it cost to participate?", a: "$40 per booth per Saturday, $35 when you book four or more consecutive weeks, and $30 for the full season. You can request up to four booths per market day for more space. Non-profit exhibitor booths are free." },
  { q: "I run a non-profit. Can we participate?", a: "Yes. Every Saturday we feature one non-profit at no cost. Apply as a Non-Profit Organization and tell us about your mission; one non-profit is scheduled per market day." },
  { q: "Do I need a license or permit to sell at the market?", a: "You are responsible for any permits and licenses your products require. Food vendors will be asked for their food license or permit during review, and all vendors provide proof of insurance." },
  { q: "Can I bring a generator to power my booth?", a: "Quiet generators may be allowed depending on your booth location and neighbors. Mention it in your application so we can place you appropriately." },
  { q: "What happens if it rains?", a: "The market is outdoors and runs rain or shine unless conditions are unsafe. If we must cancel a market day, registered vendors are notified as early as possible." },
  { q: "Can I reserve a spot for the whole season?", a: "Yes. Choose the full season on your application for the $30 per week rate. Final dates and booth count are confirmed with you after approval." },
  { q: "What is a Vendor Pass and how do I get one?", a: "Once your application is approved and your booth fee is paid, you'll be emailed a Vendor Pass for each market weekend. You must print your pass and present it on the day of the market to be admitted to your booth — so don't forget to bring it with you!" },
];

export default function VendorsPage() {
  return (
    <div className="bg-cream text-ink">
      <SiteHeader />
      <main>
        <section className="relative isolate overflow-hidden">
          <Image src="/site/vendors.png" alt="" fill priority className="object-cover" sizes="100vw" />
          <div className="absolute inset-0 bg-navy/75" />
          <div className="relative mx-auto max-w-4xl px-5 py-20 text-center text-white">
            <h1 className="font-display text-4xl sm:text-6xl">Become a Vendor</h1>
            <p className="mt-5 text-lg text-white/85">Join the {MARKET.market} — a vibrant weekly gathering of local makers, artisans, food trucks, and community organizations.</p>
            <div className="mt-8 flex justify-center"><InfoPills /></div>
            <Link href="/apply" className="mt-8 inline-block rounded-full bg-sky px-8 py-3 font-semibold text-white shadow-lg hover:bg-white hover:text-navy">Apply Now</Link>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="font-display text-3xl text-navy sm:text-4xl">Why Vendor With Us?</h2>
          <p className="mt-3 text-ink/70">Fresh Air Markets is committed to creating a thriving space where local businesses grow.</p>
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {WHY.map(item => <li key={item} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-navy/10">✅ <span className="ml-1">{item}</span></li>)}
          </ul>
        </section>

        <section className="bg-navy/5 py-16">
          <div className="mx-auto max-w-6xl px-5">
            <h2 className="font-display text-3xl text-navy sm:text-4xl">Vendor Requirements</h2>
            <p className="mt-3 text-ink/70">Everything you need to know to get set up and succeed at the market.</p>
            <div className="mt-8 grid gap-6 lg:grid-cols-3">
              {REQUIREMENTS.map(group => (
                <div key={group.title} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-navy/10">
                  <h3 className="font-semibold text-navy">{group.title}</h3>
                  <ul className="mt-3 space-y-2 text-sm text-ink/75">{group.items.map(item => <li key={item}>• {item}</li>)}</ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-5 py-16">
          <h2 className="font-display text-3xl text-navy sm:text-4xl">How to Apply</h2>
          <p className="mt-3 text-ink/70">Our simple, step-by-step process gets you from application to market day with everything you need.</p>
          <ol className="mt-8 space-y-5">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-5 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-navy/10">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky font-display text-lg text-white">{index + 1}</span>
                <div><p className="font-semibold text-navy">{step.title}</p><p className="mt-1 text-sm text-ink/70">{step.body}</p></div>
              </li>
            ))}
          </ol>
          <Link href="/apply" className="mt-8 inline-block rounded-full bg-navy px-8 py-3 font-semibold text-white hover:bg-sky">Start Your Application</Link>
        </section>

        <section id="nonprofits" className="bg-sky/10 py-16">
          <div className="mx-auto max-w-4xl px-5 text-center">
            <h2 className="font-display text-3xl text-navy sm:text-4xl">Featured Non-Profit Each Week</h2>
            <p className="mt-4 text-ink/70">Every Saturday we spotlight a different local non-profit organization — at no cost. It&rsquo;s our way of giving back and helping great causes connect with the community. If you represent a non-profit, we&rsquo;d love to feature you.</p>
            <Link href="/apply" className="mt-6 inline-block rounded-full bg-navy px-8 py-3 font-semibold text-white hover:bg-sky">Register as a Non-Profit</Link>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-5 py-16">
          <h2 className="font-display text-3xl text-navy sm:text-4xl">Frequently Asked Questions</h2>
          <p className="mt-3 text-ink/70">Got questions? We&rsquo;ve got answers. Don&rsquo;t see yours? Just reach out!</p>
          <div className="mt-8 space-y-3">
            {FAQ.map(item => (
              <details key={item.q} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-navy/10">
                <summary className="cursor-pointer font-semibold text-navy">{item.q}</summary>
                <p className="mt-3 text-sm text-ink/75">{item.a}</p>
              </details>
            ))}
          </div>
          <p className="mt-8 text-center text-ink/70">Still have questions? <Link href="/#contact" className="font-semibold text-sky underline">Get in Touch</Link></p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
