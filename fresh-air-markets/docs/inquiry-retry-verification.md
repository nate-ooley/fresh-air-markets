# Public application retry protection

Repeated submission of the same portal form previously created another booking and CRM synchronization. The portal now supplies a UUID v4 Idempotency-Key header, reused for an unchanged submission. A synchronous browser guard suppresses double clicks; hashed session-storage entries preserve the key across same-tab reloads without storing the form fields. When storage is unavailable, an in-memory key still covers retries while the component remains mounted.

The public API requires this header. Deploy the updated form and endpoint together; custom clients must generate one key per intended submission and reuse it for retries. Requests without a valid key fail before writes or CRM calls. New keys intentionally represent new submissions; this is not email-based deduplication or reconciliation of old applications.

The database transaction locks the market/key, validates the original normalized payload, and commits the booking, dates and receipt together. Exact repeats return the original booking ID, price and current review state without a second CRM call. Changed details with the same key return 409. Duplicate dates are rejected rather than silently changing the requested selection. Existing IP/email limits remain enabled; the 100-request route pressure case isolates the replay behavior using a limiter double.

Apply additive migration 003 to the verified existing database before release, or let the existing schema initializer create its matching table. Do not delete receipts while their bookings exist. This change does not rewrite existing contacts, applications or review decisions. The test schema uses the real initializer; production schema compatibility still needs verification.

## Evidence and limits

- Five route scenarios cover key validation, 100 simultaneous identical requests producing one booking and one mocked CRM call, preserved approved/rejected/cancelled applications, changed-payload conflicts, and safe database-failure responses.
- Three component-handler tests cover rapid double clicks, lost-response retry and same-tab reload identity, edited-form identity, and unavailable session storage. These invoke actual component handlers with controlled React/browser boundaries; they are not deployed browser evidence.
- Five disposable PostgreSQL scenarios cover 100 identical requests across two pools; changed vendor/date/booth/message conflicts; market isolation; rollback after an injected receipt-write failure and exact retry; and persistence across reconnection with approval, cancellation, changed prices and a deactivated booth.
- The remaining isolated regression tests and production build are required alongside these scenarios. No real CRM, inbox, live contact or payment action is used by this suite.

L04 public application and L12 final date selection remain release checks until the deployed browser flow and production mapping are verified. Vercel project access currently returns 403. AI Studio form integration is a separate source and has not been exercised by these portal tests.

CRM dispatch still occurs after the booking commits. A process crash or provider failure at that boundary can leave a saved booking without a CRM event, and a receipt replay deliberately does not send again. A durable outbox, retry/reconciliation worker and downstream event identity are still required to prove recovery without duplicate automation. Do not describe this change as exactly-once email delivery or full workflow completion. Retries after selected dates close still fail date validation without creating a duplicate booking. Multi-tab/new-key submissions, full reservation quantities/pricing and inbox receipt remain separate checks.
