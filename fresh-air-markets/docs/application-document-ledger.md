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

`transferPrivateApplicationDocument` is the worker primitive for that transfer.
It requires a server-side `PrivateDocumentObjectStore` adapter and an
authenticated byte stream, enforces the 10 MiB ceiling while bytes are moving,
derives the digest and leading/trailing samples from those same bytes, and
removes the private object after a rejected, interrupted, unconsumed, or
failed transfer. It intentionally includes no cloud-storage provider,
credential, public URL, or malware scanner. A deployment must supply one
private storage adapter and invoke the primitive before it calls document
ingress.

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

For a HighLevel upload, use `POST /api/integrations/highlevel/documents`
instead of accepting an internal `applicationId` from the source. It uses the
same private transfer-worker credential and inspected file metadata, but the
payload supplies only `contactId` and `opportunityId` alongside the configured
location and season. The route resolves one existing `fame_applications` row
by exact market, location, season, contact, and immutable opportunity ID before
it writes any document record. A missing or substituted identity produces no
ledger write, HighLevel search, message, or file exposure. It does not make the
form's file storage private on its own; the worker must still transfer the
source bytes into private object storage before calling either ingress route.

Before enabling the route, the deployment still needs: an object-storage
transfer worker, a malware/deep-file scanner, a provider adapter that consumes
only the exact delivery envelope, an outbox delivery worker, migrations 001,
006 and 008, and the five QA upload scenarios in the launch grid. The endpoints
do not send email, update a HighLevel opportunity, or expose a document
publicly; those downstream mappings need explicit implementation and QA
evidence before L08 can be marked green.

## Staff upload path (no external transfer worker)

Production has no HighLevel document transfer worker or malware scanner yet.
Until one exists, market staff upload the vendor's certificate of insurance
and food license themselves from the application review page:

- `POST /api/admin/applications/{id}/documents` (multipart `kind` + `file`)
  streams the file through `transferPrivateApplicationDocument` into the
  PostgreSQL-backed private store added by migration
  `022-private-document-objects.sql`, binds it to the exact market-owned
  application as the next immutable version, and records a validation event
  whose reason is the fixed `MANAGER_UPLOAD_SCAN_REASON` text. That wording
  marks the document as admitted on the strength of the signed-in staff
  session plus the type, size and file-signature checks, not a scanner.
- `GET /api/admin/applications/{id}/documents` lists versions and states
  without storage keys. `GET /api/admin/documents/{id}/file` returns the bytes
  to the signed-in market with `no-store`, `nosniff` and a sandboxed CSP.
- The existing `PATCH /api/admin/documents/{id}/review` records the decision.
  Final reservation still requires an approved current insurance document.

Vercel serverless functions cap request bodies at about 4.5 MB, so a larger
PDF must be compressed before upload even though the ledger allows 10 MiB.
Identical bytes uploaded twice bind to the existing version and leave one
stored object; every rejected or failed upload removes its object.
