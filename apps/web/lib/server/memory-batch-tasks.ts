import {
  BatchDeleteMemoriesCommandSchema,
  BatchUpdateMemoriesCommandSchema,
  type BatchDeleteMemoriesCommand,
  type BatchUpdateMemoriesCommand,
} from "@fishmem/contracts";
import { MemoryApplication, MemoryApplicationError } from "@fishmem/application";
import type { Memory } from "fishmem";
import type { OperationTask } from "@/lib/server/operation-tasks";

const BATCH_CHUNK_SIZE = 20;

type BatchItemResult =
  | {
      memory_id: string;
      status: "succeeded";
      event: "UPDATE" | "DELETE";
    }
  | {
      memory_id: string;
      status: "failed";
      error: {
        code: string;
        message: string;
      };
    };

export type MemoryBatchResult = {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  items: BatchItemResult[];
};

export type MemoryBatchTaskOutcome =
  | {
      done: false;
      payload: Record<string, unknown>;
      result: MemoryBatchResult;
    }
  | {
      done: true;
      result: MemoryBatchResult;
    };

function previousResult(task: OperationTask, total: number): MemoryBatchResult {
  const result = task.result as Partial<MemoryBatchResult> | null;
  if (!result) {
    return { total, processed: 0, succeeded: 0, failed: 0, items: [] };
  }
  if (
    result.total !== total ||
    !Number.isInteger(result.processed) ||
    typeof result.succeeded !== "number" ||
    typeof result.failed !== "number" ||
    !Array.isArray(result.items)
  ) {
    throw new Error(`Invalid persisted batch result for ${task.documentId}`);
  }
  return result as MemoryBatchResult;
}

function permanentItemFailure(error: unknown) {
  if (error instanceof MemoryApplicationError && error.status < 500) {
    return { code: error.code, message: error.message };
  }
  return null;
}

function itemIdempotencyKey(
  task: OperationTask,
  action: "update" | "delete",
  index: number,
) {
  return `batch:${action}:${task.documentId}:${index}`;
}

async function updateChunk(
  application: MemoryApplication,
  task: OperationTask,
  command: BatchUpdateMemoriesCommand,
  start: number,
) {
  const results: BatchItemResult[] = [];
  const chunk = command.memories.slice(start, start + BATCH_CHUNK_SIZE);
  for (const [offset, item] of chunk.entries()) {
    try {
      await application.update(
        task.workspaceId,
        item.memory_id,
        {
          content: item.content,
          metadata: item.metadata,
          importance: item.importance,
          memory_type: item.memory_type,
          version: item.version,
        },
        itemIdempotencyKey(task, "update", start + offset),
      );
      results.push({
        memory_id: item.memory_id,
        status: "succeeded",
        event: "UPDATE",
      });
    } catch (error) {
      const failure = permanentItemFailure(error);
      if (!failure) throw error;
      results.push({
        memory_id: item.memory_id,
        status: "failed",
        error: failure,
      });
    }
  }
  return results;
}

async function deleteChunk(
  application: MemoryApplication,
  task: OperationTask,
  command: BatchDeleteMemoriesCommand,
  start: number,
) {
  const results: BatchItemResult[] = [];
  const chunk = command.memories.slice(start, start + BATCH_CHUNK_SIZE);
  for (const [offset, item] of chunk.entries()) {
    try {
      await application.delete(
        task.workspaceId,
        item.memory_id,
        itemIdempotencyKey(task, "delete", start + offset),
      );
      results.push({
        memory_id: item.memory_id,
        status: "succeeded",
        event: "DELETE",
      });
    } catch (error) {
      const failure = permanentItemFailure(error);
      if (!failure) throw error;
      results.push({
        memory_id: item.memory_id,
        status: "failed",
        error: failure,
      });
    }
  }
  return results;
}

export async function processMemoryBatchTask(
  memory: Memory,
  task: OperationTask,
): Promise<MemoryBatchTaskOutcome> {
  if (task.kind !== "batch_update" && task.kind !== "batch_delete") {
    throw new Error(`Unsupported memory batch task kind: ${task.kind}`);
  }
  const update = task.kind === "batch_update";
  const command = update
    ? BatchUpdateMemoriesCommandSchema.parse({
        memories: task.payload.memories,
      })
    : BatchDeleteMemoriesCommandSchema.parse({
        memories: task.payload.memories,
      });
  const previous = previousResult(task, command.memories.length);
  const start = previous.processed;
  if (
    start < 0 ||
    start > command.memories.length ||
    previous.items.length !== start
  ) {
    throw new Error(`Invalid persisted batch progress for ${task.documentId}`);
  }
  const application = new MemoryApplication(memory);
  const items = update
    ? await updateChunk(
        application,
        task,
        command as BatchUpdateMemoriesCommand,
        start,
      )
    : await deleteChunk(
        application,
        task,
        command as BatchDeleteMemoriesCommand,
        start,
      );
  const next = start + items.length;
  const combined = [...previous.items, ...items];
  const result: MemoryBatchResult = {
    total: command.memories.length,
    processed: next,
    succeeded: combined.filter((item) => item.status === "succeeded").length,
    failed: combined.filter((item) => item.status === "failed").length,
    items: combined,
  };
  if (next < command.memories.length) {
    return {
      done: false,
      payload: { memories: command.memories },
      result,
    };
  }
  return { done: true, result };
}
