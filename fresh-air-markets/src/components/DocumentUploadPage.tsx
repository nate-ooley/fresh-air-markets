"use client";

import { useEffect, useState } from "react";
import DocumentUploads from "@/components/DocumentUploads";

/** Reads the emailed upload link's token from the URL fragment and shows the upload box. */
export default function DocumentUploadPage() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const match = /(?:^#|&)token=([A-Za-z0-9_.-]+)/.exec(window.location.hash);
    setToken(match ? match[1] : null);
    // Keep the personal link out of history and referrers.
    window.history.replaceState(null, "", window.location.pathname);
    setReady(true);
  }, []);
  if (!ready) return <p role="status" className="mt-6 text-sm text-ink/60">Checking your link…</p>;
  if (!token) {
    return (
      <p role="alert" className="mt-6 rounded-2xl bg-clay/10 p-4 text-sm text-clay">
        This upload link is incomplete or has expired. Open the link from your most recent email from us, or email the market and we&rsquo;ll attach your documents for you.
      </p>
    );
  }
  return <DocumentUploads token={token} vendor title="Your documents" intro="PDF, or a photo from your phone (large photos are shrunk automatically). This link works for 14 days and you can come back to add a second file." />;
}
