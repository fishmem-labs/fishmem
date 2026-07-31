"use client";

import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "./utils";

/**
 * Centered modal confirm. For destructive actions pass `confirmText` to require
 * the user to type a phrase (e.g. the project name) before the button enables.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  confirmText,
  destructive,
  loading,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  confirmText?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, loading, onClose]);

  if (!open) return null;

  const armed = !confirmText || typed.trim() === confirmText;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        aria-label="Close"
        className="absolute inset-0 bg-foreground/40"
        disabled={loading}
        onClick={onClose}
        type="button"
      />
      <div className="relative z-10 w-full max-w-[440px] rounded-xl bg-popover p-5 text-popover-foreground shadow-[0_24px_64px_rgba(0,0,0,0.24)] ring-1 ring-foreground/10">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          <button
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            disabled={loading}
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </div>

        {confirmText ? (
          <div className="mt-4">
            <p className="mb-1.5 text-[13px] text-muted-foreground">
              Type{" "}
              <span className="font-mono font-medium text-foreground">
                {confirmText}
              </span>{" "}
              to confirm.
            </p>
            <input
              autoFocus
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmText}
              value={typed}
            />
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            className="inline-flex h-9 items-center rounded-lg border border-border bg-background px-3.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            disabled={loading}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
              destructive
                ? "bg-destructive text-white hover:bg-destructive/90"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
            disabled={!armed || loading}
            onClick={onConfirm}
            type="button"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
