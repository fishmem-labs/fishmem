"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "./utils";

export type DateRange = { from?: Date; to?: Date };

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function sameDay(a?: Date, b?: Date) {
  return Boolean(a && b && a.toDateString() === b.toDateString());
}
function addMonths(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/**
 * Minimal range calendar styled to match shadcn/ui (no react-day-picker dep).
 * Click sets `from`, then `to`; a third click restarts the range.
 */
export function Calendar({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
}) {
  const [view, setView] = useState<Date>(value.from ?? new Date());
  const [hover, setHover] = useState<Date | null>(null);

  const year = view.getFullYear();
  const month = view.getMonth();
  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: Array<Date | null> = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

  const { from, to } = value;
  const inRange = (d: Date) => {
    if (!from) return false;
    const end = to ?? hover;
    if (!end) return false;
    const lo = startOfDay(from < end ? from : end);
    const hi = startOfDay(from < end ? end : from);
    const day = startOfDay(d);
    return day >= lo && day <= hi;
  };

  const pick = (d: Date) => {
    if (!from || (from && to)) {
      onChange({ from: d, to: undefined });
    } else if (d < from) {
      onChange({ from: d, to: from });
    } else {
      onChange({ from, to: d });
    }
  };

  return (
    <div className="select-none">
      <div className="mb-2 flex items-center justify-between">
        <button
          aria-label="Previous month"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => setView(addMonths(view, -1))}
          type="button"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-xs font-medium text-foreground">
          {view.toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
          })}
        </span>
        <button
          aria-label="Next month"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => setView(addMonths(view, 1))}
          type="button"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAYS.map((w) => (
          <div
            className="flex h-6 items-center justify-center text-[11px] font-medium text-muted-foreground"
            key={w}
          >
            {w}
          </div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={`empty-${i}`} />;
          const selected = sameDay(d, from) || sameDay(d, to);
          const ranged = inRange(d) && !selected;
          return (
            <button
              className={cn(
                "flex h-7 items-center justify-center rounded-md text-xs transition-colors",
                selected
                  ? "bg-primary text-primary-foreground"
                  : ranged
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-accent",
              )}
              key={d.toISOString()}
              onClick={() => pick(d)}
              onMouseEnter={() => setHover(d)}
              onMouseLeave={() => setHover(null)}
              type="button"
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
