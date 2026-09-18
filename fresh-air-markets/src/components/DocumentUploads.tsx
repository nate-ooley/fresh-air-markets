"use client";

import { useState } from "react";
import { prepareUpload, uploadFailureMessage } from "@/lib/upload-prepare";

const FIELD = "mt-1 w-full rounded-xl border border-navy/15 bg-white px-4 py-3 text-ink outline-none transition focus:border-sky focus:ring-2 focus:ring-sky/25";
const LABEL = "block text-xs font-semibold uppercase tracking-wide text-navy/60";

type UploadState = { status: "idle" | "busy" | "done" | "error"; message: string };

/**
 * Vendor document upload against a signed application token. Used right after
 * submitting and from the emailed upload link. Each file goes to the same
 * ledger staff review on the application page.
 */
export default function DocumentUploads({ token, vendor, title, intro }: { token: string; vendor: boolean; title?: string; intro?: string }) {
  const [state, setState] = useState<Record<string, UploadState>>({});
  const kinds = vendor
    ? [{ kind: "insurance", label: "Certificate of insurance", note: "Required before dates can be reserved." },
       { kind: "food_license", label: "Food license or permit", note: "Only if you sell food or drinks." }]
    : [{ kind: "insurance", label: "Certificate of insurance", note: "If your organization carries one." }];
  const upload = async (kind: string, file: File | null) => {
    if (!file) return;
    setState(s => ({ ...s, [kind]: { status: "busy", message: `Preparing ${file.name}…` } }));
    try {
      const prepared = await prepareUpload(file);
      setState(s => ({ ...s, [kind]: { status: "busy", message: `Uploading ${prepared.name}…` } }));
      const form = new FormData();
      form.set("token", token); form.set("kind", kind); form.set("file", prepared, prepared.name);
      const response = await fetch("/api/apply/documents", { method: "POST", body: form, cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(uploadFailureMessage(response.status, payload?.error));
      setState(s => ({ ...s, [kind]: { status: "done", message: payload?.duplicate ? "Already on file." : `Received ${prepared.name}. Staff will review it.` } }));
    } catch (err) {
      setState(s => ({ ...s, [kind]: { status: "error", message: err instanceof Error ? err.message : "The file was not accepted." } }));
    }
  };
  return (
    <div className="mt-6 rounded-2xl border border-navy/10 bg-parchment/40 p-5">
      <h3 className="font-semibold text-navy">{title ?? "Save a step: upload your documents now"}</h3>
      <p className="mt-1 text-sm text-ink/65">{intro ?? "PDF, or a photo from your phone (we shrink large photos automatically). You can also send them later using the link in your emails from us."}</p>
      <div className="mt-4 space-y-4">
        {kinds.map(item => {
          const current = state[item.kind] ?? { status: "idle", message: "" };
          return (
            <div key={item.kind}>
              <label className={LABEL}>{item.label}
                <input type="file" accept=".pdf,.png,.jpg,.jpeg,.heic,.heif,application/pdf,image/*" disabled={current.status === "busy" || current.status === "done"}
                  onChange={e => void upload(item.kind, e.target.files?.[0] ?? null)} className={`mt-1 block ${FIELD}`} />
              </label>
              <p className={`mt-1 text-sm ${current.status === "error" ? "text-clay" : current.status === "done" ? "text-navy" : "text-ink/55"}`}>{current.message || item.note}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
