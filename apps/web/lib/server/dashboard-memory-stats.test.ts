import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, it } from "vitest";
import type { AppDb } from "@/db";
import { queryDashboardMemoryStats } from "./memory-api";

describe("queryDashboardMemoryStats", () => {
  it("counts active memories and distinct typed scope entities in one namespace", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(`
      CREATE TABLE fishmem_memories (
        namespace_id TEXT,
        user_id TEXT,
        agent_id TEXT,
        run_id TEXT,
        forgotten INTEGER NOT NULL DEFAULT 0
      )
    `);
    await client.batch(
      [
        ["alpha", "ada", null, null, 0],
        ["alpha", "ada", "helper", null, 0],
        ["alpha", null, "helper", "run-1", 0],
        ["alpha", "ignored", null, null, 1],
        ["alpha", "", "", "", 0],
        ["beta", "grace", "reviewer", "run-2", 0],
      ].map((args) => ({
        sql: `INSERT INTO fishmem_memories
          (namespace_id, user_id, agent_id, run_id, forgotten)
          VALUES (?, ?, ?, ?, ?)`,
        args,
      })),
      "write",
    );

    const db = drizzle(client) as AppDb;
    await expect(queryDashboardMemoryStats(db, "alpha")).resolves.toEqual({
      totalMemories: 4,
      totalEntities: 3,
    });
    await expect(queryDashboardMemoryStats(db, "missing")).resolves.toEqual({
      totalMemories: 0,
      totalEntities: 0,
    });

    client.close();
  });
});
