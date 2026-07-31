import { afterEach, describe, expect, it } from "vitest";
import { uuid } from "../src/core/util.js";
import type { GraphStore } from "../src/graph/base.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import { createSqliteGraphStore } from "../src/graph/sqlite.js";
import type { Association, Entity, Episode, Memory } from "../src/types.js";

function mem(content: string, overrides: Partial<Memory> = {}): Memory {
  const now = new Date();
  return {
    id: uuid(),
    content,
    memoryType: "fact",
    importance: 0.5,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    forgotten: false,
    ...overrides,
  };
}

function edge(
  sourceId: string,
  targetId: string,
  relationType: Association["relationType"] = "related_to",
  weight = 0.5,
): Association {
  return {
    id: uuid(),
    sourceId,
    targetId,
    relationType,
    weight,
    createdAt: new Date(),
  };
}

function entity(name: string, overrides: Partial<Entity> = {}): Entity {
  return {
    id: uuid(),
    name,
    normalized: name.toLowerCase(),
    mentionCount: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function episode(content: string, overrides: Partial<Episode> = {}): Episode {
  return {
    id: uuid(),
    messages: [{ role: "user", content }],
    createdAt: new Date(),
    ...overrides,
  };
}

/** A shared contract test, run against every GraphStore implementation. */
function contractTests(name: string, factory: () => Promise<GraphStore>) {
  describe(`GraphStore contract: ${name}`, () => {
    let store: GraphStore;

    async function fresh(): Promise<GraphStore> {
      store = await factory();
      await store.init();
      await store.reset();
      return store;
    }

    afterEach(async () => {
      if (store) await store.close();
    });

    it("freezes a pending operation's canonical write plan", async () => {
      const s = await fresh();
      const now = new Date();
      const claim = await s.claimOperation({
        id: "operation-1",
        namespaceId: "namespace-1",
        idempotencyKey: "request-1",
        kind: "add",
        requestHash: "hash-1",
        command: { messages: [{ role: "user", content: "hello" }] },
        memoryIds: [],
        status: "pending",
        rawStatus: "pending",
        vectorStatus: "pending",
        derivedStatus: "not_requested",
        attempts: 1,
        createdAt: now,
        updatedAt: now,
      });
      expect(claim.claimed).toBe(true);

      const planned = await s.planOperation(
        "operation-1",
        {
          ...claim.operation.command,
          addPlan: { version: 1, records: [{ content: "refined hello" }] },
        },
        ["memory-1"],
      );

      expect(planned.memoryIds).toEqual(["memory-1"]);
      expect((await s.getOperation("operation-1"))?.command).toMatchObject({
        addPlan: {
          version: 1,
          records: [{ content: "refined hello" }],
        },
      });
      await expect(s.summarizeOperations("namespace-1")).resolves.toMatchObject(
        {
          pending: 1,
          failed: 0,
          vectorPending: 1,
          derivedPending: 0,
          oldestPendingAt: now,
        },
      );
      await expect(s.summarizeOperations("namespace-2")).resolves.toEqual({
        pending: 0,
        failed: 0,
        vectorPending: 0,
        derivedPending: 0,
      });
    });

    it("atomically versions, points, and purges document sources", async () => {
      const s = await fresh();
      const firstCreatedAt = new Date("2026-07-30T00:00:00.000Z");
      const secondCreatedAt = new Date("2026-07-30T00:01:00.000Z");
      const first = {
        id: "document-1",
        namespaceId: "namespace-1",
        sourceKey: "docs/guide.md",
        contentHash: "hash-1",
        versionHash: "version-hash-1",
        content: "first version",
        mimeType: "text/markdown",
        sizeBytes: 13,
        createdAt: firstCreatedAt,
      };
      const firstChunk = {
        id: "chunk-1",
        namespaceId: "namespace-1",
        documentId: first.id,
        sourceKey: first.sourceKey,
        index: 0,
        content: first.content,
        startOffset: 0,
        endOffset: 13,
        contentHash: "chunk-hash-1",
        createdAt: firstCreatedAt,
      };
      const second = {
        ...first,
        id: "document-2",
        contentHash: "hash-2",
        versionHash: "version-hash-2",
        content: "second version",
        createdAt: secondCreatedAt,
      };
      const secondChunk = {
        ...firstChunk,
        id: "chunk-2",
        documentId: second.id,
        content: second.content,
        contentHash: "chunk-hash-2",
        createdAt: secondCreatedAt,
      };
      const head = {
        id: "head-1",
        namespaceId: "namespace-1",
        sourceKey: first.sourceKey,
        documentId: first.id,
        updatedAt: firstCreatedAt,
      };

      await s.commitDocumentVersion(first, [firstChunk], head);
      await s.commitDocumentVersion(second, [secondChunk], {
        ...head,
        documentId: second.id,
        updatedAt: secondCreatedAt,
      });
      await s.commitDocumentVersion(first, [firstChunk], head);

      await expect(
        s.getCurrentDocument("namespace-1", first.sourceKey),
      ).resolves.toMatchObject({ id: second.id });
      await expect(
        s.listDocumentVersions("namespace-1", first.sourceKey),
      ).resolves.toHaveLength(2);
      await expect(s.listDocumentChunks(second.id)).resolves.toEqual([
        secondChunk,
      ]);
      await expect(
        s.listCurrentDocuments({ namespaceId: "namespace-1" }),
      ).resolves.toEqual([second]);
      await expect(s.purgeDocument(first.id)).resolves.toEqual({
        documentIds: [first.id, second.id],
        chunkIds: [firstChunk.id, secondChunk.id],
      });
      await expect(
        s.getCurrentDocument("namespace-1", first.sourceKey),
      ).resolves.toBeNull();
    });

    it("saves, loads, updates, and deletes a memory", async () => {
      const s = await fresh();
      const m = mem("hello world", { userId: "u1" });
      await s.saveMemory(m);

      const loaded = await s.getMemory(m.id);
      expect(loaded?.content).toBe("hello world");
      expect(loaded?.userId).toBe("u1");

      loaded!.content = "updated";
      await s.updateMemory(loaded!);
      expect((await s.getMemory(m.id))?.content).toBe("updated");

      await s.deleteMemory(m.id);
      expect(await s.getMemory(m.id)).toBeNull();
    });

    it("records access and forgets", async () => {
      const s = await fresh();
      const m = mem("x");
      await s.saveMemory(m);
      await s.recordAccess(m.id);
      const after = await s.getMemory(m.id);
      expect(after?.accessCount).toBe(1);

      expect(await s.forget(m.id)).toBe(true);
      expect(await s.forget(m.id)).toBe(false); // already forgotten
      expect((await s.getMemory(m.id))?.forgotten).toBe(true);
      // Forgotten memories are excluded from listings.
      expect(await s.listMemories({})).toHaveLength(0);
    });

    it("lists by scope and sort", async () => {
      const s = await fresh();
      const old = mem("old", {
        userId: "u1",
        importance: 0.2,
        createdAt: new Date(Date.now() - 100_000),
      });
      const recent = mem("recent", { userId: "u1", importance: 0.9 });
      const other = mem("other-user", { userId: "u2" });
      await s.saveMemory(old);
      await s.saveMemory(recent);
      await s.saveMemory(other);

      const byRecent = await s.listMemories(
        { userId: "u1" },
        { sort: "recent" },
      );
      expect(byRecent.map((m) => m.content)).toEqual(["recent", "old"]);

      const byImportance = await s.listMemories(
        { userId: "u1" },
        { sort: "importance" },
      );
      expect(byImportance[0]!.content).toBe("recent");

      expect(await s.countMemories({ userId: "u1" })).toBe(2);
      expect(await s.countMemories({ userId: "u2" })).toBe(1);
    });

    it("filters and sorts memory activity", async () => {
      const s = await fresh();
      const earlier = mem("earlier recall", {
        namespaceId: "default",
        createdAt: new Date("2026-07-17T08:00:00.000Z"),
        lastAccessedAt: new Date("2026-07-18T09:00:00.000Z"),
        accessCount: 4,
      });
      const latest = mem("latest recall", {
        namespaceId: "default",
        createdAt: new Date("2026-07-18T08:00:00.000Z"),
        lastAccessedAt: new Date("2026-07-19T10:00:00.000Z"),
        accessCount: 1,
      });
      const neverAccessed = mem("new memory", {
        namespaceId: "default",
        createdAt: new Date("2026-07-19T11:00:00.000Z"),
        lastAccessedAt: new Date("2026-07-19T11:00:00.000Z"),
        accessCount: 0,
      });
      await s.saveMemory(earlier);
      await s.saveMemory(latest);
      await s.saveMemory(neverAccessed);

      const recalledToday = await s.listMemories(
        {
          namespaceId: "default",
          accessed: true,
          lastAccessedAtFrom: new Date("2026-07-19T00:00:00.000Z"),
        },
        { sort: "last_accessed" },
      );
      expect(recalledToday.map((memory) => memory.content)).toEqual([
        "latest recall",
      ]);
      expect(
        await s.countMemories({
          namespaceId: "default",
          createdAtFrom: new Date("2026-07-19T00:00:00.000Z"),
        }),
      ).toBe(1);
    });

    it("isolates memories, entities, episodes, and bulk deletion by namespace", async () => {
      const s = await fresh();
      const alphaMemory = mem("alpha", {
        namespaceId: "alpha",
        userId: "same",
      });
      const betaMemory = mem("beta", {
        namespaceId: "beta",
        userId: "same",
      });
      await s.saveMemory(alphaMemory);
      await s.saveMemory(betaMemory);
      await s.saveEntity(
        entity("Mel", { namespaceId: "alpha", userId: "same" }),
      );
      await s.saveEntity(
        entity("Mel", { namespaceId: "beta", userId: "same" }),
      );
      await s.saveEpisode(
        episode("alpha", { namespaceId: "alpha", userId: "same" }),
      );
      await s.saveEpisode(
        episode("beta", { namespaceId: "beta", userId: "same" }),
      );

      expect(
        (await s.listMemories({ namespaceId: "alpha", userId: "same" })).map(
          (memory) => memory.id,
        ),
      ).toEqual([alphaMemory.id]);
      expect(
        await s.listEntities({ namespaceId: "alpha", userId: "same" }),
      ).toHaveLength(1);
      expect(
        await s.listEpisodes({ namespaceId: "alpha", userId: "same" }),
      ).toHaveLength(1);

      expect(await s.deleteAll({ namespaceId: "alpha" })).toEqual([
        alphaMemory.id,
      ]);
      expect(await s.getMemory(betaMemory.id)).not.toBeNull();
    });

    it("exports complete namespace state including forgotten history", async () => {
      const s = await fresh();
      const active = mem("active", { namespaceId: "alpha" });
      const forgotten = mem("forgotten", {
        namespaceId: "alpha",
        forgotten: true,
      });
      const beta = mem("beta", { namespaceId: "beta" });
      const alphaEntity = entity("Mel", { namespaceId: "alpha" });
      const betaEntity = entity("Mel", { namespaceId: "beta" });
      const alphaEpisode = episode("alpha", { namespaceId: "alpha" });
      const betaEpisode = episode("beta", { namespaceId: "beta" });
      await s.saveMemory(active);
      await s.saveMemory(forgotten);
      await s.saveMemory(beta);
      await s.createAssociation(edge(active.id, forgotten.id));
      await s.createAssociation(edge(active.id, beta.id));
      await s.addHistory({
        memoryId: forgotten.id,
        event: "UPDATE",
        previousValue: "before",
        newValue: "forgotten",
      });
      await s.saveEntity(alphaEntity);
      await s.saveEntity(betaEntity);
      await s.linkMemoryEntities(active.id, [alphaEntity.id, betaEntity.id]);
      await s.saveEpisode(alphaEpisode);
      await s.saveEpisode(betaEpisode);

      const snapshot = await s.exportNamespace("alpha");
      expect(snapshot.memories.map((memory) => memory.id).sort()).toEqual(
        [active.id, forgotten.id].sort(),
      );
      expect(
        snapshot.memories.find((memory) => memory.id === forgotten.id),
      ).toMatchObject({ forgotten: true });
      expect(
        snapshot.associations.map((association) => association.targetId),
      ).toEqual([forgotten.id]);
      expect(snapshot.history).toHaveLength(1);
      expect(snapshot.entities.map((item) => item.id)).toEqual([
        alphaEntity.id,
      ]);
      expect(snapshot.memoryEntities).toEqual([
        { memoryId: active.id, entityId: alphaEntity.id },
      ]);
      expect(snapshot.episodes.map((item) => item.id)).toEqual([
        alphaEpisode.id,
      ]);
    });

    it("creates and traverses associations (neighbors)", async () => {
      const s = await fresh();
      const a = mem("a");
      const b = mem("b");
      const c = mem("c");
      await s.saveMemory(a);
      await s.saveMemory(b);
      await s.saveMemory(c);
      await s.createAssociation(edge(a.id, b.id, "related_to"));
      await s.createAssociation(edge(b.id, c.id, "related_to"));

      const depth1 = await s.getNeighbors(a.id, 1, []);
      expect(depth1.nodes.map((n) => n.id).sort()).toEqual([b.id].sort());

      const depth2 = await s.getNeighbors(a.id, 2, []);
      expect(depth2.nodes.map((n) => n.id).sort()).toEqual([b.id, c.id].sort());

      const between = await s.getAssociationsBetween([a.id, b.id, c.id]);
      expect(between).toHaveLength(2);
    });

    it("dedupes associations on (source,target,relation)", async () => {
      const s = await fresh();
      const a = mem("a");
      const b = mem("b");
      await s.saveMemory(a);
      await s.saveMemory(b);
      await s.createAssociation(edge(a.id, b.id, "related_to", 0.3));
      await s.createAssociation(edge(a.id, b.id, "related_to", 0.9));
      const assocs = await s.getAssociations(a.id);
      expect(assocs).toHaveLength(1);
      expect(assocs[0]!.weight).toBeCloseTo(0.9, 6);
    });

    it("merges memories atomically (rewire + updates edge + forget)", async () => {
      const s = await fresh();
      const survivor = mem("survivor", { importance: 0.9 });
      const loser = mem("loser", { importance: 0.4 });
      const neighbor = mem("neighbor");
      await s.saveMemory(survivor);
      await s.saveMemory(loser);
      await s.saveMemory(neighbor);
      // loser <-> neighbor edge should be rewired onto survivor.
      await s.createAssociation(edge(loser.id, neighbor.id, "related_to"));

      survivor.content = "survivor\n\nloser";
      await s.mergeMemoriesAtomic(survivor, loser);

      expect((await s.getMemory(loser.id))?.forgotten).toBe(true);
      expect((await s.getMemory(survivor.id))?.content).toBe(
        "survivor\n\nloser",
      );

      const survivorEdges = await s.getAssociations(survivor.id);
      // updates edge survivor->loser + rewired survivor->neighbor
      expect(survivorEdges.some((e) => e.relationType === "updates")).toBe(
        true,
      );
      expect(
        survivorEdges.some(
          (e) => e.relationType === "related_to" && e.targetId === neighbor.id,
        ),
      ).toBe(true);
    });

    it("records and reads history", async () => {
      const s = await fresh();
      const m = mem("v1");
      await s.saveMemory(m);
      await s.addHistory({
        memoryId: m.id,
        event: "ADD",
        previousValue: null,
        newValue: "v1",
      });
      await s.addHistory({
        memoryId: m.id,
        event: "UPDATE",
        previousValue: "v1",
        newValue: "v2",
      });
      const history = await s.getHistory(m.id);
      expect(history.map((h) => h.event)).toEqual(["ADD", "UPDATE"]);
    });

    it("deleteAll removes scoped memories", async () => {
      const s = await fresh();
      await s.saveMemory(mem("a", { userId: "u1" }));
      await s.saveMemory(mem("b", { userId: "u1" }));
      await s.saveMemory(mem("c", { userId: "u2" }));
      const removed = await s.deleteAll({ userId: "u1" });
      expect(removed).toHaveLength(2);
      expect(await s.countMemories({ userId: "u2" })).toBe(1);
    });

    it("filters by event date and belief slot", async () => {
      const s = await fresh();
      await s.saveMemory(
        mem("Mel lived in Paris", {
          userId: "u1",
          subject: "Mel",
          attribute: "residence",
          eventDate: new Date("2024-01-15T00:00:00.000Z"),
        }),
      );
      await s.saveMemory(
        mem("Mel likes pottery", {
          userId: "u1",
          subject: "Mel",
          attribute: "hobby",
          eventDate: new Date("2024-03-10T00:00:00.000Z"),
        }),
      );

      const inJanuary = await s.listMemories({
        userId: "u1",
        eventDateFrom: new Date("2024-01-01T00:00:00.000Z"),
        eventDateTo: new Date("2024-01-31T23:59:59.999Z"),
      });
      expect(inJanuary.map((m) => m.content)).toEqual(["Mel lived in Paris"]);

      const slot = await s.listMemories({
        userId: "u1",
        subject: "mel",
        attribute: "RESIDENCE",
      });
      expect(slot.map((m) => m.content)).toEqual(["Mel lived in Paris"]);
    });

    it("stores scoped entities and idempotent memory mentions", async () => {
      const s = await fresh();
      const memory = mem("Mel has a cat", { userId: "u1" });
      const mel = entity("Mel", {
        userId: "u1",
        embedding: [1, 0],
      });
      const otherTenantMel = entity("Mel", { userId: "u2" });
      await s.saveMemory(memory);
      await s.saveEntity(mel);
      await s.saveEntity(otherTenantMel);

      mel.mentionCount = 1;
      await s.updateEntity(mel);
      await s.linkMemoryEntities(memory.id, [mel.id, mel.id]);

      expect(await s.listEntities({ userId: "u1" })).toHaveLength(1);
      expect((await s.listEntities({ userId: "u2" }))[0]!.id).toBe(
        otherTenantMel.id,
      );

      const byMemory = await s.getEntityIdsForMemories([memory.id]);
      expect(byMemory.get(memory.id)).toEqual([mel.id]);

      const byEntity = await s.getMemoryIdsForEntities([mel.id]);
      expect(byEntity.get(mel.id)).toEqual([memory.id]);
    });

    it("rewires entity mentions during atomic merge", async () => {
      const s = await fresh();
      const survivor = mem("survivor");
      const merged = mem("merged");
      const mel = entity("Mel");
      await s.saveMemory(survivor);
      await s.saveMemory(merged);
      await s.saveEntity(mel);
      await s.linkMemoryEntities(merged.id, [mel.id]);

      await s.mergeMemoriesAtomic(survivor, merged);

      const byMemory = await s.getEntityIdsForMemories([
        survivor.id,
        merged.id,
      ]);
      expect(byMemory.get(survivor.id)).toEqual([mel.id]);
      expect(byMemory.has(merged.id)).toBe(false);
    });

    it("archives episodes by scope and returns defensive message copies", async () => {
      const s = await fresh();
      const ep1 = episode("first", {
        userId: "u1",
        source: "chat",
        createdAt: new Date("2024-01-02T00:00:00.000Z"),
      });
      const ep2 = episode("second", {
        userId: "u2",
        createdAt: new Date("2024-01-03T00:00:00.000Z"),
      });
      await s.saveEpisode(ep1);
      await s.saveEpisode(ep2);

      const scoped = await s.listEpisodes({ userId: "u1" });
      expect(scoped).toHaveLength(1);
      expect(scoped[0]!.source).toBe("chat");

      scoped[0]!.messages[0]!.content = "mutated";
      expect((await s.getEpisode(ep1.id))!.messages[0]!.content).toBe("first");
    });
  });
}

contractTests("InMemoryGraphStore", async () => new InMemoryGraphStore());

// Real Drizzle store over libSQL in-memory — validates schema + adapter.
contractTests("DrizzleGraphStore (libSQL)", async () =>
  createSqliteGraphStore({ url: ":memory:" }),
);
