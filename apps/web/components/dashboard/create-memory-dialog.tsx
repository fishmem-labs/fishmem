"use client";

import { Info, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  SCOPE_META,
  type ScopeType,
} from "@/components/dashboard/entities-shared";
import { inputClass } from "@fishmem/dashboard/page-shell";
import { Tooltip } from "@fishmem/dashboard/tooltip";
import { cn } from "@/lib/utils";

/** Writable scopes (a memory is keyed by user/agent/run; "app" is derived). */
const SCOPES: ScopeType[] = ["user", "agent", "run"];

export function CreateMemoryDialog({
  open,
  loading,
  onClose,
  onCreate,
}: {
  open: boolean;
  loading?: boolean;
  onClose: () => void;
  onCreate: (value: {
    scopeType: ScopeType;
    scopeId: string;
    content: string;
    infer: boolean;
  }) => void;
}) {
  const [scopeType, setScopeType] = useState<ScopeType>("user");
  const [scopeId, setScopeId] = useState("");
  const [content, setContent] = useState("");
  const [infer, setInfer] = useState(true);

  useEffect(() => {
    if (!open) {
      setScopeType("user");
      setScopeId("");
      setContent("");
      setInfer(true);
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
  const valid = scopeId.trim() && content.trim();

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
        className="relative z-10 w-full max-w-[460px] animate-in fade-in zoom-in-95 rounded-xl bg-popover p-5 text-popover-foreground shadow-[0_24px_64px_rgba(0,0,0,0.24)] ring-1 ring-foreground/10 duration-150"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid)
            onCreate({
              scopeType,
              scopeId: scopeId.trim(),
              content,
              infer,
            });
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            New memory
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
              Scope
            </label>
            <div className="flex gap-2">
              <div className="inline-flex rounded-lg bg-muted p-[3px]">
                {SCOPES.map((s) => {
                  const Icon = SCOPE_META[s].icon;
                  return (
                    <button
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                        scopeType === s
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      key={s}
                      onClick={() => setScopeType(s)}
                      type="button"
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {SCOPE_META[s].label}
                    </button>
                  );
                })}
              </div>
              <input
                className={cn(inputClass, "flex-1")}
                onChange={(e) => setScopeId(e.target.value)}
                placeholder={`${scopeType}_id`}
                value={scopeId}
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-foreground">
              Content
            </label>
            <textarea
              autoFocus
              className={cn(inputClass, "h-auto min-h-[96px] py-2 leading-relaxed")}
              onChange={(e) => setContent(e.target.value)}
              placeholder="What to remember…"
              value={content}
            />
          </div>

          <label className="flex items-center gap-2 text-[13px] text-foreground">
            <input
              checked={infer}
              className="h-3.5 w-3.5 accent-brand"
              onChange={(e) => setInfer(e.target.checked)}
              type="checkbox"
            />
            Extract refined records (default)
            <Tooltip content="On: one LLM call extracts refined canonical records and the input is not also stored. Off: this content is stored byte-for-byte as one record with zero LLM calls.">
              <button
                aria-label="About fact extraction"
                className="text-muted-foreground hover:text-foreground"
                type="button"
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </label>
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
            disabled={!valid || loading}
            type="submit"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Add memory
          </button>
        </div>
      </form>
    </div>
  );
}
