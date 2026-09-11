import type { Metadata } from "next";
import ApplyForm from "@/components/ApplyForm";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { FRESH_AIR_SEASON_DATES } from "@/lib/fresh-air-season";
import { FULL_SEASON_LABEL, VENDOR_CATEGORIES } from "@/lib/portal-intake";

export const metadata: Metadata = { title: "Vendor Application — Fresh Air Markets & Events" };
export const dynamic = "force-dynamic";

export default function ApplyPage() {
  return (
    <div className="bg-cream text-ink">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
        <h1 className="font-display text-4xl text-navy sm:text-5xl">Vendor &amp; Non-Profit Application</h1>
        <p className="mt-4 text-lg text-ink/70">North Port Farmer&rsquo;s Market, 2026–2027 season. Takes about three minutes. Market staff review every application and reply by email.</p>
        <div className="mt-8">
          <ApplyForm dates={[...FRESH_AIR_SEASON_DATES]} categories={VENDOR_CATEGORIES} fullSeasonLabel={FULL_SEASON_LABEL} />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
