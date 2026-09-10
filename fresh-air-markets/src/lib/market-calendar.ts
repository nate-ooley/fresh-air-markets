import { upcomingWeekends, type MarketWeekend } from "./dates";
import { FRESH_AIR_SEASON_DATES } from "./fresh-air-season";

type CalendarEnvironment = { [key: string]: string | undefined; FAME_MARKET_ACCOUNT_ID?: string; FAME_SEASON_ID?: string };

/** Shared server-side calendar for page rendering and API validation.
 * The configured market gets its confirmed season; other tenants retain their
 * own existing demo behavior. Unsupported Fresh Air seasons fail closed.
 */
export function marketWeekends(
  marketId: string,
  env: CalendarEnvironment = process.env,
  from = new Date(),
  includePast = false,
): MarketWeekend[] {
  const configured = env.FAME_MARKET_ACCOUNT_ID?.trim();
  if (!configured || marketId !== configured) return upcomingWeekends(from);
  if (env.FAME_SEASON_ID !== "2026-2027") return [];
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(from);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  return FRESH_AIR_SEASON_DATES.filter(date => includePast || date >= today).map(date => ({
    key: date,
    label: new Date(date + "T12:00:00Z").toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    }),
    dates: [{ date, dow: "Sat" }],
  }));
}

export function marketBookableDates(
  marketId: string,
  env: CalendarEnvironment = process.env,
  from = new Date(),
  includePast = false,
): Set<string> {
  return new Set(marketWeekends(marketId, env, from, includePast).flatMap(group => group.dates.map(day => day.date)));
}
