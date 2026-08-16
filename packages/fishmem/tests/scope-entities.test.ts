import { describe, expect, it } from "vitest";
import type { GraphStore } from "../src/graph/base.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import { createSqliteGraphStore } from "../src/graph/sqlite.js";
import type { Memory } from "../src/types.js";

function record(
  id: string,
  input: Partial<Memory> & Pick<Memory, "namespaceId">,
): Memory {
  return {
    id,
    content: id,
    memoryType: "fact",
    importance: 0.5,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    lastAccessedAt: new Date("2026-07-01T00:00:00.000Z"),
    accessCount: 0,
    forgotten: false,
    ...input,
  };
}

async function seed(store: GraphStore) {
  await store.init();
  await store.saveMemory(
    record("m1", {
      namespaceId: "alpha",
      userId: "ada",
      agentId: "assistant",
      runId: "run-1",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    }),
  );
  await store.saveMemory(
    record("m2", {
      namespaceId: "alpha",
      userId: "ada",
      agentId: "reviewer",
      createdAt: new Date("2026-06-30T00:00:00.000Z"),
      updatedAt: new Date("2026-07-03T00:00:00.000Z"),
    }),
  );
  await store.saveMemory(
    record("forgotten", {
      namespaceId: "alpha",
      userId: "old-user",
      forgotten: true,
      updatedAt: new Date("2026-07-04T00:00:00.000Z"),
    }),
  );
  await store.saveMemory(
    record("other-namespace", {
      namespaceId: "beta",
      userId: "ada",
      updatedAt: new Date("2026-07-05T00:00:00.000Z"),
    }),
  );
}

async function expectScopeEntityContract(store: GraphStore) {
  await seed(store);
  expect(store.countScopeEntities).toBeDefined();
  await expect(store.countScopeEntities!("alpha")).resolves.toBe(4);
  await expect(store.countScopeEntities!("beta")).resolves.toBe(1);
  const first = await store.listScopeEntities("alpha", { limit: 2 });
  expect(first).toMatchObject([
    {
      id: "ada",
      type: "user",
      totalMemories: 2,
      createdAt: new Date("2026-06-30T00:00:00.000Z"),
      updatedAt: new Date("2026-07-03T00:00:00.000Z"),
    },
    {
      id: "reviewer",
      type: "agent",
      totalMemories: 1,
      updatedAt: new Date("2026-07-03T00:00:00.000Z"),
    },
  ]);

  const last = first[1]!;
  const second = await store.listScopeEntities("alpha", {
    limit: 2,
    cursor: { id: last.id, type: last.type, updatedAt: last.updatedAt },
  });
  expect(second.map(({ type, id }) => `${type}:${id}`)).toEqual([
    "agent:assistant",
    "run:run-1",
  ]);
  await expect(
    store.listScopeEntities("alpha", {
      type: "user",
      id: "ada",
      limit: 1,
    }),
  ).resolves.toMatchObject([{ id: "ada", totalMemories: 2 }]);
  await expect(
    store.listScopeEntities("alpha", {
      type: "user",
      id: "old-user",
      limit: 1,
    }),
  ).resolves.toEqual([]);
}

describe("scope entity aggregation", () => {
  it("uses canonical non-forgotten memories in the in-memory adapter", async () => {
    await expectScopeEntityContract(new InMemoryGraphStore());
  });

  it("has matching pagination and aggregation in the SQLite adapter", async () => {
    await expectScopeEntityContract(
      await createSqliteGraphStore({ url: ":memory:" }),
    );
  });
});
