import { test } from "node:test";
import assert from "node:assert/strict";
import { viewApplications, matchesSearch } from "../src/lib/application-list-view.ts";

const item = (id: string, businessName: string, reviewState: string, submittedAt: string | null, extra: Partial<{ vendorName: string; email: string; phone: string; category: string }> = {}) => ({
  id, reviewState, submittedAt,
  identitySnapshot: { businessName, vendorName: extra.vendorName ?? "Pat", email: extra.email ?? `${id}@example.com`, phone: extra.phone, category: extra.category ?? "Produce" },
});
const items = [
  item("a", "Zesty Pickles", "approved", "2026-10-02T12:00:00Z", { phone: "(941) 555-0101" }),
  item("b", "aquae Vitae", "unreviewed", "2026-10-05T12:00:00Z", { category: "Beverages" }),
  item("c", "Café Rosa", "withdrawn", "2026-09-01T12:00:00Z", { vendorName: "Rosa Díaz" }),
  { id: "d", reviewState: "needs_review", submittedAt: null, identitySnapshot: null },
];
const ids = (list: { id: string }[]) => list.map(i => i.id);

test("sorts newest, oldest, by name (case- and accent-insensitive) and by status", () => {
  assert.deepEqual(ids(viewApplications(items, { query: "", status: "all", sort: "newest" })), ["b", "a", "c", "d"]);
  // No submitted date sorts last either way.
  assert.deepEqual(ids(viewApplications(items, { query: "", status: "all", sort: "oldest" })), ["c", "a", "b", "d"]);
  assert.deepEqual(ids(viewApplications(items, { query: "", status: "all", sort: "name" })), ["b", "c", "a", "d"]);
  assert.deepEqual(ids(viewApplications(items, { query: "", status: "all", sort: "status" })), ["b", "d", "a", "c"]);
});

test("search matches business, contact, email, category and phone digits; every word must match", () => {
  assert.deepEqual(ids(viewApplications(items, { query: "cafe", status: "all", sort: "name" })), ["c"]);
  assert.deepEqual(ids(viewApplications(items, { query: "diaz", status: "all", sort: "name" })), ["c"]);
  assert.deepEqual(ids(viewApplications(items, { query: "BEVERAGES", status: "all", sort: "name" })), ["b"]);
  assert.deepEqual(ids(viewApplications(items, { query: "555-0101", status: "all", sort: "name" })), ["a"]);
  assert.deepEqual(ids(viewApplications(items, { query: "zesty rosa", status: "all", sort: "name" })), []);
  assert.equal(matchesSearch(items[3], "anything"), false);
  assert.equal(matchesSearch(items[3], "  "), true);
});

test("status filter keeps only that status, and does not change the input", () => {
  const before = ids(items);
  assert.deepEqual(ids(viewApplications(items, { query: "", status: "approved", sort: "newest" })), ["a"]);
  assert.deepEqual(ids(items), before);
});
