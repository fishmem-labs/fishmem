import { describe, expect, it, vi } from "vitest";
import {
  createSqliteGraphStore,
  Memory,
  MockEmbedder,
  MockLLM,
  SqliteVectorStore,
} from "fishmem";
import { MemoryApplication } from "../src/index";

function fixture() {
  const memory = {
    add: vi.fn().mockResolvedValue({
      results: [{ id: "m1", memory: "fact", event: "ADD" }],
    }),
    get: vi.fn().mockResolvedValue({
      id: "m1",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
    getAll: vi.fn().mockResolvedValue({ results: [] }),
    getFeedback: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue({ results: [] }),
    setFeedback: vi.fn().mockResolvedValue({
      id: "feedback-1",
      memoryId: "m1",
      rating: "negative",
      reason: "Out of date",
      requestId: "req_1",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    }),
    clearFeedback: vi.fn().mockResolvedValue(true),
    update: vi.fn(),
  };
  const engine = { forNamespace: vi.fn().mockReturnValue(memory) };
  return { app: new MemoryApplication(engine as never), engine, memory };
}

describe("MemoryApplication", () => {
  it("validates and binds canonical add commands", async () => {
    const { app, engine, memory } = fixture();
    await app.add(
      "workspace",
      { content: "fact", user_id: "user" },
      "command-1",
    );
    expect(engine.forNamespace).toHaveBeenCalledWith("workspace");
    expect(memory.add).toHaveBeenCalledWith("fact", {
      userId: "user",
      agentId: undefined,
      runId: undefined,
      infer: true,
      idempotencyKey: "command-1",
      metadata: undefined,
    });
  });

  it("rejects stale optimistic versions before mutation", async () => {
    const { app, memory } = fixture();
    await expect(
      app.update("workspace", "m1", {
        content: "changed",
        version: "2025-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      status: 409,
    });
    expect(memory.update).not.toHaveBeenCalled();
  });

  it("validates, shapes, and clears native memory feedback", async () => {
    const { app, memory } = fixture();
    await expect(
      app.setFeedback(
        "workspace",
        "m1",
        {
          rating: "negative",
          reason: "Out of date",
          request_id: "req_1",
        },
        "feedback-command-1",
      ),
    ).resolves.toEqual({
      feedback: {
        id: "feedback-1",
        memory_id: "m1",
        rating: "negative",
        reason: "Out of date",
        request_id: "req_1",
        created_at: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(memory.setFeedback).toHaveBeenCalledWith(
      "m1",
      {
        rating: "negative",
        reason: "Out of date",
        requestId: "req_1",
      },
      { idempotencyKey: "feedback-command-1" },
    );
    await expect(app.getFeedback("workspace", "m1")).resolves.toEqual({
      feedback: null,
    });
    await expect(
      app.clearFeedback("workspace", "m1", "feedback-clear-1"),
    ).resolves.toEqual({ cleared: true });
  });

  it("validates and forwards public retrieval controls to the core engine", async () => {
    const { app, memory } = fixture();
    await app.search("workspace", {
      query: "deployment",
      user_id: "ada",
      top_k: 7,
      memory_type: "decision",
      mode: "hybrid",
      search_strategy: "precision",
      sort_by: "importance",
      min_score: 0.2,
      filters: { environment: "production", active: true },
      trace: true,
    });
    expect(memory.search).toHaveBeenCalledWith("deployment", {
      userId: "ada",
      agentId: undefined,
      runId: undefined,
      limit: 7,
      memoryType: "decision",
      mode: "hybrid",
      searchStrategy: "precision",
      sortBy: "importance",
      minScore: 0.2,
      filters: { environment: "production", active: true },
      trace: true,
    });
  });

  it("compiles the advanced wire filter once before calling the core", async () => {
    const { app, memory } = fixture();
    await app.search("workspace", {
      query: "deployment",
      user_id: "ada",
      filters: {
        and: [
          {
            field: "metadata.environment",
            operator: "eq",
            value: "production",
          },
          {
            field: "created_at",
            operator: "gte",
            value: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    expect(memory.search).toHaveBeenCalledWith("deployment", {
      userId: "ada",
      agentId: undefined,
      runId: undefined,
      limit: 10,
      filter: {
        kind: "and",
        conditions: [
          {
            kind: "condition",
            field: "metadata.environment",
            operator: "eq",
            value: "production",
          },
          {
            kind: "condition",
            field: "createdAt",
            operator: "gte",
            value: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
      },
    });
  });

  it("searches an authenticated workspace without adding a subject scope", async () => {
    const { app, memory } = fixture();
    await app.searchWorkspace("workspace", {
      query: "deployment",
      limit: 7,
      memory_type: "decision",
    });
    expect(memory.search).toHaveBeenCalledWith("deployment", {
      limit: 7,
      memoryType: "decision",
    });
  });

  it("rejects malformed cursors instead of falling back to page one", async () => {
    const { app, memory } = fixture();
    await expect(
      app.list("workspace", { cursor: "not-base64" }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR", status: 400 });
    expect(memory.getAll).not.toHaveBeenCalled();
  });

  it("lists, gets, paginates, and retry-safely deletes scope entities", async () => {
    const engine = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore: await createSqliteGraphStore({ url: ":memory:" }),
      llm: new MockLLM(),
      vectorStore: new SqliteVectorStore({ url: ":memory:" }),
    });
    const app = new MemoryApplication(engine);
    await app.add(
      "workspace",
      {
        content: "Ada works with the helper",
        user_id: "艾达",
        agent_id: "helper",
        run_id: "run-1",
        infer: false,
      },
      "scope-entity-add-1",
    );
    await app.add(
      "workspace",
      {
        content: "Bob works with the helper",
        user_id: "bob",
        agent_id: "helper",
        infer: false,
      },
      "scope-entity-add-2",
    );

    const collected: Array<{ type: string; id: string }> = [];
    let cursor: string | null | undefined;
    do {
      const page = await app.listScopeEntities("workspace", {
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      collected.push(...page.results);
      cursor = page.next_cursor;
    } while (cursor);
    expect(collected.map(({ type, id }) => `${type}:${id}`).sort()).toEqual([
      "agent:helper",
      "run:run-1",
      "user:bob",
      "user:艾达",
    ]);
    await expect(
      app.getScopeEntity("workspace", "agent", "helper"),
    ).resolves.toMatchObject({ total_memories: 2 });
    await expect(
      app.listScopeEntities("workspace", { cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR", status: 400 });

    const deleted = {
      id: "helper",
      type: "agent",
      deleted_memories: 2,
    };
    await expect(
      app.deleteScopeEntity(
        "workspace",
        "agent",
        "helper",
        "delete-helper-1",
      ),
    ).resolves.toEqual(deleted);
    await expect(
      app.deleteScopeEntity(
        "workspace",
        "agent",
        "helper",
        "delete-helper-1",
      ),
    ).resolves.toEqual(deleted);
    await expect(
      app.deleteScopeEntity(
        "workspace",
        "agent",
        "helper",
        "delete-helper-2",
      ),
    ).rejects.toMatchObject({ code: "SCOPE_ENTITY_NOT_FOUND", status: 404 });
    await engine.close();
  });

  it("runs the canonical CRUD and operation journey on SQLite", async () => {
    const engine = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore: await createSqliteGraphStore({ url: ":memory:" }),
      llm: new MockLLM(),
      vectorStore: new SqliteVectorStore({ url: ":memory:" }),
    });
    const app = new MemoryApplication(engine);

    const first = await app.add(
      "workspace",
      {
        content: "Ada prefers tea",
        user_id: "ada",
        infer: false,
        metadata: { environment: "production" },
      },
      "sqlite-add-1",
    );
    await app.add(
      "workspace",
      {
        content: "Ada lives in Taipei",
        user_id: "ada",
        infer: false,
        metadata: { environment: "development" },
      },
      "sqlite-add-2",
    );
    const firstPage = await app.list("workspace", {
      user_id: "ada",
      limit: 1,
    });
    expect(firstPage.results).toHaveLength(1);
    expect(firstPage.next_cursor).toEqual(expect.any(String));
    const secondPage = await app.list("workspace", {
      user_id: "ada",
      limit: 1,
      cursor: firstPage.next_cursor!,
    });
    expect(secondPage.results).toHaveLength(1);
    expect(secondPage.results[0]?.id).not.toBe(firstPage.results[0]?.id);

    const id = first.results[0]!.id;
    const before = await app.get("workspace", id);
    expect(
      (await app.search("workspace", { query: "tea", user_id: "ada" }))
        .results,
    ).not.toHaveLength(0);
    expect(
      (await app.searchWorkspace("workspace", { query: "tea" })).results,
    ).not.toHaveLength(0);
    const production = await app.search("workspace", {
      query: "Ada",
      user_id: "ada",
      filters: { environment: "production" },
    });
    expect(production.results.map((hit) => hit.memory.id)).toEqual([id]);
    await app.update(
      "workspace",
      id,
      { content: "Ada prefers green tea", version: before.updatedAt.toISOString() },
      "sqlite-update-1",
    );
    expect((await app.history("workspace", id)).map((row) => row.event)).toEqual([
      "ADD",
      "UPDATE",
    ]);
    const operations = await app.listOperations("workspace");
    expect(operations.results).toHaveLength(3);
    await expect(
      app.getOperation("workspace", operations.results[0]!.id),
    ).resolves.toMatchObject({ status: "committed" });
    const deleted = { id, deleted: true };
    await expect(
      app.delete("workspace", id, "sqlite-delete-1"),
    ).resolves.toEqual(deleted);
    await expect(
      app.delete("workspace", id, "sqlite-delete-1"),
    ).resolves.toEqual(deleted);
    await expect(
      app.delete("workspace", id, "sqlite-delete-new-command"),
    ).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND", status: 404 });
    await expect(app.get("workspace", id)).rejects.toMatchObject({
      code: "MEMORY_NOT_FOUND",
    });
    expect((await app.history("workspace", id)).map((row) => row.event)).toEqual([
      "ADD",
      "UPDATE",
      "DELETE",
    ]);
    await engine.close();
  });

  it("runs the canonical source ingest, retrieval, content, and delete journey", async () => {
    const engine = await Memory.create({
      embedder: new MockEmbedder(64),
      graphStore: await createSqliteGraphStore({ url: ":memory:" }),
      llm: new MockLLM(),
      vectorStore: new SqliteVectorStore({ url: ":memory:" }),
    });
    const app = new MemoryApplication(engine);
    const content = [
      "FishMem source guide",
      "The Aster deployment gate uses a violet release token.",
      "Always verify the original source before executing the rollout.",
    ].join("\n\n");

    const ingested = await app.ingestDocument(
      "workspace",
      {
        source_key: "docs/source-guide.md",
        content,
        title: "Source guide",
        mime_type: "text/markdown",
        user_id: "ada",
      },
      "source-guide-1",
    );
    expect(ingested).toMatchObject({
      created: true,
      document: {
        source_key: "docs/source-guide.md",
        title: "Source guide",
      },
    });
    expect(ingested.document).not.toHaveProperty("content");
    await expect(
      app.ingestDocument(
        "workspace",
        {
          source_key: "docs/source-guide.md",
          content,
          title: "Source guide",
          mime_type: "text/markdown",
          user_id: "ada",
        },
        "source-guide-1",
      ),
    ).resolves.toEqual(ingested);

    const page = await app.listDocuments("workspace", {
      user_id: "ada",
      limit: 1,
    });
    expect(page.results).toEqual([ingested.document]);
    expect(page.next_cursor).toBeNull();

    await expect(
      app.getDocumentContent("workspace", ingested.document.id),
    ).resolves.toMatchObject({ content });
    const found = await app.searchDocuments("workspace", {
      user_id: "ada",
      query: "violet release token",
      neighbors: 1,
    });
    expect(found.results[0]).toMatchObject({
      document: { id: ingested.document.id },
      chunk: { start_byte: 0 },
    });
    expect(found.results[0]?.chunk.content).toContain("violet release token");

    await expect(
      app.deleteDocument(
        "workspace",
        ingested.document.id,
        "source-guide-delete",
      ),
    ).resolves.toMatchObject({ deleted: true, versions: 1 });
    await expect(
      app.deleteDocument(
        "workspace",
        ingested.document.id,
        "source-guide-delete",
      ),
    ).resolves.toMatchObject({ deleted: true, versions: 1 });
    await expect(
      app.deleteDocument(
        "workspace",
        ingested.document.id,
        "source-guide-delete-new-command",
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND", status: 404 });
    await expect(
      app.getDocument("workspace", ingested.document.id),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND", status: 404 });
    await engine.close();
  });
});
