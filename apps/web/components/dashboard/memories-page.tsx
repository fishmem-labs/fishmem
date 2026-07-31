"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Clock,
  FileJson,
  Hash,
  Loader2,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  User,
  UsersRound,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@fishmem/dashboard/confirm-dialog";
import { CreateMemoryDialog } from "@/components/dashboard/create-memory-dialog";
import {
  DateRangeFilter,
  type TimeWindow,
  windowContains,
} from "@/components/dashboard/date-range-filter";
import {
  memoryCategories,
  scopeOfMemory,
  type ScopeType,
} from "@/components/dashboard/entities-shared";
import {
  applyFilter,
  EMPTY_FILTER,
  type Filter,
  type FilterParamDef,
  FilterPopover,
} from "@fishmem/dashboard/filter";
import { MemoryDetailDrawer } from "@/components/dashboard/memory-detail-drawer";
import { toDashboardMemory } from "@/components/dashboard/memory-view";
import {
  MemorySearchToolbar,
  MemoryTable,
} from "@fishmem/dashboard/memory-workspace";
import { dashButton, PageShell } from "@fishmem/dashboard/page-shell";
import { useUrlParam } from "@/hooks/use-url-param";
import { useCurrentUser } from "@/hooks/use-user";
import {
  addMemory,
  batchDeleteMemories,
  deleteMemory,
  fetchMemories,
  type MemoryRow,
} from "@/lib/memories-api";
import { cn } from "@/lib/utils";

const MEMORY_PARAMS: FilterParamDef[] = [
  { value: "entity_type", label: "Entity Type", icon: UsersRound },
  { value: "user_id", label: "User ID", icon: User },
  { value: "agent_id", label: "Agent ID", icon: Bot },
  { value: "run_id", label: "Run ID", icon: Clock },
  { value: "memory_id", label: "Memory ID", icon: Hash },
  { value: "category", label: "Category", icon: Tag },
  { value: "metadata", label: "Metadata", icon: FileJson },
];

function memoryFieldValue(row: MemoryRow, param: string): string | string[] {
  switch (param) {
    case "entity_type":
      return scopeOfMemory(row).type;
    case "user_id":
      return row.user_id ?? "";
    case "agent_id":
      return row.agent_id ?? "";
    case "run_id":
      return row.run_id ?? "";
    case "memory_id":
      return row.id;
    case "category":
      return memoryCategories(row);
    case "metadata":
      return row.metadata ? JSON.stringify(row.metadata) : "";
    default:
      return "";
  }
}

export function MemoriesPage() {
  const { jwt, workspaceId } = useCurrentUser();
  const queryClient = useQueryClient();
  const [window, setWindow] = useState<TimeWindow>({ kind: "all" });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(EMPTY_FILTER);
  const [selectedId, setSelectedId] = useUrlParam("memory");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<
    { type: "single"; id: string } | { type: "bulk" } | null
  >(null);
  const searching = query.trim().length > 0;

  const memoriesQuery = useQuery({
    queryKey: ["memories", jwt, workspaceId, searching ? `q:${query}` : "list"],
    queryFn: () =>
      fetchMemories(jwt!, {
        query: searching ? query : undefined,
        limit: 200,
        workspace: workspaceId,
      }),
    enabled: Boolean(jwt && workspaceId),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteMemory(jwt ?? "", id, workspaceId),
    onSuccess: () => {
      toast.success("Memory deleted");
      void queryClient.invalidateQueries({ queryKey: ["memories"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not delete memory"),
  });

  const create = useMutation({
    mutationFn: (v: {
      scopeType: ScopeType;
      scopeId: string;
      content: string;
      infer: boolean;
    }) => {
      const scopeKey: "user_id" | "agent_id" | "run_id" =
        v.scopeType === "agent"
          ? "agent_id"
          : v.scopeType === "run"
            ? "run_id"
            : "user_id";
      return addMemory(jwt ?? "", {
        content: v.content,
        [scopeKey]: v.scopeId,
        infer: v.infer,
        workspace: workspaceId,
      });
    },
    onSuccess: () => {
      setCreateOpen(false);
      toast.success("Memory added");
      void queryClient.invalidateQueries({ queryKey: ["memories"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not add memory"),
  });

  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) =>
      batchDeleteMemories(jwt ?? "", ids, workspaceId),
    onSuccess: (operation, ids) => {
      setSelectedIds(new Set());
      toast.success(
        `${ids.length} ${ids.length === 1 ? "memory" : "memories"} queued for deletion`,
      );
      void queryClient.invalidateQueries({
        queryKey: ["operations-console"],
      });
      if (operation.status === "completed") {
        void queryClient.invalidateQueries({ queryKey: ["memories"] });
      }
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Bulk delete failed"),
  });

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // In search mode results come back rank-ordered by score; don't re-sort by
  // recency — only apply the time window + advanced filter (order-preserving).
  const windowed = useMemo(
    () =>
      (memoriesQuery.data ?? []).filter((m) =>
        windowContains(m.updated_at ?? m.created_at, window),
      ),
    [memoriesQuery.data, window],
  );

  const filtered = useMemo(
    () => applyFilter(windowed, filter, memoryFieldValue),
    [windowed, filter],
  );

  const selectedIndex = filtered.findIndex((m) => m.id === selectedId);
  const selectedMemory = selectedIndex >= 0 ? filtered[selectedIndex] : undefined;
  const dashboardRows = useMemo(
    () => filtered.map(toDashboardMemory),
    [filtered],
  );

  return (
    <PageShell
      title="Memories"
      actions={
        <div className="flex items-center gap-2">
          <DateRangeFilter onChange={setWindow} value={window} />
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
            disabled={memoriesQuery.isFetching}
            onClick={() => memoriesQuery.refetch()}
            type="button"
          >
            {memoriesQuery.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh
          </button>
          <button
            className={dashButton.primary}
            onClick={() => setCreateOpen(true)}
            type="button"
          >
            <Plus className="h-4 w-4" />
            New memory
          </button>
        </div>
      }
      contentClassName="space-y-5"
    >
      <MemorySearchToolbar
        activeQuery={query}
        filters={
          <FilterPopover
            onChange={setFilter}
            params={MEMORY_PARAMS}
            triggerClassName="h-9"
            value={filter}
          />
        }
        onChange={setSearch}
        onClear={() => {
          setSearch("");
          setQuery("");
          setSelectedId(null);
        }}
        onSearch={(value) => {
          setQuery(value);
          setSelectedId(null);
        }}
        resultCount={filtered.length}
        value={search}
      />

      {selectedIds.size > 0 ? (
        <div className="flex items-center gap-3 rounded-xl bg-foreground/5 px-4 py-2.5 ring-1 ring-foreground/10">
          <span className="text-[13px] font-medium text-foreground">
            {selectedIds.size} selected
          </span>
          <button
            className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setSelectedIds(new Set())}
            type="button"
          >
            Clear
          </button>
          <button
            className={cn(dashButton.danger, "ml-auto")}
            disabled={bulkDelete.isPending}
            onClick={() => setPendingDelete({ type: "bulk" })}
            type="button"
          >
            {bulkDelete.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            Delete
          </button>
        </div>
      ) : null}

      <MemoryTable
        emptyDescription={
          searching
            ? `Try another semantic query or clear the active filters.`
            : "Add a memory from the Playground or through the API."
        }
        emptyTitle={
          searching ? `No memories match “${query}”` : "No memories yet"
        }
        loading={memoriesQuery.isLoading}
        onDelete={(id) => setPendingDelete({ type: "single", id })}
        onOpen={setSelectedId}
        onToggle={toggleSelect}
        onToggleAll={(checked) =>
          setSelectedIds(
            checked ? new Set(filtered.map((row) => row.id)) : new Set(),
          )
        }
        rows={dashboardRows}
        searching={searching}
        selectedId={selectedId}
        selectedIds={selectedIds}
      />

      <MemoryDetailDrawer
        hasNext={selectedIndex >= 0 && selectedIndex < filtered.length - 1}
        hasPrev={selectedIndex > 0}
        memory={selectedMemory}
        onClose={() => setSelectedId(null)}
        onNext={() => setSelectedId(filtered[selectedIndex + 1]?.id ?? null)}
        onPrev={() => setSelectedId(filtered[selectedIndex - 1]?.id ?? null)}
        open={Boolean(selectedMemory)}
      />

      <CreateMemoryDialog
        loading={create.isPending}
        onClose={() => setCreateOpen(false)}
        onCreate={(value) => create.mutate(value)}
        open={createOpen}
      />

      <ConfirmDialog
        confirmLabel="Delete"
        description={
          pendingDelete?.type === "bulk"
            ? `This queues permanent deletion of ${selectedIds.size} selected memor${
                selectedIds.size === 1 ? "y" : "ies"
              }. Progress is visible in Operations. This cannot be undone.`
            : "This permanently deletes this memory. This cannot be undone."
        }
        destructive
        loading={
          pendingDelete?.type === "bulk" ? bulkDelete.isPending : remove.isPending
        }
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete?.type === "bulk") bulkDelete.mutate([...selectedIds]);
          else if (pendingDelete?.type === "single") remove.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
        open={Boolean(pendingDelete)}
        title={
          pendingDelete?.type === "bulk"
            ? "Delete selected memories"
            : "Delete memory"
        }
      />
    </PageShell>
  );
}
