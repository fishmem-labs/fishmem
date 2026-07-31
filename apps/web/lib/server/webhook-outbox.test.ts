import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { webhookDeliveries, webhookEndpoints } from "@/db/schema";
import {
  enqueueWebhookEvent,
  processWebhookOutbox,
  retryWebhookDelivery,
} from "./webhook-outbox";

async function database() {
  const client = createClient({ url: "file::memory:" });
  for (const name of [
    "../../migrations/0001_fishmem_core.sql",
    "../../migrations/0015_operations_observability.sql",
    "../../migrations/0017_task_leases_provider_prices.sql",
    "../../migrations/0022_async_memory_events.sql",
  ]) {
    const migration = readFileSync(
      fileURLToPath(new URL(name, import.meta.url)),
      "utf8",
    );
    await client.executeMultiple(migration);
  }
  return { client, db: drizzle(client, { schema }) };
}

describe("webhook outbox", () => {
  it("persists first, then delivers from the worker", async () => {
    const { client, db } = await database();
    const now = new Date("2026-07-13T00:00:00.000Z");
    await db.insert(webhookEndpoints).values({
      id: "endpoint",
      documentId: "endpoint",
      workspaceId: "workspace",
      url: "https://example.test/hook",
      events: ["memory_add"],
      secret: "secret",
      createdAt: now,
      updatedAt: now,
    });
    await enqueueWebhookEvent(db as never, "workspace", "memory_add", {
      memory_id: "memory",
    }, now);
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      processWebhookOutbox(db as never, fetcher, now),
    ).resolves.toMatchObject({ claimed: 1, succeeded: 1 });
    const [delivery] = await db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({ status: "success", attempts: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
    client.close();
  });

  it("persists retry evidence and schedules exponential backoff", async () => {
    const { client, db } = await database();
    const now = new Date("2026-07-13T00:00:00.000Z");
    await db.insert(webhookEndpoints).values({
      id: "endpoint",
      documentId: "endpoint",
      workspaceId: "workspace",
      url: "https://example.test/hook",
      events: ["memory_add"],
      secret: "secret",
      createdAt: now,
      updatedAt: now,
    });
    await enqueueWebhookEvent(db as never, "workspace", "memory_add", {}, now);
    await processWebhookOutbox(
      db as never,
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
      now,
    );
    const [delivery] = await db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({
      status: "retry",
      attempts: 1,
      httpStatus: 503,
      error: "HTTP 503",
    });
    expect(delivery?.nextAttemptAt?.getTime()).toBe(now.getTime() + 60_000);
    await expect(
      retryWebhookDelivery(db as never, "workspace", delivery!.documentId, now),
    ).resolves.toMatchObject({ status: "pending", attempts: 0 });
    client.close();
  });

  it("deduplicates task-replay deliveries by stable event id", async () => {
    const { client, db } = await database();
    const now = new Date("2026-07-13T00:00:00.000Z");
    await db.insert(webhookEndpoints).values({
      id: "endpoint",
      documentId: "endpoint",
      workspaceId: "workspace",
      url: "https://example.test/hook",
      events: ["memory_add"],
      secret: "secret",
      createdAt: now,
      updatedAt: now,
    });

    const first = await enqueueWebhookEvent(
      db as never,
      "workspace",
      "memory_add",
      { memory_id: "memory" },
      now,
      { eventId: "memory_add:task_1" },
    );
    const replay = await enqueueWebhookEvent(
      db as never,
      "workspace",
      "memory_add",
      { memory_id: "memory" },
      now,
      { eventId: "memory_add:task_1" },
    );

    expect(replay).toEqual(first);
    expect(await db.select().from(webhookDeliveries)).toHaveLength(1);
    client.close();
  });
});
