import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Database,
  FileJson,
  Hash,
  Loader2,
  Pencil,
  Search,
  Tag,
  Trash2,
  User,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { DrawerShell } from "./drawer-shell";
import { cn } from "./utils";

/**
 * Canonical dashboard projection used by every FishMem operator surface.
 *
 * Storage and transport casing deliberately stay outside this module: Web maps
 * the HTTP wire shape here, while Desktop maps its typed IPC records here.
 */
export type DashboardMemory = {
  id: string;
  content: string;
  memoryType: string;
  importance: number;
  userId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  eventDate?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  subject?: string | null;
  attribute?: string | null;
  supersededBy?: string | null;
  lastAccessedAt?: string | null;
  accessCount?: number;
  score?: number;
};

export type DashboardMemoryHistory = {
  id: string;
  memoryId: string;
  event: string;
  previousValue?: string | null;
  newValue?: string | null;
  createdAt: string;
};

export type DashboardMemoryPatch = {
  content: string;
  metadata: Record<string, unknown>;
};

export type DashboardMemoryScope = {
  type: "user" | "agent" | "run" | "unscoped";
  label: string;
  id: string;
};

export function dashboardMemoryScope(
  memory: DashboardMemory,
): DashboardMemoryScope {
  if (memory.userId) return { type: "user", label: "User", id: memory.userId };
  if (memory.agentId) {
    return { type: "agent", label: "Agent", id: memory.agentId };
  }
  if (memory.runId) return { type: "run", label: "Run", id: memory.runId };
  return { type: "unscoped", label: "Scope", id: "Unscoped" };
}

export function formatMemoryDateTime(value?: string | null) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function relativeMemoryTime(value: string) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function MemorySearchToolbar({
  value,
  activeQuery,
  resultCount,
  onChange,
  onSearch,
  onClear,
  filters,
}: {
  value: string;
  activeQuery: string;
  resultCount?: number;
  onChange: (value: string) => void;
  onSearch: (value: string) => void;
  onClear: () => void;
  filters?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const searching = activeQuery.trim().length > 0;

  return (
    <div className="space-y-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch(value.trim());
        }}
      >
        <label className="relative min-w-[240px] flex-1">
          <span className="sr-only">Semantic search across memories</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            aria-label="Semantic search across memories"
            className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-16 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onChange={(event) => {
              const next = event.target.value;
              onChange(next);
              if (!next) onClear();
            }}
            placeholder="Semantic search across memories…"
            value={value}
          />
          {value ? (
            <button
              aria-label="Clear search"
              className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={onClear}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              /
            </kbd>
          )}
        </label>
        <button
          aria-label="Search memories"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40"
          disabled={!value.trim()}
          type="submit"
        >
          <Search className="size-3.5" />
          Search
        </button>
        {filters}
      </form>
      {searching ? (
        <p className="text-xs text-muted-foreground" role="status">
          Ranked by recall relevance
          {typeof resultCount === "number"
            ? ` · ${resultCount} result${resultCount === 1 ? "" : "s"}`
            : ""}
          {` for “${activeQuery}”`}
        </p>
      ) : null}
    </div>
  );
}

function ScopeCell({ memory }: { memory: DashboardMemory }) {
  const scope = dashboardMemoryScope(memory);
  const ScopeIcon =
    scope.type === "user"
      ? User
      : scope.type === "agent"
        ? Bot
        : scope.type === "run"
          ? Clock
          : Database;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <ScopeIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-xs text-muted-foreground">
        {scope.id}
      </span>
    </span>
  );
}

function MemoryTypeTag({ value }: { value: string }) {
  if (!value || value === "raw") {
    return <span className="text-xs text-muted-foreground/60">untyped</span>;
  }
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
      {value}
    </span>
  );
}

export function MemoryTable({
  rows,
  loading,
  searching,
  selectedId,
  selectedIds,
  onOpen,
  onDelete,
  onToggle,
  onToggleAll,
  emptyTitle = "No memories found",
  emptyDescription,
}: {
  rows: DashboardMemory[];
  loading: boolean;
  searching: boolean;
  selectedId?: string | null;
  selectedIds: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onDelete?: (id: string) => void;
  onToggle: (id: string) => void;
  onToggleAll: (checked: boolean) => void;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const allSelected =
    rows.length > 0 && rows.every((row) => selectedIds.has(row.id));
  const columns = searching
    ? "md:grid-cols-[32px_48px_64px_180px_minmax(0,1fr)_120px_44px]"
    : "md:grid-cols-[32px_100px_180px_minmax(0,1fr)_120px_44px]";

  return (
    <section className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div
        className={cn(
          "hidden items-center gap-4 border-b border-border bg-muted/40 px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid",
          columns,
        )}
      >
        <span className="flex items-center">
          <input
            aria-label="Select all memories"
            checked={allSelected}
            className="size-3.5 accent-brand"
            onChange={(event) => onToggleAll(event.target.checked)}
            type="checkbox"
          />
        </span>
        <span>{searching ? "Rank" : "Time"}</span>
        {searching ? <span>Score</span> : null}
        <span>Scope</span>
        <span>Memory Content</span>
        <span>Type</span>
        <span className="text-right">Action</span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 px-5 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading memories…
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-16 text-center">
          <Database className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">{emptyTitle}</p>
          {emptyDescription ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {emptyDescription}
            </p>
          ) : null}
        </div>
      ) : (
        rows.map((row, index) => (
          <div
            aria-label={`Open memory: ${row.content}`}
            className={cn(
              "grid w-full cursor-pointer grid-cols-1 gap-2 border-b border-border px-5 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50 md:items-center md:gap-4",
              columns,
              selectedId === row.id && "bg-muted/60",
            )}
            key={row.id}
            onClick={() => onOpen(row.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(row.id);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <span
              className="flex items-center"
              onClick={(event) => event.stopPropagation()}
            >
              <input
                aria-label={`Select memory ${row.content}`}
                checked={selectedIds.has(row.id)}
                className="size-3.5 accent-brand"
                onChange={() => onToggle(row.id)}
                type="checkbox"
              />
            </span>
            {searching ? (
              <>
                <span className="font-mono text-[13px] font-semibold text-foreground">
                  #{index + 1}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {typeof row.score === "number" ? row.score.toFixed(2) : "—"}
                </span>
              </>
            ) : (
              <time
                className="text-[13px] text-muted-foreground"
                dateTime={row.updatedAt}
                title={formatMemoryDateTime(row.updatedAt)}
              >
                {relativeMemoryTime(row.updatedAt)}
              </time>
            )}
            <ScopeCell memory={row} />
            <span className="truncate text-[13px] text-foreground">
              {row.content}
            </span>
            <span className="flex items-center">
              <MemoryTypeTag value={row.memoryType} />
            </span>
            <span className="flex justify-start md:justify-end">
              {onDelete ? (
                <button
                  aria-label={`Delete memory ${row.content}`}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(row.id);
                  }}
                  type="button"
                >
                  <Trash2 className="size-4" />
                </button>
              ) : null}
            </span>
          </div>
        ))
      )}
    </section>
  );
}

function DetailField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 truncate text-sm text-foreground">{children}</div>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function MemoryDetails({
  memory,
  onSave,
}: {
  memory: DashboardMemory;
  onSave?: (patch: DashboardMemoryPatch) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(memory.content);
  const [draftMetadata, setDraftMetadata] = useState(() =>
    memory.metadata ? JSON.stringify(memory.metadata, null, 2) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const scope = dashboardMemoryScope(memory);

  useEffect(() => {
    setEditing(false);
    setDraftContent(memory.content);
    setDraftMetadata(
      memory.metadata ? JSON.stringify(memory.metadata, null, 2) : "",
    );
    setError("");
  }, [memory.id, memory.content, memory.metadata]);

  async function copyId() {
    try {
      await navigator.clipboard.writeText(memory.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setError("Could not copy the memory ID.");
    }
  }

  async function save() {
    if (!onSave || !draftContent.trim()) return;
    setError("");
    let metadata: Record<string, unknown> = {};
    if (draftMetadata.trim()) {
      try {
        const value: unknown = JSON.parse(draftMetadata);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          setError("Metadata must be a JSON object.");
          return;
        }
        metadata = value as Record<string, unknown>;
      } catch {
        setError("Metadata must be valid JSON.");
        return;
      }
    }
    setSaving(true);
    try {
      await onSave({ content: draftContent, metadata });
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 p-5">
      <section className="flex items-center gap-2 rounded-lg bg-muted/50 px-4 py-2.5 ring-1 ring-foreground/10">
        <Hash className="size-3.5 text-muted-foreground" />
        <span className="flex-1 truncate font-mono text-xs text-foreground">
          {memory.id}
        </span>
        <button
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => void copyId()}
          type="button"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </section>

      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <MemoryTypeTag value={memory.memoryType} />
          <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            importance {memory.importance.toFixed(2)}
          </span>
          {typeof memory.score === "number" ? (
            <span className="inline-flex items-center rounded-md bg-brand/10 px-1.5 py-0.5 text-xs text-brand">
              score {memory.score.toFixed(2)}
            </span>
          ) : null}
        </div>
        {onSave ? (
          editing ? (
            <div className="flex items-center gap-2">
              <button
                className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setDraftContent(memory.content);
                  setDraftMetadata(
                    memory.metadata
                      ? JSON.stringify(memory.metadata, null, 2)
                      : "",
                  );
                  setError("");
                }}
                type="button"
              >
                Cancel
              </button>
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                disabled={saving || !draftContent.trim()}
                onClick={() => void save()}
                type="button"
              >
                {saving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                Save
              </button>
            </div>
          ) : (
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
              onClick={() => setEditing(true)}
              type="button"
            >
              <Pencil className="size-3.5" />
              Edit
            </button>
          )
        ) : null}
      </div>

      {editing ? (
        <textarea
          autoFocus
          className="min-h-[132px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onChange={(event) => setDraftContent(event.target.value)}
          value={draftContent}
        />
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {memory.content}
        </p>
      )}

      <section className="grid grid-cols-2 divide-x divide-border overflow-hidden rounded-lg ring-1 ring-foreground/10">
        <DetailField label="Created">
          {formatMemoryDateTime(memory.createdAt)}
        </DetailField>
        <DetailField label="Updated">
          {formatMemoryDateTime(memory.updatedAt)}
        </DetailField>
      </section>

      <section className="grid grid-cols-2 divide-x divide-border overflow-hidden rounded-lg ring-1 ring-foreground/10">
        <DetailField label="Retrieved">
          {memory.accessCount ?? 0} time{memory.accessCount === 1 ? "" : "s"}
        </DetailField>
        <DetailField label="Last retrieved">
          {memory.lastAccessedAt
            ? formatMemoryDateTime(memory.lastAccessedAt)
            : "Never"}
        </DetailField>
      </section>

      <section className="grid grid-cols-2 divide-x divide-border overflow-hidden rounded-lg ring-1 ring-foreground/10">
        <DetailField label={scope.label}>
          <span className="font-mono text-xs">{scope.id}</span>
        </DetailField>
        <DetailField label="Source">{memory.source ?? "Direct memory"}</DetailField>
      </section>

      {memory.subject || memory.attribute ? (
        <section className="grid grid-cols-2 divide-x divide-border overflow-hidden rounded-lg ring-1 ring-foreground/10">
          <DetailField label="Subject">{memory.subject ?? "—"}</DetailField>
          <DetailField label="Attribute">{memory.attribute ?? "—"}</DetailField>
        </section>
      ) : null}

      {memory.eventDate || memory.validFrom || memory.validTo ? (
        <section className="overflow-hidden rounded-lg ring-1 ring-foreground/10">
          <div className="grid grid-cols-3 divide-x divide-border">
            <DetailField label="Event date">
              {formatMemoryDateTime(memory.eventDate)}
            </DetailField>
            <DetailField label="Valid from">
              {formatMemoryDateTime(memory.validFrom)}
            </DetailField>
            <DetailField label="Valid to">
              {formatMemoryDateTime(memory.validTo)}
            </DetailField>
          </div>
          {memory.supersededBy ? (
            <p className="border-t border-border px-4 py-2.5 font-mono text-xs text-muted-foreground">
              Superseded by {memory.supersededBy}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="overflow-hidden rounded-lg ring-1 ring-foreground/10">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <FileJson className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Metadata</span>
        </div>
        <div className="px-4 py-3">
          {editing ? (
            <textarea
              className="min-h-[112px] w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onChange={(event) => setDraftMetadata(event.target.value)}
              placeholder={'{ "key": "value" }'}
              value={draftMetadata}
            />
          ) : memory.metadata && Object.keys(memory.metadata).length ? (
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
              {JSON.stringify(memory.metadata, null, 2)}
            </pre>
          ) : (
            <p className="py-5 text-center text-sm text-muted-foreground">
              No metadata
            </p>
          )}
        </div>
      </section>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

function MemoryHistory({
  memory,
  history,
  loading,
}: {
  memory: DashboardMemory;
  history: DashboardMemoryHistory[];
  loading: boolean;
}) {
  return (
    <div className="space-y-4 p-5">
      <section className="overflow-hidden rounded-lg ring-1 ring-foreground/10">
        {[
          ["Created", memory.createdAt],
          ["Last updated", memory.updatedAt],
          ["Event date", memory.eventDate],
          ["Valid from", memory.validFrom],
          ["Valid to", memory.validTo],
        ]
          .filter(([, value]) => Boolean(value))
          .map(([label, value], index, values) => (
            <div
              className={cn(
                "flex items-center justify-between gap-4 px-4 py-3",
                index < values.length - 1 && "border-b border-border",
              )}
              key={label}
            >
              <span className="text-[13px] text-muted-foreground">{label}</span>
              <span className="text-right text-[13px] text-foreground">
                {formatMemoryDateTime(value)}
              </span>
            </div>
          ))}
      </section>

      <section className="overflow-hidden rounded-lg ring-1 ring-foreground/10">
        <div className="border-b border-border px-4 py-2.5 text-sm font-medium text-foreground">
          Immutable history
        </div>
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading history…
          </div>
        ) : history.length ? (
          history.map((entry) => (
            <div
              className="border-b border-border px-4 py-3 last:border-b-0"
              key={entry.id}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs font-medium text-foreground">
                  {entry.event}
                </span>
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={entry.createdAt}
                >
                  {formatMemoryDateTime(entry.createdAt)}
                </time>
              </div>
              {entry.previousValue ? (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  Previous: {entry.previousValue}
                </p>
              ) : null}
              {entry.newValue ? (
                <p className="mt-1 text-xs leading-relaxed text-foreground">
                  New: {entry.newValue}
                </p>
              ) : null}
              <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
                event {entry.id}
              </p>
            </div>
          ))
        ) : (
          <p className="px-4 py-5 text-xs text-muted-foreground">
            No history events recorded.
          </p>
        )}
      </section>
    </div>
  );
}

export function MemoryInspectorDrawer({
  open,
  memory,
  history = [],
  historyLoading = false,
  hasPrevious,
  hasNext,
  onClose,
  onPrevious,
  onNext,
  onSave,
}: {
  open: boolean;
  memory?: DashboardMemory;
  history?: DashboardMemoryHistory[];
  historyLoading?: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSave?: (patch: DashboardMemoryPatch) => Promise<void>;
}) {
  const [tab, setTab] = useState<"details" | "history">("details");

  useEffect(() => {
    setTab("details");
  }, [memory?.id]);

  return (
    <DrawerShell onClose={onClose} open={open} widthClass="max-w-[720px]">
      {memory ? (
        <>
          <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                Memory details
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Content, scope, provenance, and change history
              </p>
            </div>
            <div className="ml-auto flex items-center gap-1">
              <IconButton
                disabled={!hasPrevious}
                label="Previous memory"
                onClick={onPrevious}
              >
                <ChevronUp className="size-4" />
              </IconButton>
              <IconButton disabled={!hasNext} label="Next memory" onClick={onNext}>
                <ChevronDown className="size-4" />
              </IconButton>
              <IconButton label="Close memory details" onClick={onClose}>
                <X className="size-4" />
              </IconButton>
            </div>
          </header>
          <nav className="flex border-b border-border px-5">
            {[
              { id: "details" as const, label: "Details" },
              { id: "history" as const, label: "Source & history" },
            ].map((item) => (
              <button
                className={cn(
                  "relative mr-6 h-11 px-1 text-[13px] font-medium transition-colors",
                  tab === item.id
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={item.id}
                onClick={() => setTab(item.id)}
                type="button"
              >
                {item.label}
                {tab === item.id ? (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-foreground" />
                ) : null}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === "details" ? (
              <MemoryDetails memory={memory} onSave={onSave} />
            ) : (
              <MemoryHistory
                history={history}
                loading={historyLoading}
                memory={memory}
              />
            )}
          </div>
        </>
      ) : null}
    </DrawerShell>
  );
}
