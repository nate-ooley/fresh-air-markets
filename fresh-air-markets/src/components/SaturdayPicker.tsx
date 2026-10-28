"use client";

/**
 * Season Saturdays as tiles grouped by month, for staff booking screens.
 * A Saturday already on the booking looks different from an open weekend,
 * and the change being made (adding / removing) is shown on each tile.
 * Past Saturdays are never shown. Ones already on a booking stay on it
 * (and in its total) without appearing here.
 */

export type TileState = "booked" | "removing" | "adding" | "open" | "kept" | "blocked";

export interface SaturdayPickerProps {
  dates: readonly string[];
  today: string;
  /** Saturdays on the booking being edited (empty when adding a new booking). */
  booked: readonly string[];
  /** The Saturdays that will be on the booking after saving. */
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  /** Why a Saturday can't be chosen (other booking, insurance), or null. */
  blockedReason: (date: string) => string | null;
  disabled?: boolean;
  /** Booked Saturdays belong to other bookings and can't be removed here. */
  lockBooked?: boolean;
}

const MONTH = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const DAY = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function tileState(date: string, props: Pick<SaturdayPickerProps, "today" | "booked" | "selected" | "blockedReason" | "lockBooked">): TileState {
  const onBooking = props.booked.includes(date);
  const picked = props.selected.includes(date);
  if (onBooking && (date < props.today || props.lockBooked)) return "kept";
  if (onBooking) return picked ? "booked" : "removing";
  if (props.blockedReason(date)) return "blocked";
  return picked ? "adding" : "open";
}

const STYLE: Record<TileState, string> = {
  booked: "border-pine bg-pine text-cream",
  kept: "border-pine/40 bg-pine/60 text-cream cursor-not-allowed",
  removing: "border-clay bg-clay/10 text-clay line-through",
  adding: "border-amber bg-amber/20 text-pine-deep ring-2 ring-amber/40",
  open: "border-pine/20 bg-white text-pine-deep hover:border-pine/50 hover:bg-parchment/60",
  blocked: "border-dashed border-ink/15 bg-ink/5 text-ink/35 cursor-not-allowed",
};
const TAG: Record<TileState, string> = {
  booked: "Booked", kept: "Happened", removing: "Removing", adding: "Adding", open: "Open", blocked: "",
};

export default function SaturdayPicker(props: SaturdayPickerProps) {
  const visible = props.dates.filter(date => date >= props.today);
  const months = [...new Set(visible.map(MONTH))];
  const toggle = (date: string, state: TileState) => {
    if (props.disabled || state === "kept" || state === "blocked") return;
    props.onChange(props.selected.includes(date) ? props.selected.filter(d => d !== date) : [...props.selected, date].sort());
  };
  return (
    <div>
      <div className="flex flex-wrap gap-3 text-xs text-ink/70">
        {props.booked.length > 0 && <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-pine" /> Booked now</span>}
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded border border-pine/30 bg-white" /> Open</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded border border-amber bg-amber/20" /> Adding</span>
        {props.booked.length > 0 && <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded border border-clay bg-clay/10" /> Removing</span>}
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded border border-dashed border-ink/20 bg-ink/5" /> Not available</span>
      </div>
      <div className="mt-3 max-h-96 space-y-4 overflow-y-auto rounded-xl border border-pine/15 bg-white p-3">
        {months.map(month => (
          <div key={month}>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">{month}</p>
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {visible.filter(date => MONTH(date) === month).map(date => {
                const state = tileState(date, props);
                const reason = state === "blocked" ? props.blockedReason(date) : null;
                return (
                  <button key={date} type="button" aria-pressed={state === "booked" || state === "adding" || state === "kept"}
                    aria-label={`Saturday ${DAY(date)}: ${reason ?? TAG[state]}`} title={reason ?? undefined}
                    disabled={props.disabled || state === "kept" || state === "blocked"} onClick={() => toggle(date, state)}
                    className={`rounded-lg border px-2 py-2 text-left text-sm transition ${STYLE[state]}`}>
                    <span className="block font-semibold">{DAY(date)}</span>
                    <span className="block text-[11px] opacity-80">{reason ?? (state === "kept" ? (date < props.today ? "Happened" : "Booked") : TAG[state])}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
