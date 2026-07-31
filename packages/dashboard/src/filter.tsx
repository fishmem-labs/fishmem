"use client";

import { Check, Plus, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Select } from "./select";
import { useClickOutside } from "./use-click-outside";
import { cn } from "./utils";

// ---------------------------------------------------------------------------
// Generic param / operator / value filter, applied client-side. Each page
// supplies its own param list (with icons) and a getField(row, param) reader.
// ---------------------------------------------------------------------------

export type FilterOp = "equals" | "not_equals" | "contains";

export const FILTER_OPS: Array<{ value: FilterOp; label: string }> = [
  { value: "equals", label: "= equals" },
  { value: "not_equals", label: "≠ not equals" },
  { value: "contains", label: "∋ contains" },
];

export type FilterParamDef = { value: string; label: string; icon: LucideIcon };

export type FilterCondition = {
  id: string;
  param: string;
  op: FilterOp;
  value: string;
};

export type Filter = { match: "all" | "any"; conditions: FilterCondition[] };

export const EMPTY_FILTER: Filter = { match: "all", conditions: [] };

export function activeConditionCount(filter: Filter): number {
  return filter.conditions.filter((c) => c.value.trim()).length;
}

function matchOne(
  field: string | string[],
  cond: FilterCondition,
): boolean {
  const expected = cond.value.trim().toLowerCase();
  if (!expected) return true; // incomplete row → ignore
  const fields = (Array.isArray(field) ? field : [field])
    .map((s) => s.toLowerCase())
    .filter(Boolean);
  switch (cond.op) {
    case "equals":
      return fields.includes(expected);
    case "not_equals":
      return !fields.includes(expected);
    case "contains":
      return fields.some((f) => f.includes(expected));
  }
}

/** Filter rows; `getField` returns the value(s) of `param` for a row. */
export function applyFilter<T>(
  rows: T[],
  filter: Filter,
  getField: (row: T, param: string) => string | string[],
): T[] {
  const active = filter.conditions.filter((c) => c.value.trim());
  if (active.length === 0) return rows;
  return rows.filter((row) =>
    filter.match === "all"
      ? active.every((c) => matchOne(getField(row, c.param), c))
      : active.some((c) => matchOne(getField(row, c.param), c)),
  );
}

function ParamDropdown({
  params,
  value,
  onChange,
}: {
  params: FilterParamDef[];
  value: string;
  onChange: (param: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  const current = params.find((p) => p.value === value) ?? params[0]!;
  const Icon = current.icon;

  return (
    <div className="relative" ref={ref}>
      <button
        aria-expanded={open}
        className="flex h-9 w-full items-center gap-2 rounded-lg border border-input bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted aria-expanded:bg-muted"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-left">{current.label}</span>
      </button>
      {open ? (
        <div className="absolute left-0 top-10 z-20 w-52 rounded-lg bg-popover p-1 shadow-lg ring-1 ring-foreground/10">
          {params.map((p) => {
            const PIcon = p.icon;
            return (
              <button
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-accent"
                key={p.value}
                onClick={() => {
                  onChange(p.value);
                  setOpen(false);
                }}
                type="button"
              >
                <PIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1">{p.label}</span>
                {p.value === value ? (
                  <Check className="h-4 w-4 text-foreground" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function FilterPopover({
  value,
  onChange,
  params,
  triggerClassName,
}: {
  value: Filter;
  onChange: (filter: Filter) => void;
  params: FilterParamDef[];
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Filter>(value);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  const activeCount = activeConditionCount(value);
  const newCondition = (): FilterCondition => ({
    id: crypto.randomUUID(),
    param: params[0]!.value,
    op: "equals",
    value: "",
  });

  const openPopover = () => {
    setDraft(value.conditions.length ? value : { match: "all", conditions: [newCondition()] });
    setOpen(true);
  };

  const setCondition = (id: string, patch: Partial<FilterCondition>) =>
    setDraft((d) => ({
      ...d,
      conditions: d.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));

  return (
    <div className="relative" ref={ref}>
      <button
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted",
          activeCount > 0 && "border-foreground/30",
          triggerClassName,
        )}
        onClick={() => (open ? setOpen(false) : openPopover())}
        type="button"
      >
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M3 6h18M7 12h10M11 18h2" strokeLinecap="round" />
        </svg>
        Filters
        {activeCount > 0 ? (
          <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-brand-foreground">
            {activeCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-10 z-40 w-[min(640px,calc(100vw-2rem))] rounded-xl bg-popover p-4 shadow-[0_18px_50px_rgba(0,0,0,0.16)] ring-1 ring-foreground/10">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-muted-foreground">Match</span>
            <Select<"all" | "any">
              onChange={(v) => setDraft((d) => ({ ...d, match: v }))}
              options={[
                { value: "all", label: "all" },
                { value: "any", label: "any" },
              ]}
              size="sm"
              value={draft.match}
            />
            <span className="text-[13px] text-muted-foreground">
              filters in this group
            </span>
          </div>

          <div className="mt-4 space-y-2">
            {draft.conditions.map((cond) => (
              <div
                className="grid grid-cols-[1.1fr_1fr_1.2fr_auto] items-center gap-2"
                key={cond.id}
              >
                <ParamDropdown
                  onChange={(param) => setCondition(cond.id, { param })}
                  params={params}
                  value={cond.param}
                />
                <Select<FilterOp>
                  className="w-full"
                  onChange={(op) => setCondition(cond.id, { op })}
                  options={FILTER_OPS.map((op) => ({
                    value: op.value,
                    label: op.label,
                  }))}
                  value={cond.op}
                />
                <input
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  onChange={(e) => setCondition(cond.id, { value: e.target.value })}
                  placeholder="Value"
                  value={cond.value}
                />
                <button
                  aria-label="Remove filter"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      conditions: d.conditions.filter((c) => c.id !== cond.id),
                    }))
                  }
                  type="button"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  conditions: [...d.conditions, newCondition()],
                }))
              }
              type="button"
            >
              <Plus className="h-4 w-4" />
              Add Filter
            </button>
            <div className="ml-auto flex items-center gap-2">
              <button
                className="inline-flex h-8 items-center rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={() => {
                  setDraft(EMPTY_FILTER);
                  onChange(EMPTY_FILTER);
                  setOpen(false);
                }}
                type="button"
              >
                Remove Filters
              </button>
              <button
                className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80"
                onClick={() => {
                  onChange({
                    ...draft,
                    conditions: draft.conditions.filter((c) => c.value.trim()),
                  });
                  setOpen(false);
                }}
                type="button"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
