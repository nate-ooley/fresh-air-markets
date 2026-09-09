# Durable vendor payment email

The payment-request email uses one database notification per private market, final reservation, and revision. Queueing reads the exact source email and CRM identities recorded with the committed finalization. It accepts no recipient, contact, opportunity, price, or URL from the manager request. QA delivery is limited to `lnooley@gmail.com` and `nate@autocraftstudios.com` by both queue and provider adapter.

Migration `019-payment-email-outbox.sql` adds the notification ledger. Migration `017` supplies the separate vendor invitation/session tables. Creating or explicitly recovering an unsent notification rotates its invitation and writes the encrypted delivery URL in the same transaction. Any failure rolls back both, preserving the previous invitation. Ordinary repeat requests return the existing notification without rotating or sending again.

The delivery URL is encrypted with AES-256-GCM. HKDF derives an independent encryption key from the existing strong private `AUTH_SECRET`; no additional secret is required. The authentication data binds the notification, market, reservation, revision, and recipient. Only ciphertext is stored while awaiting preflight. Manager status responses contain no email address, invitation token, URL, body, or CRM identifiers.

Before provider preflight, the worker requires the exact Ready for Payment custom-field outbox receipt for this checkout, finalization, recipient identity, revision and deadline. Pending/processing field work preserves the encrypted email intent and defers without consuming the email preflight budget. Missing, mismatched or failed prerequisite evidence produces an operator-visible preparation failure. Paid or expired reservations cancel first, even while field delivery is still waiting. The same prerequisite is rechecked before the email send checkpoint.

The worker processes at most five notifications per request; an immediate manager request can restrict dispatch to its exact notification. Each item is leased for two minutes. The worker checks the current exact checkout and invitation, performs only read-only provider identity/status-field checks, then rechecks payment state, revision, deadline, invitation revocation, and the payment stop immediately before committing `send_started`. That committed checkpoint erases the ciphertext **before** the single provider POST.

State meanings:

| State | Evidence and next action |
| --- | --- |
| pending / preparing | No POST has started. Transient preflight reads retry with delay, at most five attempts. |
| send_started | The irreversible attempt checkpoint is committed. A worker crash becomes uncertain after its lease expires; it never POSTs again. |
| accepted | Provider returned all three exact receipt IDs. This is not proof of delivery. Receipt GETs verify delivery; after verified sent evidence, separate field-only Payment Sent synchronization can run. |
| delivered | Exact provider receipt reports delivered, opened, or read. Independent inbox observation remains a separate acceptance test. |
| failed | A permanent/exhausted preflight failure or a verified failed/undelivered provider receipt. `canRetryPreflight` distinguishes the two. |
| uncertain | POST result was ambiguous, the send worker stopped, or five consecutive receipt checks could not verify the exact email. No automatic resend. |
| cancelled | A pre-send reservation/invitation/deadline/payment-stop check failed. No POST occurred. |

An explicit `retryPreflight: true` manager action may recover only `failed` or `cancelled` notifications whose `send_started_at` is null. It revalidates the same immutable identity and payable checkout and atomically rotates the token on the same notification. A delivered, accepted, uncertain, or post-send failed notification cannot use this action. Receipt GETs can still verify delivery after the payment deadline or after payment completion and require no stored invitation secret.

Local verification covers encryption roundtrips, fresh nonces, all identity bindings, tampering/wrong secrets, and weak-secret rejection. The PostgreSQL suite covers concurrent queueing and workers, rollback, tenant/source/payment gates, provider preflight mismatch and safe retry, payment/revocation races, timeout/crash parking, post-expiry receipts, receipt mismatch/bounce handling, bounded targeted dispatch, explicit unsent recovery, and unavailable-receipt exhaustion. All provider transport is injected in these tests; no email is sent externally.

Hosted migration execution, exact HighLevel field/stage configuration, authenticated native workflow tests, and independent test-inbox receipt observation are separate release requirements. This document and automated fixtures do not claim those external checks have passed.

The manager POST attempts only the selected notification. Its status refresh reads the saved receipt; ongoing receipt polling and recovery require the authenticated payment-email worker. A production scheduler has not been installed by this change. Configure and verify a scheduler compatible with the hosting plan before release, covering payment-email receipts, paid-status sync, and existing expiry/retirement jobs. Both new cron routes process one item per request to fit their 60-second execution budget.

The reservation lock ends when the send checkpoint commits. A payment or revocation can race the subsequent provider POST and leave an obsolete email in flight. The private portal still validates current payment and access state; this implementation does not claim atomic exclusion between PostgreSQL and HighLevel.

Migration 021 adds verified custom-field receipts and separates email provider
evidence from the Payment Sent CRM update. The provider proof commits before
that update. CRM failures retry only the field update (five attempts maximum),
never the email POST. The shared reservation lock orders Ready/Sent/Paid;
skipping Sent as paid requires exact local Square reconciliation. A native Paid
field alone is not proof of payment. The manager shows CRM pending/failed status
separately from actual email delivery.
