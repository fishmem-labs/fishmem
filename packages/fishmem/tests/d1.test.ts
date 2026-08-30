import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GraphSnapshotData, MemoryOperation } from "../src/index.js";
import { chunkDocumentText, createD1GraphStore } from "../src/index.js";
import type {
  Association,
  DocumentChunk,
  DocumentHead,
  DocumentSource,
  Entity,
  Memory,
} from "../src/types.js";

describe("D1 document persistence", () => {
  it("stages wide snapshot rows below D1's bound-parameter limit", async () => {
    const { Miniflare } = await import("miniflare");
    const miniflare = new Miniflare({
      d1Databases: { DB: randomUUID() },
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
    });
    const database = await miniflare.getD1Database("DB");
    const store = await createD1GraphStore({
      binding: database,
      autoMigrate: true,
    });

    try {
      await store.init();
      const createdAt = new Date("2026-08-30T00:00:00.000Z");
      const operations: MemoryOperation[] = Array.from(
        { length: 11 },
        (_, index) => ({
          id: randomUUID(),
          namespaceId: "snapshot-source",
          idempotencyKey: `snapshot-operation-${index}`,
          kind: "add",
          requestHash: `snapshot-hash-${index}`,
          command: { content: `durable preference ${index}` },
          memoryIds: [],
          status: "committed",
          rawStatus: "ready",
          vectorStatus: "ready",
          derivedStatus: "not_requested",
          result: { results: [] },
          attempts: 1,
          createdAt,
          updatedAt: createdAt,
        }),
      );
      const snapshot: GraphSnapshotData = {
        memories: [],
        documents: [],
        documentHeads: [],
        documentChunks: [],
        associations: [],
        history: [],
        entities: [],
        memoryEntities: [],
        episodes: [],
        operations,
        events: [],
      };

      await expect(
        store.stageNamespaceImport("snapshot-staging", snapshot),
      ).resolves.toBeUndefined();
      const staged = await store.exportNamespace("snapshot-staging");
      expect(staged.operations).toHaveLength(11);
      expect(staged.operations.map((operation) => operation.id).sort()).toEqual(
        operations.map((operation) => operation.id).sort(),
      );
    } finally {
      await store.close();
      await miniflare.dispose();
    }
  });

  it("reconciles a legacy memory table before current writes", async () => {
    const { Miniflare } = await import("miniflare");
    const miniflare = new Miniflare({
      d1Databases: { DB: randomUUID() },
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
    });
    const database = await miniflare.getD1Database("DB");
    await database
      .prepare(
        `CREATE TABLE fishmem_memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          importance REAL NOT NULL DEFAULT 0.5,
          hash TEXT,
          user_id TEXT,
          agent_id TEXT,
          run_id TEXT,
          source TEXT,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_accessed_at INTEGER NOT NULL,
          access_count INTEGER NOT NULL DEFAULT 0,
          forgotten INTEGER NOT NULL DEFAULT 0,
          tier TEXT NOT NULL DEFAULT 'graph',
          demoted_at INTEGER,
          event_date INTEGER,
          valid_from INTEGER,
          valid_to INTEGER,
          superseded_by TEXT
        )`,
      )
      .run();
    const store = await createD1GraphStore({
      binding: database,
      autoMigrate: true,
    });

    try {
      await store.init();
      const createdAt = new Date("2026-07-31T00:00:00.000Z");
      const memory: Memory = {
        id: randomUUID(),
        namespaceId: "legacy-upgrade",
        content: "Ada prefers violet tea.",
        memoryType: "fact",
        importance: 0.7,
        subject: "Ada",
        attribute: "preferred_drink",
        episodeId: "episode-1",
        createdAt,
        updatedAt: createdAt,
        lastAccessedAt: createdAt,
        accessCount: 0,
        forgotten: false,
      };

      await expect(store.saveMemory(memory)).resolves.toBeUndefined();
      await expect(store.getMemory(memory.id)).resolves.toMatchObject(memory);
    } finally {
      await store.close();
      await miniflare.dispose();
    }
  });

  it("atomically commits a one-megabyte source in a bounded query batch", async () => {
    const { Miniflare } = await import("miniflare");
    const miniflare = new Miniflare({
      d1Databases: { DB: randomUUID() },
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
    });
    const database = await miniflare.getD1Database("DB");
    const batchSizes: number[] = [];
    const binding = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: unknown[]) => {
            batchSizes.push(statements.length);
            return target.batch(statements as any);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store = await createD1GraphStore({
      binding,
      autoMigrate: true,
    });

    try {
      await store.init();
      const content = `${"source line with exact bytes\n".repeat(34_400)}tail`;
      expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(
        1_000_000,
      );
      expect(new TextEncoder().encode(content).byteLength).toBeGreaterThan(
        990_000,
      );
      const createdAt = new Date("2026-07-30T08:00:00.000Z");
      const source: DocumentSource = {
        id: randomUUID(),
        namespaceId: "d1-large-source",
        sourceKey: "fixtures/large.txt",
        contentHash: "exact-source-hash",
        versionHash: "version-hash",
        content,
        title: "Large source",
        mimeType: "text/plain",
        metadata: { fixture: true },
        sizeBytes: new TextEncoder().encode(content).byteLength,
        createdAt,
      };
      const chunks: DocumentChunk[] = chunkDocumentText(content).map(
        (chunk) => ({
          ...chunk,
          id: randomUUID(),
          namespaceId: source.namespaceId,
          documentId: source.id,
          sourceKey: source.sourceKey,
          createdAt,
        }),
      );
      const head: DocumentHead = {
        id: randomUUID(),
        namespaceId: source.namespaceId,
        sourceKey: source.sourceKey,
        documentId: source.id,
        updatedAt: createdAt,
      };

      expect(chunks.length).toBeGreaterThan(500);
      await store.commitDocumentVersion(source, chunks, head);

      expect(batchSizes).toHaveLength(1);
      expect(batchSizes[0]).toBeLessThanOrEqual(6);
      expect(await store.getDocument(source.id)).toEqual(source);
      expect(
        await store.getCurrentDocument(source.namespaceId, source.sourceKey),
      ).toEqual(source);
      const storedChunks = await store.listDocumentChunks(source.id);
      expect(storedChunks).toHaveLength(chunks.length);
      expect(storedChunks[0]?.content).toBe(chunks[0]?.content);
      expect(storedChunks.at(-1)?.endOffset).toBe(source.sizeBytes);
    } finally {
      await store.close();
      await miniflare.dispose();
    }
  });

  it("bulk-deletes an exact memory set in one bounded atomic batch", async () => {
    const { Miniflare } = await import("miniflare");
    const miniflare = new Miniflare({
      d1Databases: { DB: randomUUID() },
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
    });
    const database = await miniflare.getD1Database("DB");
    const batchSizes: number[] = [];
    const binding = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: unknown[]) => {
            batchSizes.push(statements.length);
            return target.batch(statements as any);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store = await createD1GraphStore({
      binding,
      autoMigrate: true,
    });

    try {
      await store.init();
      const createdAt = new Date("2026-07-30T09:00:00.000Z");
      const removed: Memory = {
        id: randomUUID(),
        namespaceId: "d1-bulk-delete",
        userId: "ada",
        content: "remove me",
        memoryType: "fact",
        importance: 0.6,
        createdAt,
        updatedAt: createdAt,
        lastAccessedAt: createdAt,
        accessCount: 0,
        forgotten: false,
      };
      const survivor: Memory = {
        ...removed,
        id: randomUUID(),
        content: "keep me",
      };
      const association: Association = {
        id: randomUUID(),
        sourceId: removed.id,
        targetId: survivor.id,
        relationType: "related_to",
        weight: 0.5,
        createdAt,
      };
      const entity: Entity = {
        id: randomUUID(),
        namespaceId: removed.namespaceId,
        userId: removed.userId,
        name: "Ada",
        normalized: "ada",
        mentionCount: 1,
        createdAt,
      };
      await store.saveMemory(removed);
      await store.saveMemory(survivor);
      await store.createAssociation(association);
      await store.addHistory({
        memoryId: removed.id,
        event: "ADD",
        previousValue: null,
        newValue: removed.content,
        createdAt,
      });
      await store.saveEntity(entity);
      await store.linkMemoryEntities(removed.id, [entity.id]);
      batchSizes.length = 0;

      await store.deleteMemories([removed.id, removed.id]);

      expect(batchSizes).toEqual([4]);
      expect(await store.getMemory(removed.id)).toBeNull();
      expect(await store.getMemory(survivor.id)).toMatchObject(survivor);
      const counts = await database
        .prepare(
          `SELECT
             (SELECT count(*) FROM fishmem_associations
                WHERE source_id = ? OR target_id = ?) AS associations,
             (SELECT count(*) FROM fishmem_history WHERE memory_id = ?) AS history,
             (SELECT count(*) FROM fishmem_memory_entities WHERE memory_id = ?) AS mentions`,
        )
        .bind(removed.id, removed.id, removed.id, removed.id)
        .first<{
          associations: number;
          history: number;
          mentions: number;
        }>();
      expect(counts).toEqual({
        associations: 0,
        history: 0,
        mentions: 0,
      });
    } finally {
      await store.close();
      await miniflare.dispose();
    }
  });
});
