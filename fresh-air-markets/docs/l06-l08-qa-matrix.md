# L06–L08 QA matrix

This is the launch-grid evidence checklist for the three vendor workflows. Every
row stays **RED** until a safe QA deployment produces the listed evidence. Use
only `lnooley@gmail.com` and `nate@autocraftstudios.com` for any test message.
Do not record secrets, public document links, raw file names, storage keys, or
full file hashes in Asana or Linear.

## Evidence to capture for every run

Record a run ID, timestamp, deployment commit, QA environment, and the exact
record IDs in the row's evidence. A HighLevel workflow execution ID and a
provider message/document ID are required whenever that action occurs. Capture
the before-and-after stage/status from the exact opportunity ID and a duplicate
count. Keep the full evidence in the restricted QA record; add only the safe
summary and status to the launch grid.

| Workflow | Required exact IDs |
| --- | --- |
| L06 review | `applicationId`, `sourceEventId`, `contactId`, `opportunityId`, `reviewEventId`, `applicationOutboxId`, idempotency key |
| L07 agreement | `applicationId`, issued and completed event IDs, `documentId`, `templateId`, `contactId`, `opportunityId`, `completionId`, notification outbox ID, stage-outbox ID |
| L08 document | `applicationId`, `contactId`, `opportunityId`, `documentId`, version, source file/event ID, scan/review event ID, document-outbox ID |

## L06 — application review and approval

| ID | QA scenario | Expected exact mapping and proof | Current status | Blocker to green |
| --- | --- | --- | --- | --- |
| L06-1 | Approve one current QA application | The submitted `applicationId` and latest `sourceEventId` create one `reviewEventId` and one `applicationOutboxId`. A direct read of that stored `opportunityId` starts in the configured Review stage and ends once in the configured Approved stage. Capture one HighLevel workflow execution and any QA-only message receipt. | **RED** — adapter and portal test coverage exist; no deployed QA transaction or provider evidence is recorded. | Apply migrations, configure the reviewed QA database and exact L06 IDs, then run against the QA opportunity. |
| L06-2 | Request changes for one current QA application | The same exact-record chain moves only its `opportunityId` from Review to the configured Changes Requested stage, preserving the review reason. Capture one outbox delivery and one QA-only workflow execution. | **RED** — code supports the mapped outcome; no end-to-end proof exists. | The isolated QA stage now exists. Retrieve its exact ID through the scoped read-only API, configure the QA environment, then deploy and test it. |
| L06-3 | Decline one current QA application | The decision’s `reviewEventId` and `applicationOutboxId` move only the stored `opportunityId` from Review to Declined. Capture pre/post stages, one delivery receipt, and zero messages outside the two QA addresses. | **RED** — no QA deployment evidence exists. | Exact QA stage mapping, private deployment variables, migrations, and a controlled QA run. |
| L06-4 | Pressure test duplicate clicks and recovery | Reuse one idempotency key across concurrent review requests and race the immediate dispatch with the recovery scheduler. Expected: one review event, one outbox row, one HighLevel stage mutation, one workflow execution. A failed first delivery may recover from the same outbox ID. | **RED** — disposable database tests exercise these properties; no deployed provider race evidence exists. | Authenticated scheduler and QA deployment are unconfigured; capture provider calls and duplicate counts in a live QA run. |
| L06-5 | Reject wrong, stale, or unauthorized review input | Use a stale source event, a wrong-market session, a missing/stale opportunity, and a signed-out or tampered request. Expected: no review event, no outbox, no HighLevel `PUT`, and no workflow/message. | **RED** — route and database tests cover the guard paths; no deployment evidence exists. | Run the cases against the protected QA routes and capture the zero-mutation proof. |

## L07 — agreement completion

| ID | QA scenario | Expected exact mapping and proof | Current status | Blocker to green |
| --- | --- | --- | --- | --- |
| L07-1 | Complete one issued QA agreement | First bind the issued `documentId` to its exact `applicationId`, `contactId`, `opportunityId`, and approved `templateId`. A genuine completed event creates one `completionId`, one notification outbox ID, and one stage-outbox ID. The stored opportunity moves once from Agreement Sent to Agreement Completed. | **RED** — exact-stage code and automated tests exist; no QA issuance, signature, or deployed event exists. | The isolated QA pipeline now exists. Retrieve its exact stage IDs, configure private variables/migrations, and obtain fresh confirmation at the actual signature action. |
| L07-2 | Replay and concurrent completion pressure test | Deliver the same completed event repeatedly and concurrently. Expected: one immutable completion, one notification outbox item, one stage-outbox item, one stage mutation, and at most one QA-only notification. | **RED** — disposable database coverage exists; no provider/event evidence exists. | QA deployment plus controlled source-event replay and workflow/message logs. |
| L07-3 | Recover after provider success before local receipt | Simulate or observe an interrupted delivery after HighLevel moves the exact opportunity. On retry, a direct read finds Agreement Completed and records delivery without a second `PUT` or second workflow trigger. | **RED** — adapter test coverage exists; no deployed recovery proof exists. | QA sent/completed mapping and an authenticated recovery endpoint/scheduler. |
| L07-4 | Reject wrong or superseded agreement identity | Submit completed events with a wrong/superseded `documentId`, `templateId`, `contactId`, `opportunityId`, location, season, or non-completed status. Expected: no completion, no stage outbox, no opportunity update, and no message. | **RED** — handler/database guard coverage exists; no QA endpoint evidence exists. | Deploy the issued/completed endpoints and capture rejected-event plus zero-mutation records. |
| L07-5 | Preserve terminal opportunity safety | Exercise a closed opportunity, an unexpected source stage, and a post-update status divergence. Expected: a terminal failed stage-outbox result, no reopening, no wrong-stage overwrite, no repeat message. | **RED** — fake-transport tests cover the guard; no configured QA pipeline or provider proof exists. | Retrieve the exact QA Agreement Sent stage ID, configure the QA environment, and run the exact-stage/status checks. |

## L08 — insurance/document upload and review

| ID | QA scenario | Expected exact mapping and proof | Current status | Blocker to green |
| --- | --- | --- | --- | --- |
| L08-1 | Accept valid private insurance uploads | For valid PDF, PNG, and JPEG samples, a private transfer worker records each source file/event against its exact `applicationId`; scanner results advance the matching `documentId` and version only. Capture the bounded validation result, scanner event, and exact ledger/outbox IDs. | **RED** — portal validation and ledger code exist. User-confirmed form-validation email receipt and one reply are partial inbox evidence only; they do not prove private transfer, scanning, or exact mapping. | Private object storage transfer worker, scanner, source-event mapper, migrations, and QA deployment are absent. |
| L08-2 | Refuse unsafe or invalid uploads | Exercise an unsupported type, spoofed signature/MIME/extension, empty file, corrupt file, and the size boundary. Expected: rejected validation with no accepted ledger version, downstream delivery, or message. | **RED** — validation code tests exist; no private-transfer QA evidence exists. | Run the files through the actual private transfer and scanner path. |
| L08-3 | Keep two QA vendors isolated | Upload documents for the two QA applications. Each resulting envelope must contain that application’s stored `contactId`, `opportunityId`, market, location, and season. Capture two distinct application/document/version sets and prove zero cross-record delivery. | **RED** — exact envelope tests exist; no two-vendor deployed proof exists. | Reliable application-to-HighLevel source-event mapping and a QA deployment. |
| L08-4 | Fence correction and resubmission versions | Submit version 1, scan/review it, then submit version 2 before delivery. Expected: version 2 is current; stale version-1 scan/review/outbox work is retired; only the current event can progress. Capture both versions and every retired outbox ID. | **RED** — ledger/outbox database tests cover this behavior; no QA proof exists. | Private transfer/scanner setup and an end-to-end resubmission run. |
| L08-5 | Prevent replay and stale/cross-record review | Replay an upload event, send a changed payload under the same event ID, attempt a stale version review, and attempt a substituted application/document identity. Expected: no duplicate document, no wrong review state, no downstream call, and a safe error/zero-mutation record. | **RED** — code-level replay and exact-identity coverage exists; no deployment evidence exists. | Run protected ingress, scanner, and manager-review cases in the QA environment. |

## Verified release position

- The portal code contains exact-record L06, L07, and L08 foundations, including
  direct opportunity-ID delivery adapters and durable outboxes. GitHub Actions
  run 23 for commit `a0f92b7` passed its isolated and PostgreSQL suites. Neither
  code-level result constitutes a deployed workflow pass.
- The verified Fresh Air QA configuration now has a `Changes Requested` stage
  in `QA ONLY - FAME Intake Tests` and a separate `QA ONLY - FAME Agreement
  Tests` pipeline with `Agreement Sent` and `Agreement Completed`. No workflow,
  contact, message, SMS, or live pipeline was changed. The per-stage IDs still
  need a safe read-only API lookup before the QA deployment can be configured.
- The known HighLevel upload form uses public file storage. It cannot supply
  L08’s required private-transfer and scanner evidence.
- No row may become green from an inbox response alone. Public-browser upload
  and signature proof remains blocked until the browser policy is restored;
  it must not be bypassed. A real signature still requires confirmation at the
  action itself.
