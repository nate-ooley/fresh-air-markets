# Checkout readiness in HighLevel

Migration 020 queues a job for an exact committed, unexpired Square checkout.
Migration 021 records verified Opportunity custom-field evidence instead of the
previous Payment Pending pipeline-stage acknowledgement.

The worker changes Vendor Payment Status from Not Ready to Ready for Payment,
while keeping Approved/Open and the selected application pipeline unchanged.
An already-Ready field is read-only success. Paid, Payment Sent, Payment Issue,
closed, foreign, or manually diverged state never regresses. It validates exact
configured field metadata and rereads the opportunity after any field-only PUT.

Ready and Paid require the finalization's exact Signed field-delivery receipt.
Queued agreement work defers without spending the normal failure budget. A
stage-only, wrong-field, wrong-pipeline or missing receipt cannot open the gate.
A common per-reservation advisory lock orders Ready, Payment Sent and Paid;
Square webhook database updates can still commit while provider calls run.
Expired, cancelled, reassigned or paid checkouts cancel obsolete Ready work.

Configuration is shared with the Paid adapter: approved stage ID, agreement and
payment status custom-field IDs, selected pipeline, tenant/season, exact QA
recipient checks and verified downstream field-trigger routing. Features stay
disabled until native QA is proven. Apply through migration 021 with old workers
paused; old operational stages are not valid configuration inputs.

The authenticated cron attempts one job per invocation. Bounded provider retry
never infers delivery from a successful PUT alone. Isolated adapter fixtures and
disposable PostgreSQL scenarios cover identity, field proof, duplicates,
rollback, legacy receipts, expiry and competing workers. Hosted workflow and
inbox evidence remain separate acceptance requirements.
