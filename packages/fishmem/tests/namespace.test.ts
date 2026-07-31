import { describe, expect, it } from "vitest";
import { InMemoryStateSidecar } from "../src/core/sidecar.js";
import { contentHash } from "../src/core/util.js";
import { MockEmbedder } from "../src/embeddings/mock.js";
import type { ListOptions } from "../src/graph/base.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import { createSqliteGraphStore } from "../src/graph/sqlite.js";
import { MockLLM } from "../src/llms/mock.js";
import {
  DELETE_ALL_MAX_TARGETS,
  DeleteAllLimitError,
  Memory,
} from "../src/memory.js";
import type { MemoryFilters, Memory as MemoryRecord } from "../src/types.js";
import type { VectorRecord } from "../src/vector/base.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";
import { SqliteVectorStore } from "../src/vector/sqlite.js";

async function createMemory() {
  return Memory.create({
    embedder: new MockEmbedder(64),
    graphStore: new InMemoryGraphStore(),
    llm: new MockLLM(),
    vectorStore: new InMemoryVectorStore(),
  });
}

describe("Memory.forNamespace", () => {
  it("isolates reads and writes even when user scope is identical", async () => {
    const memory = await createMemory();
    const alpha = memory.forNamespace("alpha");
    const beta = memory.forNamespace("beta");

    const alphaAdd = await alpha.add("Ada prefers tea", {
      infer: false,
      userId: "ada",
    });
    const betaAdd = await beta.add("Ada prefers coffee", {
      infer: false,
      userId: "ada",
      namespaceId: "alpha",
    });
    const alphaId = alphaAdd.results[0]!.id;
    const betaId = betaAdd.results[0]!.id;

    expect((await alpha.getAll({ userId: "ada" })).results).toHaveLength(1);
    expect((await beta.getAll({ userId: "ada" })).results).toHaveLength(1);
    expect(await alpha.get(betaId)).toBeNull();
    expect(await beta.get(alphaId)).toBeNull();
    const alphaSearch = await alpha.search("coffee", { userId: "ada" });
    expect(alphaSearch.results.map((result) => result.memory.id)).not.toContain(
      betaId,
    );
    expect((await beta.get(betaId))?.namespaceId).toBe("beta");
  });

  it("rejects cross-namespace mutation and graph operations", async () => {
    const memory = await createMemory();
    const alpha = memory.forNamespace("alpha");
    const beta = memory.forNamespace("beta");
    const alphaId = (await alpha.add("alpha", { infer: false })).results[0]!.id;
    const betaId = (await beta.add("beta", { infer: false })).results[0]!.id;

    await expect(alpha.update(betaId, "changed")).rejects.toThrow(
      "memory not found",
    );
    await alpha.delete(betaId);
    expect(await beta.get(betaId)).not.toBeNull();
    expect(await alpha.link(alphaId, betaId)).toBeNull();
  });

  it("exports a versioned namespace snapshot including forgotten records", async () => {
    const memory = await createMemory();
    const alpha = memory.forNamespace("alpha");
    const beta = memory.forNamespace("beta");
    const alphaId = (await alpha.add("alpha", { infer: false, userId: "same" }))
      .results[0]!.id;
    await beta.add("beta", { infer: false, userId: "same" });
    await alpha.forget(alphaId);

    const snapshot = await alpha.exportSnapshot();
    expect(snapshot).toMatchObject({
      format: "fishmem.namespace-snapshot",
      version: 1,
      sourceNamespaceId: "alpha",
      projections: {
        sidecar: "rebuild-required",
        vectors: "rebuild-required",
      },
    });
    expect(snapshot.data.memories).toHaveLength(1);
    expect(snapshot.data.memories[0]).toMatchObject({
      id: alphaId,
      namespaceId: "alpha",
      forgotten: true,
    });
    expect(snapshot.data.memories[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snapshot.data.history.map((entry) => entry.event)).toEqual(["ADD"]);
    await expect(memory.exportSnapshot({})).rejects.toThrow(
      "requires a structural namespace",
    );
  });

  it("replays a committed idempotent add without duplicating data", async () => {
    const memory = await createMemory();
    const alpha = memory.forNamespace("alpha");
    const first = await alpha.add("alpha fact", {
      idempotencyKey: "add-1",
      infer: false,
      userId: "same",
    });
    const replay = await alpha.add("alpha fact", {
      userId: "same",
      infer: false,
      idempotencyKey: "add-1",
    });

    expect(replay).toEqual(first);
    expect((await alpha.getAll({ userId: "same" })).results).toHaveLength(1);
    const snapshot = await alpha.exportSnapshot();
    expect(snapshot.data.operations).toHaveLength(1);
    expect(snapshot.data.operations[0]).toMatchObject({
      idempotencyKey: "add-1",
      status: "committed",
      rawStatus: "ready",
      vectorStatus: "ready",
      derivedStatus: "not_requested",
    });
    expect(snapshot.data.events).toHaveLength(1);
    expect(snapshot.data.events[0]).toMatchObject({
      eventType: "ADD",
      memoryId: first.results[0]?.id,
    });
  });

  it("rejects idempotency conflicts while allowing the key in another namespace", async () => {
    const memory = await createMemory();
    const alpha = memory.forNamespace("alpha");
    const beta = memory.forNamespace("beta");
    await alpha.add("alpha fact", {
      idempotencyKey: "shared-key",
      infer: false,
    });

    await expect(
      alpha.add("different command", {
        idempotencyKey: "shared-key",
        infer: false,
      }),
    ).rejects.toThrow("idempotency key conflict");
    await expect(
      beta.add("beta fact", {
        idempotencyKey: "shared-key",
        infer: false,
      }),
    ).resolves.toMatchObject({ results: [{ event: "ADD" }] });
  });

  it("freezes and replays the exact delete-all target set", async () => {
    const memory = await createMemory();
    const alpha = memory.forNamespace("alpha");
    const first = await alpha.add("first disposable memory", {
      idempotencyKey: "delete-all-source-1",
      infer: false,
      userId: "ada",
    });
    const second = await alpha.add("second disposable memory", {
      idempotencyKey: "delete-all-source-2",
      infer: false,
      userId: "ada",
    });
    await alpha.add("different user remains", {
      idempotencyKey: "delete-all-source-3",
      infer: false,
      userId: "grace",
    });

    const deleted = await alpha.deleteAll(
      { userId: "ada" },
      { idempotencyKey: "delete-all-ada" },
    );
    expect(deleted).toEqual({ deleted: 2 });

    const later = await alpha.add("created after the bulk delete", {
      idempotencyKey: "delete-all-source-4",
      infer: false,
      userId: "ada",
    });
    await expect(
      alpha.deleteAll({ userId: "ada" }, { idempotencyKey: "delete-all-ada" }),
    ).resolves.toEqual(deleted);
    expect(await alpha.get(later.results[0]!.id)).not.toBeNull();
    expect((await alpha.getAll({ userId: "grace" })).results).toHaveLength(1);

    await expect(
      alpha.deleteAll(
        { userId: "grace" },
        { idempotencyKey: "delete-all-ada" },
      ),
    ).rejects.toThrow("idempotency key conflict");

    const operation = (await alpha.listOperations()).find(
      (candidate) => candidate.idempotencyKey === "delete-all-ada",
    );
    expect(operation).toMatchObject({
      kind: "delete_all",
      status: "committed",
      rawStatus: "ready",
      vectorStatus: "ready",
      result: { deleted: 2 },
      command: {
        filters: { namespaceId: "alpha", userId: "ada" },
        planned: true,
      },
    });
    expect(new Set(operation?.memoryIds)).toEqual(
      new Set([first.results[0]!.id, second.results[0]!.id]),
    );
  });

  it("rejects an oversized delete-all before deleting any canonical row", async () => {
    class OversizedGraphStore extends InMemoryGraphStore {
      deleteCalls = 0;

      override async listMemories(
        filters: MemoryFilters,
        options: ListOptions = {},
      ): Promise<MemoryRecord[]> {
        if (options.limit === DELETE_ALL_MAX_TARGETS + 1) {
          return Array.from(
            { length: DELETE_ALL_MAX_TARGETS + 1 },
            (_, index) => ({ id: `oversized-${index}` }) as MemoryRecord,
          );
        }
        return super.listMemories(filters, options);
      }

      override async deleteMemories(ids: string[]): Promise<void> {
        this.deleteCalls += 1;
        await super.deleteMemories(ids);
      }
    }

    const graphStore = new OversizedGraphStore();
    const memory = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore,
      llm: new MockLLM(),
      vectorStore: new InMemoryVectorStore(),
    });
    const alpha = memory.forNamespace("alpha");

    await expect(
      alpha.deleteAll(
        { userId: "ada" },
        { idempotencyKey: "oversized-delete" },
      ),
    ).rejects.toBeInstanceOf(DeleteAllLimitError);
    expect(graphStore.deleteCalls).toBe(0);
    expect(
      (await alpha.listOperations()).find(
        (operation) => operation.idempotencyKey === "oversized-delete",
      ),
    ).toMatchObject({
      kind: "delete_all",
      status: "failed",
      rawStatus: "pending",
      vectorStatus: "pending",
    });
  });

  it("repairs an interrupted add without duplicating raw data", async () => {
    class FailingVectorStore extends InMemoryVectorStore {
      private failed = false;

      override async upsert(
        records: Parameters<InMemoryVectorStore["upsert"]>[0],
      ): Promise<void> {
        if (!this.failed) {
          this.failed = true;
          throw new Error("vector unavailable");
        }
        await super.upsert(records);
      }
    }
    const graphStore = new InMemoryGraphStore();
    const memory = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore,
      llm: new MockLLM(),
      vectorStore: new FailingVectorStore(),
    });
    const alpha = memory.forNamespace("alpha");

    await expect(
      alpha.add("partially written", {
        idempotencyKey: "failed-add",
        infer: false,
      }),
    ).rejects.toThrow("vector unavailable");
    expect(
      (await graphStore.exportNamespace("alpha")).operations,
    ).toMatchObject([
      {
        status: "failed",
        rawStatus: "ready",
        vectorStatus: "pending",
      },
    ]);
    const repaired = await alpha.add("partially written", {
      idempotencyKey: "failed-add",
      infer: false,
    });

    const snapshot = await alpha.exportSnapshot();
    expect(snapshot.data.memories).toHaveLength(1);
    expect(repaired.results[0]?.id).toBe(snapshot.data.memories[0]?.id);
    expect(snapshot.data.operations).toMatchObject([
      {
        idempotencyKey: "failed-add",
        status: "committed",
        memoryIds: [repaired.results[0]?.id],
      },
    ]);
    expect(snapshot.data.events).toHaveLength(1);
  });

  it("repairs an inferred add from its frozen plan without calling the LLM again", async () => {
    class FailingVectorStore extends InMemoryVectorStore {
      private failed = false;

      override async upsert(
        records: Parameters<InMemoryVectorStore["upsert"]>[0],
      ): Promise<void> {
        if (!this.failed) {
          this.failed = true;
          throw new Error("vector unavailable");
        }
        await super.upsert(records);
      }
    }
    let extractionCalls = 0;
    const graphStore = new InMemoryGraphStore();
    const memory = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore,
      llm: new MockLLM(() => {
        extractionCalls++;
        return JSON.stringify({
          facts: [
            {
              text: "Ada prefers tea",
              subject: "Ada",
              attribute: "beverage",
              type: "preference",
            },
          ],
        });
      }),
      vectorStore: new FailingVectorStore(),
    });
    const alpha = memory.forNamespace("alpha");

    await expect(
      alpha.add("I prefer tea", {
        idempotencyKey: "inferred-repair",
      }),
    ).rejects.toThrow("vector unavailable");
    expect(extractionCalls).toBe(1);

    const repaired = await alpha.add("I prefer tea", {
      idempotencyKey: "inferred-repair",
    });
    const snapshot = await alpha.exportSnapshot();

    expect(extractionCalls).toBe(1);
    expect(repaired.results).toEqual([
      {
        id: snapshot.data.memories[0]?.id,
        memory: "Ada prefers tea",
        event: "ADD",
      },
    ]);
    expect(snapshot.data.memories).toHaveLength(1);
    expect(snapshot.data.operations[0]).toMatchObject({
      status: "committed",
      memoryIds: [repaired.results[0]?.id],
      command: {
        addPlan: {
          version: 1,
          records: [{ content: "Ada prefers tea" }],
        },
      },
    });
  });

  it("reclaims an expired operation lease but still rejects a changed command", async () => {
    const graphStore = new InMemoryGraphStore();
    await graphStore.init();
    const expiredAt = new Date(Date.now() - 60_000);
    await graphStore.claimOperation({
      id: "stale-operation",
      namespaceId: "alpha",
      idempotencyKey: "stale-key",
      kind: "add",
      requestHash: "different-command-hash",
      command: { messages: [{ role: "user", content: "original" }] },
      memoryIds: ["planned-memory"],
      status: "pending",
      rawStatus: "pending",
      vectorStatus: "pending",
      derivedStatus: "not_requested",
      leaseExpiresAt: expiredAt,
      attempts: 1,
      createdAt: expiredAt,
      updatedAt: expiredAt,
    });
    const memory = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore,
      llm: new MockLLM(),
      vectorStore: new InMemoryVectorStore(),
    });

    await expect(
      memory.forNamespace("alpha").add("changed command", {
        idempotencyKey: "stale-key",
        infer: false,
      }),
    ).rejects.toThrow("idempotency key conflict");
    const [operation] = (await graphStore.exportNamespace("alpha")).operations;
    expect(operation).toMatchObject({
      id: "stale-operation",
      status: "pending",
      attempts: 2,
    });
  });

  it("journals and replays update, invalidate, delete, and purge", async () => {
    const memory = await createMemory();
    const alpha = memory.forNamespace("alpha");
    const id = (
      await alpha.add("draft", {
        idempotencyKey: "mutation-source",
        infer: false,
      })
    ).results[0]!.id;

    const updated = await alpha.update(id, "final", {
      idempotencyKey: "update-1",
    });
    await expect(
      alpha.update(id, "final", { idempotencyKey: "update-1" }),
    ).resolves.toEqual(updated);
    await expect(
      alpha.invalidate(id, {
        idempotencyKey: "invalidate-1",
        validTo: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).resolves.toBe(true);
    await expect(
      alpha.invalidate(id, {
        idempotencyKey: "invalidate-1",
        validTo: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).resolves.toBe(true);
    await alpha.delete(id, { idempotencyKey: "delete-1" });
    await alpha.delete(id, { idempotencyKey: "delete-1" });
    await expect(alpha.purge(id, { idempotencyKey: "purge-1" })).resolves.toBe(
      true,
    );
    await expect(alpha.purge(id, { idempotencyKey: "purge-1" })).resolves.toBe(
      true,
    );

    const snapshot = await alpha.exportSnapshot();
    expect(snapshot.data.memories).toEqual([]);
    expect(snapshot.data.operations).toHaveLength(5);
    expect(snapshot.data.events.map((event) => event.eventType).sort()).toEqual(
      ["ADD", "DELETE", "INVALIDATE", "PURGE", "UPDATE"],
    );
    expect(
      snapshot.data.events.filter((event) => event.memoryId === id),
    ).toHaveLength(5);
  });

  it("repairs an update after its raw write succeeds and vector write fails", async () => {
    class FailingUpdateVectorStore extends InMemoryVectorStore {
      failNext = false;

      override async upsert(
        records: Parameters<InMemoryVectorStore["upsert"]>[0],
      ): Promise<void> {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("vector update unavailable");
        }
        await super.upsert(records);
      }
    }
    const graphStore = new InMemoryGraphStore();
    const vectorStore = new FailingUpdateVectorStore();
    const memory = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore,
      llm: new MockLLM(),
      vectorStore,
    });
    const alpha = memory.forNamespace("alpha");
    const id = (await alpha.add("before", { infer: false })).results[0]!.id;
    vectorStore.failNext = true;

    await expect(
      alpha.update(id, "after", { idempotencyKey: "repair-update" }),
    ).rejects.toThrow("vector update unavailable");
    expect(
      (await graphStore.exportNamespace("alpha")).operations,
    ).toMatchObject([
      {
        idempotencyKey: "repair-update",
        status: "failed",
        rawStatus: "ready",
        vectorStatus: "pending",
      },
    ]);
    await expect(
      alpha.update(id, "after", { idempotencyKey: "repair-update" }),
    ).resolves.toMatchObject({ memory: "after", event: "UPDATE" });
    expect((await alpha.history(id)).map((entry) => entry.event)).toEqual([
      "ADD",
      "UPDATE",
    ]);
    expect((await alpha.exportSnapshot()).data.events).toHaveLength(1);
  });

  it("rebuilds and verifies namespace vector projections from raw records", async () => {
    const vectorStore = new InMemoryVectorStore();
    const memory = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore: new InMemoryGraphStore(),
      llm: new MockLLM(),
      vectorStore,
    });
    const alpha = memory.forNamespace("alpha");
    const beta = memory.forNamespace("beta");
    const alphaId = (await alpha.add("alpha source", { infer: false }))
      .results[0]!.id;
    const betaId = (await beta.add("beta source", { infer: false })).results[0]!
      .id;
    await vectorStore.delete(alphaId);
    await vectorStore.upsert([
      {
        id: "stale-alpha",
        vector: new Array(64).fill(0),
        content: "stale",
        payload: { namespaceId: "alpha" },
      },
    ]);

    await expect(alpha.rebuildProjections()).resolves.toEqual({
      vectors: 1,
      sidecar: "not_configured",
    });
    expect(
      (await vectorStore.list({ namespaceId: "alpha" }, 10)).map((v) => v.id),
    ).toEqual([alphaId]);
    expect(await vectorStore.get(betaId)).not.toBeNull();
  });

  it("rebuilds and verifies projections on a non-enumerable vector backend", async () => {
    class NonEnumerableVectorStore extends InMemoryVectorStore {
      readonly capabilities = {
        filterDelete: false,
        enumeration: false,
      } as const;

      override async deleteByFilter(): Promise<void> {
        throw new Error("deleteByFilter must not be called");
      }

      override async list(): Promise<never> {
        throw new Error("list must not be called");
      }

      override async upsert(records: VectorRecord[]): Promise<void> {
        return super.upsert(
          records.map((record) => ({
            ...record,
            content: "",
            payload: {
              ...record.payload,
              projectionContentHash: contentHash(record.content),
            },
          })),
        );
      }
    }

    const vectorStore = new NonEnumerableVectorStore();
    const memory = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore: new InMemoryGraphStore(),
      llm: new MockLLM(),
      vectorStore,
    });
    const alpha = memory.forNamespace("alpha");
    const id = (await alpha.add("canonical source", { infer: false }))
      .results[0]!.id;
    await vectorStore.delete(id);

    await expect(alpha.rebuildProjections()).resolves.toEqual({
      vectors: 1,
      sidecar: "not_configured",
    });
    expect(await vectorStore.get(id)).toMatchObject({
      id,
      content: "",
      payload: {
        namespaceId: "alpha",
        projectionContentHash: contentHash("canonical source"),
      },
    });
  });

  it("keeps failed derivation pending until a successful rebuild", async () => {
    let failProjection = true;
    class FailingSidecar extends InMemoryStateSidecar {
      override async upsert(
        input: Parameters<InMemoryStateSidecar["upsert"]>[0],
      ) {
        if (failProjection) throw new Error("projection unavailable");
        return super.upsert(input);
      }
    }
    const graphStore = new InMemoryGraphStore();
    const memory = await Memory.create({
      derivation: { enabled: true, sidecar: new FailingSidecar() },
      embedder: new MockEmbedder(64),
      graphStore,
      llm: new MockLLM(() => {
        return JSON.stringify({
          facts: [
            {
              text: "Canonical fact remains authoritative",
              subject: "Canonical fact",
              attribute: "status",
              type: "fact",
            },
          ],
        });
      }),
      vectorStore: new InMemoryVectorStore(),
    });
    const alpha = memory.forNamespace("alpha");
    await alpha.add("raw remains authoritative", {
      idempotencyKey: "derive-repair",
    });
    expect((await graphStore.listOperations("alpha"))[0]).toMatchObject({
      status: "committed",
      rawStatus: "ready",
      vectorStatus: "ready",
      derivedStatus: "pending",
    });

    failProjection = false;
    await alpha.rebuildProjections();
    expect((await graphStore.listOperations("alpha"))[0]).toMatchObject({
      derivedStatus: "ready",
    });
  });

  it("round-trips a namespace snapshot through staged import", async () => {
    const source = await createMemory();
    const sourceAlpha = source.forNamespace("alpha");
    const first = await sourceAlpha.add("first", {
      idempotencyKey: "source-first",
      infer: false,
    });
    const second = await sourceAlpha.add("second", {
      idempotencyKey: "source-second",
      infer: false,
    });
    await sourceAlpha.link(first.results[0]!.id, second.results[0]!.id);
    const snapshot = await sourceAlpha.exportSnapshot();

    const target = await createMemory();
    const targetAlpha = target.forNamespace("alpha");
    await expect(
      targetAlpha.importSnapshot(snapshot, { idempotencyKey: "restore-1" }),
    ).resolves.toEqual({ imported: 2, documents: 0, vectors: 2 });
    await expect(
      targetAlpha.importSnapshot(snapshot, { idempotencyKey: "restore-1" }),
    ).resolves.toEqual({ imported: 2, documents: 0, vectors: 2 });
    const restored = await targetAlpha.exportSnapshot();
    expect(restored.data.memories).toEqual(snapshot.data.memories);
    expect(restored.data.associations).toEqual(snapshot.data.associations);
    expect(restored.data.history).toEqual(snapshot.data.history);
    expect(restored.data.events).toEqual(snapshot.data.events);
    expect(
      restored.data.operations.filter(
        (operation) => operation.kind !== "import",
      ),
    ).toEqual(snapshot.data.operations);
    expect((await targetAlpha.search("first")).results[0]?.memory.id).toBe(
      first.results[0]!.id,
    );
  });

  it("restores a portable snapshot into a different empty namespace", async () => {
    const source = await createMemory();
    const sourceAlpha = source.forNamespace("alpha");
    const added = await sourceAlpha.add("portable memory", {
      idempotencyKey: "portable-source",
      infer: false,
    });
    const snapshot = await sourceAlpha.exportSnapshot();

    const target = await createMemory();
    await expect(
      target
        .forNamespace("restored-project")
        .importSnapshot(snapshot, { idempotencyKey: "portable-restore" }),
    ).resolves.toEqual({ imported: 1, documents: 0, vectors: 1 });

    const restored = await target
      .forNamespace("restored-project")
      .exportSnapshot();
    expect(restored.sourceNamespaceId).toBe("restored-project");
    expect(restored.data.memories).toMatchObject([
      {
        id: added.results[0]!.id,
        namespaceId: "restored-project",
      },
    ]);
    expect(
      restored.data.operations
        .filter((operation) => operation.kind !== "import")
        .every((operation) => operation.namespaceId === "restored-project"),
    ).toBe(true);
    expect(
      restored.data.events.every(
        (event) => event.namespaceId === "restored-project",
      ),
    ).toBe(true);
  });

  it("permanently purges one namespace and releases its ids for restore", async () => {
    const memory = await createMemory();
    const alpha = memory.forNamespace("alpha");
    const beta = memory.forNamespace("beta");
    await alpha.add("alpha backup", {
      idempotencyKey: "alpha-source",
      infer: false,
    });
    await beta.add("beta stays", {
      idempotencyKey: "beta-source",
      infer: false,
    });
    const snapshot = await alpha.exportSnapshot();

    await expect(alpha.purgeAll()).resolves.toEqual({
      purged: 1,
      documents: 0,
    });
    expect((await alpha.exportSnapshot()).data).toMatchObject({
      memories: [],
      associations: [],
      history: [],
      entities: [],
      episodes: [],
      operations: [],
      events: [],
    });
    expect((await beta.getAll()).results.map((row) => row.content)).toEqual([
      "beta stays",
    ]);

    await expect(
      beta.importSnapshot(snapshot, { idempotencyKey: "restore-after-purge" }),
    ).rejects.toThrow("target namespace must be empty");
    const restored = memory.forNamespace("restored");
    await expect(
      restored.importSnapshot(snapshot, {
        idempotencyKey: "restore-after-purge",
      }),
    ).resolves.toEqual({ imported: 1, documents: 0, vectors: 1 });
    expect((await restored.getAll()).results.map((row) => row.content)).toEqual(
      ["alpha backup"],
    );
  });

  it("rejects snapshots with foreign namespace rows or dangling references", async () => {
    const source = await createMemory();
    await source.forNamespace("alpha").add("validated memory", {
      idempotencyKey: "validated-source",
      infer: false,
    });
    const snapshot = await source.forNamespace("alpha").exportSnapshot();
    const target = await createMemory();

    const foreign = structuredClone(snapshot);
    foreign.data.memories[0]!.namespaceId = "other";
    await expect(
      target
        .forNamespace("restored")
        .importSnapshot(foreign, { idempotencyKey: "foreign-row" }),
    ).rejects.toThrow("namespaceId must match sourceNamespaceId");

    const dangling = structuredClone(snapshot);
    dangling.data.history[0]!.memoryId = "missing-memory";
    await expect(
      target
        .forNamespace("restored")
        .importSnapshot(dangling, { idempotencyKey: "dangling-row" }),
    ).rejects.toThrow("must reference an imported memory");
  });

  it("repairs a failed import projection without importing raw rows twice", async () => {
    class FailOnceVectorStore extends InMemoryVectorStore {
      failNextUpsert = false;

      override async upsert(
        records: Parameters<InMemoryVectorStore["upsert"]>[0],
      ): Promise<void> {
        if (this.failNextUpsert) {
          this.failNextUpsert = false;
          throw new Error("injected projection failure");
        }
        await super.upsert(records);
      }
    }

    const source = await createMemory();
    await source.forNamespace("alpha").add("repairable import", {
      idempotencyKey: "source-import-repair",
      infer: false,
    });
    const snapshot = await source.forNamespace("alpha").exportSnapshot();
    const graphStore = new InMemoryGraphStore();
    const vectorStore = new FailOnceVectorStore();
    const target = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore,
      llm: new MockLLM(),
      vectorStore,
    });
    const alpha = target.forNamespace("alpha");
    vectorStore.failNextUpsert = true;

    await expect(
      alpha.importSnapshot(snapshot, { idempotencyKey: "import-repair" }),
    ).rejects.toThrow("injected projection failure");
    expect((await alpha.getAll()).results).toHaveLength(1);
    expect(
      (await graphStore.listOperations("alpha")).find(
        (operation) => operation.kind === "import",
      ),
    ).toMatchObject({
      kind: "import",
      status: "failed",
      rawStatus: "ready",
      vectorStatus: "pending",
    });

    await expect(
      alpha.importSnapshot(snapshot, { idempotencyKey: "import-repair" }),
    ).resolves.toEqual({ imported: 1, documents: 0, vectors: 1 });
    expect((await alpha.getAll()).results).toHaveLength(1);
    expect((await alpha.exportSnapshot()).data.memories).toHaveLength(1);
  });

  it("rejects import into a non-empty namespace without changing it", async () => {
    const source = await createMemory();
    const snapshot = await source.forNamespace("alpha").exportSnapshot();
    const target = await createMemory();
    const alpha = target.forNamespace("alpha");
    const existing = await alpha.add("existing", { infer: false });

    await expect(
      alpha.importSnapshot(snapshot, { idempotencyKey: "unsafe-replace" }),
    ).rejects.toThrow("target namespace must be empty");
    expect((await alpha.getAll()).results.map((memory) => memory.id)).toEqual([
      existing.results[0]!.id,
    ]);
  });
});

describe("namespace-aware sidecar", () => {
  it("keeps derived state isolated for identical subjects and user scope", async () => {
    const memory = await Memory.create({
      derivation: { enabled: true },
      embedder: new MockEmbedder(64),
      graphStore: new InMemoryGraphStore(),
      llm: new MockLLM((messages) => {
        const text = messages.map((message) => message.content).join("\n");
        return text.includes("FISHMEM_TASK: extract")
          ? JSON.stringify({
              facts: [
                {
                  attribute: "residence",
                  subject: "Mel",
                  text: "Mel lives in Taipei",
                  type: "fact",
                },
              ],
            })
          : "";
      }),
      vectorStore: new InMemoryVectorStore(),
    });
    const alpha = memory.forNamespace("alpha");
    const beta = memory.forNamespace("beta");
    await alpha.add("Mel lives in Taipei", { userId: "mel" });

    expect(
      (await alpha.getState("Mel", "residence", { userId: "mel" }))?.value,
    ).toBe("Mel lives in Taipei");
    expect(
      await beta.getState("Mel", "residence", { userId: "mel" }),
    ).toBeUndefined();
  });
});

describe("persistent namespace adapters", () => {
  it("isolates SQLite graph and vector records", async () => {
    const memory = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore: await createSqliteGraphStore({ url: ":memory:" }),
      llm: new MockLLM(),
      vectorStore: new SqliteVectorStore({ url: ":memory:" }),
    });
    const alpha = memory.forNamespace("alpha");
    const beta = memory.forNamespace("beta");
    const alphaAdd = await alpha.add("shared phrase alpha", {
      idempotencyKey: "sqlite-add",
      infer: false,
      userId: "same",
    });
    expect(
      await alpha.add("shared phrase alpha", {
        idempotencyKey: "sqlite-add",
        infer: false,
        userId: "same",
      }),
    ).toEqual(alphaAdd);
    await beta.add("shared phrase beta", { infer: false, userId: "same" });

    expect((await alpha.getAll({ userId: "same" })).results).toHaveLength(1);
    expect((await beta.getAll({ userId: "same" })).results).toHaveLength(1);
    expect(
      (await alpha.search("shared phrase", { userId: "same" })).results.every(
        (result) => result.memory.namespaceId === "alpha",
      ),
    ).toBe(true);
    expect((await alpha.exportSnapshot()).data.operations).toHaveLength(1);
    await memory.close();
  });

  it("commits a staged snapshot atomically in SQLite", async () => {
    const source = await createMemory();
    await source.forNamespace("alpha").add("sqlite restore", {
      idempotencyKey: "sqlite-source",
      infer: false,
    });
    const snapshot = await source.forNamespace("alpha").exportSnapshot();
    const target = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore: await createSqliteGraphStore({ url: ":memory:" }),
      llm: new MockLLM(),
      vectorStore: new SqliteVectorStore({ url: ":memory:" }),
    });

    await expect(
      target
        .forNamespace("alpha")
        .importSnapshot(snapshot, { idempotencyKey: "sqlite-import" }),
    ).resolves.toEqual({ imported: 1, documents: 0, vectors: 1 });
    expect(
      (await target.forNamespace("alpha").getAll()).results.map(
        (memory) => memory.content,
      ),
    ).toEqual(["sqlite restore"]);
  });

  it("atomically purges a SQLite namespace without touching its neighbor", async () => {
    const memory = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore: await createSqliteGraphStore({ url: ":memory:" }),
      llm: new MockLLM(),
      vectorStore: new SqliteVectorStore({ url: ":memory:" }),
    });
    await memory.forNamespace("alpha").add("remove all alpha state", {
      idempotencyKey: "sqlite-purge-alpha",
      infer: false,
    });
    await memory.forNamespace("beta").add("keep beta state", {
      idempotencyKey: "sqlite-purge-beta",
      infer: false,
    });

    await expect(memory.forNamespace("alpha").purgeAll()).resolves.toEqual({
      purged: 1,
      documents: 0,
    });
    expect(
      (await memory.forNamespace("alpha").exportSnapshot()).data,
    ).toMatchObject({
      memories: [],
      operations: [],
      events: [],
    });
    expect(
      (await memory.forNamespace("beta").getAll()).results.map(
        (row) => row.content,
      ),
    ).toEqual(["keep beta state"]);
    await memory.close();
  });
});
