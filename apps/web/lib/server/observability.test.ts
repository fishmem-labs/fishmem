import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import {
  createProviderPriceSnapshot,
  getObservabilitySummary,
  recordMemoryWarning,
  recordProviderUsage,
} from "./observability";

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

describe("observability evidence", () => {
  it("prices provider usage from the effective immutable snapshot", async () => {
    const { client, db } = await database();
    const now = new Date("2026-07-13T00:00:00.000Z");
    const price = await createProviderPriceSnapshot(
      db as never,
      {
        workspaceId: "workspace",
        provider: "openai",
        model: "model",
        kind: "chat",
        inputMicrosPerMillion: 200_000,
        outputMicrosPerMillion: 800_000,
        source: "operator-config",
      },
      now,
    );
    const event = await recordProviderUsage(
      db as never,
      {
        provider: "openai",
        model: "model",
        kind: "chat",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        latencyMs: 120,
        context: { namespaceId: "workspace", operation: "memory.add" },
      },
      now,
    );
    expect(event).toMatchObject({ costMicros: 600_000, inputTokens: 1_000_000 });
    expect(event.metadata).toMatchObject({ price_snapshot_id: price.documentId });
    client.close();
  });

  it("keeps unpriced calls explicit and aggregates tokens, warnings, and percentiles", async () => {
    const { client, db } = await database();
    const now = new Date("2026-07-13T00:00:00.000Z");
    await recordProviderUsage(
      db as never,
      {
        provider: "openai",
        model: "unpriced",
        kind: "embedding",
        inputTokens: 10,
        outputTokens: 0,
        latencyMs: 10,
        context: { namespaceId: "workspace" },
      },
      now,
    );
    await recordProviderUsage(
      db as never,
      {
        provider: "openai",
        model: "unpriced",
        kind: "embedding",
        inputTokens: 20,
        outputTokens: 0,
        latencyMs: 100,
        context: { namespaceId: "workspace" },
      },
      now,
    );
    await recordMemoryWarning(
      db as never,
      "workspace",
      {
        code: "search_vector_failed",
        message: "Vector search unavailable",
        recoverable: true,
      },
      now,
    );
    await expect(
      getObservabilitySummary(db as never, "workspace"),
    ).resolves.toEqual({
      events: 3,
      inputTokens: 30,
      outputTokens: 0,
      knownCostMicros: 0,
      unpricedCalls: 2,
      warnings: 1,
      retries: 0,
      p50LatencyMs: 10,
      p95LatencyMs: 100,
    });
    client.close();
  });
});
