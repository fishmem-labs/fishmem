import { describe, expect, it } from "vitest";
import {
  chunkDocumentText,
  type DocumentOriginalDescriptor,
  type DocumentOriginalStore,
  type DocumentSource,
  InMemoryGraphStore,
  InMemoryVectorStore,
  Memory,
  type MemoryFilters,
  MockEmbedder,
  MockLLM,
  type VectorHit,
} from "../src/index.js";

class InMemoryDocumentOriginalStore implements DocumentOriginalStore {
  private readonly values = new Map<string, string>();
  failNextDelete = false;

  private key(namespaceId: string, documentId: string) {
    return `${namespaceId}\0${documentId}`;
  }

  async put(source: DocumentSource): Promise<void> {
    const key = this.key(source.namespaceId, source.id);
    const existing = this.values.get(key);
    if (existing !== undefined && existing !== source.content) {
      throw new Error(`document original id collision: ${source.id}`);
    }
    this.values.set(key, source.content);
  }

  async get(source: DocumentOriginalDescriptor): Promise<string> {
    const value = this.values.get(this.key(source.namespaceId, source.id));
    if (value === undefined) {
      throw new Error(`document original missing: ${source.id}`);
    }
    return value;
  }

  async delete(namespaceId: string, documentIds: string[]): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("injected original delete failure");
    }
    for (const documentId of documentIds) {
      this.values.delete(this.key(namespaceId, documentId));
    }
  }

  async deleteNamespace(namespaceId: string): Promise<void> {
    for (const key of this.values.keys()) {
      if (key.startsWith(`${namespaceId}\0`)) this.values.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.values.clear();
  }

  has(namespaceId: string, documentId: string) {
    return this.values.has(this.key(namespaceId, documentId));
  }
}

class UnfilteredCandidateVectorStore extends InMemoryVectorStore {
  override search(
    vector: number[],
    limit: number,
    _filters?: MemoryFilters,
  ): Promise<VectorHit[]> {
    return super.search(vector, limit);
  }

  override textSearch(
    query: string,
    limit: number,
    _filters?: MemoryFilters,
  ): Promise<VectorHit[]> {
    return super.textSearch(query, limit);
  }
}

async function createMemory() {
  return Memory.create({
    embedder: new MockEmbedder(128),
    llm: new MockLLM(),
    graphStore: new InMemoryGraphStore(),
    vectorStore: new InMemoryVectorStore(),
  });
}

function corpus(unique = "Aster protocol uses a cobalt release gate.") {
  return [
    `Introduction\n\n${"General background. ".repeat(90)}`,
    `Implementation\n\n${unique} ${"Detailed implementation. ".repeat(90)}`,
    `Operations\n\n${"Run the integrity check before deployment. ".repeat(90)}`,
  ].join("\n\n");
}

describe("document corpus", () => {
  it("chunks exact source substrings with UTF-8 byte provenance", () => {
    const content = `開場\n\n${"alpha ".repeat(100)}結尾`;
    const chunks = chunkDocumentText(content, {
      maxChars: 240,
      overlapChars: 40,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const bytes = new TextEncoder().encode(content);
      const selected = new TextDecoder().decode(
        bytes.slice(chunk.startOffset, chunk.endOffset),
      );
      expect(selected).toBe(chunk.content);
    }
  });

  it("clamps hostile overlap settings and always advances", () => {
    const content = "short line\n".repeat(200);
    const chunks = chunkDocumentText(content, {
      maxChars: 200,
      overlapChars: Number.MAX_SAFE_INTEGER,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(content.length);
    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index]!.startOffset).toBeGreaterThan(
        chunks[index - 1]!.startOffset,
      );
    }
  });

  it("keeps original sources canonical and retrieves chunk neighbors", async () => {
    const memory = await createMemory();
    const namespace = memory.forNamespace("project");
    const content = corpus();

    const first = await namespace.ingestDocument(
      {
        sourceKey: "docs/architecture.md",
        title: "Architecture",
        mimeType: "text/markdown",
        content,
        metadata: { repository: "fishmem" },
      },
      { userId: "ada", idempotencyKey: "document-architecture-v1" },
    );
    expect(first.created).toBe(true);
    expect(first.chunks).toBeGreaterThan(2);
    expect(first.document).not.toHaveProperty("content");

    const replay = await namespace.ingestDocument(
      {
        sourceKey: "docs/architecture.md",
        title: "Architecture",
        mimeType: "text/markdown",
        content,
        metadata: { repository: "fishmem" },
      },
      { userId: "ada", idempotencyKey: "document-architecture-v1" },
    );
    expect(replay).toEqual(first);

    const duplicateContent = await namespace.ingestDocument(
      {
        sourceKey: "docs/architecture.md",
        title: "Architecture",
        mimeType: "text/markdown",
        content,
        metadata: { repository: "fishmem" },
      },
      { userId: "ada", idempotencyKey: "document-architecture-v1-again" },
    );
    expect(duplicateContent.created).toBe(false);
    expect(duplicateContent.document.id).toBe(first.document.id);

    const stored = await namespace.getDocument(first.document.id);
    expect(stored?.content).toBe(content);
    expect(stored?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.versionHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await namespace.getAll({ userId: "ada" })).results).toEqual([]);

    const hits = await namespace.searchDocuments("cobalt release gate", {
      userId: "ada",
      limit: 3,
      neighbors: 1,
    });
    expect(hits[0]?.chunk.content).toContain("cobalt release gate");
    expect(hits[0]?.neighbors.length).toBeGreaterThan(0);
    expect(hits[0]?.document.sourceKey).toBe("docs/architecture.md");

    await expect(
      namespace.ingestDocument(
        {
          sourceKey: "docs/architecture.md",
          content: `${content}\nchanged`,
        },
        { userId: "ada", idempotencyKey: "document-architecture-v1" },
      ),
    ).rejects.toThrow("idempotency key conflict");
  });

  it("externalizes originals without forking document behavior", async () => {
    const graphStore = new InMemoryGraphStore();
    const originals = new InMemoryDocumentOriginalStore();
    const memory = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      graphStore,
      vectorStore: new InMemoryVectorStore(),
      documentOriginalStore: originals,
    });
    const namespace = memory.forNamespace("project");
    const content = corpus("The object-backed source token is cerulean.");
    const ingested = await namespace.ingestDocument(
      {
        sourceKey: "docs/object-backed.md",
        content,
        mimeType: "text/markdown",
      },
      { userId: "ada", idempotencyKey: "object-backed-1" },
    );

    expect((await graphStore.getDocument(ingested.document.id))?.content).toBe(
      "",
    );
    expect(originals.has("project", ingested.document.id)).toBe(true);
    expect(await namespace.getDocument(ingested.document.id)).toMatchObject({
      content,
      contentHash: ingested.document.contentHash,
    });
    expect(await namespace.listDocuments({ userId: "ada" })).toEqual([
      ingested.document,
    ]);

    const snapshot = await namespace.exportSnapshot();
    expect(snapshot.data.documents[0]?.content).toBe(content);

    await namespace.deleteDocument(ingested.document.id, {
      userId: "ada",
      idempotencyKey: "object-backed-delete",
    });
    expect(originals.has("project", ingested.document.id)).toBe(false);
  });

  it("replays an interrupted object-backed delete from its frozen plan", async () => {
    const originals = new InMemoryDocumentOriginalStore();
    const memory = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      graphStore: new InMemoryGraphStore(),
      vectorStore: new InMemoryVectorStore(),
      documentOriginalStore: originals,
    });
    const namespace = memory.forNamespace("project");
    const ingested = await namespace.ingestDocument(
      { sourceKey: "retry.txt", content: corpus("Retry the object cleanup.") },
      { userId: "ada", idempotencyKey: "retry-ingest" },
    );
    originals.failNextDelete = true;

    await expect(
      namespace.deleteDocument(ingested.document.id, {
        userId: "ada",
        idempotencyKey: "retry-delete",
      }),
    ).rejects.toThrow("injected original delete failure");
    expect(originals.has("project", ingested.document.id)).toBe(true);

    await expect(
      namespace.deleteDocument(ingested.document.id, {
        userId: "ada",
        idempotencyKey: "retry-delete",
      }),
    ).resolves.toMatchObject({ deleted: true, versions: 1 });
    expect(originals.has("project", ingested.document.id)).toBe(false);
  });

  it("versions normalized source metadata independently from exact content", async () => {
    const memory = await createMemory();
    const namespace = memory.forNamespace("project");
    const content = corpus();
    const first = await namespace.ingestDocument(
      {
        sourceKey: "docs/reference.md",
        content,
        title: "Reference v1",
        metadata: { revision: 1 },
      },
      { userId: "ada", idempotencyKey: "reference-metadata-1" },
    );
    const second = await namespace.ingestDocument(
      {
        sourceKey: "docs/reference.md",
        content,
        title: "Reference v2",
        metadata: { revision: 2 },
      },
      { userId: "ada", idempotencyKey: "reference-metadata-2" },
    );

    expect(second.created).toBe(true);
    expect(second.document.id).not.toBe(first.document.id);
    expect(second.document.contentHash).toBe(first.document.contentHash);
    expect(second.document.versionHash).not.toBe(first.document.versionHash);
    await expect(
      namespace.listDocuments({ userId: "ada" }),
    ).resolves.toMatchObject([
      {
        id: second.document.id,
        title: "Reference v2",
        metadata: { revision: 2 },
      },
    ]);
  });

  it("versions by stable source identity and fences superseded chunks", async () => {
    const memory = await createMemory();
    const namespace = memory.forNamespace("project");
    const oldVersion = await namespace.ingestDocument(
      {
        sourceKey: "handbook.txt",
        content: corpus("The launch color is amber."),
      },
      { agentId: "support", idempotencyKey: "handbook-1" },
    );
    const newVersion = await namespace.ingestDocument(
      {
        sourceKey: "handbook.txt",
        content: corpus("The launch color is violet."),
      },
      { agentId: "support", idempotencyKey: "handbook-2" },
    );

    expect(newVersion.created).toBe(true);
    expect(newVersion.document.id).not.toBe(oldVersion.document.id);
    expect(await namespace.getDocument(oldVersion.document.id)).not.toBeNull();
    expect(
      await namespace.listDocuments({ agentId: "support" }, { limit: 10 }),
    ).toHaveLength(1);
    const current = await namespace.searchDocuments("launch color", {
      agentId: "support",
      limit: 5,
    });
    expect(current.some((hit) => hit.chunk.content.includes("violet"))).toBe(
      true,
    );
    expect(current.some((hit) => hit.chunk.content.includes("amber"))).toBe(
      false,
    );
  });

  it("rechecks canonical document scope after a vector candidate match", async () => {
    const memory = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      graphStore: new InMemoryGraphStore(),
      vectorStore: new UnfilteredCandidateVectorStore(),
    });
    const namespace = memory.forNamespace("project");
    await namespace.ingestDocument(
      {
        sourceKey: "private/wrong.md",
        content: "The shared retrieval token is indigo.",
      },
      { userId: "wrong-user", idempotencyKey: "wrong-source" },
    );
    const expected = await namespace.ingestDocument(
      {
        sourceKey: "private/expected.md",
        content: "The shared retrieval token is indigo.",
      },
      { userId: "expected-user", idempotencyKey: "expected-source" },
    );

    const hits = await namespace.searchDocuments("indigo retrieval token", {
      userId: "expected-user",
      sourceKey: "private/expected.md",
      limit: 5,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.document.id).toBe(expected.document.id);
  });

  it("permanently deletes every source version and replays safely", async () => {
    const memory = await createMemory();
    const namespace = memory.forNamespace("project");
    const first = await namespace.ingestDocument(
      { sourceKey: "guide.txt", content: corpus("First guide version.") },
      { runId: "run", idempotencyKey: "guide-1" },
    );
    const second = await namespace.ingestDocument(
      { sourceKey: "guide.txt", content: corpus("Second guide version.") },
      { runId: "run", idempotencyKey: "guide-2" },
    );

    const deleted = await namespace.deleteDocument(second.document.id, {
      runId: "run",
      idempotencyKey: "guide-delete",
    });
    expect(deleted).toMatchObject({ deleted: true, versions: 2 });
    expect(await namespace.getDocument(first.document.id)).toBeNull();
    expect(await namespace.getDocument(second.document.id)).toBeNull();
    expect(await namespace.listDocuments({ runId: "run" })).toEqual([]);
    await expect(
      namespace.deleteDocument(second.document.id, {
        runId: "run",
        idempotencyKey: "guide-delete",
      }),
    ).resolves.toEqual(deleted);
  });

  it("backs up source versions and rebuilds their retrieval projections", async () => {
    const sourceMemory = await createMemory();
    const source = sourceMemory.forNamespace("source");
    const ingested = await source.ingestDocument(
      {
        sourceKey: "portable.txt",
        content: corpus("Portable evidence token."),
      },
      { userId: "ada", idempotencyKey: "portable-ingest" },
    );
    const snapshot = await source.exportSnapshot();

    const targetMemory = await createMemory();
    const target = targetMemory.forNamespace("target");
    await expect(
      target.importSnapshot(snapshot, { idempotencyKey: "portable-restore" }),
    ).resolves.toMatchObject({
      imported: 0,
      documents: 1,
      vectors: ingested.chunks,
    });
    expect(
      (
        await target.searchDocuments("Portable evidence token", {
          userId: "ada",
        })
      )[0]?.document.id,
    ).toBe(ingested.document.id);
    expect((await target.getDocument(ingested.document.id))?.namespaceId).toBe(
      "target",
    );
  });

  it("restores snapshots through the configured original store", async () => {
    const sourceMemory = await createMemory();
    const source = sourceMemory.forNamespace("source");
    const content = corpus("The restored object token is chartreuse.");
    const ingested = await source.ingestDocument(
      { sourceKey: "restore.txt", content },
      { userId: "ada", idempotencyKey: "restore-source" },
    );
    const snapshot = await source.exportSnapshot();

    const graphStore = new InMemoryGraphStore();
    const originals = new InMemoryDocumentOriginalStore();
    const targetMemory = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      graphStore,
      vectorStore: new InMemoryVectorStore(),
      documentOriginalStore: originals,
    });
    const target = targetMemory.forNamespace("target");
    await target.importSnapshot(snapshot, {
      idempotencyKey: "restore-target",
    });

    expect((await graphStore.getDocument(ingested.document.id))?.content).toBe(
      "",
    );
    expect(originals.has("target", ingested.document.id)).toBe(true);
    expect((await target.getDocument(ingested.document.id))?.content).toBe(
      content,
    );

    await target.purgeAll();
    expect(originals.has("target", ingested.document.id)).toBe(false);
  });
});
