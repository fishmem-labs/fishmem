import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createSqliteGraphStore,
  Memory,
  MockEmbedder,
  MockLLM,
  SqliteVectorStore,
} from "fishmem";
import * as schema from "@/db/schema";
import {
  getMemoryEvent,
  listMemoryEvents,
} from "@/lib/server/memory-events";
import {
  enqueueMemoryInferenceTask,
} from "@/lib/server/memory-inference-tasks";
import { processMemoryTaskById } from "@/lib/server/memory-task-worker";

async function database() {
  const client = createClient({ url: "file::memory:" });
  for (const name of [
    "../../migrations/0001_fishmem_core.sql",
    "../../migrations/0015_operations_observability.sql",
    "../../migrations/0017_task_leases_provider_prices.sql",
    "../../migrations/0022_async_memory_events.sql",
  ]) {
    await client.executeMultiple(
      readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8"),
    );
  }
  return { client, db: drizzle(client, { schema }) };
}

async function engine() {
  return Memory.create({
    embedder: new MockEmbedder(64),
    graphStore: await createSqliteGraphStore({ url: ":memory:" }),
    llm: new MockLLM(),
    vectorStore: new SqliteVectorStore({ url: ":memory:" }),
  });
}

describe("asynchronous memory inference", () => {
  it("executes through the durable task and exposes a privacy-safe event", async () => {
    const { client, db } = await database();
    const memory = await engine();
    const task = await enqueueMemoryInferenceTask(db as never, {
      workspaceId: "workspace",
      command: {
        messages: [
          { role: "user", content: "Ada prefers tea. Ada lives in Taipei." },
        ],
        user_id: "ada",
      },
      idempotencyKey: "conversation-1",
      derivationEnabled: false,
    });

    await expect(
      getMemoryEvent(db as never, "workspace", task.documentId),
    ).resolves.toMatchObject({
      id: task.documentId,
      status: "PENDING",
      scope: { user_id: "ada" },
      results: [],
      write_summary: null,
    });

    const now = new Date(task.nextAttemptAt!.getTime() + 1_000);
    await expect(
      processMemoryTaskById(
        db as never,
        memory,
        task.documentId,
        now,
      ),
    ).resolves.toMatchObject({ claimed: 1, succeeded: 1 });

    const event = await getMemoryEvent(
      db as never,
      "workspace",
      task.documentId,
    );
    expect(event).toMatchObject({
      status: "SUCCEEDED",
      attempts: 1,
      error: null,
      scope: { user_id: "ada" },
      results: [
        { memory: "Ada prefers tea", event: "ADD" },
        { memory: "Ada lives in Taipei", event: "ADD" },
      ],
      write_summary: {
        outcome: "STORED",
        planned: 2,
        persisted: 2,
        failed: 0,
      },
      started_at: now.toISOString(),
    });
    expect(new Date(event!.completed_at!).getTime()).toBeGreaterThanOrEqual(
      now.getTime(),
    );
    expect(event!.latency_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(event)).not.toContain(
      "Ada prefers tea. Ada lives in Taipei.",
    );
    const completedTask = await db
      .select()
      .from(schema.operationTasks)
      .where(eq(schema.operationTasks.documentId, task.documentId))
      .get();
    expect(JSON.stringify(completedTask?.payload)).not.toContain(
      "Ada prefers tea. Ada lives in Taipei.",
    );
    expect(completedTask?.payload).not.toHaveProperty("command");
    const replay = await enqueueMemoryInferenceTask(db as never, {
      workspaceId: "workspace",
      command: {
        messages: [
          { role: "user", content: "Ada prefers tea. Ada lives in Taipei." },
        ],
        user_id: "ada",
      },
      idempotencyKey: "conversation-1",
      derivationEnabled: false,
    });
    expect(replay.documentId).toBe(task.documentId);
    client.close();
  });

  it("surfaces a failed projection and repairs it without reinference or duplicate writes", async () => {
    class FailingOnceVectorStore extends SqliteVectorStore {
      private failed = false;

      override async upsert(
        records: Parameters<SqliteVectorStore["upsert"]>[0],
      ): Promise<void> {
        if (!this.failed) {
          this.failed = true;
          throw new Error("vector unavailable");
        }
        await super.upsert(records);
      }
    }

    const { client, db } = await database();
    let extractionCalls = 0;
    const memory = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore: await createSqliteGraphStore({ url: ":memory:" }),
      llm: new MockLLM(() => {
        extractionCalls += 1;
        return JSON.stringify({ facts: [{ text: "Ada prefers tea" }] });
      }),
      vectorStore: new FailingOnceVectorStore({ url: ":memory:" }),
    });
    const task = await enqueueMemoryInferenceTask(db as never, {
      workspaceId: "workspace",
      command: { content: "Ada prefers tea", user_id: "ada" },
      idempotencyKey: "recover-projection-1",
      derivationEnabled: false,
    });

    const firstAttemptAt = new Date(task.nextAttemptAt!.getTime() + 1_000);
    await expect(
      processMemoryTaskById(
        db as never,
        memory,
        task.documentId,
        firstAttemptAt,
      ),
    ).resolves.toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
    await expect(
      getMemoryEvent(db as never, "workspace", task.documentId),
    ).resolves.toMatchObject({
      status: "RETRYING",
      results: [],
      write_summary: null,
      error: "vector unavailable",
    });

    const retryable = await db
      .select()
      .from(schema.operationTasks)
      .where(eq(schema.operationTasks.documentId, task.documentId))
      .get();
    const retryAt = new Date(retryable!.nextAttemptAt!.getTime() + 1_000);
    await expect(
      processMemoryTaskById(
        db as never,
        memory,
        task.documentId,
        retryAt,
      ),
    ).resolves.toMatchObject({ claimed: 1, succeeded: 1, retried: 0 });

    const event = await getMemoryEvent(
      db as never,
      "workspace",
      task.documentId,
    );
    expect(event).toMatchObject({
      status: "SUCCEEDED",
      results: [{ memory: "Ada prefers tea", event: "ADD" }],
      write_summary: {
        outcome: "STORED",
        planned: 1,
        persisted: 1,
        failed: 0,
      },
      attempts: 2,
      error: null,
    });
    expect(extractionCalls).toBe(1);
    expect(
      (await memory.forNamespace("workspace").getAll({ userId: "ada" }))
        .results,
    ).toHaveLength(1);
    client.close();
  });

  it("distinguishes a successful no-op inference from a write failure", async () => {
    const { client, db } = await database();
    const memory = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore: await createSqliteGraphStore({ url: ":memory:" }),
      llm: new MockLLM(() => JSON.stringify({ facts: [] })),
      vectorStore: new SqliteVectorStore({ url: ":memory:" }),
    });
    const task = await enqueueMemoryInferenceTask(db as never, {
      workspaceId: "workspace",
      command: { content: "Thanks!", user_id: "ada" },
      idempotencyKey: "no-memory-1",
      derivationEnabled: false,
    });

    await processMemoryTaskById(
      db as never,
      memory,
      task.documentId,
      new Date(task.nextAttemptAt!.getTime() + 1_000),
    );

    await expect(
      getMemoryEvent(db as never, "workspace", task.documentId),
    ).resolves.toMatchObject({
      status: "SUCCEEDED",
      results: [],
      write_summary: {
        outcome: "NO_MEMORY",
        planned: 0,
        persisted: 0,
        failed: 0,
      },
    });
    client.close();
  });

  it("fails closed when a completed task result violates the public contract", async () => {
    const { client, db } = await database();
    const task = await enqueueMemoryInferenceTask(db as never, {
      workspaceId: "workspace",
      command: { content: "Ada prefers tea", user_id: "ada" },
      idempotencyKey: "invalid-result-1",
      derivationEnabled: false,
    });
    await db
      .update(schema.operationTasks)
      .set({
        status: "success",
        result: {
          results: [
            { id: "mem_1", memory: "", event: "ADD" },
          ],
        },
        completedAt: new Date(),
      })
      .where(eq(schema.operationTasks.documentId, task.documentId));

    await expect(
      getMemoryEvent(db as never, "workspace", task.documentId),
    ).rejects.toThrow(
      `Completed memory inference event ${task.documentId} has an invalid result`,
    );
    client.close();
  });

  it("replays equivalent commands while ignoring ephemeral usage ownership", async () => {
    const { client, db } = await database();
    const base = {
      workspaceId: "workspace",
      command: {
        content: "Ada prefers tea",
        metadata: { source: "chat", channel: "support" },
        user_id: "ada",
      },
      idempotencyKey: "conversation-2",
      derivationEnabled: false,
    };
    const first = await enqueueMemoryInferenceTask(db as never, {
      ...base,
      usage: {
        version: 1,
        api_token_id: "key_1",
        credits: 2,
        reservation: { reservationId: "usage_1", ownerId: "owner_1" },
      },
    });
    const replay = await enqueueMemoryInferenceTask(db as never, {
      ...base,
      command: {
        user_id: "ada",
        metadata: { channel: "support", source: "chat" },
        content: "Ada prefers tea",
      },
      usage: {
        version: 1,
        api_token_id: "key_1",
        credits: 0,
        reservation: {
          reservationId: "usage_1",
          alreadyCharged: true,
        },
      },
    });
    expect(replay.documentId).toBe(first.documentId);
    await expect(
      enqueueMemoryInferenceTask(db as never, {
        ...base,
        command: { content: "Ada prefers coffee", user_id: "ada" },
      }),
    ).rejects.toThrow("idempotency key conflict:");
    client.close();
  });

  it("paginates event reads with opaque cursors", async () => {
    const { client, db } = await database();
    for (const idempotencyKey of ["first", "second"]) {
      await enqueueMemoryInferenceTask(db as never, {
        workspaceId: "workspace",
        command: { content: idempotencyKey, user_id: "ada" },
        idempotencyKey,
        derivationEnabled: false,
      });
    }
    const firstPage = await listMemoryEvents(db as never, "workspace", {
      limit: "1",
    });
    expect(firstPage.results).toHaveLength(1);
    expect(firstPage.next_cursor).toEqual(expect.any(String));
    const secondPage = await listMemoryEvents(db as never, "workspace", {
      cursor: firstPage.next_cursor,
      limit: "1",
    });
    expect(secondPage.results).toHaveLength(1);
    expect(secondPage.results[0]?.id).not.toBe(firstPage.results[0]?.id);
    client.close();
  });
});
