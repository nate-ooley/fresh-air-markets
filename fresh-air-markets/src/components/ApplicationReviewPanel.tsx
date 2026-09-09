"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import FinalReservationPanel from "./FinalReservationPanel";

type ReviewAction = "approve" | "request_changes" | "decline";
type ReviewState = "unreviewed" | "needs_review" | "changes_requested" | "approved" | "declined";

interface ApplicationReviewIdentitySnapshot {
  vendorName: string;
  businessName: string;
  email: string;
  applicantType: string;
  dates: string[];
  fullSeason: boolean;
  requiresFinalDateConfirmation: boolean;
  category: string;
  details: string | null;
}

interface ApplicationReviewDetail {
  id: string;
  sourceEventId: string | null;
  reviewState: ReviewState;
  reviewRevision: number;
  hasOpportunity: boolean;
  identitySnapshot: ApplicationReviewIdentitySnapshot | null;
}

interface SavedReview {
  application: { id: string; reviewState: ReviewState };
  reviewEventId: string;
  duplicate: boolean;
  delivery: "delivered" | "queued";
}

interface ReviewNotice {
  duplicate: boolean;
  delivery: "delivered" | "queued";
  reviewState: ReviewState;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACTIONS: Array<{ value: ReviewAction; title: string; description: string }> = [
  { value: "approve", title: "Approve", description: "Mark this exact application approved." },
  { value: "request_changes", title: "Request changes", description: "Ask the vendor to submit a newer application." },
  { value: "decline", title: "Decline", description: "Mark this exact application declined." },
];

const STATE_LABEL: Record<ReviewState, string> = {
  unreviewed: "Unreviewed",
  needs_review: "Needs review",
  changes_requested: "Changes requested",
  approved: "Approved",
  declined: "Declined",
};

function reviewEndpoint(applicationId: string): string {
  return `/api/admin/applications/${encodeURIComponent(applicationId)}/review`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isReviewState(value: unknown): value is ReviewState {
  return value === "unreviewed" || value === "needs_review" || value === "changes_requested"
    || value === "approved" || value === "declined";
}

function isIdentitySnapshot(value: unknown): value is ApplicationReviewIdentitySnapshot {
  const snapshot = asRecord(value);
  return typeof snapshot?.vendorName === "string" && typeof snapshot.businessName === "string"
    && typeof snapshot.email === "string" && typeof snapshot.applicantType === "string"
    && typeof snapshot.category === "string" && typeof snapshot.fullSeason === "boolean"
    && typeof snapshot.requiresFinalDateConfirmation === "boolean"
    && Array.isArray(snapshot.dates) && snapshot.dates.every(date => typeof date === "string")
    && (typeof snapshot.details === "string" || snapshot.details === null);
}

function isApplicationReviewDetail(value: unknown, applicationId: string): value is ApplicationReviewDetail {
  const detail = asRecord(value);
  return detail?.id === applicationId
    && (typeof detail.sourceEventId === "string" || detail.sourceEventId === null)
    && isReviewState(detail.reviewState)
    && Number.isSafeInteger(detail.reviewRevision)
    && typeof detail.hasOpportunity === "boolean"
    && (detail.identitySnapshot === null || isIdentitySnapshot(detail.identitySnapshot));
}

function isSavedReview(value: unknown, applicationId: string): value is SavedReview {
  const saved = asRecord(value);
  const application = asRecord(saved?.application);
  return application?.id === applicationId
    && isReviewState(application.reviewState)
    && typeof saved?.reviewEventId === "string"
    && typeof saved?.duplicate === "boolean"
    && (saved?.delivery === "delivered" || saved?.delivery === "queued");
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function messageFrom(value: unknown, fallback: string): string {
  const data = asRecord(value);
  return typeof data?.error === "string" && data.error.trim() ? data.error : fallback;
}

function requestedDates(snapshot: ApplicationReviewIdentitySnapshot): string {
  if (snapshot.fullSeason) {
    return snapshot.requiresFinalDateConfirmation
      ? `${snapshot.dates[0] ?? "Full season"} — confirm the final market date during final reservation.`
      : snapshot.dates[0] ?? "Full season";
  }
  return snapshot.dates.length ? snapshot.dates.join(", ") : "No vendor dates requested.";
}

/**
 * A reload-safe key is stored only under a SHA-256 fingerprint. It never puts a
 * manager note, application ID, source event, or other application data into
 * browser storage; it keeps an interrupted same-decision retry idempotent.
 */
async function reviewAttemptStorageKey(material: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    return `fame-application-review:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}

export default function ApplicationReviewPanel({ applicationId }: { applicationId: string }) {
  const router = useRouter();
  const attempts = useRef(new Map<string, string>());
  const [application, setApplication] = useState<ApplicationReviewDetail | null>(null);
  const [action, setAction] = useState<ReviewAction>("approve");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState<ReviewNotice | null>(null);
  const [awaitingResubmission, setAwaitingResubmission] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setSaveError("");
    setNotice(null);
    setAwaitingResubmission(false);
    try {
      const response = await fetch(reviewEndpoint(applicationId), {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const payload = await readJson(response);
      if (response.status === 401) {
        // A lost session requires a fresh sign-in. Do not automatically reload
        // or resubmit a manager decision after authentication changes.
        router.replace("/login");
        return;
      }
      const data = asRecord(payload);
      if (!response.ok || !isApplicationReviewDetail(data?.application, applicationId)) {
        setApplication(null);
        setLoadError(messageFrom(payload, "This application review is unavailable."));
        return;
      }
      attempts.current.clear();
      setApplication(data.application);
      setAction("approve");
      setReason("");
    } catch {
      setApplication(null);
      setLoadError("The application review could not be loaded. Check your connection, then reload it manually.");
    } finally {
      setLoading(false);
    }
  }, [applicationId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const idempotencyKeyFor = useCallback(async (material: string): Promise<string> => {
    const inMemory = attempts.current.get(material);
    if (inMemory) return inMemory;

    let key = crypto.randomUUID();
    const storageKey = await reviewAttemptStorageKey(material);
    if (storageKey) {
      try {
        const prior = sessionStorage.getItem(storageKey);
        if (prior && UUID_V4.test(prior)) key = prior;
        else sessionStorage.setItem(storageKey, key);
      } catch {
        // In-memory retry identity remains available when session storage is blocked.
      }
    }
    attempts.current.set(material, key);
    return key;
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!application || !application.sourceEventId || !application.identitySnapshot || saving || awaitingResubmission) return;

    const normalizedReason = reason.trim();
    if (action !== "approve" && !normalizedReason) {
      setSaveError("A manager note is required for changes or a decline.");
      return;
    }

    setSaving(true);
    setSaveError("");
    setNotice(null);
    const material = JSON.stringify([application.id, application.sourceEventId, action, normalizedReason]);
    try {
      const idempotencyKey = await idempotencyKeyFor(material);
      const response = await fetch(reviewEndpoint(application.id), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ action, sourceEventId: application.sourceEventId, reason: normalizedReason }),
      });
      const payload = await readJson(response);
      if (response.status === 401) {
        // Do not retry a decision after a session expires. The manager must sign
        // in again and deliberately reload the current source event.
        router.replace("/login");
        return;
      }
      if (!response.ok || !isSavedReview(payload, application.id)) {
        // In particular, stale-source and terminal 409 responses stay visible
        // until the manager chooses Reload review; no request is retried here.
        setSaveError(messageFrom(payload, "The review could not be saved. You can retry the same decision after resolving this message."));
        return;
      }
      const saved = payload;
      setApplication(current => current
        ? { ...current, reviewState: saved.application.reviewState }
        : current);
      setNotice({
        duplicate: saved.duplicate,
        delivery: saved.delivery,
        reviewState: saved.application.reviewState,
      });
      setAwaitingResubmission(saved.application.reviewState === "changes_requested");
    } catch {
      // The saved key is retained for an explicit retry of this exact decision.
      setSaveError("The review could not be saved. You can retry the same decision without creating a duplicate.");
    } finally {
      setSaving(false);
    }
  };

  const terminal = application?.reviewState === "approved" || application?.reviewState === "declined";
  const canReview = Boolean(application?.sourceEventId && application.hasOpportunity && application.identitySnapshot && !terminal && !awaitingResubmission);
  const requiresReason = action !== "approve";
  const canSubmit = canReview && !saving && (!requiresReason || Boolean(reason.trim()));

  return (
    <main className="min-h-screen bg-parchment/50 pb-16">
      <header className="border-b border-pine/10 bg-cream/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-leaf">Market staff</p>
            <h1 className="font-display text-2xl text-pine-deep">Application review</h1>
          </div>
          <a href="/applications" className="rounded-full px-4 py-2 text-sm font-semibold text-pine hover:bg-pine/10">
            Back to applications
          </a>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-6 py-8">
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-pine/10 sm:p-8">
          {loading && <p className="text-sm text-ink/60">Loading the current application review…</p>}

          {!loading && loadError && (
            <div role="alert" className="rounded-2xl bg-clay/10 p-5 text-sm text-clay">
              <p>{loadError}</p>
              <button type="button" onClick={() => void load()} className="mt-3 rounded-full bg-clay px-4 py-2 font-semibold text-white hover:bg-pine">
                Reload review
              </button>
            </div>
          )}

          {!loading && application && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="font-display text-3xl text-pine-deep">Review the applicant details</h2>
                  <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink/65">
                    Review the applicant details below before choosing a decision. Application approval does not reserve a booth.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${terminal ? "bg-pine/15 text-pine" : "bg-amber/15 text-clay"}`}>
                    {STATE_LABEL[application.reviewState]}
                  </span>
                  <button
                    type="button"
                    onClick={() => void load()}
                    disabled={saving}
                    className="rounded-full border border-pine/20 px-3 py-1 text-xs font-semibold text-pine hover:bg-pine/10 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    Reload application
                  </button>
                </div>
              </div>

              {application.identitySnapshot && (
                <section className="mt-5 rounded-2xl border border-pine/10 bg-white p-4">
                  <h3 className="font-semibold text-pine-deep">Captured vendor application</h3>
                  <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Vendor name</dt>
                      <dd className="mt-1 text-pine-deep">{application.identitySnapshot.vendorName}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Business</dt>
                      <dd className="mt-1 text-pine-deep">{application.identitySnapshot.businessName}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Email</dt>
                      <dd className="mt-1 break-words text-pine-deep">{application.identitySnapshot.email}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Applicant type</dt>
                      <dd className="mt-1 text-pine-deep">{application.identitySnapshot.applicantType}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Category</dt>
                      <dd className="mt-1 text-pine-deep">{application.identitySnapshot.category}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Requested dates</dt>
                      <dd className="mt-1 text-pine-deep">
                        {requestedDates(application.identitySnapshot)}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Application details</dt>
                      <dd className="mt-1 whitespace-pre-wrap text-pine-deep">{application.identitySnapshot.details ?? "No additional details were captured."}</dd>
                    </div>
                  </dl>
                </section>
              )}

              <details className="mt-5 rounded-2xl bg-parchment/60 p-4 text-sm text-ink/65">
                <summary className="cursor-pointer font-semibold text-pine-deep">Application reference</summary>
                <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Application ID</dt>
                    <dd className="mt-1 break-all font-mono text-xs text-pine-deep">{application.id}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Review revision</dt>
                    <dd className="mt-1 font-semibold text-pine-deep">{application.reviewRevision}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Latest captured submission</dt>
                    <dd className="mt-1 break-all font-mono text-xs text-pine-deep">{application.sourceEventId ?? "No submission is available."}</dd>
                  </div>
                </dl>
              </details>

              {!application.sourceEventId && (
                <p role="alert" className="mt-5 rounded-2xl bg-clay/10 p-4 text-sm text-clay">
                  No application submission is available yet, so there is nothing to review.
                </p>
              )}
              {!application.identitySnapshot && (
                <p role="alert" className="mt-5 rounded-2xl bg-clay/10 p-4 text-sm text-clay">
                  Some applicant details are missing. Capture a complete application before reviewing it.
                </p>
              )}
              {!application.hasOpportunity && (
                <p role="alert" className="mt-5 rounded-2xl bg-clay/10 p-4 text-sm text-clay">
                  This application is missing the workflow record required to save a decision. Correct it before reviewing.
                </p>
              )}
              {terminal && (
                <p role="status" className="mt-5 rounded-2xl bg-pine/10 p-4 text-sm text-pine">
                  This application is already {STATE_LABEL[application.reviewState].toLowerCase()}. Terminal decisions cannot be changed here.
                </p>
              )}
              {awaitingResubmission && (
                <p role="status" className="mt-5 rounded-2xl bg-amber/15 p-4 text-sm text-clay">
                  Changes were requested. Wait for a newer vendor submission, then choose Reload review before making another decision.
                </p>
              )}

              {notice && (
                <div role="status" className="mt-5 rounded-2xl bg-pine-deep p-4 text-sm text-cream">
                  <p className="font-semibold">
                    {notice.duplicate ? "This exact decision was already saved." : `Application marked ${STATE_LABEL[notice.reviewState].toLowerCase()}.`}
                  </p>
                  <p className="mt-1 text-cream/75">
                    {notice.delivery === "delivered"
                      ? "The matching CRM stage update was delivered."
                      : "The decision was saved and its matching CRM stage update is queued for recovery."}
                  </p>
                </div>
              )}

              <form onSubmit={submit} className="mt-7 space-y-5">
                <fieldset disabled={!canReview || saving}>
                  <legend className="text-sm font-bold text-pine-deep">Decision</legend>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    {ACTIONS.map(option => (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={action === option.value}
                        onClick={() => {
                          setAction(option.value);
                          setSaveError("");
                          setNotice(null);
                        }}
                        className={`rounded-2xl border p-4 text-left transition ${
                          action === option.value
                            ? "border-pine bg-pine text-cream shadow-sm"
                            : "border-pine/15 bg-white text-pine hover:border-amber"
                        } disabled:cursor-not-allowed disabled:opacity-50`}
                      >
                        <span className="block font-semibold">{option.title}</span>
                        <span className={`mt-1 block text-xs leading-relaxed ${action === option.value ? "text-cream/75" : "text-ink/55"}`}>
                          {option.description}
                        </span>
                      </button>
                    ))}
                  </div>

                  <label className="mt-5 block text-sm font-bold text-pine-deep">
                    Manager note {requiresReason ? <span className="text-clay">(required)</span> : <span className="font-normal text-ink/50">(optional)</span>}
                    <textarea
                      rows={5}
                      maxLength={2000}
                      required={requiresReason}
                      value={reason}
                      onChange={event => {
                        setReason(event.target.value);
                        setSaveError("");
                      }}
                      placeholder={requiresReason ? "Explain what needs to change or why the application is declined." : "Add an optional internal review note."}
                      className="mt-2 w-full rounded-2xl border border-pine/20 bg-white px-4 py-3 font-normal text-ink outline-none transition focus:border-amber focus:ring-2 focus:ring-amber/25"
                    />
                    <span className="mt-1 block text-right text-xs font-normal text-ink/45">{reason.length}/2000</span>
                  </label>
                </fieldset>

                {saveError && <p role="alert" className="rounded-2xl bg-clay/10 p-4 text-sm text-clay">{saveError}</p>}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-pine/10 pt-5">
                  <p className="max-w-md text-xs leading-relaxed text-ink/50">
                    A saved decision is not automatically retried after the application changes or your session expires.
                  </p>
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="rounded-full bg-pine px-6 py-3 text-sm font-semibold text-cream shadow transition enabled:hover:bg-leaf disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {saving ? "Saving review…" : `Save ${ACTIONS.find(option => option.value === action)?.title.toLowerCase() ?? "review"}`}
                  </button>
                </div>
              </form>

              {application.reviewState === "approved" && application.sourceEventId && application.identitySnapshot && (
                <FinalReservationPanel
                  key={`${application.id}:${application.sourceEventId}`}
                  applicationId={application.id}
                  sourceEventId={application.sourceEventId}
                  snapshot={application.identitySnapshot}
                />
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
