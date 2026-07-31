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
