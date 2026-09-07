import { test } from "node:test";
import assert from "node:assert/strict";
import { checkVendorBooking, readyForDateSelection } from "../src/lib/vendor-booking-rules.ts";

const dates = ["2026-10-03", "2026-10-10", "2026-10-17", "2026-10-24", "2026-11-07", "2026-11-14"];
const calendar = { dates, boothCapacity: 20 };
const base = { applicantType: "Vendor" as const, vendorCategory: "Arts & Crafts", selectedDates: [dates[0]], fullSeason: false, boothsPerMarket: 1 };
const empty = dates.map(date => ({ date, booths: 0, foodTrucks: 0, nonprofits: 0 }));

test("standard single date uses $40 per final booth", () => {
  assert.equal(checkVendorBooking(calendar, base, empty).totalCents, 4000);
  assert.equal(checkVendorBooking(calendar, { ...base, boothsPerMarket: 2 }, empty).totalCents, 8000);
});

test("four and five consecutive markets use $35, including a calendar holiday gap", () => {
  for (const count of [4, 5]) {
    const quote = checkVendorBooking(calendar, { ...base, selectedDates: dates.slice(0, count), boothsPerMarket: 2 }, empty);
    assert.equal(quote.rateCents, 3500);
    assert.equal(quote.totalCents, count * 3500 * 2);
  }
});

test("nonconsecutive selection stays at $40 even with a four-date run", () => {
  const quote = checkVendorBooking(calendar, { ...base, selectedDates: [...dates.slice(0, 4), dates[5]] }, empty);
  assert.equal(quote.rateCents, 4000);
});

test("Full Season expands the configured calendar and uses $30 per booth", () => {
  const quote = checkVendorBooking(calendar, { ...base, selectedDates: [], fullSeason: true, boothsPerMarket: 2 }, empty);
  assert.equal(quote.dates.length, 6);
  assert.equal(quote.totalCents, 36000);
});

test("nonprofits are free by applicant type and skip payment", () => {
  const quote = checkVendorBooking(calendar, { ...base, applicantType: "Non-Profit Organization", boothsPerMarket: 2 }, empty);
  assert.equal(quote.totalCents, 0);
  assert.equal(quote.paymentRequired, false);
});

test("the fifth Food Truck and second nonprofit are unavailable", () => {
  const occupied = empty.map(row => ({ ...row, foodTrucks: 4, nonprofits: 1 }));
  assert.equal(checkVendorBooking(calendar, { ...base, vendorCategory: "Food Truck" }, occupied).allDatesAvailable, false);
  assert.equal(checkVendorBooking(calendar, { ...base, applicantType: "Non-Profit Organization" }, occupied).allDatesAvailable, false);
  assert.equal(checkVendorBooking(calendar, base, occupied).allDatesAvailable, true);
  assert.equal(checkVendorBooking(calendar, { ...base, vendorCategory: "Food Truck" }, empty.map(r => ({ ...r, foodTrucks: 3 }))).allDatesAvailable, true);
});

test("multiple booths consume multiple spaces", () => {
  const occupied = empty.map(row => ({ ...row, booths: 19 }));
  assert.equal(checkVendorBooking(calendar, base, occupied).allDatesAvailable, true);
  assert.equal(checkVendorBooking(calendar, { ...base, boothsPerMarket: 2 }, occupied).allDatesAvailable, false);
});

test("partial availability preserves the whole quote and revision reprices", () => {
  const occupied = empty.map((row, i) => ({ ...row, booths: i === 1 ? 20 : 0 }));
  const quote = checkVendorBooking(calendar, { ...base, selectedDates: dates.slice(0, 4) }, occupied);
  assert.equal(quote.totalCents, 14000);
  assert.deepEqual(quote.unavailableDates, [dates[1]]);
  const revised = checkVendorBooking(calendar, { ...base, selectedDates: quote.availableDates }, occupied);
  assert.equal(revised.totalCents, 12000);
  assert.equal(revised.rateCents, 4000);
});

test("duplicate selected dates are normalized and input is not mutated", () => {
  const request = { ...base, selectedDates: [dates[1], dates[0], dates[1]] };
  const quote = checkVendorBooking(calendar, request, empty);
  assert.deepEqual(quote.dates, dates.slice(0, 2));
  assert.equal(quote.totalCents, 8000);
  assert.equal(request.selectedDates.length, 3);
});

test("invalid dates, missing occupancy, ambiguous season and invalid booth counts fail closed", () => {
  assert.throws(() => checkVendorBooking({ ...calendar, dates: [] }, base, empty));
  assert.throws(() => checkVendorBooking({ ...calendar, dates: ["2026-02-30"] }, base, empty));
  assert.throws(() => checkVendorBooking(calendar, { ...base, selectedDates: ["2026-10-04"] }, empty));
  assert.throws(() => checkVendorBooking(calendar, { ...base, fullSeason: true }, empty));
  assert.throws(() => checkVendorBooking(calendar, base, []));
  assert.throws(() => checkVendorBooking(calendar, base, [...empty, empty[0]]));
  for (const boothsPerMarket of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => checkVendorBooking(calendar, { ...base, boothsPerMarket }, empty));
  }
});

const ready = { applicationStatus: "Approved", agreementStatus: "Signed", insuranceStatus: "Approved", foodLicenseRequired: true, foodLicenseStatus: "Approved" };
test("document gate requires explicit approval or a deliberate Not Required decision", () => {
  assert.equal(readyForDateSelection(ready), true);
  for (const foodLicenseStatus of ["Requested", "Submitted", "Needs Correction", "Not Required", ""]) {
    assert.equal(readyForDateSelection({ ...ready, foodLicenseStatus }), false);
  }
  assert.equal(readyForDateSelection({ ...ready, foodLicenseRequired: null }), false);
  assert.equal(readyForDateSelection({ ...ready, foodLicenseRequired: false, foodLicenseStatus: "Not Required" }), true);
  assert.equal(readyForDateSelection({ ...ready, agreementStatus: "Sent" }), false);
  assert.equal(readyForDateSelection({ ...ready, insuranceStatus: "Needs Correction" }), false);
  assert.equal(readyForDateSelection({ ...ready, applicationStatus: "Waitlist" }), false);
});
