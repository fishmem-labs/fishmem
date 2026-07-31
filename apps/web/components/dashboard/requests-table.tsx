"use client";

import { Activity, CircleCheck, CircleX, Clock, Loader2, Search } from "lucide-react";
import type { RequestEvent } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  relativeTime,
  requestEntityLabel,
  requestResultCount,
  typeMeta,
} from "@/components/dashboard/requests-shared";

export function RequestsTable({
  rows,
  loading,
  selectedId,
  onSelect,
  emptyText = "No request activity for this filter.",
}: {
  rows: RequestEvent[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (row: RequestEvent, index: number) => void;
  emptyText?: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="hidden grid-cols-[130px_110px_1fr_96px_110px_80px] gap-4 border-b border-border bg-muted/40 px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid">
        <span className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" /> Time
        </span>
        <span>Type</span>
        <span>Entities</span>
        <span>Results</span>
        <span>Latency</span>
        <span className="text-right">Status</span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center gap-2 px-5 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading requests…
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 py-16 text-center">
          <Activity className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        </div>
      ) : (
        rows.map((row, i) => (
          <RequestRow
            active={selectedId === row.id}
            key={row.id}
            onClick={() => onSelect(row, i)}
            row={row}
          />
        ))
      )}
    </div>
  );
}

function RequestRow({
  row,
  active,
  onClick,
}: {
  row: RequestEvent;
  active: boolean;
  onClick: () => void;
}) {
  const meta = typeMeta(row.kind);
  const entity = requestEntityLabel(row);
  const count = requestResultCount(row);
  const failed = row.status === "failed";

  return (
    <button
      className={cn(
        "grid w-full grid-cols-1 gap-2 border-b border-border px-5 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50 md:grid-cols-[130px_110px_1fr_96px_110px_80px] md:items-center md:gap-4",
        active && "bg-muted/60",
      )}
      onClick={onClick}
      type="button"
    >
      <span className="text-sm text-muted-foreground">
        {relativeTime(row.createdAt)}
      </span>
      <span>
        <span
          className={cn(
            "inline-flex h-[18px] items-center rounded-full px-1.5 text-[10.5px] font-medium",
            meta.tone,
          )}
        >
          {meta.label}
        </span>
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground">
        {entity ?? "—"}
      </span>
      <span>
        {count !== null && count > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            <Search className="h-3 w-3" />
            {count}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </span>
      <span className="font-mono text-xs text-muted-foreground">
        {typeof row.latencyMs === "number" ? `${row.latencyMs} ms` : "—"}
      </span>
      <span className="flex items-center justify-start md:justify-end">
        {failed ? (
          <CircleX className="h-4 w-4 text-destructive" />
        ) : (
          <CircleCheck className="h-4 w-4 text-success" />
        )}
      </span>
    </button>
  );
}
