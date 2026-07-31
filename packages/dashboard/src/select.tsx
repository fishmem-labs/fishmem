"use client";

import { Check, ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { useClickOutside } from "./use-click-outside";
import { cn } from "./utils";

export type SelectOption<T extends string> = {
  value: T;
  label: string;
};

/**
 * Token-styled custom select (replaces the browser-native `<select>`): a
 * popover listbox with a check on the active option and click-outside to close.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  align = "left",
  className,
  placeholder = "Select",
  disabled = false,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<SelectOption<T>>;
  size?: "sm" | "md";
  align?: "left" | "right";
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  const current = options.find((o) => o.value === value);

  return (
    <div className="relative" ref={ref}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "inline-flex items-center justify-between gap-1.5 rounded-lg border border-input bg-background text-foreground outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-background",
          size === "sm" ? "h-7 px-2 text-xs" : "h-9 px-3 text-[13px]",
          className,
        )}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span className="truncate">{current?.label ?? placeholder}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open ? (
        <div
          className={cn(
            "absolute z-40 mt-1 min-w-[8rem] overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10",
            align === "right" ? "right-0" : "left-0",
          )}
          role="listbox"
        >
          {options.map((o) => (
            <button
              aria-selected={o.value === value}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent",
                o.value === value && "bg-accent",
              )}
              key={o.value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              role="option"
              type="button"
            >
              <span className="flex-1 truncate">{o.label}</span>
              {o.value === value ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
