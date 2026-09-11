"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
  boothsRequested?: number;
}

interface ApplicationReviewListItem {
  id: string;
  sourceEventId: string | null;
  reviewState: ReviewState;
  reviewRevision: number;
  hasOpportunity: boolean;
  identitySnapshot: ApplicationReviewIdentitySnapshot | null;
}

const STATE_LABEL: Record<ReviewState, string> = {
  unreviewed: "Unreviewed",
  needs_review: "Needs review",
  changes_requested: "Changes requested",
  approved: "Approved",
  declined: "Declined",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isState(value: unknown): value is ReviewState {
  return value === "unreviewed" || value === "needs_review" || value === "changes_requested"
    || value === "approved" || value === "declined";
}

function isSnapshot(value: unknown): value is ApplicationReviewIdentitySnapshot {
  const snapshot = asRecord(value);
  return typeof snapshot?.vendorName === "string" && typeof snapshot.businessName === "string"
    && typeof snapshot.email === "string" && typeof snapshot.applicantType === "string"
    && typeof snapshot.category === "string" && typeof snapshot.fullSeason === "boolean"
    && typeof snapshot.requiresFinalDateConfirmation === "boolean"
    && Array.isArray(snapshot.dates) && snapshot.dates.every(date => typeof date === "string")
    && (typeof snapshot.details === "string" || snapshot.details === null)
    && (snapshot.boothsRequested === undefined || Number.isSafeInteger(snapshot.boothsRequested));
}

function isItem(value: unknown): value is ApplicationReviewListItem {
  const item = asRecord(value);
  return typeof item?.id === "string" && (typeof item.sourceEventId === "string" || item.sourceEventId === null)
    && isState(item.reviewState) && Number.isSafeInteger(item.reviewRevision)
    && typeof item.hasOpportunity === "boolean"
    && (item.identitySnapshot === null || isSnapshot(item.identitySnapshot));
}

function messageFrom(value: unknown, fallback: string): string {
  const body = asRecord(value);
  return typeof body?.error === "string" && body.error.trim() ? body.error : fallback;
}

function requestedDates(snapshot: ApplicationReviewIdentitySnapshot): string {
  if (snapshot.fullSeason) {
    return snapshot.requiresFinalDateConfirmation
      ? `${snapshot.dates[0] ?? "Full season"} — final date confirmation required`
      : snapshot.dates[0] ?? "Full season";
  }
  return snapshot.dates.length ? snapshot.dates.join(", ") : "No vendor dates requested";
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export default function ApplicationReviewList() {
  const router = useRouter();
  const [applications, setApplications] = useState<ApplicationReviewListItem[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/applications", { headers: { Accept: "application/json" }, cache: "no-store" });
      const payload = await readJson(response);
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      const body = asRecord(payload);
      if (!response.ok || !Array.isArray(body?.applications) || !body.applications.every(isItem)) {
        setApplications(null);
        setError(messageFrom(payload, "Application reviews could not be loaded."));
        return;
      }
      setApplications(body.applications);
    } catch {
      setApplications(null);
      setError("Application reviews could not be loaded. Check your connection, then reload manually.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const signOut = async () => {
    try {
      const response = await fetch("/api/auth/login", { method: "DELETE" });
      if (!response.ok) throw new Error("Sign out failed");
      router.replace("/login");
      router.refresh();
    } catch { setError("Sign out failed. Please try again."); }
  };

  return (
    <main className="min-h-screen bg-parchment/50 pb-16">
      <header className="border-b border-pine/10 bg-cream/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-leaf">Market staff</p>
            <h1 className="font-display text-2xl text-pine-deep">Applications</h1>
          </div>
          <nav className="flex items-center gap-3 text-sm font-semibold text-pine">
            <a href="/roster" className="rounded-full px-3 py-2 hover:bg-pine/10">Roster</a>
            <a href="/messages" className="rounded-full px-3 py-2 hover:bg-pine/10">Messages</a>
            <a href="/staff" className="rounded-full px-3 py-2 hover:bg-pine/10">Staff</a>
            <button type="button" onClick={() => void signOut()} className="rounded-full px-4 py-2 hover:bg-pine/10">Sign out</button>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-8">
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-pine/10 sm:p-8">
          <p className="max-w-2xl text-sm leading-relaxed text-ink/65">
            Review each applicant’s submitted details before choosing a decision. Application approval does not reserve a booth.
          </p>

          {loading && <p className="mt-6 text-sm text-ink/60">Loading current applications…</p>}

          {!loading && error && (
            <div role="alert" className="mt-6 rounded-2xl bg-clay/10 p-5 text-sm text-clay">
              <p>{error}</p>
              <button type="button" onClick={() => void load()} className="mt-3 rounded-full bg-clay px-4 py-2 font-semibold text-white hover:bg-pine">Reload applications</button>
            </div>
          )}

          {!loading && applications?.length === 0 && (
            <p className="mt-6 rounded-2xl bg-parchment/60 p-5 text-sm text-ink/65">No applications have been captured for this market yet.</p>
          )}

          {!loading && applications && applications.length > 0 && (
            <ul className="mt-6 grid gap-4">
              {applications.map(application => {
                const snapshot = application.identitySnapshot;
                const reviewable = Boolean(snapshot && application.sourceEventId && application.hasOpportunity);
                return (
                  <li key={application.id} className="rounded-2xl border border-pine/10 bg-parchment/30 p-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <h2 className="font-display text-xl text-pine-deep">{snapshot?.businessName ?? "Incomplete applicant details"}</h2>
                        {snapshot && <p className="mt-1 text-sm text-ink/65">{snapshot.vendorName} · {snapshot.email}</p>}
                      </div>
                      <span className="rounded-full bg-amber/15 px-3 py-1 text-xs font-bold text-clay">{STATE_LABEL[application.reviewState]}</span>
                    </div>

                    {snapshot ? (
                      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                        <div><dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Applicant type</dt><dd className="mt-1 text-pine-deep">{snapshot.applicantType}</dd></div>
                        <div><dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Category</dt><dd className="mt-1 text-pine-deep">{snapshot.category}</dd></div>
                        <div><dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Booths requested</dt><dd className="mt-1 text-pine-deep">{snapshot.boothsRequested ?? 1} per market day</dd></div>
                        <div><dt className="text-xs font-semibold uppercase tracking-wide text-ink/45">Requested dates</dt><dd className="mt-1 text-pine-deep">{requestedDates(snapshot)}</dd></div>
                      </dl>
                    ) : (
                      <p role="alert" className="mt-4 rounded-xl bg-clay/10 p-3 text-sm text-clay">Some applicant details are missing, so review remains unavailable until a complete application is captured.</p>
                    )}

                    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-pine/10 pt-4">
                      <span className="text-xs text-ink/45">{application.reviewRevision ? `Reviewed ${application.reviewRevision} time${application.reviewRevision === 1 ? "" : "s"}` : "Not yet reviewed"}</span>
                      {reviewable ? (
                        <a href={`/applications/${encodeURIComponent(application.id)}`} className="rounded-full bg-pine px-4 py-2 text-sm font-semibold text-cream hover:bg-leaf">Review application</a>
                      ) : (
                        <span className="rounded-full bg-ink/10 px-4 py-2 text-sm font-semibold text-ink/50">Review unavailable</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
