#!/usr/bin/env node
// Permanently removes ONE vendor application and everything attached to it:
// submissions, agreement signature, review history, uploaded documents (rows
// and file bytes) and the email log rows that reference it.
//
//   node scripts/delete-application.mjs --email someone@example.com            (dry run: shows what would go)
//   node scripts/delete-application.mjs --email someone@example.com --confirm  (deletes, in one transaction)
//
// Refuses when the application has a reservation: reservations carry immutable
// payment/audit records and must be handled by expiry or a refund instead.
// Needs DATABASE_URL for the target database.
import postgres from 'postgres';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const email = flag('--email')?.trim().toLowerCase();
const applicationId = flag('--application-id')?.trim();
const confirm = args.includes('--confirm');
if ((!email && !applicationId) || !process.env.DATABASE_URL) {
  console.error('usage: DATABASE_URL=… node scripts/delete-application.mjs (--email <address> | --application-id <id>) [--confirm]');
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const out = { mode: confirm ? 'delete' : 'dry-run', deleted: {} };
try {
  const matches = await sql`
    SELECT a.id, a.market_id, a.review_state, s.snapshot->'snapshot'->>'businessName' AS business,
           s.snapshot->'snapshot'->>'email' AS email
    FROM fame_applications a
    JOIN LATERAL (SELECT snapshot FROM fame_application_events e WHERE e.application_id = a.id ORDER BY created_at DESC LIMIT 1) s ON true
    WHERE (${applicationId ?? null}::text IS NOT NULL AND a.id = ${applicationId ?? null})
       OR (${email ?? null}::text IS NOT NULL AND lower(s.snapshot->'snapshot'->>'email') = ${email ?? null})`;
  if (matches.length !== 1) { console.error(JSON.stringify({ error: matches.length ? 'more_than_one_match' : 'no_match', matches })); process.exit(1); }
  const app = matches[0];
  out.application = app;
  const [res] = await sql`SELECT count(*)::int AS n FROM fame_reservations WHERE application_id = ${app.id}`;
  if (res.n > 0) { console.error(JSON.stringify({ error: 'has_reservation', application: app, reservations: res.n })); process.exit(1); }

  await sql.begin(async tx => {
    const del = async (label, query) => { const rows = await query; out.deleted[label] = rows.count; };
    const keys = (await tx`SELECT storage_key FROM fame_application_documents WHERE application_id = ${app.id}`).map(r => r.storage_key);
    const optional = async (label, run) => { try { await tx.savepoint(async sp => { const rows = await run(sp); out.deleted[label] = rows.count; }); } catch (e) { if (e?.code !== '42P01') throw e; } };
    // Document outbox rows are only reachable through the events that point at them.
    const docOutboxIds = (await tx`
      SELECT outbox_id FROM fame_document_review_events WHERE application_id = ${app.id} AND outbox_id IS NOT NULL
      UNION
      SELECT v.outbox_id FROM fame_document_validation_events v
      WHERE v.outbox_id IS NOT NULL AND v.document_id IN (SELECT id FROM fame_application_documents WHERE application_id = ${app.id})`).map(r => r.outbox_id);
    await del('document_review_events', tx`DELETE FROM fame_document_review_events WHERE application_id = ${app.id}`);
    await del('document_validation_events', tx`DELETE FROM fame_document_validation_events WHERE document_id IN (SELECT id FROM fame_application_documents WHERE application_id = ${app.id})`);
    if (docOutboxIds.length) await del('document_outbox', tx`DELETE FROM fame_document_outbox WHERE id IN ${tx(docOutboxIds)}`);
    await del('document_source_events', tx`DELETE FROM fame_document_source_events WHERE application_id = ${app.id}`);
    await del('documents', tx`DELETE FROM fame_application_documents WHERE application_id = ${app.id}`);
    if (keys.length) await optional('document_files', sp => sp`DELETE FROM fame_private_document_objects WHERE storage_key IN ${sp(keys)}`);
    for (const table of ['fame_payment_pending_sync_outbox', 'fame_payment_paid_sync_outbox', 'fame_agreement_notification_outbox', 'fame_agreement_stage_outbox', 'fame_agreement_events', 'fame_agreement_issuances']) {
      await optional(table.replace('fame_', ''), sp => sp.unsafe(`DELETE FROM ${table} WHERE application_id = $1`, [app.id]));
    }
    await del('agreement_completions', tx`DELETE FROM fame_agreement_completions WHERE application_id = ${app.id}`);
    await del('agreement_signatures', tx`DELETE FROM fame_agreement_signatures WHERE application_id = ${app.id}`);
    const outboxIds = (await tx`SELECT outbox_id FROM fame_application_review_events WHERE application_id = ${app.id} AND outbox_id IS NOT NULL`).map(r => r.outbox_id);
    await del('review_events', tx`DELETE FROM fame_application_review_events WHERE application_id = ${app.id}`);
    if (outboxIds.length) await del('review_outbox', tx`DELETE FROM fame_application_outbox WHERE id IN ${tx(outboxIds)}`);
    await del('submissions', tx`DELETE FROM fame_application_events WHERE application_id = ${app.id}`);
    await del('email_log', tx`DELETE FROM fame_email_log WHERE reference_id = ${app.id}`);
    await del('application', tx`DELETE FROM fame_applications WHERE id = ${app.id}`);
    if (!confirm) throw Object.assign(new Error('dry-run rollback'), { dryRun: true });
  }).catch(e => { if (!e?.dryRun) throw e; });
  console.log(JSON.stringify(out, null, 1));
} catch (e) {
  console.error(JSON.stringify({ error: 'failed', message: e?.message, pgCode: e?.code }));
  process.exitCode = 1;
} finally { await sql.end(); }
