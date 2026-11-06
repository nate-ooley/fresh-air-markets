/**
 * Search, status filter and sort for the staff Applications list. Runs in the
 * browser on the list the page already loaded.
 */

export type ApplicationSort = "newest" | "oldest" | "name" | "status";

export const SORT_LABEL: Record<ApplicationSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  name: "Business name A–Z",
  status: "Status",
};

/** Order for "Status": what needs staff attention comes first. */
const STATUS_ORDER = ["unreviewed", "needs_review", "changes_requested", "approved", "declined", "withdrawn"];

export interface ListViewItem {
  id: string;
  reviewState: string;
  submittedAt?: string | null;
  identitySnapshot: { businessName: string; vendorName: string; email: string; phone?: string; category: string } | null;
}

const fold = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
const digits = (text: string) => text.replace(/\D/g, "");
const nameOf = (item: ListViewItem) => fold(item.identitySnapshot?.businessName.trim() || "￿");

/** Every word typed must appear in the business, contact, email, phone or category. */
export function matchesSearch(item: ListViewItem, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const s = item.identitySnapshot;
  if (!s) return false;
  const haystack = fold([s.businessName, s.vendorName, s.email, s.phone ?? "", s.category].join(" "));
  const phone = digits(s.phone ?? "");
  // Phone numbers match on digits alone, so "941 555" finds "(941) 555-0101".
  return words.every(word => haystack.includes(word) || (digits(word).length >= 3 && phone.includes(digits(word))));
}

export function viewApplications<T extends ListViewItem>(items: readonly T[], options: { query: string; status: string; sort: ApplicationSort }): T[] {
  const time = (item: T) => (item.submittedAt ? Date.parse(item.submittedAt) : NaN);
  // Applications with no submitted date stay at the bottom in either direction.
  const byDate = (direction: 1 | -1) => (a: T, b: T) => {
    const ta = time(a), tb = time(b);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return Number(Number.isNaN(ta)) - Number(Number.isNaN(tb));
    return direction * (ta - tb);
  };
  const byName = (a: T, b: T) => nameOf(a).localeCompare(nameOf(b));
  const compare: Record<ApplicationSort, (a: T, b: T) => number> = {
    newest: (a, b) => byDate(-1)(a, b) || byName(a, b),
    oldest: (a, b) => byDate(1)(a, b) || byName(a, b),
    name: (a, b) => byName(a, b) || byDate(-1)(a, b),
    status: (a, b) => STATUS_ORDER.indexOf(a.reviewState) - STATUS_ORDER.indexOf(b.reviewState) || byName(a, b),
  };
  return items
    .filter(item => (options.status === "all" || item.reviewState === options.status) && matchesSearch(item, options.query))
    .sort(compare[options.sort]);
}
