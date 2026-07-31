"use client";

import { Download, Loader2, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { dashButton } from "@fishmem/dashboard/page-shell";
import { useCurrentUser } from "@/hooks/use-user";
import {
  fetchMemorySnapshot,
  importMemorySnapshot,
  type MemoryRow,
} from "@/lib/memories-api";

const CSV_COLS = [
  "id",
  "memory",
  "memory_type",
  "user_id",
  "agent_id",
  "run_id",
  "created_at",
  "updated_at",
] as const;

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toCsv(rows: MemoryRow[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    CSV_COLS.join(","),
    ...rows.map((r) =>
      CSV_COLS.map((c) => esc((r as Record<string, unknown>)[c])).join(","),
    ),
  ].join("\n");
}

export function BackupSection({ projectName }: { projectName: string }) {
  const { jwt, workspaceId } = useCurrentUser();
  const [exporting, setExporting] = useState<"json" | "csv" | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);

  const slug =
    projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
    "project";

  const doExport = async (format: "json" | "csv") => {
    if (!jwt) return;
    setExporting(format);
    try {
      const snapshot = await fetchMemorySnapshot(jwt, workspaceId);
      const rows: MemoryRow[] = snapshot.data.memories.map((memory) => ({
        id: memory.id,
        memory: memory.content,
        memory_type: memory.memoryType,
        importance: memory.importance,
        user_id: memory.userId ?? null,
        agent_id: memory.agentId ?? null,
        run_id: memory.runId ?? null,
        metadata: memory.metadata ?? null,
        created_at: memory.createdAt,
        updated_at: memory.updatedAt,
        event_date: memory.eventDate ?? null,
        valid_from: memory.validFrom ?? null,
        valid_to: memory.validTo ?? null,
      }));
      if (format === "json") {
        download(
          `fishmem-${slug}-snapshot-v${snapshot.version}.json`,
          JSON.stringify(snapshot, null, 2),
          "application/json",
        );
      } else {
        download(`fishmem-${slug}-memories.csv`, toCsv(rows), "text/csv");
      }
      toast.success(`Exported ${rows.length} memories`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(null);
    }
  };

  const doRestore = async () => {
    if (!jwt || !restoreFile) return;
    setRestoring(true);
    try {
      const snapshot = JSON.parse(await restoreFile.text()) as unknown;
      const task = await importMemorySnapshot(
        jwt,
        snapshot,
        `dashboard-restore:${crypto.randomUUID()}`,
        workspaceId,
      );
      setRestoreFile(null);
      toast.success(`Restore queued (${task.id}). Track it in Operations.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Restore failed");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <p className="mb-1 text-[13px] font-medium text-foreground">Backup</p>
        <p className="mb-3 text-xs text-muted-foreground">
          Versioned project snapshot, or a flat CSV subset.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            className={dashButton.outline}
            disabled={exporting !== null}
            onClick={() => doExport("json")}
            type="button"
          >
            {exporting === "json" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Export JSON
          </button>
          <button
            className={dashButton.outline}
            disabled={exporting !== null}
            onClick={() => doExport("csv")}
            type="button"
          >
            {exporting === "csv" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Export CSV
          </button>
        </div>
      </div>

      <div className="border-t border-border pt-5">
        <p className="mb-1 text-[13px] font-medium text-foreground">Restore</p>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Restore a FishMem JSON snapshot into this project. The target must be
          empty; FishMem preserves record IDs, history, and journal provenance,
          then rebuilds vector and state projections.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className={dashButton.outline}>
            <Upload className="h-4 w-4" />
            Choose snapshot
            <input
              accept="application/json,.json"
              className="sr-only"
              disabled={restoring}
              onChange={(event) =>
                setRestoreFile(event.target.files?.[0] ?? null)
              }
              type="file"
            />
          </label>
          {restoreFile ? (
            <>
              <span className="max-w-[240px] truncate text-xs text-muted-foreground">
                {restoreFile.name}
              </span>
              <button
                className={dashButton.primary}
                disabled={restoring}
                onClick={doRestore}
                type="button"
              >
                {restoring ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                Restore snapshot
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
