"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Clock,
  Hash,
  Loader2,
  MousePointerClick,
  RefreshCw,
  Trash2,
  User,
  UsersRound,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  DateRangeFilter,
  type TimeWindow,
  windowContains,
} from "@/components/dashboard/date-range-filter";
import {
  applyFilter,
  EMPTY_FILTER,
  type Filter,
  type FilterParamDef,
  FilterPopover,
} from "@fishmem/dashboard/filter";
import {
  SCOPE_META,
  SCOPE_TYPES,
  type ScopeType,
} from "@/components/dashboard/entities-shared";
import { ConfirmDialog } from "@fishmem/dashboard/confirm-dialog";
import { chipToggle, PageShell } from "@fishmem/dashboard/page-shell";
import { useCurrentUser } from "@/hooks/use-user";
import {
  deleteScopeEntity,
  fetchAllScopeEntities,
  type ScopeEntityRow,
} from "@/lib/entities-api";

const ENTITY_PARAMS: FilterParamDef[] = [
  { value: "entity_type", label: "Entity Type", icon: UsersRound },
  { value: "user_id", label: "User ID", icon: User },
  { value: "agent_id", label: "Agent ID", icon: Bot },
  { value: "run_id", label: "Run ID", icon: Clock },
  { value: "entity_id", label: "Entity ID", icon: Hash },
];

function entityFieldValue(e: ScopeEntityRow, param: string): string {
  switch (param) {
    case "entity_type":
      return e.type;
    case "user_id":
      return e.type === "user" ? e.id : "";
    case "agent_id":
      return e.type === "agent" ? e.id : "";
    case "run_id":
      return e.type === "run" ? e.id : "";
    case "entity_id":
      return e.id;
    default:
      return "";
  }
}

function formatDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

export function EntitiesPage() {
  const { jwt, workspaceId } = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [window, setWindow] = useState<TimeWindow>({ kind: "all" });
  const [typeFilter, setTypeFilter] = useState<ScopeType | null>(null);
  const [filter, setFilter] = useState<Filter>(EMPTY_FILTER);
  const [pendingDelete, setPendingDelete] = useState<ScopeEntityRow | null>(null);

  const entitiesQuery = useQuery({
    queryKey: ["entities", jwt, workspaceId],
    queryFn: () => fetchAllScopeEntities(jwt!, workspaceId),
    enabled: Boolean(jwt && workspaceId),
  });

  const entities = entitiesQuery.data ?? [];

  const filtered = useMemo(() => {
    const base = entities.filter((e) => {
      if (typeFilter && e.type !== typeFilter) return false;
      if (window.kind !== "all") {
        if (!windowContains(e.updated_at, window)) return false;
      }
      return true;
    });
    return applyFilter(base, filter, entityFieldValue);
  }, [entities, typeFilter, window, filter]);

  const remove = useMutation({
    mutationFn: (entity: ScopeEntityRow) =>
      deleteScopeEntity(jwt ?? "", entity, workspaceId),
    onSuccess: (result) => {
      toast.success(`${result.deleted_memories} memories removed from recall`);
      void queryClient.invalidateQueries({ queryKey: ["entities"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not delete entity"),
  });

  return (
    <PageShell
      title="Entities"
      actions={<DateRangeFilter onChange={setWindow} value={window} />}
      contentClassName="space-y-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        {SCOPE_TYPES.map((t) => {
          const Icon = SCOPE_META[t].icon;
          const active = typeFilter === t;
          return (
            <button
              className={chipToggle(active)}
              key={t}
              onClick={() => setTypeFilter((v) => (v === t ? null : t))}
              type="button"
            >
              <Icon className="h-4 w-4" />
              {SCOPE_META[t].label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          <FilterPopover onChange={setFilter} params={ENTITY_PARAMS} value={filter} />
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
            disabled={entitiesQuery.isFetching}
            onClick={() => entitiesQuery.refetch()}
            type="button"
          >
            {entitiesQuery.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <div className="hidden grid-cols-[1fr_1fr_80px] gap-4 border-b border-border bg-muted/40 px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid">
          <span className="flex items-center gap-1.5">
            <MousePointerClick className="h-3.5 w-3.5" /> Entities
          </span>
          <span>Updated On</span>
          <span className="text-right">Action</span>
        </div>
        {entitiesQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading entities…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-16 text-center">
            <UsersRound className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No entities found for this project.
            </p>
          </div>
        ) : (
          filtered.map((entity) => {
            const Icon = SCOPE_META[entity.type].icon;
            return (
              <button
                className="grid w-full grid-cols-1 gap-2 border-b border-border px-5 py-3.5 text-left transition-colors last:border-b-0 hover:bg-muted/50 md:grid-cols-[1fr_1fr_80px] md:items-center md:gap-4"
                key={`${entity.type}:${entity.id}`}
                onClick={() =>
                  void navigate({
                    to: "/dashboard/entities/$id",
                    params: { id: encodeURIComponent(entity.id) },
                    search: { type: entity.type },
                  })
                }
                type="button"
              >
                <span className="flex items-center gap-2">
                  <span className="flex h-6 items-center gap-1.5 rounded-md bg-muted px-2 font-mono text-xs text-foreground">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    {entity.id}
                  </span>
                </span>
                <span className="text-[13px] text-muted-foreground">
                  {formatDateTime(entity.updated_at)}
                </span>
                <span className="flex justify-start md:justify-end">
                  <span
                    aria-label="Delete entity memories"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDelete(entity);
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <Trash2 className="h-4 w-4" />
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>

      <ConfirmDialog
        confirmLabel="Delete memories"
        description={
          pendingDelete ? (
            <>
              This removes all{" "}
              <span className="font-medium text-foreground">
                {pendingDelete.total_memories}
              </span>{" "}
              memories for{" "}
              <span className="font-medium text-foreground">
                {pendingDelete.id}
              </span>
              {" "}from active recall and records deletion tombstones in the
              audit history. Restoring them requires writing the memories again.
            </>
          ) : (
            ""
          )
        }
        destructive
        loading={remove.isPending}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete);
          setPendingDelete(null);
        }}
        open={Boolean(pendingDelete)}
        title="Delete entity memories"
      />
    </PageShell>
  );
}
