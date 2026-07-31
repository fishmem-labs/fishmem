"use client";

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ChevronRight,
  Clock,
  GitBranch,
  History,
  LayoutList,
  Loader2,
  PlusCircle,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  UserRound,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { MemoryDetailDrawer } from "@/components/dashboard/memory-detail-drawer";
import { RequestDetailDrawer } from "@/components/dashboard/request-detail-drawer";
import { RequestsTable } from "@/components/dashboard/requests-table";
import {
  categoryDot,
  memoryCategories,
  SCOPE_META,
  type ScopeType,
} from "@/components/dashboard/entities-shared";
import {
  relativeTime,
  requestScopeFilters,
} from "@/components/dashboard/requests-shared";
import { useUrlParam } from "@/hooks/use-url-param";
import { useCurrentUser } from "@/hooks/use-user";
import { fetchRequests, type RequestEvent } from "@/lib/api";
import {
  deleteMemory,
  fetchAllMemories,
  fetchMemoryProfile,
  fetchMemoryStateHistory,
  type MemoryRow,
  type StateSlotRow,
} from "@/lib/memories-api";
import { cn, formatNumber } from "@/lib/utils";

function scopeParams(type: ScopeType, id: string) {
  if (type === "agent") return { agent_id: id };
  if (type === "run") return { run_id: id };
  return { user_id: id };
}

/** A derived belief slot: one `(subject, attribute)` and its value over time. */
type BeliefSlot = {
  key: string;
  subject: string;
  attribute: string;
  history: MemoryRow[]; // oldest first
  current: MemoryRow; // open value (valid_to null), else latest
};

function slotTime(r: MemoryRow) {
  return new Date(r.valid_from ?? r.event_date ?? r.created_at).getTime();
}

/**
 * Group the entity's memories into belief slots—only refined rows tagged with
 * subject+attribute. Explicit verbatim records can remain unstructured, so the
 * Timeline falls back to the canonical chronological view.
 */
function buildSlots(rows: MemoryRow[]): BeliefSlot[] {
  const map = new Map<string, MemoryRow[]>();
  for (const r of rows) {
    if (!r.subject || !r.attribute) continue;
    const key = `${r.subject.toLowerCase()}␟${r.attribute.toLowerCase()}`;
    const list = map.get(key);
    if (list) list.push(r);
    else map.set(key, [r]);
  }
  const slots: BeliefSlot[] = [];
  for (const [key, list] of map) {
    const history = [...list].sort((a, b) => slotTime(a) - slotTime(b));
    const open = history.filter((r) => !r.valid_to);
    const current = open[open.length - 1] ?? history[history.length - 1];
    slots.push({
      key,
      subject: current.subject ?? "",
      attribute: current.attribute ?? "",
      history,
      current,
    });
  }
  return slots.sort((a, b) => slotTime(b.current) - slotTime(a.current));
}

function buildProfile(rows: MemoryRow[]) {
  const byType = new Map<string, number>();
  for (const r of rows) {
    const t = r.memory_type || "raw";
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  const times = rows
    .map((r) => new Date(r.event_date ?? r.created_at).getTime())
    .filter((t) => !Number.isNaN(t));
  return {
    total: rows.length,
    byType: [...byType.entries()].sort((a, b) => b[1] - a[1]),
    first: times.length ? new Date(Math.min(...times)) : null,
    last: times.length ? new Date(Math.max(...times)) : null,
    top: [...rows]
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
      .slice(0, 5),
  };
}

function shortDate(d: Date | string | null) {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function EntityDetail({
  scopeType,
  entityId,
}: {
  scopeType: ScopeType;
  entityId: string;
}) {
  const { jwt, workspaceId } = useCurrentUser();
  const [tab, setTab] = useState<"memories" | "timeline" | "requests">(
    "memories",
  );
  const ScopeIcon = SCOPE_META[scopeType].icon;

  const memories = useQuery({
    queryKey: ["entity-memories", jwt, workspaceId, scopeType, entityId],
    queryFn: () =>
      fetchAllMemories(jwt!, {
        ...scopeParams(scopeType, entityId),
        workspace: workspaceId,
      }),
    enabled: Boolean(jwt && workspaceId),
  });

  const requestsQuery = useQuery({
    queryKey: ["requests", jwt, workspaceId, "all"],
    queryFn: () => fetchRequests(jwt!, "all", workspaceId),
    enabled: Boolean(jwt && workspaceId),
  });

  const scopedRequests = useMemo(
    () =>
      (requestsQuery.data?.data ?? []).filter((r) =>
        Object.values(requestScopeFilters(r)).includes(entityId),
      ),
    [requestsQuery.data?.data, entityId],
  );

  const totalMemories = memories.data?.length ?? null;
  const rows = useMemo(() => memories.data ?? [], [memories.data]);
  const profile = useMemo(() => buildProfile(rows), [rows]);
  const slots = useMemo(() => buildSlots(rows), [rows]);
  const derivedProfile = useQuery({
    queryKey: ["entity-profile", jwt, workspaceId, scopeType, entityId],
    queryFn: () =>
      fetchMemoryProfile(jwt!, {
        ...scopeParams(scopeType, entityId),
        workspace: workspaceId,
      }),
    enabled: Boolean(jwt && workspaceId),
  });
  const stateQueries = useQueries({
    queries: slots.map((slot) => ({
      queryKey: ["state-history", workspaceId, scopeType, entityId, slot.key],
      queryFn: () =>
        fetchMemoryStateHistory(jwt!, {
          subject: slot.subject,
          attribute: slot.attribute,
          ...scopeParams(scopeType, entityId),
          workspace: workspaceId,
        }),
      enabled: Boolean(jwt && workspaceId),
    })),
  });
  const derivedSlots = stateQueries.flatMap((query) => query.data ?? []);

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-6">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <a className="transition-colors hover:text-foreground" href="/dashboard/entities">
          Entities
        </a>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="font-mono text-foreground">{entityId}</span>
      </nav>

      <div className="flex items-center gap-2 rounded-xl bg-card px-5 py-4 ring-1 ring-foreground/10">
        <ScopeIcon className="h-5 w-5 text-muted-foreground" />
        <span className="font-mono text-base text-foreground">{entityId}</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard
          icon={Clock}
          label="Total Memories"
          value={totalMemories === null ? "—" : formatNumber(totalMemories)}
        />
        <StatCard
          icon={UserRound}
          label="Total Requests"
          value={
            requestsQuery.isLoading ? "—" : formatNumber(scopedRequests.length)
          }
        />
      </div>

      <ProfileCard
        loading={memories.isLoading}
        profile={profile}
        derivedProfile={derivedProfile.data}
        scopeType={scopeType}
        slotCount={slots.length}
      />

      <div className="inline-flex rounded-lg bg-muted p-[3px]">
        {(["memories", "timeline", "requests"] as const).map((t) => (
          <button
            className={cn(
              "h-8 rounded-md px-4 text-[13px] font-medium capitalize transition-colors",
              tab === t
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            key={t}
            onClick={() => setTab(t)}
            type="button"
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "memories" ? (
        <MemoriesTab
          entityId={entityId}
          loading={memories.isLoading}
          onRefresh={() => memories.refetch()}
          refreshing={memories.isFetching}
          rows={memories.data ?? []}
          scopeType={scopeType}
        />
      ) : tab === "timeline" ? (
        <TimelineTab
          loading={memories.isLoading}
          rows={rows}
          derivedSlots={derivedSlots}
        />
      ) : (
        <RequestsTabPanel
          loading={requestsQuery.isLoading}
          onRefresh={() => requestsQuery.refetch()}
          refreshing={requestsQuery.isFetching}
          rows={scopedRequests}
        />
      )}
    </div>
  );
}

function ProfileCard({
  profile,
  derivedProfile,
  slotCount,
  scopeType,
  loading,
}: {
  profile: ReturnType<typeof buildProfile>;
  derivedProfile: string | null | undefined;
  slotCount: number;
  scopeType: ScopeType;
  loading: boolean;
}) {
  const maxType = Math.max(...profile.byType.map(([, n]) => n), 1);
  return (
    <section className="space-y-5 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-foreground">Profile</h2>
        <span className="text-xs text-muted-foreground">
          Derived from this {SCOPE_META[scopeType].label.toLowerCase()}’s memories
        </span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Building profile…
        </div>
      ) : profile.total === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          No memories for this entity yet.
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="First seen" value={shortDate(profile.first)} />
              <Field label="Last seen" value={shortDate(profile.last)} />
              <Field label="Memories" value={formatNumber(profile.total)} />
              <Field label="Belief slots" value={formatNumber(slotCount)} />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Composition
              </p>
              <ul className="space-y-1.5">
                {profile.byType.map(([type, n]) => (
                  <li className="flex flex-col gap-1" key={type}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-foreground">{type}</span>
                      <span className="text-muted-foreground">
                        {formatNumber(n)}
                      </span>
                    </div>
                    <div className="h-1 w-full rounded-full bg-muted">
                      <div
                        className="h-1 rounded-full bg-brand"
                        style={{ width: `${(n / maxType) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Most important
            </p>
            <ul className="space-y-2">
              {profile.top.map((row) => (
                <li
                  className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2"
                  key={row.id}
                >
                  <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">
                    {(row.importance ?? 0).toFixed(1)}
                  </span>
                  <span className="text-[13px] leading-snug text-foreground">
                    {row.memory}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="border-t border-border pt-4">
        <p className="text-xs font-medium text-muted-foreground">
          Synthesized profile projection
        </p>
        {derivedProfile ? (
          <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-foreground">
            {derivedProfile}
          </pre>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            Not built. Profile derivation is opt-in and refreshes through the operation queue.
          </p>
        )}
      </div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function TimelineTab({
  rows,
  derivedSlots,
  loading,
}: {
  rows: MemoryRow[];
  derivedSlots: StateSlotRow[];
  loading: boolean;
}) {
  const [openSlot, setOpenSlot] = useState<string | null>(null);
  const chronological = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          new Date(b.event_date ?? b.created_at).getTime() -
          new Date(a.event_date ?? a.created_at).getTime(),
      ),
    [rows],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl bg-card px-5 py-16 text-sm text-muted-foreground ring-1 ring-foreground/10">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading timeline…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
        <div className="mb-3 flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-medium text-foreground">Current state</h3>
          <span className="text-xs text-muted-foreground">
            belief slots derived from structured facts
          </span>
        </div>
        {derivedSlots.length === 0 ? (
          <p className="py-2 text-[13px] leading-relaxed text-muted-foreground">
            No persisted state slots yet. Derivation is opt-in; the canonical
            memory timeline below remains the correction surface.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {derivedSlots.map((slot) => {
              const key = `${slot.subject}:${slot.attribute}:${slot.id}`;
              const open = openSlot === key;
              const superseded = Boolean(slot.validTo);
              return (
                <li className="py-3 first:pt-0 last:pb-0" key={slot.id}>
                  <button
                    className="flex w-full items-center gap-3 text-left"
                    onClick={() =>
                      setOpenSlot((v) => (v === key ? null : key))
                    }
                    type="button"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-muted-foreground">
                        {slot.subject} · {slot.attribute}
                      </p>
                      <p className="truncate text-[13px] font-medium text-foreground">
                        {slot.value}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                        superseded
                          ? "bg-muted text-muted-foreground"
                          : "bg-success/15 text-success",
                      )}
                    >
                      {superseded ? "superseded" : "current"}
                    </span>
                    {slot.sources.length ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <History className="h-3.5 w-3.5" />
                        {slot.sources.length} sources
                      </span>
                    ) : null}
                  </button>
                  {open && slot.sources.length ? (
                    <ol className="mt-3 space-y-2 border-l border-border pl-4">
                      {slot.sources.map((sourceId) => (
                        <li className="relative" key={sourceId}>
                          <span className="absolute -left-[1.31rem] top-1.5 h-2 w-2 rounded-full bg-border" />
                          <p className="text-xs text-muted-foreground">
                            {shortDate(slot.validFrom)}
                            {slot.validTo
                              ? ` → ${shortDate(slot.validTo)}`
                              : " → now"}
                          </p>
                          <a
                            className="font-mono text-xs text-brand hover:underline"
                            href={`/dashboard/memories?memory=${encodeURIComponent(sourceId)}`}
                          >
                            source {sourceId}
                          </a>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
        <div className="mb-3 flex items-center gap-2">
          <Clock className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-medium text-foreground">Memory timeline</h3>
        </div>
        {chronological.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No memories yet.</p>
        ) : (
          <ol className="space-y-3 border-l border-border pl-4">
            {chronological.map((row) => (
              <li className="relative" key={row.id}>
                <span className="absolute -left-[1.31rem] top-1.5 h-2 w-2 rounded-full bg-brand/60" />
                <p className="text-xs text-muted-foreground">
                  {shortDate(row.event_date ?? row.created_at)}
                  {row.valid_to ? (
                    <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      superseded
                    </span>
                  ) : null}
                </p>
                <p className="text-[13px] leading-snug text-foreground">
                  {row.memory}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4 text-brand" />
        <span className="text-sm">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
        {value}
      </p>
    </div>
  );
}

function ToolbarButton({
  active,
  children,
  onClick,
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium transition-colors",
        active
          ? "border-foreground/25 bg-muted text-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function RefreshButton({
  onClick,
  refreshing,
}: {
  onClick: () => void;
  refreshing: boolean;
}) {
  return (
    <button
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
      disabled={refreshing}
      onClick={onClick}
      type="button"
    >
      {refreshing ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <RefreshCw className="h-4 w-4" />
      )}
      Refresh
    </button>
  );
}

function MemoriesTab({
  rows,
  loading,
  scopeType,
  entityId,
  onRefresh,
  refreshing,
}: {
  rows: MemoryRow[];
  loading: boolean;
  scopeType: ScopeType;
  entityId: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { jwt, workspaceId } = useCurrentUser();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useUrlParam("memory");
  const ScopeIcon = SCOPE_META[scopeType].icon;

  const allCategories = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) for (const c of memoryCategories(row)) set.add(c);
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(
    () =>
      category
        ? rows.filter((row) => memoryCategories(row).includes(category))
        : rows,
    [rows, category],
  );

  const remove = useMutation({
    mutationFn: (id: string) => deleteMemory(jwt ?? "", id, workspaceId),
    onSuccess: () => {
      toast.success("Memory deleted");
      void queryClient.invalidateQueries({ queryKey: ["entity-memories"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not delete memory"),
  });

  const selectedIndex = filtered.findIndex((r) => r.id === selectedId);
  const selectedMemory = selectedIndex >= 0 ? filtered[selectedIndex] : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ToolbarButton active={category === null} onClick={() => setCategory(null)}>
          <Table2 className="h-4 w-4" /> Overview
        </ToolbarButton>
        <span className="mx-1 h-5 w-px bg-border" />
        {allCategories.map((c) => (
          <ToolbarButton
            active={category === c}
            key={c}
            onClick={() => setCategory((v) => (v === c ? null : c))}
          >
            <span className={cn("h-2 w-2 rounded-full", categoryDot(c))} />
            {c}
          </ToolbarButton>
        ))}
        <div className="ml-auto">
          <RefreshButton onClick={onRefresh} refreshing={refreshing} />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <div className="hidden grid-cols-[110px_180px_1fr_200px_56px] gap-4 border-b border-border bg-muted/40 px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid">
          <span>Time</span>
          <span>Entities</span>
          <span>Memory Content</span>
          <span>Categories</span>
          <span className="text-right">Action</span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading memories…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-16 text-center text-sm text-muted-foreground">
            No memories for this entity{category ? ` in “${category}”` : ""}.
          </div>
        ) : (
          filtered.map((row, i) => {
            const cats = memoryCategories(row);
            return (
              <button
                className={cn(
                  "grid w-full grid-cols-1 gap-2 border-b border-border px-5 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50 md:grid-cols-[110px_180px_1fr_200px_56px] md:items-center md:gap-4",
                  selectedIndex === i && "bg-muted/60",
                )}
                key={row.id}
                onClick={() => setSelectedId(row.id)}
                type="button"
              >
                <span className="text-sm text-muted-foreground">
                  {relativeTime(row.updated_at)}
                </span>
                <span className="flex items-center gap-1.5 truncate">
                  <ScopeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {entityId}
                  </span>
                </span>
                <span className="truncate text-sm text-foreground">
                  {row.memory}
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  {cats.slice(0, 1).map((c) => (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                      key={c}
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full", categoryDot(c))} />
                      {c}
                    </span>
                  ))}
                  {cats.length > 1 ? (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                      +{cats.length - 1}
                    </span>
                  ) : null}
                </span>
                <span className="flex justify-start md:justify-end">
                  <span
                    aria-label="Delete memory"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm("Delete this memory?")) remove.mutate(row.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>

      <MemoryDetailDrawer
        hasNext={selectedIndex >= 0 && selectedIndex < filtered.length - 1}
        hasPrev={selectedIndex > 0}
        memory={selectedMemory}
        onClose={() => setSelectedId(null)}
        onNext={() => setSelectedId(filtered[selectedIndex + 1]?.id ?? null)}
        onPrev={() => setSelectedId(filtered[selectedIndex - 1]?.id ?? null)}
        open={Boolean(selectedMemory)}
      />
    </div>
  );
}

type ReqTab = "overview" | "add" | "search" | "get_all";

function reqTabMatches(row: RequestEvent, tab: ReqTab) {
  if (tab === "overview") return true;
  if (tab === "search") return row.kind === "memories.search";
  if (tab === "get_all") return row.kind === "memories.list";
  return row.kind === "memories.add" || row.kind === "memories.add_raw";
}

function RequestsTabPanel({
  rows,
  loading,
  onRefresh,
  refreshing,
}: {
  rows: RequestEvent[];
  loading: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [tab, setTab] = useState<ReqTab>("overview");
  const [selectedId, setSelectedId] = useUrlParam("request");
  const filtered = useMemo(
    () => rows.filter((r) => reqTabMatches(r, tab)),
    [rows, tab],
  );
  const selectedIndex = filtered.findIndex((r) => r.id === selectedId);
  const selectedEvent = selectedIndex >= 0 ? filtered[selectedIndex] : undefined;

  const TABS: Array<{ value: ReqTab; label: string; icon: typeof Search }> = [
    { value: "overview", label: "Overview", icon: Table2 },
    { value: "add", label: "ADD", icon: PlusCircle },
    { value: "search", label: "SEARCH", icon: Search },
    { value: "get_all", label: "GET ALL", icon: LayoutList },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <ToolbarButton
              active={tab === t.value}
              key={t.value}
              onClick={() => setTab(t.value)}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </ToolbarButton>
          );
        })}
        <div className="ml-auto">
          <RefreshButton onClick={onRefresh} refreshing={refreshing} />
        </div>
      </div>

      <RequestsTable
        emptyText="No requests for this entity."
        loading={loading}
        onSelect={(row) => setSelectedId(row.id)}
        rows={filtered}
        selectedId={selectedId}
      />

      <RequestDetailDrawer
        event={selectedEvent}
        hasNext={selectedIndex >= 0 && selectedIndex < filtered.length - 1}
        hasPrev={selectedIndex > 0}
        onClose={() => setSelectedId(null)}
        onNext={() => setSelectedId(filtered[selectedIndex + 1]?.id ?? null)}
        onPrev={() => setSelectedId(filtered[selectedIndex - 1]?.id ?? null)}
        open={Boolean(selectedEvent)}
      />
    </div>
  );
}
