# Vendor scenario tests

Run `npm test` with Node 22. Tests compile the existing store and session modules into `.test-build`, then run directly against the code. They do not start a server, connect to HighLevel or Square, send messages, or change production data. The in-memory test vendors use the two addresses authorized for QA.

The current 24 tests cover:

- All 2,160 combinations of application, agreement, insurance, food-license requirement and food-license status in the test matrix. Only two complete states qualify for date selection.
- $30 full-season, $35 four-or-more consecutive market dates and $40 standard pricing, multiplied by final booth quantity.
- Every nonempty subset of a six-date test calendar; normalization, quantity scaling and complete quotes despite partial availability.
- Canonical calendar expansion, holiday gaps, duplicate dates, invalid dates, missing inventory, unsafe totals and invalid booth quantities.
- Four-food-truck and one-featured-nonprofit limits, nonprofit payment bypass, category validation and whitespace handling.
- Competing memory-store approvals, cancellation releasing capacity, no partial reservation on conflict, market isolation, removed booths, and public availability omitting vendor identities.
- Production secret requirements and rejection of tampered session tokens, including non-ASCII signatures.

Two regressions were reproduced before fixing them: memory-store approval of an inactive booth and a malformed Unicode session signature throwing a server error. Both now pass.

## Limits of this evidence

The advisory booking rules are not yet integrated into the portal routes or HighLevel. These are code-level tests, not proof of live workflow behavior. Memory-store concurrency is not PostgreSQL concurrency. Real database transaction tests, public-form submissions, trigger-link routing, document signing, inbox delivery, duplicate workflow enrollment, Square payment outcomes and payment webhook replay must still be tested in their intended environments.

The portal's current demo calendar and prices remain separate from the new Fresh Air rules. Do not use the demo portal as the production reservation/payment system until the calendar, CHECK/RESERVE and payment integration are complete.
