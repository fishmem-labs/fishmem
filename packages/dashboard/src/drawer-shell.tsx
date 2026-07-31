"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "./utils";

/**
 * Right-side drawer chrome shared by the request/memory drawers: a dimmed
 * click-to-close overlay and a panel that slides in/out. Stays mounted through
 * the exit transition (caching the last children) so closing animates too.
 */
export function DrawerShell({
  open,
  onClose,
  children,
  widthClass = "max-w-[760px]",
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  widthClass?: string;
}) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const last = useRef<React.ReactNode>(null);
  if (open) last.current = children;

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const id = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mounted, onClose]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50">
      <button
        aria-label="Close"
        className={cn(
          "absolute inset-0 bg-foreground/40 transition-opacity duration-200",
          shown ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
        type="button"
      />
      <div
        className={cn(
          "absolute inset-y-0 right-0 flex w-full flex-col border-l border-border bg-background shadow-[0_0_60px_rgba(0,0,0,0.18)] transition-transform duration-200 ease-out",
          widthClass,
          shown ? "translate-x-0" : "translate-x-full",
        )}
      >
        {last.current}
      </div>
    </div>
  );
}
