"use client";

import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { inputClass } from "@fishmem/dashboard/page-shell";
import { cn } from "@/lib/utils";

/** Centered modal for creating a project — name (required) + description
 * (optional). Animates in over a dimmed, click-to-close overlay. */
export function CreateProjectDialog({
  open,
  loading,
  onClose,
  onCreate,
}: {
  open: boolean;
  loading?: boolean;
  onClose: () => void;
  onCreate: (value: { name: string; description: string }) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
    }
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        aria-label="Close"
        className="absolute inset-0 animate-in fade-in bg-foreground/40 duration-150"
        disabled={loading}
        onClick={onClose}
        type="button"
      />
      <form
        className="relative z-10 w-full max-w-[440px] animate-in fade-in zoom-in-95 rounded-xl bg-popover p-5 text-popover-foreground shadow-[0_24px_64px_rgba(0,0,0,0.24)] ring-1 ring-foreground/10 duration-150"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onCreate({ name: name.trim(), description: description.trim() });
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Create project
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

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-foreground">
              Name
            </label>
            <input
              autoFocus
              className={inputClass}
              onChange={(e) => setName(e.target.value)}
              placeholder="My project"
              value={name}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-foreground">
              Description{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </label>
            <textarea
              className={cn(inputClass, "h-auto min-h-[72px] py-2 leading-relaxed")}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this project is for."
              value={description}
            />
          </div>
        </div>

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
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
            disabled={!name.trim() || loading}
            type="submit"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Create project
          </button>
        </div>
      </form>
    </div>
  );
}
