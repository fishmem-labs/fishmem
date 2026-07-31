import { describe, expect, it } from "vitest";
import {
  createSqliteGraphStore,
  Memory,
  MockEmbedder,
  MockLLM,
  SqliteVectorStore,
} from "fishmem";
import { MemoryApplication } from "@fishmem/application";
import type { OperationTask } from "@/lib/server/operation-tasks";
import { processMemoryBatchTask } from "./memory-batch-tasks";

function task(
  kind: "batch_update" | "batch_delete",
  memories: Array<Record<string, unknown>>,
): OperationTask {
  const now = new Date("2026-07-30T00:00:00.000Z");
  return {
    id: "task_batch",
    documentId: "task_batch",
    workspaceId: "workspace",
    operationId: `${kind}:request-1`,
    kind,
    status: "pending",
    payload: { memories },
    result: null,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: now,
    leaseExpiresAt: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function engine() {
  return Memory.create({
    embedder: new MockEmbedder(64),
    graphStore: await createSqliteGraphStore({ url: ":memory:" }),
    llm: new MockLLM(),
    vectorStore: new SqliteVectorStore({ url: ":memory:" }),
  });
}

describe("durable memory batch tasks", () => {
  it("checkpoints bounded chunks and reports permanent item failures", async () => {
    const memory = await engine();
    const application = new MemoryApplication(memory);
    const ids: string[] = [];
    for (let index = 0; index < 20; index++) {
      const added = await application.add(
        "workspace",
        {
          content: `Memory ${index}`,
          user_id: "ada",
          infer: false,
        },
        `add-${index}`,
      );
      ids.push(added.results[0]!.id);
    }

    const firstTask = task("batch_update", [
      ...ids.map((memoryId, index) => ({
        memory_id: memoryId,
        content: `Updated ${index}`,
      })),
      { memory_id: "missing", content: "Cannot update this" },
    ]);
    const first = await processMemoryBatchTask(memory, firstTask);
    expect(first).toMatchObject({
      done: false,
      result: { total: 21, processed: 20, succeeded: 20, failed: 0 },
    });
    if (first.done) throw new Error("expected a continuation");

    const second = await processMemoryBatchTask(memory, {
      ...firstTask,
      payload: first.payload,
      result: first.result,
    });
    expect(second).toMatchObject({
      done: true,
      result: {
        total: 21,
        processed: 21,
        succeeded: 20,
        failed: 1,
        items: [
          ...ids.map((memoryId) => ({
            memory_id: memoryId,
            status: "succeeded",
            event: "UPDATE",
          })),
          {
            memory_id: "missing",
            status: "failed",
            error: { code: "MEMORY_NOT_FOUND" },
          },
        ],
      },
    });
    await expect(application.get("workspace", ids[0]!)).resolves.toMatchObject({
      content: "Updated 0",
    });
    await memory.close();
  });

  it("uses the same durable result contract for batch deletion", async () => {
    const memory = await engine();
    const application = new MemoryApplication(memory);
    const added = await application.add(
      "workspace",
      { content: "Delete me", user_id: "ada", infer: false },
      "add-delete",
    );
    const memoryId = added.results[0]!.id;
    const outcome = await processMemoryBatchTask(
      memory,
      task("batch_delete", [{ memory_id: memoryId }]),
    );
    expect(outcome).toMatchObject({
      done: true,
      result: {
        total: 1,
        processed: 1,
        succeeded: 1,
        failed: 0,
        items: [
          {
            memory_id: memoryId,
            status: "succeeded",
            event: "DELETE",
          },
        ],
      },
    });
    await expect(application.get("workspace", memoryId)).rejects.toMatchObject({
      code: "MEMORY_NOT_FOUND",
    });
    await memory.close();
  });
});
