const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rosterForDate, seasonOverview, rosterCsv, validRosterDate } = require('../.test-build/market-roster.js');

const vendor = (patch) => ({ reservationId: 'r', applicationId: 'a', businessName: 'Biz', vendorName: 'Person', email: 'p@example.com', phone: '', applicantType: 'Vendor', category: 'Produce', booths: 1, dates: ['2026-10-03'], status: 'paid', totalCents: 4000, paymentDueAt: null, ...patch });
const vendors = [
  vendor({ reservationId: 'r1', businessName: 'Sunrise Farms', category: 'Produce', booths: 2, dates: ['2026-10-03', '2026-10-10'] }),
  vendor({ reservationId: 'r2', businessName: 'Apple Acres', category: 'Produce', booths: 1 }),
  vendor({ reservationId: 'r3', businessName: 'Clay Works, "The" Studio', category: 'Arts & Crafts', booths: 1, status: 'pending', paymentDueAt: '2026-09-13T06:20:24.000Z' }),
  vendor({ reservationId: 'r4', businessName: 'Food Bank', applicantType: 'Non-Profit Organization', category: 'Non-Profit Organization', status: 'confirmed', totalCents: 0 }),
  vendor({ reservationId: 'r5', businessName: 'Elsewhere', dates: ['2026-10-17'] }),
  vendor({ reservationId: 'r6', businessName: 'Taco Truck', category: 'Food Truck', booths: 1 }),
  vendor({ reservationId: 'r7', businessName: 'Waffle Truck', category: 'Food Truck', booths: 1, status: 'pending', paymentDueAt: '2026-09-13T06:20:24.000Z' }),
];

test('a date roster groups confirmed and pending vendors by category with booth totals, sorted for reading', () => {
  const day = rosterForDate(vendors, '2026-10-03');
  assert.deepEqual(day.confirmed.map(g => [g.category, g.booths, g.vendors.map(v => v.businessName)]), [
    ['Food Truck', 1, ['Taco Truck']],
    ['Non-Profit Organization', 1, ['Food Bank']],
    ['Produce', 3, ['Apple Acres', 'Sunrise Farms']],
  ]);
  assert.deepEqual(day.pending.map(g => [g.category, g.booths]), [['Arts & Crafts', 1], ['Food Truck', 1]]);
  assert.deepEqual(day.totals, { confirmedVendors: 4, confirmedBooths: 4, confirmedFoodTrucks: 1, pendingVendors: 2, pendingBooths: 1, pendingFoodTrucks: 1 });
  const later = rosterForDate(vendors, '2026-10-10');
  assert.deepEqual(later.totals, { confirmedVendors: 1, confirmedBooths: 2, confirmedFoodTrucks: 0, pendingVendors: 0, pendingBooths: 0, pendingFoodTrucks: 0 });
  assert.deepEqual(rosterForDate(vendors, '2026-12-05').totals, { confirmedVendors: 0, confirmedBooths: 0, confirmedFoodTrucks: 0, pendingVendors: 0, pendingBooths: 0, pendingFoodTrucks: 0 });
});

test('the season overview counts booths per date against capacity and never reports negative open booths', () => {
  const season = seasonOverview(vendors, ['2026-10-03', '2026-10-10', '2026-10-17'], 4, 4);
  assert.deepEqual(season, [
    { date: '2026-10-03', confirmedVendors: 4, confirmedBooths: 4, pendingBooths: 1, capacity: 4, openBooths: 0, foodTrucks: 1, pendingFoodTrucks: 1, foodTruckCapacity: 4, openFoodTrucks: 2 },
    { date: '2026-10-10', confirmedVendors: 1, confirmedBooths: 2, pendingBooths: 0, capacity: 4, openBooths: 2, foodTrucks: 0, pendingFoodTrucks: 0, foodTruckCapacity: 4, openFoodTrucks: 4 },
    { date: '2026-10-17', confirmedVendors: 1, confirmedBooths: 1, pendingBooths: 0, capacity: 4, openBooths: 3, foodTrucks: 0, pendingFoodTrucks: 0, foodTruckCapacity: 4, openFoodTrucks: 4 },
  ]);
});

test('the spreadsheet lists confirmed rows first, quotes commas and quotes, and only accepts season dates', () => {
  const csv = rosterCsv(vendors, '2026-10-03');
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines[0], 'Market date,Status,Category,Business,Contact,Email,Phone,Booths,Type');
  assert.equal(lines.length, 7);
  assert.equal(lines[1], '2026-10-03,Paid,Food Truck,Taco Truck,Person,p@example.com,,1,Vendor');
  assert.equal(lines[2], '2026-10-03,Confirmed (no payment due),Non-Profit Organization,Food Bank,Person,p@example.com,,1,Non-Profit Organization');
  assert.equal(lines[3], '2026-10-03,Paid,Produce,Apple Acres,Person,p@example.com,,1,Vendor');
  assert.equal(lines[5], '2026-10-03,Payment pending,Arts & Crafts,"Clay Works, ""The"" Studio",Person,p@example.com,,1,Vendor');
  assert.equal(validRosterDate('2026-10-03', ['2026-10-03']), true);
  assert.equal(validRosterDate('2026-10-04', ['2026-10-03']), false);
  assert.equal(validRosterDate(undefined, ['2026-10-03']), false);
});
