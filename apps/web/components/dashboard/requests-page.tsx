"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  Bot,
  CircleCheck,
  Clock,
  Hash,
  Layers,
  LayoutList,
  Loader2,
  PlusCircle,
  RefreshCw,
  Search,
  Table2,
  User,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";
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
import { chipToggle, PageShell } from "@fishmem/dashboard/page-shell";
import { RequestDetailDrawer } from "@/components/dashboard/request-detail-drawer";
import { RequestsTable } from "@/components/dashboard/requests-table";
import {
  requestHasResults,
  requestScopeFilters,
  typeMeta,
} from "@/components/dashboard/requests-shared";
import { BarChart } from "@/components/dashboard/charts";
import { bucketizeMetrics } from "@fishmem/dashboard/metrics";
import { useUrlParam } from "@/hooks/use-url-param";
import { useCurrentUser } from "@/hooks/use-user";
import { fetchRequests, type RequestEvent } from "@/lib/api";

const REQUEST_PARAMS: FilterParamDef[] = [
  { value: "type", label: "Type", icon: Layers },
  { value: "entity_type", label: "Entity Type", icon: Users },
  { value: "status", label: "Status", icon: CircleCheck },
  { value: "user_id", label: "User ID", icon: User },
  { value: "agent_id", label: "Agent ID", icon: Bot },
  { value: "app_id", label: "App ID", icon: AppWindow },
  { value: "run_id", label: "Run ID", icon: Clock },
  { value: "request_id", label: "Request ID", icon: Hash },
];

function requestFieldValue(e: RequestEvent, param: string): string {
  const scope = requestScopeFilters(e);
  switch (param) {
    case "type":
      return typeMeta(e.kind).label;
    case "status":
      return e.status;
    case "request_id":
      return e.id;
    case "entity_type": {
      const k = Object.keys(scope)[0];
      return k ? k.replace(/_id$/, "") : "";
    }
    default:
      return scope[param] ?? "";
  }
}

type TypeTab = "overview" | "add" | "search" | "get_all";

const TYPE_TABS: Array<{ value: TypeTab; label: string; icon: typeof Search }> = [
  { value: "overview", label: "Overview", icon: Table2 },
  { value: "add", label: "ADD", icon: PlusCircle },
  { value: "search", label: "SEARCH", icon: Search },
  { value: "get_all", label: "GET ALL", icon: LayoutList },
];

function tabMatches(row: RequestEvent, tab: TypeTab) {
  if (tab === "overview") return true;
  if (tab === "search") return row.kind === "memories.search";
  if (tab === "get_all") return row.kind === "memories.list";
  return row.kind === "memories.add" || row.kind === "memories.add_raw";
}

export function RequestsPage() {
  const { jwt, workspaceId } = useCurrentUser();
  const [window, setWindow] = useState<TimeWindow>({ kind: "all" });
  const [tab, setTab] = useState<TypeTab>("overview");
  const [onlyWithResults, setOnlyWithResults] = useState(false);
  const [filter, setFilter] = useState<Filter>(EMPTY_FILTER);
  const [selectedId, setSelectedId] = useUrlParam("request");

  const requests = useQuery({
    queryKey: ["requests", jwt, workspaceId, "all"],
    queryFn: () => fetchRequests(jwt!, "all", workspaceId),
    enabled: Boolean(jwt && workspaceId),
  });

  const rows = useMemo(() => requests.data?.data ?? [], [requests.data?.data]);
  const filteredRows = useMemo(
    () =>
      applyFilter(
        rows.filter(
          (row) =>
            windowContains(row.createdAt, window) &&
            tabMatches(row, tab) &&
            (!onlyWithResults || requestHasResults(row)),
        ),
        filter,
        requestFieldValue,
      ),
    [rows, window, tab, onlyWithResults, filter],
  );

  const selectedIndex = filteredRows.findIndex((r) => r.id === selectedId);
  const selectedEvent = selectedIndex >= 0 ? filteredRows[selectedIndex] : undefined;

  return (
    <PageShell
      title="Requests"
      actions={
        <div className="flex items-center gap-2">
          <DateRangeFilter onChange={setWindow} value={window} />
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
            disabled={requests.isFetching}
            onClick={() => requests.refetch()}
            type="button"
          >
            {requests.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh
          </button>
        </div>
      }
      contentClassName="space-y-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        {TYPE_TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              className={chipToggle(tab === t.value)}
              key={t.value}
              onClick={() => setTab(t.value)}
              type="button"
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
        <button
          className={chipToggle(onlyWithResults)}
          onClick={() => setOnlyWithResults((v) => !v)}
          title="Only requests that returned at least one memory"
          type="button"
        >
          <CircleCheck className="h-4 w-4" />
          Has Results
        </button>
        <div className="ml-auto">
          <FilterPopover onChange={setFilter} params={REQUEST_PARAMS} value={filter} />
        </div>
      </div>

      <RequestsChart rows={filteredRows} window={window} />

      <RequestsTable
        loading={requests.isLoading}
        onSelect={(row) => setSelectedId(row.id)}
        rows={filteredRows}
        selectedId={selectedId}
      />

      <RequestDetailDrawer
        event={selectedEvent}
        hasNext={selectedIndex >= 0 && selectedIndex < filteredRows.length - 1}
        hasPrev={selectedIndex > 0}
        onClose={() => setSelectedId(null)}
        onNext={() => setSelectedId(filteredRows[selectedIndex + 1]?.id ?? null)}
        onPrev={() => setSelectedId(filteredRows[selectedIndex - 1]?.id ?? null)}
        open={Boolean(selectedEvent)}
      />
    </PageShell>
  );
}

function RequestsChart({
  rows,
  window,
}: {
  rows: RequestEvent[];
  window: TimeWindow;
}) {
  // Bucket across the *selected window* (same helper the Home charts use), so
  // the x-axis spans the chosen range — e.g. 30 daily bars for 30d — instead of
  // collapsing to just the days that happen to have data.
  const data = useMemo(
    () =>
      bucketizeMetrics(
        window,
        rows.map((row) => ({
          t: new Date(row.createdAt).getTime(),
          key: "value",
        })),
      ).map((b) => ({ label: b.label, value: b.counts.value ?? 0 })),
    [rows, window],
  );

  if (rows.length === 0) {
    return (
      <div className="flex h-28 items-center justify-center rounded-xl bg-card text-sm text-muted-foreground ring-1 ring-foreground/10">
        No request activity in this range.
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <BarChart
        data={data}
        height={120}
        index="label"
        tooltip={(row) => (
          <>
            <p className="font-mono text-muted-foreground">{String(row.label)}</p>
            <p className="mt-1 font-mono text-foreground">
              {Number(row.value)} request{Number(row.value) === 1 ? "" : "s"}
            </p>
          </>
        )}
        valueKey="value"
      />
    </div>
  );
}
