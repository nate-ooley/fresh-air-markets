import type { Metadata } from "next";
import VendorBookingPage from "@/components/VendorBookingPage";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = { title: "Book more dates — Fresh Air Markets & Events", robots: { index: false, follow: false } };

/** Opened from the "book more dates" link in vendor emails; the link's token identifies the vendor. */
export default function VendorBookPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
        <h1 className="font-display text-4xl text-navy sm:text-5xl">Book more dates</h1>
        <p className="mt-3 text-ink/70">Pick the Saturdays you want. Market staff confirm them and email you a payment link; your insurance and agreement stay on file.</p>
        <VendorBookingPage />
      </main>
      <SiteFooter />
    </>
  );
}
