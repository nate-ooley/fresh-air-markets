import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  finalReservationEligibilityReason,
  finalReservationSelectionFingerprint,
  parseFinalReservationSelection,
  preflightFinalReservation,
} = require("../.test-build/final-reservation.js") as typeof import("../src/lib/final-reservation");
const { freshAirFinalReservationConfig } = require("../.test-build/final-reservation-pg.js") as typeof import("../src/lib/final-reservation-pg");

const key = "11111111-1111-4111-8111-111111111111";
const selectionBody = {
  applicantType: "Vendor",
  vendorCategory: "Arts & Crafts",
  selectedDates: ["2026-10-24", "2026-10-03", "2026-10-10", "2026-10-17"],
  fullSeason: false,
  boothsPerMarket: 2,
  foodLicenseRequired: false,
};

function selection() {
  const parsed = parseFinalReservationSelection(selectionBody, key);
  assert.ok(parsed);
  return parsed;
}

test("final reservation input excludes browser identity, pricing and payment controls", () => {
  assert.deepEqual(selection(), {
    ...selectionBody,
    selectedDates: ["2026-10-03", "2026-10-10", "2026-10-17", "2026-10-24"],
    idempotencyKey: key,
  });
  for (const body of [
    { ...selectionBody, totalCents: 1 },
    { ...selectionBody, applicationId: "22222222-2222-4222-8222-222222222222" },
    { ...selectionBody, reservationId: "other" },
    { ...selectionBody, selectedDates: ["2026-10-03", "2026-10-03"] },
    { ...selectionBody, boothsPerMarket: 1.5 },
  ]) assert.equal(parseFinalReservationSelection(body, key), null);
  assert.equal(parseFinalReservationSelection(selectionBody, "not-a-retry-key"), null);
});

test("CHECK preflight derives lock dates using zero inventory, then retains the canonical consecutive quote", () => {
  const quote = preflightFinalReservation({
    dates: ["2026-10-03", "2026-10-10", "2026-10-17", "2026-10-24"],
    boothCapacity: 12,
  }, selection());
  assert.deepEqual(quote.dates, ["2026-10-03", "2026-10-10", "2026-10-17", "2026-10-24"]);
  assert.equal(quote.tier, "consecutive");
  assert.equal(quote.totalCents, 28_000);
  assert.equal(quote.allDatesAvailable, true);
});

test("eligibility fails closed until the approved source, agreement, insurance and required food license all agree", () => {
  const complete = {
    applicationApproved: true,
    approvedSourceIsCurrent: true,
    agreementSigned: true,
    insuranceApproved: true,
    foodLicenseApproved: true,
  };
  assert.equal(finalReservationEligibilityReason(complete, { foodLicenseRequired: true }), null);
  assert.equal(finalReservationEligibilityReason({ ...complete, approvedSourceIsCurrent: false }, { foodLicenseRequired: false }), "application_not_approved");
  assert.equal(finalReservationEligibilityReason({ ...complete, agreementSigned: false }, { foodLicenseRequired: false }), "agreement_not_signed");
  assert.equal(finalReservationEligibilityReason({ ...complete, insuranceApproved: false }, { foodLicenseRequired: false }), "insurance_not_approved");
  assert.equal(finalReservationEligibilityReason({ ...complete, foodLicenseApproved: false }, { foodLicenseRequired: true }), "food_license_not_approved");
  assert.equal(finalReservationEligibilityReason({ ...complete, foodLicenseApproved: false }, { foodLicenseRequired: false }), null);
});

test("finalization fingerprint is replay-stable only for the exact canonical manager selection", () => {
  const original = selection();
  assert.equal(
    finalReservationSelectionFingerprint("22222222-2222-4222-8222-222222222222", original),
    finalReservationSelectionFingerprint("22222222-2222-4222-8222-222222222222", { ...original }),
  );
  assert.notEqual(
    finalReservationSelectionFingerprint("22222222-2222-4222-8222-222222222222", original),
    finalReservationSelectionFingerprint("22222222-2222-4222-8222-222222222222", { ...original, boothsPerMarket: 1 }),
  );
});

test("the reserve writer refuses to guess a tenant, season or market-wide capacity", () => {
  assert.throws(() => freshAirFinalReservationConfig({
    FAME_MARKET_ACCOUNT_ID: "qa-market", FAME_SEASON_ID: "2026-2027",
  }));
  assert.throws(() => freshAirFinalReservationConfig({
    FAME_MARKET_ACCOUNT_ID: "qa-market", FAME_SEASON_ID: "2027-2028", FAME_BOOTH_CAPACITY: "20",
  }));
  assert.deepEqual(freshAirFinalReservationConfig({
    FAME_MARKET_ACCOUNT_ID: "qa-market", FAME_SEASON_ID: "2026-2027", FAME_BOOTH_CAPACITY: "20",
  }).boothCapacity, 20);
});
