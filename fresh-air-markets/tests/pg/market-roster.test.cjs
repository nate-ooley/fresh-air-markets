const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const postgres = require('postgres');
const { loadMarketRoster } = require('../../.test-build/market-roster.js');

const url = new URL(process.env.DATABASE_TEST_URL || 'postgres://invalid/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/fresh_air_test', 'Set DATABASE_TEST_URL to local fresh_air_test only');
const schema = `qa_market_roster_${process.pid}`;
const admin = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
const sql = postgres(url.toString(), { max: 2, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
const marketId = 'fame-qa-market';
const locationId = 'qa-location';
const now = new Date('2026-09-11T12:00:00Z');

async function application(name, business, email, category, extra = {}) {
  const id = randomUUID();
  await sql`INSERT INTO fame_applications (id, market_id, location_id, contact_id, season_id, opportunity_id, review_state, review_revision)
    VALUES (${id}, ${marketId}, ${locationId}, ${`contact-${id}`}, '2026-2027', ${`opp-${id}`}, 'approved', 1)`;
  const [first, last] = name.split(' ');
  const snapshot = { contactId: `contact-${id}`, opportunityId: `opp-${id}`, seasonId: '2026-2027', snapshot: { registrationType: 'Vendor', firstName: first, lastName: last, email, phone: '555-0100', businessName: business, vendorCategory: category, fullSeason: false, vendorDatesRequested: ['2026-10-03'], ...extra } };
  await sql`INSERT INTO fame_application_events (location_id, event_id, market_id, application_id, payload_hash, snapshot, created_at)
    VALUES (${locationId}, ${`event-${id}`}, ${marketId}, ${id}, ${'a'.repeat(64)}, ${sql.json(snapshot)}, ${now})`;
  return id;
}
async function reservation(applicationId, state, booths, dates, patch = {}) {
  const id = randomUUID();
  await sql`INSERT INTO fame_reservations (id, market_id, application_id, revision, state, payment_required, total_cents, checkout_description, quote_version, final_booth_quantity, final_dates, payment_due_at, created_at, updated_at)
    VALUES (${id}, ${marketId}, ${applicationId}, 1, ${state}, ${state !== 'confirmed'}, ${booths * dates.length * 4000}, 'qa', 'qa-v1', ${booths}, ${sql.json(dates)}, ${patch.paymentDueAt ?? null}, ${now}, ${now})`;
  return id;
}

before(async () => {
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await sql`CREATE TABLE accounts (id TEXT PRIMARY KEY)`;
  await sql`INSERT INTO accounts (id) VALUES (${marketId}), ('other-market')`;
  const migration = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
  try {
    for (const file of ['001-application-handoff.sql', '004-application-review-outbox.sql', '005-agreement-completion-outbox.sql', '006-application-document-ledger.sql', '011-square-payment-checkout-ledger.sql', '012-square-webhook-events.sql', '013-final-reservation-writer.sql']) {
      await migration.unsafe(fs.readFileSync(path.join(__dirname, '../../docs/migrations', file), 'utf8'));
    }
  } finally { await migration.end(); }
});
after(async () => { await sql.end(); await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });

test('the roster reads live reservations with vendor identity, dates, booths and payment status, and ignores dead ones and other markets', async () => {
  const paid = await application('Rosa Alvarez', 'Sunrise Farms', 'rosa@example.com', 'Produce');
  await reservation(paid, 'paid', 2, ['2026-10-03', '2026-10-10']);
  const pending = await application('Ken Potter', 'Clay Works', 'ken@example.com', 'Arts & Crafts');
  await reservation(pending, 'payment_pending', 1, ['2026-10-03'], { paymentDueAt: new Date('2026-09-13T06:20:24Z') });
  const held = await application('Ada Baker', 'Bread Co', 'ada@example.com', 'Baked Goods');
  await reservation(held, 'held', 1, ['2026-10-10']);
  const expired = await application('Old Vendor', 'Gone Inc', 'old@example.com', 'Produce');
  await reservation(expired, 'expired', 3, ['2026-10-03']);
  const cancelled = await application('Quit Vendor', 'Quit Inc', 'quit@example.com', 'Produce');
  await reservation(cancelled, 'cancelled', 1, ['2026-10-03']);
  // Same shape in another market must not leak through.
  const foreignApp = randomUUID();
  await sql`INSERT INTO fame_applications (id, market_id, location_id, contact_id, season_id, opportunity_id, review_state, review_revision)
    VALUES (${foreignApp}, 'other-market', ${locationId}, 'c', '2026-2027', 'o', 'approved', 1)`;
  await sql`INSERT INTO fame_reservations (id, market_id, application_id, revision, state, payment_required, total_cents, checkout_description, quote_version, final_booth_quantity, final_dates, created_at, updated_at)
    VALUES (${randomUUID()}, 'other-market', ${foreignApp}, 1, 'paid', true, 4000, 'qa', 'qa-v1', 1, ${sql.json(['2026-10-03'])}, ${now}, ${now})`;

  const roster = await loadMarketRoster(marketId, sql);
  assert.deepEqual(roster.map(v => [v.businessName, v.status, v.booths, v.dates, v.category, v.vendorName, v.email, v.phone]).sort(), [
    ['Bread Co', 'pending', 1, ['2026-10-10'], 'Baked Goods', 'Ada Baker', 'ada@example.com', '555-0100'],
    ['Clay Works', 'pending', 1, ['2026-10-03'], 'Arts & Crafts', 'Ken Potter', 'ken@example.com', '555-0100'],
    ['Sunrise Farms', 'paid', 2, ['2026-10-03', '2026-10-10'], 'Produce', 'Rosa Alvarez', 'rosa@example.com', '555-0100'],
  ]);
  const clay = roster.find(v => v.businessName === 'Clay Works');
  assert.equal(clay.paymentDueAt, '2026-09-13T06:20:24.000Z');
  assert.equal(clay.applicationId, pending);
  assert.deepEqual(await loadMarketRoster('empty-market', sql), []);
});
