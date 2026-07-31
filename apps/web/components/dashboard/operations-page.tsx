"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Clock3,
  Loader2,
  RefreshCw,
  RotateCcw,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import {
  dashButton,
  PageShell,
  StatusPill,
} from "@fishmem/dashboard/page-shell";
import { useCurrentUser } from "@/hooks/use-user";
import {
  fetchOperationsConsole,
  requestProjectionRebuild,
  retryOperation,
} from "@/lib/api";
import { formatDate } from "@/lib/utils";

function statusTone(status: string) {
  if (status === "success" || status === "committed") return "success" as const;
  if (status === "dead" || status === "failed") return "danger" as const;
  if (status === "retry") return "warning" as const;
  return "neutral" as const;
}

function operationKind(kind: string) {
  if (kind === "memory_infer") return "Memory inference";
  if (kind === "document_extract") return "Document extraction";
  return kind.replaceAll("_", " ");
}

export function OperationsPage() {
  const { jwt, workspaceId, user } = useCurrentUser();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["operations-console", jwt, workspaceId],
    queryFn: () => fetchOperationsConsole(jwt!, workspaceId),
    enabled: Boolean(jwt && workspaceId),
    refetchInterval: 10_000,
  });
  const rebuild = useMutation({
    mutationFn: () => requestProjectionRebuild(jwt!, workspaceId),
    onSuccess: () => {
      toast.success("Projection rebuild queued");
      void queryClient.invalidateQueries({ queryKey: ["operations-console"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Unable to queue rebuild"),
  });
  const retry = useMutation({
    mutationFn: (id: string) => retryOperation(jwt!, id, workspaceId),
    onSuccess: () => {
      toast.success("Operation queued for retry");
      void queryClient.invalidateQueries({ queryKey: ["operations-console"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Unable to retry operation"),
  });
  const data = query.data;
  const healthItems: Array<{
    label: string;
    value: number;
    icon: typeof Clock3;
  }> = [
    { label: "Pending", value: data?.health.pending_tasks ?? 0, icon: Clock3 },
    { label: "Dead", value: data?.health.dead_tasks ?? 0, icon: AlertTriangle },
    {
      label: "Warnings",
      value: data?.health.active_warnings ?? 0,
      icon: AlertTriangle,
    },
    {
      label: "Projection repairs",
      value: data?.health.projection_repairs ?? 0,
      icon: Wrench,
    },
  ];

  return (
    <PageShell
      title="Operations"
      actions={
        <div className="flex items-center gap-2">
          <button
            className={dashButton.outline}
            disabled={query.isFetching}
            onClick={() => query.refetch()}
            type="button"
          >
            {query.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh
          </button>
          {user?.role === "admin" ? (
            <button
              className={dashButton.primary}
              disabled={rebuild.isPending}
              onClick={() => rebuild.mutate()}
              type="button"
            >
              <Wrench className="h-4 w-4" />
              Rebuild projections
            </button>
          ) : null}
        </div>
      }
      contentClassName="space-y-6"
    >
      <section className="grid border-y border-border sm:grid-cols-2 lg:grid-cols-4">
        {healthItems.map(({ label, value, icon: Icon }, index) => (
          <div
            className={`px-5 py-4 ${index > 0 ? "border-t border-border sm:border-l sm:border-t-0" : ""}`}
            key={String(label)}
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon className="h-4 w-4" />
              {label}
            </div>
            <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-foreground">
          Task event timeline
        </h2>
        <div className="divide-y divide-border border-y border-border">
          {(data?.events ?? []).slice(0, 40).map((event) => (
            <div
              className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(220px,1fr)_minmax(240px,1.2fr)_140px] md:items-center"
              key={event.id}
            >
              <div className="flex min-w-0 items-start gap-3">
                {event.warning_code ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                ) : (
                  <Activity className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                )}
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground">
                    {operationKind(event.kind)}
                  </p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {event.operation_id ?? event.id}
                  </p>
                </div>
              </div>
              <p
                className="truncate text-xs text-muted-foreground"
                title={String(
                  event.metadata?.error ??
                    event.metadata?.message ??
                    event.warning_code ??
                    "",
                )}
              >
                {String(
                  event.metadata?.error ??
                    event.metadata?.message ??
                    event.warning_code ??
                    "Durable task state updated",
                )}
              </p>
              <div className="text-right text-[11px] text-muted-foreground">
                <p>
                  retry {event.retry_count}
                  {event.latency_ms !== null
                    ? ` · ${event.latency_ms} ms`
                    : ""}
                </p>
                <p>{formatDate(event.created_at)}</p>
              </div>
            </div>
          ))}
          {!query.isLoading && !data?.events.length ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No task events recorded.
            </p>
          ) : null}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-foreground">
          Recent tasks and operations
        </h2>
        <div className="overflow-x-auto border-y border-border">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Attempts</th>
                <th className="px-4 py-2 font-medium">Result / projections</th>
                <th className="px-4 py-2 font-medium">Updated</th>
                <th className="px-4 py-2 font-medium">Error</th>
                <th className="w-12 px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(data?.operations ?? []).map((operation) => (
                <tr key={operation.id}>
                  <td className="px-4 py-3 font-medium text-foreground">
                    {operationKind(operation.kind)}
                    <span className="mt-0.5 block max-w-[220px] truncate font-mono text-[10px] text-muted-foreground">
                      {operation.id}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill tone={statusTone(operation.status)}>
                      {operation.status}
                    </StatusPill>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{operation.attempts}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                    {operation.kind === "memory_infer"
                      ? `${operation.result_count ?? 0} refined record${operation.result_count === 1 ? "" : "s"}`
                      : operation.kind === "document_extract" &&
                          operation.status === "success"
                        ? `${operation.chunks ?? 0} chunk${
                            operation.chunks === 1 ? "" : "s"
                          } · search target ≤${Math.round(
                            (operation.query_visibility_target_ms ?? 120_000) /
                              1_000,
                          )}s`
                      : operation.vector_status || operation.derived_status
                      ? `vector:${operation.vector_status ?? "-"} · state:${operation.derived_status ?? "-"}`
                      : "-"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDate(operation.updated_at)}
                  </td>
                  <td className="max-w-[280px] truncate px-4 py-3 text-muted-foreground">
                    {operation.error ?? "-"}
                  </td>
                  <td className="px-4 py-3">
                    {["dead", "retry"].includes(operation.status) ? (
                      <button
                        aria-label="Retry operation"
                        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(operation.id)}
                        title="Retry operation"
                        type="button"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!query.isLoading && !data?.operations.length ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No operations recorded.
            </p>
          ) : null}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-foreground">Warnings</h2>
        <div className="divide-y divide-border border-y border-border">
          {(data?.warnings ?? []).slice(0, 20).map((warning) => (
            <div className="flex items-start gap-3 px-4 py-3" key={warning.id}>
              <AlertTriangle className="mt-0.5 h-4 w-4 text-warning" />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-xs text-foreground">{warning.code}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {String(warning.metadata?.message ?? "No message")}
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {formatDate(warning.created_at)}
              </span>
            </div>
          ))}
        </div>
      </section>
    </PageShell>
  );
}
