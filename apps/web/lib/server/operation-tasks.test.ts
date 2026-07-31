import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import {
  observabilityEvents,
  operationTasks,
  sourceAssets,
} from "@/db/schema";
import {
  continueOperationTask,
  enqueueOperationTask,
  markOperationTaskDeliveryExhausted,
  processOperationTasks,
  retryOperationTask,
} from "./operation-tasks";

async function database() {
  const client = createClient({ url: "file::memory:" });
  for (const name of [
    "../../migrations/0001_fishmem_core.sql",
    "../../migrations/0015_operations_observability.sql",
    "../../migrations/0017_task_leases_provider_prices.sql",
    "../../migrations/0021_document_extraction.sql",
    "../../migrations/0022_async_memory_events.sql",
  ]) {
    await client.executeMultiple(
      readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8"),
    );
  }
  return { client, db: drizzle(client, { schema }) };
}

describe("operation task queue", () => {
  it("claims and completes a task exactly once", async () => {
    const { client, db } = await database();
    const now = new Date("2026-07-13T00:00:00.000Z");
    await enqueueOperationTask(
      db as never,
      { workspaceId: "workspace", kind: "maintenance", payload: {} },
      now,
    );
    const handler = vi.fn().mockResolvedValue(undefined);
    await expect(
      processOperationTasks(db as never, { maintenance: handler }, now),
    ).resolves.toMatchObject({ claimed: 1, succeeded: 1 });
    await processOperationTasks(db as never, { maintenance: handler }, now);
    expect(handler).toHaveBeenCalledOnce();
    expect((await db.select().from(operationTasks))[0]).toMatchObject({
      status: "success",
      attempts: 1,
    });
    client.close();
  });

  it("reclaims expired leases and supports explicit dead-task replay", async () => {
    const { client, db } = await database();
    const now = new Date("2026-07-13T00:10:00.000Z");
    const task = await enqueueOperationTask(
      db as never,
      {
        workspaceId: "workspace",
        kind: "rebuild",
        payload: {},
        maxAttempts: 1,
      },
      new Date(now.getTime() - 600_000),
    );
    await db
      .update(operationTasks)
      .set({
        status: "processing",
        leaseExpiresAt: new Date(now.getTime() - 1),
      })
      .where(eq(operationTasks.id, task.id));
    await processOperationTasks(
      db as never,
      { rebuild: vi.fn().mockRejectedValue(new Error("offline")) },
      now,
    );
    expect((await db.select().from(operationTasks))[0]?.status).toBe("dead");
    await expect(
      retryOperationTask(db as never, "workspace", task.documentId, now),
    ).resolves.toMatchObject({ status: "pending", attempts: 0 });
    client.close();
  });

  it("replays an identical task but rejects idempotency-key payload reuse", async () => {
    const { client, db } = await database();
    const input = {
      workspaceId: "workspace",
      operationId: "import:backup-1",
      kind: "import" as const,
      payload: { snapshot: { version: 1, data: { memories: [] } } },
    };
    const first = await enqueueOperationTask(db as never, input);
    await expect(
      enqueueOperationTask(db as never, {
        ...input,
        payload: { snapshot: { data: { memories: [] }, version: 1 } },
      }),
    ).resolves.toMatchObject({ documentId: first.documentId });
    await expect(
      enqueueOperationTask(db as never, {
        ...input,
        payload: { snapshot: { version: 2, data: { memories: [] } } },
      }),
    ).rejects.toThrow("idempotency key conflict:");
    expect(await db.select().from(operationTasks)).toHaveLength(1);
    client.close();
  });

  it("persists bounded progress without spending the failure retry budget", async () => {
    const { client, db } = await database();
    const now = new Date("2026-07-13T00:20:00.000Z");
    await enqueueOperationTask(
      db as never,
      {
        workspaceId: "workspace",
        kind: "batch_update",
        payload: { cursor: 0 },
      },
      now,
    );
    const handler = vi
      .fn()
      .mockResolvedValueOnce(
        continueOperationTask(
          { cursor: 20 },
          { processed: 20, succeeded: 20, failed: 0 },
        ),
      )
      .mockResolvedValueOnce({
        processed: 25,
        succeeded: 25,
        failed: 0,
      });

    await expect(
      processOperationTasks(db as never, { batch_update: handler }, now),
    ).resolves.toMatchObject({ claimed: 1, continued: 1, succeeded: 0 });
    expect((await db.select().from(operationTasks))[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      payload: { cursor: 20 },
      result: { processed: 20, succeeded: 20, failed: 0 },
    });

    await expect(
      processOperationTasks(db as never, { batch_update: handler }, now),
    ).resolves.toMatchObject({ claimed: 1, continued: 0, succeeded: 1 });
    expect((await db.select().from(operationTasks))[0]).toMatchObject({
      status: "success",
      attempts: 1,
      result: { processed: 25, succeeded: 25, failed: 0 },
    });
    client.close();
  });

  it("persists an exhausted queue delivery and redrives its source exactly once", async () => {
    const { client, db } = await database();
    const now = new Date("2026-07-13T00:30:00.000Z");
    const task = await enqueueOperationTask(
      db as never,
      {
        workspaceId: "workspace",
        operationId: "upload-1",
        kind: "document_extract",
        payload: { sourceAssetId: "asset-1" },
      },
      now,
    );
    await db.insert(sourceAssets).values({
      id: "asset-1",
      documentId: "asset-1",
      workspaceId: "workspace",
      operationTaskId: task.documentId,
      idempotencyKey: "upload-1",
      sourceKey: "handbook.pdf",
      filename: "handbook.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      storageKey: "source-assets/v1/workspace/asset-1/original",
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });

    await markOperationTaskDeliveryExhausted(
      db as never,
      task.documentId,
      { queueName: "fishmem-document-tasks-dlq", messageId: "message-1" },
      now,
    );
    await markOperationTaskDeliveryExhausted(
      db as never,
      task.documentId,
      { queueName: "fishmem-document-tasks-dlq", messageId: "message-1" },
      new Date(now.getTime() + 1_000),
    );

    expect((await db.select().from(operationTasks))[0]).toMatchObject({
      status: "dead",
      error: expect.stringContaining("[QUEUE_DELIVERY_EXHAUSTED]"),
    });
    expect((await db.select().from(sourceAssets))[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("[QUEUE_DELIVERY_EXHAUSTED]"),
    });
    expect(await db.select().from(observabilityEvents)).toHaveLength(1);

    await expect(
      retryOperationTask(
        db as never,
        "workspace",
        task.documentId,
        new Date(now.getTime() + 2_000),
      ),
    ).resolves.toMatchObject({ status: "pending", attempts: 0 });
    await expect(
      retryOperationTask(
        db as never,
        "workspace",
        task.documentId,
        new Date(now.getTime() + 3_000),
      ),
    ).resolves.toMatchObject({ status: "pending", attempts: 0 });
    expect((await db.select().from(sourceAssets))[0]).toMatchObject({
      status: "queued",
      error: null,
    });
    expect(
      (await db.select().from(observabilityEvents)).map((event) => event.kind),
    ).toEqual([
      "task_queue_delivery_exhausted",
      "task_redriven",
    ]);
    client.close();
  });
});
