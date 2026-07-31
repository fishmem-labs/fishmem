"use client";

import type { ReactNode } from "react";
import { cn } from "./utils";

/**
 * Minimal hover/focus tooltip in the shadcn look (popover surface, small text),
 * built without a radix dependency. Wrap a focusable trigger; pass the copy as
 * `content`. Shows above the trigger on hover or keyboard focus.
 */
export function Tooltip({
  content,
  children,
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        className={cn(
          "pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-max max-w-[240px] -translate-x-1/2 rounded-md bg-popover px-2.5 py-1.5 text-[12px] leading-snug text-popover-foreground opacity-0 shadow-lg ring-1 ring-foreground/10 transition-opacity group-hover/tt:opacity-100 group-focus-within/tt:opacity-100",
          className,
        )}
        role="tooltip"
      >
        {content}
      </span>
    </span>
  );
}
