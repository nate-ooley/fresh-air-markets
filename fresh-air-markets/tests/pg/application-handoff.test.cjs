const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');
const { persistApplicationHandoff } = require('../../.test-build/application-handoff-pg.js');

// These destructive fixtures are restricted to the disposable local CI database.
const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
// This suite creates and drops only a private schema inside the disposable CI DB.
const schema = 'qa_application_handoff';
const admin = postgres(url.toString(), { max: 1, prepare: false });
const connect = () => postgres(url.toString(), { max: 10, prepare: false, connection: { search_path: schema } });
const first = connect();
const second = connect();
const event = (patch = {}) => ({
  eventId: 'qa-event', locationId: 'qa-location', marketId: 'qa-market-a',
  seasonId: '2026-2027', contactId: 'qa-contact', opportunityId: 'qa-original-opportunity',
  payloadHash: 'qa-original-hash', snapshot: { email: 'nate@autocraftstudios.com', agreementStatus: 'Signed', requestedDates: ['historical May 27 selection'] },
  ...patch,
});
before(async () => {
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  // The handoff migration depends only on accounts(id), not the rest of the portal schema.
  await first`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY)`;
  await first`INSERT INTO accounts (id) VALUES ('qa-market-a'), ('qa-market-b') ON CONFLICT DO NOTHING`;
  // Each migration contains BEGIN/COMMIT, so pin the scripts to one connection.
  const migration = postgres(url.toString(), { max: 1, prepare: false, connection: { search_path: schema } });
  // 004 adds review_state, which the upsert reads to re-list a withdrawn vendor who applies again;
  // 029 (and the chain it depends on) admits the 'withdrawn' value.
  try {
    for (const file of ['001-application-handoff.sql', '004-application-review-outbox.sql', '005-agreement-completion-outbox.sql', '006-application-document-ledger.sql',
      '011-square-payment-checkout-ledger.sql', '012-square-webhook-events.sql', '013-final-reservation-writer.sql', '029-vendor-bookings.sql']) {
      await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations', file), 'utf8'));
    }
  } finally { await migration.end(); }
});
beforeEach(async () => { await first`TRUNCATE fame_application_events, fame_applications CASCADE`; });
after(async () => { await first.end(); await second.end(); await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('100 concurrent deliveries capture one application and one event across separate pools', async () => {
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => persistApplicationHandoff(event(), i % 2 ? first : second)));
  assert.equal(results.filter(x => x === 'captured').length, 1);
  assert.equal(results.filter(x => x === 'duplicate').length, 99);
  const applications = await first`SELECT * FROM fame_applications`;
  const events = await first`SELECT * FROM fame_application_events`;
  assert.equal(applications.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].application_id, applications[0].id);
  assert.equal(applications[0].contact_id, 'qa-contact');
  assert.deepEqual(events[0].snapshot.snapshot, event().snapshot);
});

test('conflicting event reuse cannot overwrite original content or cross into another market', async () => {
  assert.equal(await persistApplicationHandoff(event(), first), 'captured');
  assert.equal(await persistApplicationHandoff(event({ payloadHash: 'changed', snapshot: { agreementStatus: 'Not Sent' } }), second), 'conflict');
  assert.equal(await persistApplicationHandoff(event({ marketId: 'qa-market-b' }), second), 'conflict');
  const rows = await first`SELECT * FROM fame_application_events`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].market_id, 'qa-market-a');
  assert.deepEqual(rows[0].snapshot.snapshot, event().snapshot);
  assert.equal((await first`SELECT * FROM fame_applications`).length, 1);
});

test('new events retain one application, fill a missing opportunity once and preserve prior snapshots', async () => {
  await persistApplicationHandoff(event({ opportunityId: null }), first);
  const [original] = await first`SELECT * FROM fame_applications`;
  await persistApplicationHandoff(event({ eventId: 'qa-next', payloadHash: 'next' }), second);
  await persistApplicationHandoff(event({ eventId: 'qa-later', payloadHash: 'later', opportunityId: 'qa-replacement', snapshot: { agreementStatus: 'Not Sent' } }), first);
  const applications = await first`SELECT * FROM fame_applications`;
  assert.equal(applications.length, 1);
  assert.equal(applications[0].id, original.id);
  assert.equal(applications[0].created_at.toISOString(), original.created_at.toISOString());
  assert.equal(applications[0].opportunity_id, 'qa-original-opportunity');
  const events = await first`SELECT * FROM fame_application_events ORDER BY event_id`;
  assert.equal(events.length, 3);
  assert.ok(events.every(x => x.application_id === original.id));
  assert.deepEqual(events.find(x => x.event_id === 'qa-event').snapshot.snapshot, event().snapshot);
});

test('contact, season, location and market each separate the application identity', async () => {
  const patches = [{}, { contactId: 'qa-other-contact' }, { seasonId: '2027-2028' }, { locationId: 'qa-other-location' }, { marketId: 'qa-market-b' }];
  await Promise.all(patches.map((patch, i) => persistApplicationHandoff(event({ ...patch, eventId: `scope-${i}`, payloadHash: `hash-${i}` }), i % 2 ? first : second)));
  const rows = await first`SELECT * FROM fame_applications`;
  assert.equal(rows.length, 5);
  assert.equal(new Set(rows.map(x => x.id)).size, 5);
  const links = await first`SELECT e.application_id, e.market_id, a.market_id AS linked_market FROM fame_application_events e JOIN fame_applications a ON a.id = e.application_id`;
  assert.equal(links.length, 5);
  assert.ok(links.every(x => x.market_id === x.linked_market));
});

test('failed final write rolls back the application and event; exact retry survives a new connection', async () => {
  await assert.rejects(persistApplicationHandoff(event({ marketId: 'qa-missing-market' }), first), /Configured market/);
  // Fail the final event-link update, after both INSERTs, to prove full rollback.
  await first`ALTER TABLE fame_application_events ADD CONSTRAINT qa_injected_failure CHECK (event_id <> 'qa-event' OR application_id IS NULL)`;
  try {
    await assert.rejects(persistApplicationHandoff(event(), first), error => error.code === '23514');
    assert.equal((await first`SELECT * FROM fame_applications`).length, 0);
    assert.equal((await first`SELECT * FROM fame_application_events`).length, 0);
  } finally {
    await first`ALTER TABLE fame_application_events DROP CONSTRAINT qa_injected_failure`;
  }
  const transient = postgres(url.toString(), { max: 1, prepare: false, connection: { search_path: schema } });
  try { assert.equal(await persistApplicationHandoff(event(), transient), 'captured'); }
  finally { await transient.end(); }
  assert.equal(await persistApplicationHandoff(event(), second), 'duplicate');
  assert.equal((await first`SELECT * FROM fame_applications`).length, 1);
  assert.equal((await first`SELECT * FROM fame_application_events`).length, 1);
});

test('a withdrawn vendor who applies again returns to needs_review; other states are left alone', async () => {
  assert.equal(await persistApplicationHandoff(event(), first), 'captured');
  await first`UPDATE fame_applications SET review_state = 'withdrawn'`;
  assert.equal(await persistApplicationHandoff(event({ eventId: 'qa-event-2', payloadHash: 'qa-hash-2' }), first), 'captured');
  assert.equal((await first`SELECT review_state FROM fame_applications`)[0].review_state, 'needs_review');
  await first`UPDATE fame_applications SET review_state = 'approved'`;
  assert.equal(await persistApplicationHandoff(event({ eventId: 'qa-event-3', payloadHash: 'qa-hash-3' }), first), 'captured');
  assert.equal((await first`SELECT review_state FROM fame_applications`)[0].review_state, 'approved');
});
