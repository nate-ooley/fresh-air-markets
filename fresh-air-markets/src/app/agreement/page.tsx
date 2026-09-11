import type { Metadata } from "next";
import { MARKET, SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { VENDOR_AGREEMENT_VERSION } from "@/lib/portal-intake";

export const metadata: Metadata = { title: "Vendor Agreement — Fresh Air Markets & Events" };

/**
 * The agreement vendors sign electronically on the application form. Edit the
 * wording here; bump VENDOR_AGREEMENT_VERSION in portal-intake.ts when terms
 * change so signatures record which version was accepted.
 */
const SECTIONS: { title: string; items: string[] }[] = [
  { title: "1. Market Schedule", items: [
    `The ${MARKET.market} runs every Saturday, ${MARKET.hours}, at ${MARKET.location}, for the 2026–2027 season (October 3, 2026 through May 29, 2027).`,
    "Vendor setup begins at 6:30 AM. All booths must be fully set up by 8:00 AM. Breakdown begins at 1:00 PM; no early departures.",
  ] },
  { title: "2. Booth & Equipment", items: [
    "Vendors supply their own 10x10 tent or canopy with weights, tables, chairs, and signage. Booth assignments are made by market staff.",
    "Vendors keep their booth area clean and remove all trash and materials at the end of each market day.",
  ] },
  { title: "3. Permits, Licenses & Insurance", items: [
    "Vendors are responsible for all permits and licenses their products require, including food licenses or permits for food vendors.",
    "Vendors provide proof of liability insurance for review before dates are reserved and keep it current for every market day attended.",
  ] },
  { title: "4. Fees & Payment", items: [
    "Booth fees are $40 per Saturday, $35 per Saturday for four or more consecutive Saturdays, and $30 per Saturday for the full season. Non-profit exhibitor booths are free of charge.",
    "After the application is approved, required documents are approved, and dates and booths are reserved, payment is due within 48 hours of the payment request. Unpaid reservations are released.",
    "Booth fees are non-refundable. Exceptions are at the sole discretion of market management.",
  ] },
  { title: "5. Conduct & Compliance", items: [
    "Vendors sell only the products described in their approved application and follow all market rules, staff instructions, and applicable laws.",
    "Market management may decline or remove any vendor for conduct that is unsafe, misleading, or contrary to the spirit of the market, without refund.",
  ] },
  { title: "6. Weather & Cancellation", items: [
    "The market operates outdoors, rain or shine, unless conditions are unsafe. If market management cancels a market day, registered vendors are notified as early as possible.",
  ] },
  { title: "7. Liability", items: [
    `Vendors participate at their own risk and agree to hold ${MARKET.name} and its staff harmless from claims arising from the vendor's products, equipment, or conduct.`,
  ] },
  { title: "8. Electronic Signature", items: [
    "By checking the agreement box on the application and typing your full name, you agree that this constitutes your electronic signature and that you have read, understood, and agree to be bound by this Vendor Agreement.",
  ] },
];

export default function AgreementPage() {
  return (
    <div className="bg-cream text-ink">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
        <h1 className="font-display text-4xl text-navy">Vendor Agreement</h1>
        <p className="mt-2 text-sm text-ink/55">{MARKET.name} · {MARKET.market} · Version {VENDOR_AGREEMENT_VERSION}</p>
        <div className="mt-8 space-y-6">
          {SECTIONS.map(section => (
            <section key={section.title} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-navy/10">
              <h2 className="font-semibold text-navy">{section.title}</h2>
              <ul className="mt-3 space-y-2 text-sm text-ink/80">{section.items.map(item => <li key={item}>{item}</li>)}</ul>
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
