const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../.test-build/store-memory.js');
const { makeSessionToken, verifySessionToken } = require('../.test-build/auth.js');

const vendor = { name: 'FAME Test Vendor', businessName: 'FAME QA Only', email: 'nate@autocraftstudios.com', phone: '', category: 'Produce', message: 'Isolated test; no email or CRM connection.' };
const booth = (marketId, id) => ({ id, marketId, label: 'QA', zone: 'Test', x: 0, y: 0, w: 40, h: 40, pricePerDay: 40, active: true });

test('competing approvals allow only one vendor for the same booth and date', async () => {
  const store = new MemoryStore();
  await store.createBooth(booth('qa-conflicts', 'qa-booth'));
  const input = { ...vendor, boothId: 'qa-booth', dates: ['2026-10-03'] };
  const a = await store.createInquiry('qa-conflicts', input, 40);
  const b = await store.createInquiry('qa-conflicts', { ...input, email: 'lnooley@gmail.com' }, 40);
  const results = await Promise.all([store.approveBooking('qa-conflicts', a.id), store.approveBooking('qa-conflicts', b.id)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  const publicBooths = await store.boothsWithAvailability('qa-conflicts', input.dates, false);
  assert.equal(publicBooths[0].status, 'rented');
  assert.equal('occupants' in publicBooths[0], false);
  assert.equal(JSON.stringify(publicBooths).includes(vendor.email), false);
});

test('cancellation releases capacity; the competing request can then be approved', async () => {
  const store = new MemoryStore();
  await store.createBooth(booth('qa-cancel', 'qa-cancel-booth'));
  const input = { ...vendor, boothId: 'qa-cancel-booth', dates: ['2026-10-10'] };
  const a = await store.createInquiry('qa-cancel', input, 40);
  const b = await store.createInquiry('qa-cancel', input, 40);
  assert.equal((await store.approveBooking('qa-cancel', a.id)).ok, true);
  await store.setBookingStatus('qa-cancel', a.id, 'cancelled');
  assert.equal((await store.approveBooking('qa-cancel', b.id)).ok, true);
});

test('a conflicting multi-date approval does not partially reserve other dates', async () => {
  const store = new MemoryStore();
  await store.createBooth(booth('qa-partial', 'qa-partial-booth'));
  const a = await store.createInquiry('qa-partial', { ...vendor, boothId: 'qa-partial-booth', dates: ['2026-10-03'] }, 40);
  await store.approveBooking('qa-partial', a.id);
  const b = await store.createInquiry('qa-partial', { ...vendor, boothId: 'qa-partial-booth', dates: ['2026-10-03', '2026-10-10'] }, 80);
  assert.equal((await store.approveBooking('qa-partial', b.id)).ok, false);
  assert.equal((await store.getBooking('qa-partial', b.id)).status, 'pending');
  assert.equal((await store.boothsWithAvailability('qa-partial', ['2026-10-10'], false))[0].status, 'available');
});

test('market isolation blocks another market from viewing or changing a booking', async () => {
  const store = new MemoryStore();
  const b = await store.createInquiry('qa-owner', { ...vendor, boothId: 'qa-private', dates: ['2026-10-03'] }, 40);
  assert.equal(await store.getBooking('qa-other', b.id), null);
  assert.equal((await store.approveBooking('qa-other', b.id)).ok, false);
  assert.equal(await store.setBookingStatus('qa-other', b.id, 'cancelled'), null);
});

test('a booth removed after inquiry cannot be approved', async () => {
  const store = new MemoryStore();
  await store.createBooth(booth('qa-removed', 'qa-removed-booth'));
  const b = await store.createInquiry('qa-removed', { ...vendor, boothId: 'qa-removed-booth', dates: ['2026-10-03'] }, 40);
  await store.deleteBooth('qa-removed', 'qa-removed-booth');
  assert.equal((await store.approveBooking('qa-removed', b.id)).ok, false);
});

test('tampered sessions, including non-ASCII signatures, are rejected without throwing', () => {
  const token = makeSessionToken('qa-session');
  assert.equal(verifySessionToken(token), 'qa-session');
  assert.equal(verifySessionToken(token.replace('qa-session', 'another-market')), null);
  const parts = token.split('.');
  parts[2] = 'é'.repeat(64);
  assert.equal(verifySessionToken(parts.join('.')), null);
});

test('late approval cannot revive rejected or cancelled bookings', async () => {
  for (const status of ['rejected', 'cancelled']) {
    const store = new MemoryStore();
    const marketId = `qa-terminal-${status}`;
    const boothId = `${marketId}-booth`;
    await store.createBooth(booth(marketId, boothId));
    const booking = await store.createInquiry(marketId, { ...vendor, boothId, dates: ['2026-10-03'] }, 40);
    await store.setBookingStatus(marketId, booking.id, status);
    assert.equal((await store.approveBooking(marketId, booking.id)).ok, false);
    assert.equal((await store.getBooking(marketId, booking.id)).status, status);
    assert.equal((await store.boothsWithAvailability(marketId, ['2026-10-03'], false))[0].status, 'available');
  }
});

test('repeated approval is recognized without another state transition', async () => {
  const store = new MemoryStore();
  await store.createBooth(booth('qa-replay', 'qa-replay-booth'));
  const booking = await store.createInquiry('qa-replay', { ...vendor, boothId: 'qa-replay-booth', dates: ['2026-10-03'] }, 40);
  const first = await store.approveBooking('qa-replay', booking.id);
  const second = await store.approveBooking('qa-replay', booking.id);
  assert.equal(first.ok, true);
  assert.equal(first.alreadyApproved, undefined);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyApproved, true);
});
