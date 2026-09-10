"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";

type Kind = "insurance" | "food_license";
type ValidationState = "pending_scan" | "ready_for_review" | "rejected";
type ReviewState = "submitted" | "approved" | "changes_requested" | "rejected";
type ReviewAction = "approve" | "request_changes" | "reject";

interface DocumentSummary {
  id: string;
  kind: Kind;
  version: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  submittedAt: string;
  validationState: ValidationState;
  validationReason: string;
  reviewState: ReviewState;
  reviewReason: string;
  isCurrent: boolean;
}

const KIND_LABELS: Record<Kind, string> = { insurance: "Certificate of insurance", food_license: "Food license / permit" };
const REVIEW_LABELS: Record<ReviewState, string> = {
  submitted: "Awaiting review", approved: "Approved", changes_requested: "Changes requested", rejected: "Rejected",
};
const VALIDATION_LABELS: Record<ValidationState, string> = {
  pending_scan: "Awaiting validation", ready_for_review: "Ready for review", rejected: "Failed validation",
};

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function isSummary(value: unknown): value is DocumentSummary {
  const row = value as DocumentSummary;
  return Boolean(row) && typeof row === "object" && typeof row.id === "string" && typeof row.kind === "string"
    && typeof row.version === "number" && typeof row.filename === "string" && typeof row.reviewState === "string";
}

/**
 * Staff-side documents for one application: upload the vendor's certificate of
 * insurance or food license, open it, and record the review decision. Final
 * reservation requires an approved current insurance document.
 */
export default function ApplicationDocumentsPanel({ applicationId }: { applicationId: string }) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<Kind>("insurance");
  const [file, setFile] = useState<File | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const listEndpoint = `/api/admin/applications/${encodeURIComponent(applicationId)}/documents`;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(listEndpoint, { cache: "no-store", signal, headers: { Accept: "application/json" } });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(payload?.documents)) {
      throw new Error(typeof payload?.error === "string" ? payload.error : "Documents could not be loaded.");
    }
    return (payload.documents as unknown[]).filter(isSummary);
  }, [listEndpoint]);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError("");
    refresh(abort.signal)
      .then(rows => { if (!abort.signal.aborted) setDocuments(rows); })
      .catch(err => { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : "Documents could not be loaded."); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [refresh]);

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const form = new FormData();
      form.set("kind", kind);
      form.set("file", file, file.name);
      const response = await fetch(listEndpoint, { method: "POST", body: form, cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "The file was not accepted.");
      setNotice(payload?.duplicate ? "That exact file is already on record." : `Uploaded ${file.name}. Review it below.`);
      setFile(null);
      (event.target as HTMLFormElement).reset();
      setDocuments(await refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "The file was not accepted.");
    } finally { setBusy(false); }
  };

  const review = async (document: DocumentSummary, action: ReviewAction) => {
    if (busy) return;
    const reason = (reasons[document.id] ?? "").trim();
    if (action !== "approve" && !reason) { setError("Add a short note for the vendor before requesting changes or rejecting."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/admin/documents/${encodeURIComponent(document.id)}/review`, {
        method: "PATCH", cache: "no-store",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ expectedVersion: document.version, action, reason }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "The review could not be saved.");
      setNotice(`${KIND_LABELS[document.kind]} v${document.version}: ${REVIEW_LABELS[payload?.document?.reviewState as ReviewState] ?? "saved"}.`);
      setDocuments(await refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "The review could not be saved.");
    } finally { setBusy(false); }
  };

  const field = "rounded-2xl border border-pine/20 bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-amber focus:ring-2 focus:ring-amber/25";
  const button = "rounded-full px-4 py-2 text-sm font-semibold shadow transition disabled:cursor-not-allowed disabled:opacity-45";

  return (
    <section className="mt-6 rounded-2xl border border-pine/10 bg-white p-4 sm:p-6">
      <h3 className="font-semibold text-pine-deep">Vendor documents</h3>
      <p className="mt-1 text-sm text-ink/60">
        Upload the vendor&rsquo;s certificate of insurance and, when required, food license. An approved current insurance
        document is required before a final reservation. PDF, PNG or JPEG up to 10 MB.
      </p>

      <form onSubmit={upload} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">
          Document type
          <select value={kind} onChange={e => setKind(e.target.value as Kind)} className={`mt-1 block ${field}`}>
            <option value="insurance">{KIND_LABELS.insurance}</option>
            <option value="food_license">{KIND_LABELS.food_license}</option>
          </select>
        </label>
        <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">
          File
          <input type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" required
            onChange={e => setFile(e.target.files?.[0] ?? null)} className={`mt-1 block ${field}`} />
        </label>
        <button type="submit" disabled={busy || !file} className={`${button} bg-pine text-cream enabled:hover:bg-leaf`}>
          {busy ? "Working…" : "Upload"}
        </button>
      </form>

      {error && <p role="alert" className="mt-4 rounded-2xl bg-clay/10 p-3 text-sm text-clay">{error}</p>}
      {notice && <p className="mt-4 rounded-2xl bg-leaf/10 p-3 text-sm text-pine-deep">{notice}</p>}

      {loading ? (
        <p className="mt-4 text-sm text-ink/50">Loading documents…</p>
      ) : documents.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">No documents on file yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {documents.map(document => {
            const reviewable = document.isCurrent && document.validationState === "ready_for_review" && document.reviewState === "submitted";
            return (
              <li key={document.id} className={`rounded-2xl border p-4 ${document.isCurrent ? "border-pine/15" : "border-pine/5 opacity-60"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-pine-deep">
                      {KIND_LABELS[document.kind]} <span className="text-ink/40">v{document.version}{document.isCurrent ? "" : " (superseded)"}</span>
                    </p>
                    <p className="text-sm text-ink/60">
                      <a href={`/api/admin/documents/${encodeURIComponent(document.id)}/file`} target="_blank" rel="noopener noreferrer" className="underline decoration-pine/30 hover:text-pine">
                        {document.filename}
                      </a>
                      {" · "}{sizeLabel(document.sizeBytes)}{" · "}{new Date(document.submittedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <p className="text-sm">
                    <span className="rounded-full bg-pine/10 px-3 py-1 text-pine-deep">{REVIEW_LABELS[document.reviewState]}</span>
                    {document.validationState !== "ready_for_review" && (
                      <span className="ml-2 rounded-full bg-amber/20 px-3 py-1 text-ink/70">{VALIDATION_LABELS[document.validationState]}</span>
                    )}
                  </p>
                </div>
                {document.reviewReason && <p className="mt-2 text-sm text-ink/60">Note: {document.reviewReason}</p>}
                {reviewable && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      type="text" maxLength={2000} placeholder="Note for changes or rejection"
                      value={reasons[document.id] ?? ""}
                      onChange={e => setReasons(current => ({ ...current, [document.id]: e.target.value }))}
                      className={`${field} min-w-[16rem] flex-1`}
                    />
                    <button type="button" disabled={busy} onClick={() => review(document, "approve")} className={`${button} bg-pine text-cream enabled:hover:bg-leaf`}>Approve</button>
                    <button type="button" disabled={busy} onClick={() => review(document, "request_changes")} className={`${button} bg-amber/20 text-ink enabled:hover:bg-amber/30`}>Request changes</button>
                    <button type="button" disabled={busy} onClick={() => review(document, "reject")} className={`${button} bg-clay/10 text-clay enabled:hover:bg-clay/20`}>Reject</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
