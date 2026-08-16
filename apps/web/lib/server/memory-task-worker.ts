import { waitUntil } from "cloudflare:workers";
import type { Memory } from "fishmem";
import type { AppDb } from "@/db";
import { IS_CLOUDFLARE } from "@/lib/platform";
import {
  continueOperationTask,
  markOperationTaskDeliveryExhausted,
  processOperationTaskById,
  processOperationTasks,
} from "@/lib/server/operation-tasks";
import {
  createDocumentExtractionDependencies,
  type DocumentExtractionAccounting,
  processDocumentExtractionTask,
} from "@/lib/server/document-ingestion";
import { enqueueWebhookEvent } from "@/lib/server/webhook-outbox";
import { processMemoryBatchTask } from "@/lib/server/memory-batch-tasks";
import {
  type MemoryInferenceAccounting,
  processMemoryInferenceTask,
} from "@/lib/server/memory-inference-tasks";
import { sanitizePublicSnapshot } from "@/lib/server/public-snapshot";

export type MemoryTaskWorkerDependencies = {
  documentExtractionAccounting?: DocumentExtractionAccounting;
  memoryInferenceAccounting?: MemoryInferenceAccounting;
};

function handlers(
  db: AppDb,
  memory: Memory,
  dependencies: MemoryTaskWorkerDependencies = {},
) {
  return {
    batch_delete: async (task) => {
      const outcome = await processMemoryBatchTask(memory, task);
      if (!outcome.done) {
        return continueOperationTask(outcome.payload, outcome.result);
      }
      await enqueueWebhookEvent(db, task.workspaceId, "memory_delete", {
        operation_id: task.documentId,
        batch: true,
        total: outcome.result.total,
        succeeded: outcome.result.succeeded,
        failed: outcome.result.failed,
        memory_ids: outcome.result.items
          .filter((item) => item.status === "succeeded")
          .map((item) => item.memory_id),
      });
      return outcome.result;
    },
    batch_update: async (task) => {
      const outcome = await processMemoryBatchTask(memory, task);
      if (!outcome.done) {
        return continueOperationTask(outcome.payload, outcome.result);
      }
      await enqueueWebhookEvent(db, task.workspaceId, "memory_update", {
        operation_id: task.documentId,
        batch: true,
        total: outcome.result.total,
        succeeded: outcome.result.succeeded,
        failed: outcome.result.failed,
        memory_ids: outcome.result.items
          .filter((item) => item.status === "succeeded")
          .map((item) => item.memory_id),
      });
      return outcome.result;
    },
    derive: async (task) => {
      const scope = task.payload as {
        userId?: string;
        agentId?: string;
        runId?: string;
      };
      await memory.forNamespace(task.workspaceId).refreshProfile(scope);
    },
    document_extract: async (task) => {
      const { objects, extractor } =
        await createDocumentExtractionDependencies(task.documentId);
      const result = await processDocumentExtractionTask(
        db,
        memory,
        objects,
        extractor,
        task,
        dependencies.documentExtractionAccounting,
      );
      const document = result.document as
        | { id: string; content_hash?: string }
        | null;
      const chunks = "chunks" in result ? result.chunks : null;
      const created = "created" in result ? result.created : false;
      const queryVisibilityTargetMs =
        result.retrieval.visibility_target_ms;
      await enqueueWebhookEvent(db, task.workspaceId, "document_ingest", {
        operation_id: task.documentId,
        source_asset_id: result.source_asset.id,
        artifact_id: result.artifact?.id ?? null,
        document_id: document?.id ?? null,
        source_key: result.source_asset.source_key,
        content_hash: document?.content_hash ?? null,
        chunks,
        created,
        query_visibility_target_ms: queryVisibilityTargetMs,
        ...(result.source_asset.user_id
          ? { user_id: result.source_asset.user_id }
          : {}),
        ...(result.source_asset.agent_id
          ? { agent_id: result.source_asset.agent_id }
          : {}),
        ...(result.source_asset.run_id
          ? { run_id: result.source_asset.run_id }
          : {}),
      });
      return result;
    },
    maintenance: (task) =>
      memory.forNamespace(task.workspaceId).runMaintenance(),
    rebuild: (task) =>
      memory.forNamespace(task.workspaceId).rebuildProjections(),
    export: async (task) =>
      sanitizePublicSnapshot(
        await memory.forNamespace(task.workspaceId).exportSnapshot(),
      ),
    import: (task) =>
      memory
        .forNamespace(task.workspaceId)
        .importSnapshot(sanitizePublicSnapshot(task.payload.snapshot), {
          idempotencyKey: task.operationId ?? task.documentId,
        }),
    memory_infer: (task) =>
      processMemoryInferenceTask(
        db,
        memory,
        task,
        undefined,
        dependencies.memoryInferenceAccounting,
      ),
  } satisfies Parameters<typeof processOperationTasks>[1];
}

export async function processPendingMemoryTasks(
  db: AppDb,
  memory: Memory,
  now = new Date(),
  dependencies: MemoryTaskWorkerDependencies = {},
) {
  return processOperationTasks(db, handlers(db, memory, dependencies), now);
}

export async function processMemoryTaskById(
  db: AppDb,
  memory: Memory,
  taskId: string,
  now = new Date(),
  dependencies: MemoryTaskWorkerDependencies = {},
) {
  return processOperationTaskById(
    db,
    handlers(db, memory, dependencies),
    taskId,
    now,
  );
}

export async function markMemoryTaskDeliveryExhausted(
  db: AppDb,
  taskId: string,
  input: { queueName: string; messageId?: string },
  now = new Date(),
) {
  return markOperationTaskDeliveryExhausted(db, taskId, input, now);
}

export async function dispatchPendingMemoryTasks(
  db: AppDb,
  engineFactory: () => Promise<Memory>,
) {
  const work = async () => {
    const memory = await engineFactory();
    return processPendingMemoryTasks(db, memory);
  };
  if (IS_CLOUDFLARE) {
    waitUntil(
      work().catch((error) => {
        console.error("Immediate memory task dispatch failed", error);
      }),
    );
    return;
  }
  await work();
}
