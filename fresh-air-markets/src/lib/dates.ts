/**
 * The market is open Friday–Sunday. Public booking offers the next
 * N upcoming weekends, each weekend being a group of open days.
 */
export const OPEN_DOW = [5, 6, 0]; // Fri, Sat, Sun
export const WEEKENDS_AHEAD = 8;

export interface MarketWeekend {
  key: string; // key = the Friday date, YYYY-MM-DD
  label: string; // e.g. "Jul 3 – 5"
  dates: { date: string; dow: string }[];
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shortLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Upcoming market weekends starting from `from` (defaults to today, UTC). */
export function upcomingWeekends(from = new Date(), count = WEEKENDS_AHEAD): MarketWeekend[] {
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  // Walk to the coming Friday (if today is Sat/Sun, this weekend's Friday already passed —
  // still include remaining open days of the current weekend).
  const day = start.getUTCDay();
  const sinceFriday = (day - 5 + 7) % 7;
  const friday = new Date(start);
  friday.setUTCDate(start.getUTCDate() - (sinceFriday <= 2 ? sinceFriday : sinceFriday - 7));

  const weekends: MarketWeekend[] = [];
  for (let i = 0; i < count; i++) {
    const fri = new Date(friday);
    fri.setUTCDate(friday.getUTCDate() + i * 7);
    const dates: MarketWeekend["dates"] = [];
    for (const offset of [0, 1, 2]) {
      const d = new Date(fri);
      d.setUTCDate(fri.getUTCDate() + offset);
      if (d < start) continue; // skip days already past within current weekend
      dates.push({
        date: fmt(d),
        dow: d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
      });
    }
    if (dates.length === 0) continue;
    const first = new Date(dates[0].date + "T00:00:00Z");
    const last = new Date(dates[dates.length - 1].date + "T00:00:00Z");
    weekends.push({
      key: fmt(fri),
      label: dates.length > 1 ? `${shortLabel(first)} – ${last.getUTCDate()}` : shortLabel(first),
      dates,
    });
  }
  return weekends;
}

/** All valid bookable dates (flat set) for validation. */
export function bookableDates(): Set<string> {
  const set = new Set<string>();
  for (const w of upcomingWeekends()) for (const d of w.dates) set.add(d.date);
  return set;
}

export function prettyDate(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
