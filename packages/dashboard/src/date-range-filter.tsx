"use client";

import { CalendarDays, ChevronDown, X } from "lucide-react";
import { useRef, useState } from "react";
import { Calendar, type DateRange } from "./calendar";
import { useClickOutside } from "./use-click-outside";
import { cn } from "./utils";

export type TimeWindow =
  | { kind: "all" }
  | { kind: "today" }
  | { kind: "7d" }
  | { kind: "30d" }
  | { kind: "range"; from: string; to: string };

const PRESETS: Array<{ kind: TimeWindow["kind"]; label: string }> = [
  { kind: "all", label: "All Time" },
  { kind: "today", label: "1d" },
  { kind: "7d", label: "7d" },
  { kind: "30d", label: "30d" },
];

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function toISO(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmt(d: string) {
  if (!d) return "";
  try {
    return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return d;
  }
}

export function windowLabel(w: TimeWindow): string {
  if (w.kind === "range") {
    return `${fmt(w.from) || "Start"} – ${fmt(w.to) || "End"}`;
  }
  return PRESETS.find((p) => p.kind === w.kind)?.label ?? "All Time";
}

const DAY = 86400000;

/** Whether an ISO timestamp falls inside the selected window. */
export function windowContains(iso: string, w: TimeWindow): boolean {
  if (w.kind === "all") return true;
  const t = new Date(iso).getTime();
  const now = Date.now();
  if (w.kind === "today") return now - t <= DAY;
  if (w.kind === "7d") return now - t <= 7 * DAY;
  if (w.kind === "30d") return now - t <= 30 * DAY;
  const from = w.from ? new Date(`${w.from}T00:00:00`).getTime() : -Infinity;
  const to = w.to ? new Date(`${w.to}T23:59:59`).getTime() : Infinity;
  return t >= from && t <= to;
}

function toDraft(w: TimeWindow): DateRange {
  if (w.kind === "range") {
    return {
      from: w.from ? new Date(`${w.from}T00:00:00`) : undefined,
      to: w.to ? new Date(`${w.to}T00:00:00`) : undefined,
    };
  }
  return {};
}

export function DateRangeFilter({
  value,
  onChange,
}: {
  value: TimeWindow;
  onChange: (w: TimeWindow) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(toDraft(value));
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  const isDefault = value.kind === "all";

  return (
    <div className="relative" ref={ref}>
      {/* FilterPill (vagent /flows style): default vs inverted-active */}
      <div
        aria-label="Date range filter"
        className={cn(
          "flex h-8 cursor-pointer select-none items-center rounded-lg border px-2 text-[13px] font-medium transition-colors",
          isDefault
            ? "border-border bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:bg-muted data-[state=open]:bg-muted"
            : "border-foreground bg-foreground text-background",
        )}
        data-state={open ? "open" : "closed"}
        onClick={() => {
          setDraft(toDraft(value));
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen((v) => !v);
        }}
        role="button"
        tabIndex={0}
      >
        {isDefault ? (
          <>
            <span className="relative h-4 w-4">
              <CalendarDays className="absolute inset-px h-3.5 w-3.5" />
            </span>
            <span className="px-1">Pick a date range</span>
            <span className="relative h-4 w-4">
              <ChevronDown className="absolute inset-px h-3.5 w-3.5" />
            </span>
          </>
        ) : (
          <>
            <button
              aria-label="Clear date range"
              className="relative h-4 w-4 shrink-0 rounded-full transition-colors hover:bg-background/20"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDraft({});
                onChange({ kind: "all" });
              }}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              type="button"
            >
              <X className="absolute inset-px h-3.5 w-3.5" />
            </button>
            <span className="pl-0.5 pr-1">Date range</span>
            <span className="ml-1 flex max-w-[12rem] items-center border-l border-background/30 pl-2 pr-1">
              <span className="block truncate">{windowLabel(value)}</span>
            </span>
          </>
        )}
      </div>

      {open ? (
        <div className="absolute right-0 top-10 z-40 w-72 rounded-md bg-popover p-3 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/10">
          <div className="flex flex-col gap-1">
            {PRESETS.map((p) => (
              <button
                className={cn(
                  "flex h-8 w-full items-center rounded-md px-2.5 text-[13px] font-medium transition-colors",
                  value.kind === p.kind
                    ? "bg-foreground text-background"
                    : "text-foreground hover:bg-accent",
                )}
                key={p.kind}
                onClick={() => {
                  onChange({ kind: p.kind } as TimeWindow);
                  setOpen(false);
                }}
                type="button"
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="my-3 border-t border-border" />

          <Calendar onChange={setDraft} value={draft} />

          <button
            className="mt-3 h-8 w-full rounded-md bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-50"
            disabled={!draft.from}
            onClick={() => {
              if (!draft.from) return;
              const to = draft.to ?? draft.from;
              onChange({ kind: "range", from: toISO(draft.from), to: toISO(to) });
              setOpen(false);
            }}
            type="button"
          >
            {draft.from
              ? `Apply ${fmt(toISO(draft.from))} – ${fmt(toISO(draft.to ?? draft.from))}`
              : "Select a date range"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
