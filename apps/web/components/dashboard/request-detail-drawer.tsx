"use client";

import {
  ChevronDown,
  ChevronUp,
  Copy,
  ListFilter,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DrawerShell } from "@fishmem/dashboard/drawer-shell";
import type { RequestEvent } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  requestScopeFilters,
  requestResultItems,
  requestQuery,
  type RequestResultItem,
  typeMeta,
} from "@/components/dashboard/requests-shared";

function formatDateTime(iso: string) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

async function copy(text: string, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch {
    toast.error("Could not copy");
  }
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  return (
    <button
      aria-label="Copy"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      onClick={() => copy(value, label)}
      type="button"
    >
      <Copy className="h-3.5 w-3.5" />
    </button>
  );
}

function Expandable({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  // Toggle only when the text actually overflows the clamp — short (1–3 line)
  // content shows in full with no "Show more" noise.
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text]);
  return (
    <div>
      <p
        className={cn(
          "whitespace-pre-wrap text-sm leading-relaxed text-foreground",
          !open && "line-clamp-3",
        )}
        ref={ref}
      >
        {text}
      </p>
      {overflowing ? (
        <button
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
          type="button"
        >
          {open ? "Show less" : "Show more"}
          <ChevronDown
            className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
          />
        </button>
      ) : null}
    </div>
  );
}

function PayloadTab({ event }: { event: RequestEvent }) {
  const query = requestQuery(event);
  const filters = requestScopeFilters(event);
  const filtersJson = JSON.stringify(filters, null, 2);
  const statusLabel =
    event.status === "success"
      ? "Succeeded"
      : event.status === "failed"
        ? "Failed"
        : "Pending";

  return (
    <div className="space-y-4 p-5">
      {query ? (
        <section className="rounded-lg ring-1 ring-foreground/10">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <Search className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">
              Search Query
            </span>
          </div>
          <div className="px-4 py-3">
            <Expandable text={query} />
          </div>
        </section>
      ) : null}

      <section className="flex items-center gap-2 rounded-lg bg-muted/50 px-4 py-2.5 ring-1 ring-foreground/10">
        <span className="text-xs font-medium text-muted-foreground">ID</span>
        <span className="flex-1 truncate font-mono text-xs text-foreground">
          {event.id}
        </span>
        <CopyButton value={event.id} label="Request ID copied" />
      </section>

      <section className="grid grid-cols-3 overflow-hidden rounded-lg ring-1 ring-foreground/10">
        <Field label="Latency">
          {typeof event.latencyMs === "number"
            ? `${event.latencyMs.toFixed(2)}ms`
            : "—"}
        </Field>
        <Field label="Requested At">{formatDateTime(event.createdAt)}</Field>
        <Field label="Status" last>
          {statusLabel}
        </Field>
      </section>

      <section className="rounded-lg ring-1 ring-foreground/10">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <ListFilter className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Filters</span>
        </div>
        <div className="relative px-4 py-3">
          <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-foreground">
            {filtersJson}
          </pre>
          <div className="absolute right-2 top-2">
            <CopyButton value={filtersJson} label="Filters copied" />
          </div>
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  children,
  last,
}: {
  label: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={cn("px-4 py-3", !last && "border-r border-border")}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm text-foreground">{children}</p>
    </div>
  );
}

function MemoryCard({ item }: { item: RequestResultItem }) {
  return (
    <div className="rounded-lg p-4 ring-1 ring-foreground/10">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Expandable text={item.memory} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {item.created_at ? (
            <span className="text-xs text-muted-foreground">
              {new Date(item.created_at).toLocaleDateString()}
            </span>
          ) : null}
          <CopyButton value={item.memory} label="Memory copied" />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {(item.categories ?? []).map((cat) => (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            key={cat}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            {cat}
          </span>
        ))}
        {typeof item.score === "number" ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            Score: {item.score.toFixed(2)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function MemoriesTab({ event }: { event: RequestEvent }) {
  const items = requestResultItems(event);
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-5 py-16 text-center">
        <Sparkles className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No retrieved-memory detail was captured for this request.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3 p-5">
      <p className="text-sm font-medium text-foreground">Memories</p>
      {items.map((item, i) => (
        <MemoryCard item={item} key={item.id ?? i} />
      ))}
    </div>
  );
}

export function RequestDetailDrawer({
  open,
  event,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: {
  open: boolean;
  event?: RequestEvent;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}) {
  const [tab, setTab] = useState<"payload" | "memories">("payload");
  const meta = event ? typeMeta(event.kind) : null;
  const resultCount = event ? requestResultItems(event).length : 0;

  return (
    <DrawerShell onClose={onClose} open={open} widthClass="max-w-[760px]">
      {event && meta ? (
        <>
          <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
        <span className="text-lg font-semibold tracking-tight text-foreground">
          Event
        </span>
        <span
          className={cn(
            "inline-flex h-[18px] items-center rounded-full px-1.5 text-[10.5px] font-medium",
            meta.tone,
          )}
        >
          {meta.label}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {resultCount > 0 ? (
            <span className="mr-1 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              <Search className="h-3 w-3" />
              {resultCount}
            </span>
          ) : null}
          <IconButton disabled={!hasPrev} onClick={onPrev} title="Previous">
            <ChevronUp className="h-4 w-4" />
          </IconButton>
          <IconButton disabled={!hasNext} onClick={onNext} title="Next">
            <ChevronDown className="h-4 w-4" />
          </IconButton>
          <IconButton onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      </div>

      <div className="flex border-b border-border px-5">
        {[
          { key: "payload" as const, label: "Request Payload" },
          { key: "memories" as const, label: "Retrieved Memories" },
        ].map((t) => (
          <button
            className={cn(
              "relative h-11 px-1 text-[13px] font-medium transition-colors",
              tab === t.key
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
              "mr-6",
            )}
            key={t.key}
            onClick={() => setTab(t.key)}
            type="button"
          >
            {t.label}
            {tab === t.key ? (
              <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-foreground" />
            ) : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === "payload" ? (
              <PayloadTab event={event} />
            ) : (
              <MemoriesTab event={event} />
            )}
          </div>
        </>
      ) : null}
    </DrawerShell>
  );
}

function IconButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title: string;
}) {
  return (
    <button
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}
