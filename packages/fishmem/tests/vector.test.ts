import { describe, expect, it } from "vitest";
import type { MemoryWarning } from "../src/index.js";
import {
  deleteVectorRecords,
  getVectorRecords,
  type VectorRecord,
  type VectorStore,
} from "../src/vector/base.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";
import { PgVectorStore } from "../src/vector/pgvector.js";
import {
  type VectorizeBinding,
  VectorizeStore,
} from "../src/vector/vectorize.js";

function record(
  id: string,
  vector: number[],
  content: string,
  payload: Record<string, unknown> = {},
): VectorRecord {
  return { id, vector, content, payload };
}

describe("InMemoryVectorStore contract", () => {
  it("falls back to the one-id contract for simple custom stores", async () => {
    const records = new Map([
      ["a", record("a", [1, 0], "a")],
      ["b", record("b", [0, 1], "b")],
    ]);
    const deleted: string[] = [];
    const store: VectorStore = {
      async init() {},
      async upsert() {},
      async search() {
        return [];
      },
      async get(id) {
        return records.get(id) ?? null;
      },
      async delete(id) {
        deleted.push(id);
        records.delete(id);
      },
      async deleteByFilter() {},
      async list() {
        return [...records.values()];
      },
    };

    await expect(getVectorRecords(store, [])).resolves.toEqual([]);
    await expect(
      getVectorRecords(store, ["b", "missing", "a"]),
    ).resolves.toEqual([
      expect.objectContaining({ id: "b" }),
      null,
      expect.objectContaining({ id: "a" }),
    ]);
    await deleteVectorRecords(store, []);
    await deleteVectorRecords(store, ["a", "a", "b"]);
    expect(deleted).toEqual(["a", "b"]);
  });

  it("rejects vectors with the wrong dimension", async () => {
    const store = new InMemoryVectorStore();
    await store.init(3);

    await expect(
      store.upsert([record("bad", [1, 0], "wrong dimension")]),
    ).rejects.toThrow("vector dim mismatch");
  });

  it("upserts by id and returns defensive copies", async () => {
    const store = new InMemoryVectorStore();
    await store.init(2);

    await store.upsert([record("m1", [1, 0], "first", { userId: "u1" })]);
    await store.upsert([record("m1", [0, 1], "replacement", { userId: "u1" })]);

    const loaded = await store.get("m1");
    expect(loaded?.content).toBe("replacement");
    loaded!.vector[0] = 99;
    loaded!.payload.userId = "mutated";

    const loadedAgain = await store.get("m1");
    expect(loadedAgain?.vector).toEqual([0, 1]);
    expect(loadedAgain?.payload.userId).toBe("u1");
  });

  it("searches by cosine similarity with scope, type, and metadata filters", async () => {
    const store = new InMemoryVectorStore();
    await store.init(2);
    await store.upsert([
      record("near", [1, 0], "near", {
        userId: "u1",
        memoryType: "fact",
        metadata: { tenant: "a" },
      }),
      record("far", [0, 1], "far", {
        userId: "u1",
        memoryType: "fact",
        metadata: { tenant: "a" },
      }),
      record("wrong-type", [1, 0], "wrong type", {
        userId: "u1",
        memoryType: "event",
        metadata: { tenant: "a" },
      }),
      record("wrong-tenant", [1, 0], "wrong tenant", {
        userId: "u2",
        memoryType: "fact",
        metadata: { tenant: "b" },
      }),
    ]);

    const hits = await store.search([1, 0], 10, {
      userId: "u1",
      memoryType: "fact",
      metadata: { tenant: "a" },
    });

    expect(hits.map((h) => h.id)).toEqual(["near", "far"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("runs keyword search over content with the same filters", async () => {
    const store = new InMemoryVectorStore();
    await store.init(2);
    await store.upsert([
      record("best", [1, 0], "Paris bakery bakery croissant", {
        userId: "u1",
        metadata: { tenant: "a" },
      }),
      record("weaker", [0, 1], "Paris bakery", {
        userId: "u1",
        metadata: { tenant: "a" },
      }),
      record("filtered", [1, 0], "Paris bakery bakery croissant", {
        userId: "u2",
        metadata: { tenant: "b" },
      }),
    ]);

    const hits = await store.textSearch!("bakery croissant", 10, {
      userId: "u1",
      metadata: { tenant: "a" },
    });

    expect(hits.map((h) => h.id)).toEqual(["best", "weaker"]);
    expect(await store.textSearch!("", 10)).toEqual([]);
  });

  it("deletes individual records and filtered sets", async () => {
    const store = new InMemoryVectorStore();
    await store.init(2);
    await store.upsert([
      record("a1", [1, 0], "a1", { userId: "u1" }),
      record("a2", [0.9, 0.1], "a2", { userId: "u1" }),
      record("b1", [0, 1], "b1", { userId: "u2" }),
    ]);

    await store.delete("a1");
    expect(await store.get("a1")).toBeNull();

    await store.deleteByFilter({ userId: "u1" });
    expect((await store.list({}, 10)).map((r) => r.id)).toEqual(["b1"]);
  });
});

describe("PgVectorStore diagnostics", () => {
  it("reports IVFFlat index creation failures without failing init", async () => {
    const warnings: MemoryWarning[] = [];
    const queries: string[] = [];
    const pool = {
      async query(sql: string): Promise<{ rows: unknown[] }> {
        queries.push(sql);
        if (sql.includes("USING ivfflat")) {
          throw new Error("ivfflat unavailable");
        }
        return { rows: [] };
      },
    };
    const store = new PgVectorStore({
      pool,
      tableName: "fishmem_test_vectors",
      onWarning: (warning) => warnings.push(warning),
    });

    await expect(store.init(128)).resolves.toBeUndefined();

    expect(queries.some((sql) => sql.includes("USING ivfflat"))).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "pgvector_ivfflat_index_failed",
      recoverable: true,
      context: { tableName: "fishmem_test_vectors", dimensions: 128 },
    });
    expect(warnings[0]?.error).toBeInstanceOf(Error);
  });
});

describe("VectorizeStore binding contract", () => {
  it("writes and queries structural namespace metadata", async () => {
    let upserted: any[] = [];
    let queryOptions: any;
    const binding: VectorizeBinding = {
      async upsert(vectors) {
        upserted = vectors;
      },
      async query(_vector, options) {
        queryOptions = options;
        return {
          matches: [
            {
              id: "alpha",
              score: 1,
              metadata: upserted[0]?.metadata,
            },
          ],
        };
      },
      async getByIds() {
        return [];
      },
      async deleteByIds() {},
    };
    const store = new VectorizeStore({ index: binding });
    await store.upsert([
      record("alpha", [1, 0], "alpha memory", {
        namespaceId: "alpha",
        userId: "same",
        metadata: { topic: "travel" },
      }),
    ]);

    expect(upserted[0]?.metadata).toMatchObject({
      namespaceId: "alpha",
      userId: "same",
      projectionContentHash: expect.any(String),
    });
    expect(upserted[0]?.metadata).not.toHaveProperty("content");
    expect(upserted[0]?.metadata).not.toHaveProperty("md_topic");
    const hits = await store.search([1, 0], 10, {
      namespaceId: "alpha",
      userId: "same",
      metadata: { topic: "travel" },
    });
    expect(hits.map((hit) => hit.id)).toEqual(["alpha"]);
    expect(queryOptions.filter).toEqual({
      namespaceId: "alpha",
      userId: "same",
    });
    expect(hits[0]?.content).toBeUndefined();
    await store.search([1, 0], 100);
    expect(queryOptions.topK).toBe(50);
  });

  it("reports unsupported enumeration instead of pretending it succeeded", async () => {
    const deletedBatches: string[][] = [];
    const fetchedBatches: string[][] = [];
    const binding: VectorizeBinding = {
      async upsert() {},
      async query() {
        return { matches: [] };
      },
      async getByIds(ids) {
        fetchedBatches.push(ids);
        return ids
          .filter((id) => id !== "vector-1001")
          .reverse()
          .map((id) => ({
            id,
            values: [1, 0],
            metadata: { namespaceId: "alpha" },
          }));
      },
      async deleteByIds(ids) {
        deletedBatches.push(ids);
      },
    };
    const store = new VectorizeStore({ index: binding });

    await expect(
      store.deleteByFilter({ namespaceId: "alpha" }),
    ).rejects.toThrow("does not support deleteByFilter");
    await expect(store.list({ namespaceId: "alpha" }, 10)).rejects.toThrow(
      "does not support listing vectors",
    );
    await store.deleteMany(
      Array.from({ length: 2_001 }, (_, index) => `vector-${index}`),
    );
    expect(deletedBatches.map((batch) => batch.length)).toEqual([
      1_000, 1_000, 1,
    ]);
    const requestedIds = Array.from(
      { length: 2_001 },
      (_, index) => `vector-${index}`,
    );
    const fetched = await store.getMany(requestedIds);
    expect(fetchedBatches.map((batch) => batch.length)).toEqual([
      1_000, 1_000, 1,
    ]);
    expect(fetched[0]?.id).toBe("vector-0");
    expect(fetched[1_001]).toBeNull();
    expect(fetched[2_000]?.id).toBe("vector-2000");
  });
});
