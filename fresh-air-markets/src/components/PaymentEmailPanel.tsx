"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "pending" | "preparing" | "send_started" | "accepted" | "delivered" | "failed" | "uncertain" | "cancelled";
type PaymentSyncStatus = "pending" | "delivered" | "skipped_paid" | "failed" | "unknown";
interface Notification { id: string; status: Status; canRetryPreflight: boolean; paymentSentSyncStatus?: PaymentSyncStatus }
const LABELS: Record<Status, string> = {
  pending: "Queued for delivery.",
  preparing: "Checking the vendor and payment request before sending.",
  send_started: "Email submission started. Check delivery before taking further action.",
  accepted: "HighLevel accepted the email. Inbox delivery has not yet been confirmed.",
  delivered: "HighLevel reports that the email was delivered.",
  failed: "Delivery needs attention. Review the email record before sending a replacement.",
  uncertain: "The send result is uncertain. Check the vendor’s HighLevel conversation before sending a replacement.",
  cancelled: "This payment link is no longer eligible for delivery.",
};
const PAYMENT_SYNC_LABELS: Record<PaymentSyncStatus, string> = {
  pending: "The Payment Sent update is pending in HighLevel.",
  delivered: "HighLevel payment status is Payment Sent.",
  skipped_paid: "Payment has advanced to Paid. The Payment Sent update was skipped.",
  failed: "The HighLevel payment status update needs attention. The email delivery result is shown above.",
  unknown: "The HighLevel payment status update could not be verified.",
};
function notificationValue(value: unknown): Notification | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const row = value as Notification;
  return typeof row.id === "string" && row.id.length > 0 && Object.hasOwn(LABELS, row.status)
    ? { id: row.id, status: row.status, canRetryPreflight: row.canRetryPreflight === true && ["failed", "cancelled"].includes(row.status),
      ...(row.paymentSentSyncStatus === undefined ? {} : { paymentSentSyncStatus: Object.hasOwn(PAYMENT_SYNC_LABELS, row.paymentSentSyncStatus) ? row.paymentSentSyncStatus : "unknown" as const }) }
    : undefined;
}

export default function PaymentEmailPanel({ reservationId }: { reservationId: string }) {
  const [notification, setNotification] = useState<Notification | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const lock = useRef(false);
  const viewRevision = useRef(0);
  const endpoint = `/api/admin/reservations/${encodeURIComponent(reservationId)}/payment-email`;

  const read = useCallback(async (method: "GET" | "POST", signal?: AbortSignal, retryPreflight = false) => {
    const response = await fetch(endpoint, { method, cache: "no-store", signal,
      headers: method === "POST" ? { "Content-Type": "application/json" } : { Accept: "application/json" },
      ...(method === "POST" ? { body: retryPreflight ? '{"retryPreflight":true}' : "{}" } : {}),
    });
    const payload = await response.json().catch(() => null);
    const record = notificationValue(payload?.notification);
    if (!response.ok || record === undefined) throw new Error(typeof payload?.error === "string" ? payload.error : "Payment email status could not be checked.");
    return record;
  }, [endpoint]);

  useEffect(() => {
    const abort = new AbortController();
    ++viewRevision.current;
    setLoading(true); setNotification(null); setError(""); setConfirmed(false);
    void read("GET", abort.signal).then(value => { if (!abort.signal.aborted) setNotification(value); })
      .catch(error => { if (!abort.signal.aborted) setError(error.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [read]);

  async function act(action: "send" | "retry" | "refresh") {
    const send = action !== "refresh";
    const retry = action === "retry";
    if (lock.current || loading || (send && (!confirmed || error))
      || (action === "send" && notification) || (retry && !notification?.canRetryPreflight)) return;
    const revision = viewRevision.current;
    lock.current = true; setBusy(true); setError("");
    try { const result = await read(send ? "POST" : "GET", undefined, retry); if (revision === viewRevision.current) setNotification(result); }
    catch (error) { if (revision === viewRevision.current) setError(error instanceof Error ? error.message : "Delivery status is unavailable."); }
    finally { lock.current = false; setBusy(false); setConfirmed(false); }
  }

  return <section className="rounded-2xl border border-pine/15 p-5">
    <h3 className="font-semibold text-pine-deep">Email the payment link</h3>
    <p className="mt-2 text-sm leading-relaxed text-ink/65">Send the private reservation link to the verified vendor contact for this application. The payment deadline stays unchanged.</p>
    {loading && <p role="status" className="mt-3 text-sm text-ink/60">Checking delivery status…</p>}
    {notification && <p role="status" className="mt-4 rounded-xl bg-parchment p-4 text-sm text-pine">{LABELS[notification.status]}</p>}
    {notification?.paymentSentSyncStatus && <p role={notification.paymentSentSyncStatus === "failed" || notification.paymentSentSyncStatus === "unknown" ? "alert" : "status"}
      className="mt-3 text-sm leading-relaxed text-ink/70"><strong>Vendor payment status: </strong>{PAYMENT_SYNC_LABELS[notification.paymentSentSyncStatus]}</p>}
    {error && <p role="alert" className="mt-4 rounded-xl bg-clay/10 p-4 text-sm text-clay">{error}</p>}
    {!loading && (!notification || notification.canRetryPreflight) && !error && <>
      {notification?.canRetryPreflight && <p className="mt-3 text-sm text-ink/65">The server confirms this attempt stopped before email submission. Correct the preparation issue before trying again.</p>}
      <label className="mt-4 flex items-start gap-3 text-sm text-ink/75"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} className="mt-0.5" />
        I confirm this application’s vendor details. Sending creates a new private link and replaces earlier links and sessions.
      </label>
      <button type="button" disabled={busy || !confirmed} onClick={() => void act(notification?.canRetryPreflight ? "retry" : "send")} className="mt-4 rounded-full bg-pine px-5 py-3 text-sm font-semibold text-cream disabled:opacity-45">{busy ? "Submitting…" : notification?.canRetryPreflight ? "Retry payment email preparation" : "Send payment email"}</button>
    </>}
    {!loading && <button type="button" disabled={busy} onClick={() => void act("refresh")} className="mt-4 block text-sm font-semibold text-pine underline underline-offset-4 disabled:opacity-45">Refresh delivery status</button>}
    <p className="mt-3 text-xs text-ink/55">An uncertain send is held for review and is not automatically sent again.</p>
  </section>;
}
