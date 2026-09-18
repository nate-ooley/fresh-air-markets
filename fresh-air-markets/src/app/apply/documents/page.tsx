import type { Metadata } from "next";
import DocumentUploadPage from "@/components/DocumentUploadPage";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = { title: "Upload your documents — Fresh Air Markets & Events" };

/** Opened from the upload link in vendor emails; the link's token identifies the application. */
export default function ApplyDocumentsPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
        <h1 className="font-display text-4xl text-navy sm:text-5xl">Upload your documents</h1>
        <p className="mt-3 text-ink/70">Attach your certificate of insurance and, if you sell food or drinks, your food license or permit. Files go straight to your application for market staff to review.</p>
        <DocumentUploadPage />
      </main>
      <SiteFooter />
    </>
  );
}
