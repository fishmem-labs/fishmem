import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphStore } from "../../src/graph/base.js";
import {
  createD1GraphStore,
  createD1StateSidecar,
  createPostgresGraphStore,
  createPostgresStateSidecar,
  InMemoryVectorStore,
  Memory,
  MockEmbedder,
  MockLLM,
  PgVectorStore,
  QdrantStore,
} from "../../src/index.js";

async function verifyPersistentJournalReplay(store: GraphStore): Promise<void> {
  const namespaceId = `journal-${randomUUID()}`;
  const operationId = randomUUID();
  const memoryId = randomUUID();
  const now = new Date();
  const claim = await store.claimOperation({
    id: operationId,
    namespaceId,
    idempotencyKey: "repair-1",
    kind: "add",
    requestHash: "request-hash",
    command: { messages: [{ role: "user", content: "repaired" }] },
    memoryIds: [memoryId],
    status: "pending",
    rawStatus: "pending",
    vectorStatus: "pending",
    derivedStatus: "not_requested",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    attempts: 1,
    createdAt: now,
    updatedAt: now,
  });
  expect(claim.claimed).toBe(true);
  await store.failOperation(operationId, "interrupted", {
    raw: "ready",
    vector: "pending",
    derived: "not_requested",
  });
  const retryLease = new Date(now.getTime() + 120_000);
  await expect(store.retryOperation(operationId, retryLease)).resolves.toBe(
    true,
  );
  await expect(store.retryOperation(operationId, retryLease)).resolves.toBe(
    false,
  );

  const event = {
    id: `${operationId}:add:${memoryId}`,
    namespaceId,
    operationId,
    memoryId,
    eventType: "ADD" as const,
    payload: { id: memoryId },
    occurredAt: now,
  };
  const result = {
    results: [{ id: memoryId, memory: "repaired", event: "ADD" as const }],
  };
  const projections = {
    raw: "ready" as const,
    vector: "ready" as const,
    derived: "not_requested" as const,
  };
  await store.completeOperation(operationId, result, projections, [event]);
  await store.completeOperation(operationId, result, projections, [event]);
  expect(await store.listEvents(namespaceId)).toHaveLength(1);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the integration test suite`);
  }
  return value;
}

const postgresUrl = requiredEnv("FISHMEM_POSTGRES_URL");
const qdrantUrl = requiredEnv("FISHMEM_QDRANT_URL");

async function restoreFixture(namespaceId: string) {
  const memory = await Memory.create({
    embedder: new MockEmbedder(64),
    llm: new MockLLM(),
    vectorStore: new InMemoryVectorStore(),
  });
  await memory.forNamespace(namespaceId).add("restored fact", {
    idempotencyKey: "source-add",
    infer: false,
  });
  const snapshot = await memory.forNamespace(namespaceId).exportSnapshot();
  await memory.close();
  return snapshot;
}

describe("real local D1 namespace isolation", () => {
  it("isolates graph and persistent sidecar state", async () => {
    const { Miniflare } = await import("miniflare");
    const miniflare = new Miniflare({
      d1Databases: { DB: randomUUID() },
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
    });
    const binding = await miniflare.getD1Database("DB");
    const graphStore = await createD1GraphStore({ binding, autoMigrate: true });
    const sidecar = await createD1StateSidecar({
      binding,
      autoMigrate: true,
    });
    const memory = await Memory.create({
      derivation: { enabled: true, sidecar },
      embedder: new MockEmbedder(64),
      graphStore,
      llm: new MockLLM(() =>
        JSON.stringify({
          facts: [
            {
              attribute: "residence",
              subject: "Mel",
              text: "Mel lives in Taipei",
              type: "fact",
            },
          ],
        }),
      ),
      vectorStore: new InMemoryVectorStore(),
    });

    try {
      await verifyPersistentJournalReplay(graphStore);
      const alpha = memory.forNamespace("alpha");
      const beta = memory.forNamespace("beta");
      const alphaAdd = await alpha.add("Mel lives in Taipei", {
        idempotencyKey: "d1-add",
        userId: "same",
      });
      const alphaId = alphaAdd.results[0]!.id;
      expect(
        await alpha.add("Mel lives in Taipei", {
          idempotencyKey: "d1-add",
          userId: "same",
        }),
      ).toEqual(alphaAdd);
      const betaId = (await beta.add("Mel lives in Taipei", { userId: "same" }))
        .results[0]!.id;

      expect((await alpha.getAll({ userId: "same" })).results).toHaveLength(1);
      expect(await alpha.get(betaId)).toBeNull();
      expect(
        (await alpha.getState("Mel", "residence", { userId: "same" }))?.scope
          .namespaceId,
      ).toBe("alpha");
      expect(
        (await beta.getState("Mel", "residence", { userId: "same" }))?.scope
          .namespaceId,
      ).toBe("beta");
      const snapshot = await alpha.exportSnapshot();
      expect(snapshot.data.memories).toHaveLength(1);
      expect(snapshot.data.memories[0]?.namespaceId).toBe("alpha");
      const restoreNamespace = "restore-d1";
      const restore = await restoreFixture(restoreNamespace);
      await expect(
        memory
          .forNamespace(restoreNamespace)
          .importSnapshot(restore, { idempotencyKey: "d1-restore" }),
      ).resolves.toMatchObject({ imported: 1, vectors: 1 });
      expect(
        (await memory.forNamespace(restoreNamespace).getAll()).results[0]
          ?.content,
      ).toBe("restored fact");

      await alpha.deleteAll({ userId: "same" });
      expect(await alpha.get(alphaId)).toBeNull();
      expect(await beta.get(betaId)).not.toBeNull();
    } finally {
      await sidecar.close?.();
      await memory.close();
      await miniflare.dispose();
    }
  });
});

describe("real PostgreSQL namespace isolation", () => {
  let pool: import("pg").Pool;

  beforeAll(async () => {
    const pg = await import("pg");
    pool = new pg.Pool({ connectionString: postgresUrl });
    await pool.query("select 1");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("isolates graph, pgvector, sidecar, maintenance, rebuild, and delete", async () => {
    const tableName = `fishmem_vectors_${randomUUID().replaceAll("-", "")}`;
    const graphStore = await createPostgresGraphStore({ pool });
    const sidecar = await createPostgresStateSidecar({ pool });
    const vectorStore = new PgVectorStore({ pool, tableName });
    const memory = await Memory.create({
      derivation: { enabled: true, sidecar },
      embedder: new MockEmbedder(64),
      graphStore,
      llm: new MockLLM((messages) => {
        const prompt = messages.map((message) => message.content).join("\n");
        const city = prompt.includes("Taipei") ? "Taipei" : "Paris";
        return JSON.stringify({
          facts: [
            {
              attribute: "residence",
              subject: "Mel",
              text: `Mel lives in ${city}`,
              type: "fact",
            },
          ],
        });
      }),
      maintenance: {
        mergeSimilarityThreshold: 2,
        pruneThreshold: -1,
      },
      vectorStore,
    });

    try {
      await graphStore.reset();
      await sidecar.clear();
      await verifyPersistentJournalReplay(graphStore);
      const alpha = memory.forNamespace("alpha");
      const beta = memory.forNamespace("beta");
      const alphaAdd = await alpha.add("Mel lives in Taipei", {
        idempotencyKey: "postgres-add",
        userId: "mel",
      });
      const alphaId = alphaAdd.results[0]!.id;
      expect(
        await alpha.add("Mel lives in Taipei", {
          idempotencyKey: "postgres-add",
          userId: "mel",
        }),
      ).toEqual(alphaAdd);
      const betaId = (await beta.add("Mel lives in Paris", { userId: "mel" }))
        .results[0]!.id;

      expect((await alpha.getAll({ userId: "mel" })).results).toHaveLength(1);
      expect((await beta.getAll({ userId: "mel" })).results).toHaveLength(1);
      expect(await alpha.get(betaId)).toBeNull();
      expect(
        (
          await alpha.search("Where does Mel live?", { userId: "mel" })
        ).results.map((result) => result.memory.id),
      ).toEqual([alphaId]);
      await expect(alpha.update(betaId, "cross-tenant update")).rejects.toThrow(
        "memory not found",
      );
      expect(await alpha.link(alphaId, betaId)).toBeNull();
      expect((await alpha.graph({ userId: "mel" })).nodes).toHaveLength(1);
      expect(
        (await alpha.getState("Mel", "residence", { userId: "mel" }))?.value,
      ).toBe("Mel lives in Taipei");
      expect(
        (await beta.getState("Mel", "residence", { userId: "mel" }))?.value,
      ).toBe("Mel lives in Paris");
      const snapshot = await alpha.exportSnapshot();
      expect(snapshot.data.memories.length).toBeGreaterThanOrEqual(1);
      expect(
        snapshot.data.memories.every(
          (record) => record.namespaceId === "alpha",
        ),
      ).toBe(true);
      const restoreNamespace = "restore-postgres";
      const restore = await restoreFixture(restoreNamespace);
      await expect(
        memory
          .forNamespace(restoreNamespace)
          .importSnapshot(restore, { idempotencyKey: "postgres-restore" }),
      ).resolves.toMatchObject({ imported: 1, vectors: 1 });
      expect(
        (await memory.forNamespace(restoreNamespace).getAll()).results[0]
          ?.content,
      ).toBe("restored fact");

      await alpha.runMaintenance({ userId: "mel" });
      expect(await beta.get(betaId)).not.toBeNull();
      await alpha.rebuildSidecar({ userId: "mel" });
      expect(
        (await beta.getState("Mel", "residence", { userId: "mel" }))?.value,
      ).toBe("Mel lives in Paris");

      await alpha.deleteAll({ userId: "mel" });
      expect(await alpha.get(alphaId)).toBeNull();
      expect(await beta.get(betaId)).not.toBeNull();
      expect(await vectorStore.list({ namespaceId: "alpha" }, 10)).toEqual([]);
      expect(await vectorStore.list({ namespaceId: "beta" }, 10)).toHaveLength(
        1,
      );
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
      await sidecar.close?.();
      await memory.close();
    }
  });
});

describe("real Qdrant namespace isolation", () => {
  it("filters searches and deletes by structural namespace", async () => {
    const collectionName = `fishmem_test_${randomUUID().replaceAll("-", "")}`;
    const store = new QdrantStore({ url: qdrantUrl, collectionName });
    const { QdrantClient } = await import("@qdrant/js-client-rest");
    const client = new QdrantClient({ url: qdrantUrl });
    const alphaId = randomUUID();
    const betaId = randomUUID();

    try {
      await store.init(3);
      await store.upsert([
        {
          id: alphaId,
          vector: [1, 0, 0],
          content: "alpha",
          payload: { namespaceId: "alpha", userId: "same" },
        },
        {
          id: betaId,
          vector: [1, 0, 0],
          content: "beta",
          payload: { namespaceId: "beta", userId: "same" },
        },
      ]);

      expect(
        (
          await store.search([1, 0, 0], 10, {
            namespaceId: "alpha",
            userId: "same",
          })
        ).map((hit) => hit.id),
      ).toEqual([alphaId]);
      expect(
        (await store.list({ namespaceId: "beta", userId: "same" }, 10)).map(
          (record) => record.id,
        ),
      ).toEqual([betaId]);

      await store.deleteByFilter({ namespaceId: "alpha" });
      expect(await store.get(alphaId)).toBeNull();
      expect(await store.get(betaId)).not.toBeNull();
    } finally {
      await client.deleteCollection(collectionName);
    }
  });
});
