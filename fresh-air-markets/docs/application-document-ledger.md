# Application document ledger

`006-application-document-ledger.sql` adds an append-only, application-bound
ledger for insurance and food-license uploads. Apply it after
`001-application-handoff.sql` to a reviewed database. It does not alter
existing HighLevel contacts, documents, or workflow history.

The transfer service must not treat a browser filename or MIME value as proof
of file type. It must fetch or receive the file on the server, stream it into
private object storage, count bytes, calculate SHA-256, retain only bounded
first/last samples, and run `validateApplicationDocumentUpload`. The guard
allows PDF, PNG, and JPEG only when filename extension, declared content type,
and signature agree; it refuses empty files, objects larger than 10 MiB, unsafe
storage keys, invalid digests, and simple truncated/spoofed samples. The
database stores the private storage key and digest, never raw document bytes or
public source URLs.

A successful source event is still `pending_scan`. A trusted malware/deep-file
scanner must call `recordApplicationDocumentScan` for the same current document
version. Only `ready_for_review` documents can receive a manager decision.
This prevents a header match from becoming an approval. A scan rejection stays
blocked and emits an outbox item for a correction path.

Every upload source event is keyed by location and stable event ID. An exact
retry returns its original document; reuse with changed metadata conflicts.
New source events create immutable versions and make only the newest version
current. Scanner and manager actions also require their expected version, so a
stale tab or delayed event cannot approve a corrected upload. Manager decisions
record the authenticated actor and create a durable outbox entry in the same
transaction. Workers claim leases, retry with safe error codes, and cannot mark
another worker's lease delivered. `dispatchApplicationDocumentOutbox` fences a
job against the current document/version immediately before delivery; a queued
notice for a superseded version is retired without a downstream side effect.

## Exact application delivery contract

`dispatchApplicationDocumentOutbox` is the only supported document-delivery
entry point. Before it calls an injected provider adapter, it checks the active
outbox lease, the persisted outbox payload, the current document version and
its event state. It then joins that document to its one stored
`fame_applications` row. The adapter receives an
`ApplicationDocumentDeliveryEnvelope` containing the exact application,
market, location, contact, season and **stored opportunity ID**, along with the
document ID/kind/version, lifecycle event, and stable outbox idempotency key.
It never receives a storage key, filename, source file ID, digest, raw file,
or public file URL.

There is no contact search, opportunity-list query, name match, or “most
recent opportunity” fallback in this path. If the exact application has not
yet captured an opportunity ID, the job remains pending with the safe
`document_identity_missing` code and the adapter is not called. If a job loses
its lease, its document is superseded, or its saved state no longer matches the
event, it is retired without a downstream call. A provider adapter added later
must use only `envelope.application.opportunityId`; for HighLevel that means a
direct request to that ID followed by identity checks, never an opportunity
search.

Apply `008-application-opportunity-identity.sql` after migration 006. It lets
an application gain its first opportunity ID, but rejects later reassignment to
a different opportunity. This preserves the routing identity used by existing
document work items.

The protected ingress endpoint is `POST /api/integrations/documents`. It accepts
only a bounded JSON record from a trusted post-transfer worker and derives the
market from server configuration. Its bearer secret is
`DOCUMENT_INGRESS_WEBHOOK_SECRET`; the payload includes a private object key,
stable source file ID, counted size, SHA-256 and bounded Base64 samples. It
uses a timezone-bearing RFC3339 `submittedAt` timestamp and stores it in
canonical UTC; it does not accept a browser upload or a public file URL. `POST
/api/integrations/documents/:id/scan` uses the separate
`DOCUMENT_SCANNER_WEBHOOK_SECRET`, and a signed-in market session submits an
exact version-bound manager decision through `PATCH
/api/admin/documents/:id/review` with an `Idempotency-Key`.

Before enabling the route, the deployment still needs: an object-storage
transfer worker, a malware/deep-file scanner, a HighLevel source-event mapper
that passes an internal application ID, a provider adapter that consumes only
the exact delivery envelope, an outbox delivery worker, migrations 001, 006
and 008, and the five QA upload scenarios in the launch grid. The endpoints do
not send email, update a HighLevel opportunity, or expose a document publicly;
those downstream mappings need explicit implementation and QA evidence before
L08 can be marked green.
