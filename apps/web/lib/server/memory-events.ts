import {
  AddMemoryResponseSchema,
  MemoryEventListQuerySchema,
  type MemoryEventListQuery,
} from "@fishmem/contracts";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { AppDb } from "@/db";
import { operationTasks } from "@/db/schema";
import { readMemoryInferenceEventScope } from "@/lib/server/memory-inference-tasks";

type OperationTask = typeof operationTasks.$inferSelect;

function encodeCursor(task: OperationTask) {
  return btoa(`${task.createdAt.toISOString()}\0${task.documentId}`);
}

function decodeCursor(cursor?: string) {
  if (!cursor) return undefined;
  try {
    const [createdAt, id] = atob(cursor).split("\0", 2);
    const date = new Date(createdAt ?? "");
    if (!id || Number.isNaN(date.getTime())) throw new Error("invalid cursor");
    return { createdAt: date, id };
  } catch {
    throw new Error("INVALID_EVENT_CURSOR");
  }
}

function taskStatuses(status?: MemoryEventListQuery["status"]) {
  switch (status) {
    case "PENDING":
      return ["pending", "awaiting_upload"];
    case "RUNNING":
      return ["processing"];
    case "RETRYING":
      return ["retry"];
    case "SUCCEEDED":
      return ["success"];
    case "FAILED":
      return ["dead"];
    default:
      return undefined;
  }
}

function eventStatus(status: string) {
  switch (status) {
    case "pending":
    case "awaiting_upload":
      return "PENDING" as const;
    case "processing":
      return "RUNNING" as const;
    case "retry":
      return "RETRYING" as const;
    case "success":
      return "SUCCEEDED" as const;
    default:
      return "FAILED" as const;
  }
}

export function shapeMemoryEvent(task: OperationTask) {
  const scope = readMemoryInferenceEventScope(task.payload);
  const completedResult = AddMemoryResponseSchema.safeParse(task.result);
  if (task.status === "success" && !completedResult.success) {
    throw new Error(
      `Completed memory inference event ${task.documentId} has an invalid result`,
    );
  }
  const results = completedResult.success ? completedResult.data.results : [];
  const writeSummary =
    task.status === "success"
      ? {
          outcome: results.length > 0 ? ("STORED" as const) : ("NO_MEMORY" as const),
          planned: results.length,
          persisted: results.length,
          failed: 0,
        }
      : null;
  const startedAt = task.startedAt ?? null;
  const completedAt = task.completedAt ?? null;
  return {
    id: task.documentId,
    event_type: "ADD" as const,
    status: eventStatus(task.status),
    scope,
    results,
    write_summary: writeSummary,
    attempts: task.attempts,
    max_attempts: task.maxAttempts,
    error: task.error,
    created_at: task.createdAt.toISOString(),
    updated_at: task.updatedAt.toISOString(),
    started_at: startedAt?.toISOString() ?? null,
    completed_at: completedAt?.toISOString() ?? null,
    latency_ms:
      startedAt && completedAt
        ? Math.max(0, completedAt.getTime() - startedAt.getTime())
        : null,
  };
}

export async function getMemoryEvent(
  db: AppDb,
  workspaceId: string,
  eventId: string,
) {
  const task = await db
    .select()
    .from(operationTasks)
    .where(
      and(
        eq(operationTasks.workspaceId, workspaceId),
        eq(operationTasks.kind, "memory_infer"),
        eq(operationTasks.documentId, eventId),
      ),
    )
    .get();
  return task ? shapeMemoryEvent(task) : null;
}

export async function listMemoryEvents(
  db: AppDb,
  workspaceId: string,
  query: unknown,
) {
  const input = MemoryEventListQuerySchema.parse(query);
  const cursor = decodeCursor(input.cursor);
  const statuses = taskStatuses(input.status);
  const conditions = [
    eq(operationTasks.workspaceId, workspaceId),
    eq(operationTasks.kind, "memory_infer"),
  ];
  if (statuses) conditions.push(inArray(operationTasks.status, statuses));
  if (cursor) {
    conditions.push(
      or(
        lt(operationTasks.createdAt, cursor.createdAt),
        and(
          eq(operationTasks.createdAt, cursor.createdAt),
          lt(operationTasks.documentId, cursor.id),
        ),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(operationTasks)
    .where(and(...conditions))
    .orderBy(desc(operationTasks.createdAt), desc(operationTasks.documentId))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  return {
    results: page.map(shapeMemoryEvent),
    next_cursor:
      hasMore && page.length ? encodeCursor(page[page.length - 1]!) : null,
  };
}
