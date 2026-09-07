import { test } from "node:test";
import assert from "node:assert/strict";
import { FRESH_AIR_SEASON_DATES } from "../src/lib/fresh-air-season.ts";
import { checkVendorBooking } from "../src/lib/vendor-booking-rules.ts";

test("Fresh Air calendar has 35 unique Saturdays ending May 29, not Thursday May 27", () => {
  const dates = [...FRESH_AIR_SEASON_DATES];
  assert.equal(dates.length, 35);
  assert.equal(new Set(dates).size, 35);
  assert.equal(dates[0], "2026-10-03");
  assert.equal(dates.at(-1), "2027-05-29");
  assert.equal(dates.includes("2027-05-27" as typeof dates[number]), false);
  for (const date of dates) assert.equal(new Date(date + "T00:00:00Z").getUTCDay(), 6);
});

test("Full Season quote uses every configured Saturday and final booth quantity", () => {
  const dates = [...FRESH_AIR_SEASON_DATES];
  const quote = checkVendorBooking({ dates, boothCapacity: 20 }, { applicantType: "Vendor", vendorCategory: "Produce", selectedDates: [], fullSeason: true, boothsPerMarket: 2 }, dates.map(date => ({ date, booths: 0, foodTrucks: 0, nonprofits: 0 })));
  assert.equal(quote.totalCents, 210000);
  assert.equal(quote.dates.length, dates.length);
});
