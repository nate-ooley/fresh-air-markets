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

No public upload route, object-storage adapter, scanner, HighLevel source-event
mapping, email dispatch, migration application, or live browser test is enabled
by this foundation. Those integrations must be completed before L08 can be
marked green.
