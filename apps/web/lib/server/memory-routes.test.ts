import { describe, expect, it, vi } from "vitest";
import {
  addMemories,
  appDocumentsHandler,
  appEntitiesHandler,
  appMemoriesHandler,
  batchDeleteMemories,
  batchUpdateMemories,
  type BatchMemoryMutationDependencies,
  exportWorkspaceSnapshot,
  getMemoryFeedback,
  getMemoryHealth,
  ingestDocument,
  type MemoryHealthDependencies,
  readMutationIdempotencyKey,
  type PublicMemoryApiDependencies,
  searchMemories,
  searchDocuments,
  setMemoryFeedback,
  clearMemoryFeedback,
  deleteScopeEntity,
  getScopeEntity,
  listScopeEntities,
} from "./memory-api";
import { sanitizePublicSnapshot } from "./public-snapshot";

function dependencies() {
  const memory = {
    add: vi.fn().mockResolvedValue({
      results: [{ id: "mem_1", memory: "Ada prefers tea", event: "ADD" }],
    }),
    search: vi.fn().mockResolvedValue({
      results: [
        {
          memory: {
            id: "mem_1",
            content: "Ada prefers tea",
            memoryType: "episodic",
            importance: 0.5,
            namespaceId: "ws_1",
            createdAt: new Date("2026-07-13T00:00:00.000Z"),
            updatedAt: new Date("2026-07-13T00:00:00.000Z"),
          },
          score: 0.9,
        },
      ],
    }),
    exportSnapshot: vi.fn().mockResolvedValue({
      format: "fishmem.namespace-snapshot",
      version: 1,
    }),
    get: vi.fn().mockResolvedValue({
      id: "mem_1",
      content: "Ada prefers tea",
      memoryType: "preference",
      importance: 0.7,
      namespaceId: "ws_1",
      userId: "ada",
      createdAt: new Date("2026-07-13T00:00:00.000Z"),
      updatedAt: new Date("2026-07-13T00:00:00.000Z"),
    }),
    getAll: vi.fn().mockResolvedValue({ results: [] }),
    getBeliefView: vi.fn().mockResolvedValue({
      projectionStatus: "ready",
      mode: "audit",
      subject: "Ada",
      attribute: "editor_theme",
      applicability: { kind: "project", key: "ws_1" },
      winner: {
        id: "belief_1",
        subject: "Ada",
        attribute: "editor_theme",
        value: "dark",
        applicability: { kind: "project", key: "ws_1" },
        status: "supported",
        score: 3,
        support: 1,
        evidenceCount: 3,
        contextCount: 3,
        sourceIds: ["mem_1"],
        firstObservedAt: new Date("2026-07-01T00:00:00.000Z"),
        lastObservedAt: new Date("2026-07-03T00:00:00.000Z"),
        reasonCodes: ["policy_thresholds_met"],
        evidence: [
          {
            id: "belief_ev_1",
            sourceId: "mem_1",
            evidenceKey: "add_1",
            contextId: "run_1",
            applicability: { kind: "project", key: "ws_1" },
            observedAt: new Date("2026-07-01T00:00:00.000Z"),
            validFrom: new Date("2026-07-01T00:00:00.000Z"),
            weight: 1,
            active: true,
          },
        ],
      },
      candidates: [],
      unresolved: false,
      reasonCodes: ["contextual_override"],
      shadow: { outcome: "belief_only", winnerId: "belief_1" },
    }),
    getFeedback: vi.fn().mockResolvedValue(null),
    setFeedback: vi.fn().mockResolvedValue({
      id: "feedback_1",
      memoryId: "mem_1",
      rating: "negative",
      reason: "Out of date",
      requestId: "req_1",
      createdAt: new Date("2026-07-31T00:00:00.000Z"),
    }),
    clearFeedback: vi.fn().mockResolvedValue(true),
    stats: vi.fn().mockResolvedValue({ totalMemories: 12, totalEntities: 4 }),
    listScopeEntities: vi.fn().mockResolvedValue([
      {
        id: "ada",
        type: "user",
        totalMemories: 2,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-03T00:00:00.000Z"),
      },
    ]),
    getScopeEntity: vi.fn().mockResolvedValue({
      id: "ada",
      type: "user",
      totalMemories: 2,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-03T00:00:00.000Z"),
    }),
    deleteAll: vi.fn().mockResolvedValue({ deleted: 2 }),
    ingestDocument: vi.fn().mockResolvedValue({
      document: {
        id: "doc_1",
        namespaceId: "ws_1",
        sourceKey: "docs/guide.md",
        contentHash: "a".repeat(64),
        versionHash: "b".repeat(64),
        title: "Guide",
        mimeType: "text/markdown",
        userId: "ada",
        sizeBytes: 21,
        createdAt: new Date("2026-07-30T00:00:00.000Z"),
      },
      chunks: 1,
      created: true,
    }),
    searchDocuments: vi.fn().mockResolvedValue([
      {
        document: {
          id: "doc_1",
          namespaceId: "ws_1",
          sourceKey: "docs/guide.md",
          contentHash: "a".repeat(64),
          versionHash: "b".repeat(64),
          title: "Guide",
          mimeType: "text/markdown",
          userId: "ada",
          sizeBytes: 21,
          createdAt: new Date("2026-07-30T00:00:00.000Z"),
        },
        chunk: {
          id: "chunk_1",
          namespaceId: "ws_1",
          documentId: "doc_1",
          sourceKey: "docs/guide.md",
          index: 0,
          content: "violet release token",
          startOffset: 0,
          endOffset: 20,
          contentHash: "chunk-hash",
          userId: "ada",
          createdAt: new Date("2026-07-30T00:00:00.000Z"),
        },
        neighbors: [],
        score: 1,
      },
    ]),
  };
  const engine = {
    forNamespace: vi.fn().mockReturnValue(memory),
  };
  const auth = {
    db: {},
    apiToken: {
      documentId: "key_1",
      name: "Test key",
      workspaceId: "ws_1",
    },
  };
  const reserveUsage = vi.fn().mockResolvedValue({ credits: 0 });
  const settleUsage = vi.fn().mockResolvedValue(undefined);
  const enqueueInference = vi.fn().mockImplementation(
    async (
      _db,
      input: {
        command: Record<string, unknown>;
        derivationEnabled: boolean;
        idempotencyKey: string;
        workspaceId: string;
        usage?: Record<string, unknown>;
      },
    ) => {
      const now = new Date("2026-07-31T00:00:00.000Z");
      return {
        id: "task_infer",
        documentId: "task_infer",
        workspaceId: input.workspaceId,
        operationId: `memory-infer:${input.idempotencyKey}`,
        kind: "memory_infer",
        status: "pending",
        payload: {
          version: 1,
          command: input.command,
          idempotency_key: input.idempotencyKey,
          derivation_enabled: input.derivationEnabled,
          ...(input.usage ? { usage: input.usage } : {}),
        },
        result: null,
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: now,
        leaseExpiresAt: null,
        error: null,
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
    },
  );
  const notifyTask = vi.fn().mockResolvedValue(undefined);
  const runtime = {
    authenticate: vi.fn().mockResolvedValue(auth),
    derivationEnabled: vi.fn().mockResolvedValue(true),
    enqueueDerivation: vi.fn().mockResolvedValue(undefined),
    enqueueInference,
    emitWebhook: vi.fn().mockResolvedValue(undefined),
    getEngine: vi.fn().mockResolvedValue(engine),
    notifyTask,
    recordRequest: vi.fn().mockResolvedValue(undefined),
    reserveUsage,
    settleUsage,
  } as unknown as PublicMemoryApiDependencies;
  return {
    auth,
    engine,
    enqueueInference,
    memory,
    notifyTask,
    reserveUsage,
    runtime,
    settleUsage,
  };
}

describe("authenticated public memory routes", () => {
  it("lists, gets, and retry-safely deletes structural scope entities", async () => {
    const { memory, runtime } = dependencies();
    const listed = await listScopeEntities(
      new Request("https://fishmem.test/v1/entities?type=user&limit=1"),
      runtime,
    );
    if (!listed) throw new Error("scope entity list returned no response");
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      results: [
        {
          id: "ada",
          type: "user",
          total_memories: 2,
          created_at: "2026-07-01T00:00:00.000Z",
          updated_at: "2026-07-03T00:00:00.000Z",
        },
      ],
      next_cursor: null,
    });
    expect(memory.listScopeEntities).toHaveBeenCalledWith({
      type: "user",
      cursor: undefined,
      limit: 2,
    });

    const detail = await getScopeEntity(
      new Request("https://fishmem.test/v1/entities/user/ada"),
      "user",
      "ada",
      runtime,
    );
    if (!detail) throw new Error("scope entity get returned no response");
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      id: "ada",
      total_memories: 2,
    });

    const missingKey = await deleteScopeEntity(
      new Request("https://fishmem.test/v1/entities/user/ada", {
        method: "DELETE",
      }),
      "user",
      "ada",
      runtime,
    );
    if (!missingKey) throw new Error("scope entity delete returned no response");
    expect(missingKey.status).toBe(400);
    expect(memory.deleteAll).not.toHaveBeenCalled();

    const deleted = await deleteScopeEntity(
      new Request("https://fishmem.test/v1/entities/user/ada", {
        method: "DELETE",
        headers: { "Idempotency-Key": "delete-user-ada-1" },
      }),
      "user",
      "ada",
      runtime,
    );
    if (!deleted) throw new Error("scope entity delete returned no response");
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({
      id: "ada",
      type: "user",
      deleted_memories: 2,
    });
    expect(memory.deleteAll).toHaveBeenCalledWith(
      { userId: "ada" },
      { idempotencyKey: "delete-user-ada-1" },
    );
  });

  it("gets, sets, and clears audited memory feedback", async () => {
    const { memory, runtime } = dependencies();
    const getResponse = await getMemoryFeedback(
      new Request("https://fishmem.test/v1/memories/mem_1/feedback"),
      "mem_1",
      runtime,
    );
    if (!getResponse) throw new Error("feedback get route returned no response");
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({ feedback: null });

    const missingKey = await setMemoryFeedback(
      new Request("https://fishmem.test/v1/memories/mem_1/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: "negative" }),
      }),
      "mem_1",
      runtime,
      { requireIdempotencyKey: true },
    );
    if (!missingKey) throw new Error("feedback set route returned no response");
    expect(missingKey.status).toBe(400);
    await expect(missingKey.json()).resolves.toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });

    const setResponse = await setMemoryFeedback(
      new Request("https://fishmem.test/v1/memories/mem_1/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "feedback-set-1",
        },
        body: JSON.stringify({
          rating: "negative",
          reason: "Out of date",
          request_id: "req_1",
        }),
      }),
      "mem_1",
      runtime,
      { requireIdempotencyKey: true },
    );
    if (!setResponse) throw new Error("feedback set route returned no response");
    expect(setResponse.status).toBe(200);
    await expect(setResponse.json()).resolves.toEqual({
      feedback: {
        id: "feedback_1",
        memory_id: "mem_1",
        rating: "negative",
        reason: "Out of date",
        request_id: "req_1",
        created_at: "2026-07-31T00:00:00.000Z",
      },
    });
    expect(memory.setFeedback).toHaveBeenCalledWith(
      "mem_1",
      {
        rating: "negative",
        reason: "Out of date",
        requestId: "req_1",
      },
      { idempotencyKey: "feedback-set-1" },
    );

    const clearResponse = await clearMemoryFeedback(
      new Request("https://fishmem.test/v1/memories/mem_1/feedback", {
        method: "DELETE",
        headers: { "Idempotency-Key": "feedback-clear-1" },
      }),
      "mem_1",
      runtime,
      { requireIdempotencyKey: true },
    );
    if (!clearResponse) {
      throw new Error("feedback clear route returned no response");
    }
    expect(clearResponse.status).toBe(200);
    await expect(clearResponse.json()).resolves.toEqual({ cleared: true });
  });

  it("binds document ingestion and evidence search to the hosted usage seam", async () => {
    const { memory, reserveUsage, runtime, settleUsage } = dependencies();
    reserveUsage.mockResolvedValue({ credits: 1 });

    const ingested = await ingestDocument(
      new Request("https://fishmem.test/v1/documents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "document-guide-1",
        },
        body: JSON.stringify({
          source_key: "docs/guide.md",
          content: "violet release token",
          title: "Guide",
          mime_type: "text/markdown",
          user_id: "ada",
        }),
      }),
      runtime,
      { requireIdempotencyKey: true },
    );
    if (!ingested) throw new Error("document ingest route returned no response");
    expect(ingested.status).toBe(200);
    await expect(ingested.json()).resolves.toMatchObject({
      created: true,
      document: {
        id: "doc_1",
        source_key: "docs/guide.md",
        content_hash: "a".repeat(64),
      },
    });
    expect(memory.ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: "docs/guide.md" }),
      expect.objectContaining({
        userId: "ada",
        idempotencyKey: "document-guide-1",
      }),
    );
    expect(reserveUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "documents.ingest",
        idempotencyKey: "document-guide-1",
        units: 1,
      }),
    );
    expect(settleUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "documents.ingest",
        outcome: "success",
      }),
    );

    const searched = await searchDocuments(
      new Request("https://fishmem.test/v1/documents/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "violet",
          user_id: "ada",
          neighbors: 1,
        }),
      }),
      runtime,
    );
    if (!searched) throw new Error("document search route returned no response");
    expect(searched.status).toBe(200);
    await expect(searched.json()).resolves.toMatchObject({
      results: [
        {
          document: { id: "doc_1" },
          chunk: { id: "chunk_1", start_byte: 0, end_byte: 20 },
          neighbors: [],
          score: 1,
        },
      ],
    });
    expect(reserveUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "documents.search" }),
    );
  });

  it("ingests an exact UTF-8 multipart file through the existing document command", async () => {
    const { memory, reserveUsage, runtime } = dependencies();
    const exactContent = "\ufeff# Guide\r\n\r\nViolet release token. 🐟\r\n";
    const form = new FormData();
    form.set(
      "file",
      new File([new TextEncoder().encode(exactContent)], "guide.md", {
        type: "text/markdown",
      }),
    );
    form.set("user_id", "ada");
    form.set("source_key", "docs/guide.md");
    form.set("title", "Release guide");
    form.set("metadata", JSON.stringify({ channel: "docs" }));

    const response = await ingestDocument(
      new Request("https://fishmem.test/v1/documents", {
        method: "POST",
        headers: { "Idempotency-Key": "multipart-guide-1" },
        body: form,
      }),
      runtime,
      { requireIdempotencyKey: true },
    );

    if (!response) throw new Error("multipart ingest returned no response");
    expect(response.status).toBe(200);
    expect(memory.ingestDocument).toHaveBeenCalledWith(
      {
        sourceKey: "docs/guide.md",
        content: exactContent,
        title: "Release guide",
        mimeType: "text/markdown",
        sourceUri: undefined,
        metadata: { channel: "docs" },
      },
      expect.objectContaining({
        userId: "ada",
        idempotencyKey: "multipart-guide-1",
      }),
    );
    expect(reserveUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "documents.ingest",
        idempotencyKey: "multipart-guide-1",
        units: 1,
      }),
    );
  });

  it.each([
    {
      name: "invalid UTF-8",
      file: new File([new Uint8Array([0xff])], "invalid.txt", {
        type: "text/plain",
      }),
      status: 400,
      code: "INVALID_UTF8",
    },
    {
      name: "binary media type",
      file: new File(["%PDF-1.7"], "guide.pdf", {
        type: "application/pdf",
      }),
      status: 415,
      code: "UNSUPPORTED_DOCUMENT_MEDIA_TYPE",
    },
    {
      name: "oversized source",
      file: new File(["x".repeat(1_000_001)], "large.txt", {
        type: "text/plain",
      }),
      status: 413,
      code: "DOCUMENT_TOO_LARGE",
    },
  ])("rejects multipart $name before reserving usage", async (scenario) => {
    const { reserveUsage, runtime } = dependencies();
    const form = new FormData();
    form.set("file", scenario.file);
    form.set("user_id", "ada");

    const response = await ingestDocument(
      new Request("https://fishmem.test/v1/documents", {
        method: "POST",
        headers: { "Idempotency-Key": `reject-${scenario.code}` },
        body: form,
      }),
      runtime,
      { requireIdempotencyKey: true },
    );

    if (!response) throw new Error("multipart rejection returned no response");
    expect(response.status).toBe(scenario.status);
    await expect(response.json()).resolves.toMatchObject({
      code: scenario.code,
    });
    expect(reserveUsage).not.toHaveBeenCalled();
  });

  it("uses the same multipart parser for the session-authenticated dashboard", async () => {
    const { engine, memory } = dependencies();
    const form = new FormData();
    form.set(
      "file",
      new File(["dashboard exact bytes"], "dashboard.txt", {
        type: "text/plain",
      }),
    );
    form.set("workspace", "ws_1");
    form.set("source_key", "dashboard/source.txt");

    const request = new Request("https://fishmem.test/api/documents", {
      method: "POST",
      body: form,
    });
    const response = await appDocumentsHandler(
      request,
      ["documents"],
      new URL(request.url),
      {} as never,
      {
        id: "dashboard-user",
        workspaces: [{ documentId: "ws_1" }],
      },
      async () => engine as never,
    );

    expect(response.status).toBe(200);
    expect(memory.ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: "dashboard/source.txt",
        content: "dashboard exact bytes",
      }),
      expect.objectContaining({ userId: "dashboard-user" }),
    );
  });

  it("reports exact project readiness without probing paid providers", async () => {
    const now = new Date("2026-07-30T12:00:00.000Z");
    const summarizeOperations = vi.fn().mockResolvedValue({
      pending: 1,
      failed: 0,
      vectorPending: 1,
      derivedPending: 0,
      oldestPendingAt: new Date("2026-07-30T11:59:00.000Z"),
    });
    const runtime = {
      authenticate: vi.fn().mockResolvedValue({
        db: {},
        apiToken: { workspaceId: "ws_1" },
      }),
      describeProvider: vi.fn().mockResolvedValue({ configured: true }),
      getEngine: vi.fn().mockResolvedValue({
        forNamespace: vi.fn().mockReturnValue({ summarizeOperations }),
      }),
      readOperationalHealth: vi.fn().mockResolvedValue({
        tasks: { pending: 0, dead: 0 },
        warningsLast24h: 2,
      }),
      now: () => now,
    } as unknown as MemoryHealthDependencies;

    const response = await getMemoryHealth(
      new Request("https://fishmem.test/v1/health"),
      runtime,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      checked_at: now.toISOString(),
      engine: { configured: true, initialized: true, code: null },
      operations: {
        pending: 1,
        failed: 0,
        oldest_pending_at: "2026-07-30T11:59:00.000Z",
      },
      tasks: { pending: 0, dead: 0, oldest_pending_at: null },
      projections: { vector_pending: 1, derived_pending: 0 },
      warnings: { last_24h: 2 },
    });
  });

  it("degrades when durable work is dead or stale", async () => {
    const runtime = {
      authenticate: vi.fn().mockResolvedValue({
        db: {},
        apiToken: { workspaceId: "ws_1" },
      }),
      describeProvider: vi.fn().mockResolvedValue({ configured: true }),
      getEngine: vi.fn().mockResolvedValue({
        forNamespace: vi.fn().mockReturnValue({
          summarizeOperations: vi.fn().mockResolvedValue({
            pending: 0,
            failed: 0,
            vectorPending: 0,
            derivedPending: 0,
          }),
        }),
      }),
      readOperationalHealth: vi.fn().mockResolvedValue({
        tasks: {
          pending: 1,
          dead: 1,
          oldestPendingAt: new Date("2026-07-30T11:00:00.000Z"),
        },
        warningsLast24h: 0,
      }),
      now: () => new Date("2026-07-30T12:00:00.000Z"),
    } as unknown as MemoryHealthDependencies;

    const response = await getMemoryHealth(
      new Request("https://fishmem.test/v1/health"),
      runtime,
    );

    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      tasks: { pending: 1, dead: 1 },
    });
  });

  it("normalizes optional idempotency keys and enforces hosted writes", () => {
    const withKey = new Request("https://fishmem.test/v1/memories", {
      headers: { "Idempotency-Key": "  command-1  " },
    });
    expect(readMutationIdempotencyKey(withKey)).toBe("command-1");

    const missing = new Request("https://fishmem.test/v1/memories");
    expect(readMutationIdempotencyKey(missing)).toBeUndefined();
    expect(() =>
      readMutationIdempotencyKey(missing, { required: true }),
    ).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_KEY_REQUIRED", status: 400 }),
    );
  });

  it("queues inferred adds without running the LLM in the request", async () => {
    const {
      auth,
      engine,
      enqueueInference,
      notifyTask,
      reserveUsage,
      runtime,
      settleUsage,
    } = dependencies();
    reserveUsage.mockResolvedValue({ credits: 2 });
    const response = await addMemories(
      new Request("https://fishmem.test/v1/memories", {
        method: "POST",
        headers: {
          authorization: "Bearer sk-test",
          "Idempotency-Key": "add-ada-tea",
        },
        body: JSON.stringify({ content: "Ada prefers tea", user_id: "ada" }),
      }),
      runtime,
    );

    expect(response).toBeInstanceOf(Response);
    if (!response) throw new Error("add route returned no response");
    expect(response.status).toBe(202);
    expect(response.headers.get("x-request-id")).toEqual(expect.any(String));
    await expect(response.json()).resolves.toMatchObject({
      event_id: "task_infer",
      status: "PENDING",
    });
    expect(enqueueInference).toHaveBeenCalledWith(
      auth.db,
      expect.objectContaining({
        command: expect.objectContaining({
          content: "Ada prefers tea",
          infer: true,
          user_id: "ada",
        }),
        derivationEnabled: true,
        idempotencyKey: "add-ada-tea",
        workspaceId: "ws_1",
        usage: expect.objectContaining({
          api_token_id: "key_1",
          credits: 2,
          version: 1,
        }),
      }),
    );
    expect(engine.forNamespace).not.toHaveBeenCalled();
    expect(settleUsage).not.toHaveBeenCalled();
    expect(notifyTask).toHaveBeenCalledWith("task_infer");
    expect(runtime.recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        credits: 2,
        httpStatus: 202,
        status: "success",
      }),
    );
  });

  it("searches only inside the authenticated workspace", async () => {
    const { engine, memory, runtime } = dependencies();
    const response = await searchMemories(
      new Request("https://fishmem.test/v1/memories/search", {
        method: "POST",
        headers: { authorization: "Bearer sk-test" },
        body: JSON.stringify({
          query: "drink",
          user_id: "ada",
          top_k: 6,
          memory_type: "preference",
          mode: "hybrid",
          search_strategy: "precision",
          sort_by: "importance",
          min_score: 0.2,
          filters: { channel: "support" },
          trace: true,
        }),
      }),
      runtime,
    );

    expect(response).toBeInstanceOf(Response);
    if (!response) throw new Error("search route returned no response");
    expect(response.status).toBe(200);
    expect(engine.forNamespace).toHaveBeenCalledWith("ws_1");
    expect(memory.search).toHaveBeenCalledWith("drink", {
      userId: "ada",
      agentId: undefined,
      runId: undefined,
      limit: 6,
      memoryType: "preference",
      mode: "hybrid",
      searchStrategy: "precision",
      sortBy: "importance",
      minScore: 0.2,
      filters: { channel: "support" },
      trace: true,
    });
    await expect(response.json()).resolves.toMatchObject({
      results: [{ id: "mem_1", memory: "Ada prefers tea", score: 0.9 }],
    });
  });

  it("compiles canonical logical filters while preserving structural scope", async () => {
    const { memory, runtime } = dependencies();
    const response = await searchMemories(
      new Request("https://fishmem.test/v1/memories/search", {
        method: "POST",
        headers: { authorization: "Bearer sk-test" },
        body: JSON.stringify({
          query: "ticket",
          user_id: "ada",
          filters: {
            and: [
              {
                field: "metadata.channel",
                operator: "eq",
                value: "support",
              },
              {
                field: "created_at",
                operator: "gte",
                value: "2026-07-01T00:00:00.000Z",
              },
              {
                not: {
                  field: "content",
                  operator: "icontains",
                  value: "resolved",
                },
              },
            ],
          },
        }),
      }),
      runtime,
    );

    expect(response).toBeInstanceOf(Response);
    if (!response) throw new Error("search route returned no response");
    expect(response.status).toBe(200);
    expect(memory.search).toHaveBeenCalledWith("ticket", {
      userId: "ada",
      agentId: undefined,
      runId: undefined,
      limit: 10,
      filter: {
        kind: "and",
        conditions: [
          {
            kind: "condition",
            field: "metadata.channel",
            operator: "eq",
            value: "support",
          },
          {
            kind: "condition",
            field: "createdAt",
            operator: "gte",
            value: new Date("2026-07-01T00:00:00.000Z"),
          },
          {
            kind: "not",
            condition: {
              kind: "condition",
              field: "content",
              operator: "icontains",
              value: "resolved",
            },
          },
        ],
      },
    });
  });

  it("queues idempotent batch mutations instead of running 1000 writes inline", async () => {
    const { auth } = dependencies();
    const enqueueTask = vi.fn().mockImplementation(
      async (
        _db,
        input: {
          workspaceId: string;
          operationId: string;
          kind: string;
          payload: Record<string, unknown>;
        },
      ) => ({
        id: "task_batch",
        documentId: "task_batch",
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: input.kind,
        status: "pending",
        payload: input.payload,
        result: null,
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date("2026-07-30T00:00:00.000Z"),
        leaseExpiresAt: null,
        error: null,
        createdAt: new Date("2026-07-30T00:00:00.000Z"),
        updatedAt: new Date("2026-07-30T00:00:00.000Z"),
      }),
    );
    const notifyTask = vi.fn().mockResolvedValue(undefined);
    const recordRequest = vi.fn().mockResolvedValue(undefined);
    const batchDependencies = {
      authenticate: vi.fn().mockResolvedValue(auth),
      enqueueTask,
      notifyTask,
      recordRequest,
    } as unknown as BatchMemoryMutationDependencies;

    const update = await batchUpdateMemories(
      new Request("https://fishmem.test/v1/memories/batch", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "batch-update-1",
        },
        body: JSON.stringify({
          memories: [
            { memory_id: "mem_1", content: "Updated one" },
            {
              memory_id: "mem_2",
              metadata: { environment: "production" },
            },
          ],
        }),
      }),
      batchDependencies,
    );
    if (!update) throw new Error("batch update route returned no response");
    expect(update.status).toBe(202);
    expect(enqueueTask).toHaveBeenLastCalledWith(auth.db, {
      workspaceId: "ws_1",
      operationId: "batch_update:batch-update-1",
      kind: "batch_update",
      payload: {
        memories: [
          { memory_id: "mem_1", content: "Updated one" },
          {
            memory_id: "mem_2",
            metadata: { environment: "production" },
          },
        ],
      },
    });
    expect(notifyTask).toHaveBeenCalledWith("task_batch");

    const deletion = await batchDeleteMemories(
      new Request("https://fishmem.test/v1/memories/batch", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "batch-delete-1",
        },
        body: JSON.stringify({
          memories: [{ memory_id: "mem_1" }, { memory_id: "mem_2" }],
        }),
      }),
      batchDependencies,
    );
    if (!deletion) throw new Error("batch delete route returned no response");
    expect(deletion.status).toBe(202);
    expect(enqueueTask).toHaveBeenLastCalledWith(auth.db, {
      workspaceId: "ws_1",
      operationId: "batch_delete:batch-delete-1",
      kind: "batch_delete",
      payload: {
        memories: [{ memory_id: "mem_1" }, { memory_id: "mem_2" }],
      },
    });
    expect(recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        httpStatus: 202,
        operation: "memories.batch_delete",
        status: "success",
      }),
    );
  });

  it("does not enqueue profile work while derivation is disabled", async () => {
    const { runtime } = dependencies();
    runtime.derivationEnabled = vi.fn().mockResolvedValue(false);
    const response = await addMemories(
      new Request("https://fishmem.test/v1/memories", {
        method: "POST",
        headers: { "Idempotency-Key": "raw-only" },
        body: JSON.stringify({
          content: "Raw fact",
          infer: false,
          user_id: "ada",
        }),
      }),
      runtime,
    );

    expect(response?.status).toBe(200);
    expect(runtime.enqueueDerivation).not.toHaveBeenCalled();
  });

  it("exports through the bound workspace facade", async () => {
    const { engine, memory } = dependencies();
    const snapshot = await exportWorkspaceSnapshot("ws_1", async () =>
      engine as never,
    );

    expect(engine.forNamespace).toHaveBeenCalledWith("ws_1");
    expect(memory.exportSnapshot).toHaveBeenCalledOnce();
    expect(snapshot).toMatchObject({
      format: "fishmem.namespace-snapshot",
      version: 1,
    });
  });

  it("strips implementation-owned belief hints at the public snapshot boundary", () => {
    const sanitized = sanitizePublicSnapshot({
      format: "fishmem.namespace-snapshot",
      version: 1,
      data: {
        memories: [
          {
            id: "mem_1",
            content: "Ada prefers tea",
            projectionHints: {
              belief: {
                evidenceKey: "forged",
                contextId: "forged",
                weight: 1,
              },
            },
          },
        ],
      },
    }) as { data: { memories: Array<Record<string, unknown>> } };

    expect(sanitized.data.memories[0]).toEqual({
      id: "mem_1",
      content: "Ada prefers tea",
    });
  });

  it("rejects an invalid idempotency key before writing", async () => {
    const { memory, runtime } = dependencies();
    const response = await addMemories(
      new Request("https://fishmem.test/v1/memories", {
        method: "POST",
        headers: {
          authorization: "Bearer sk-test",
          "Idempotency-Key": " ",
        },
        body: JSON.stringify({ content: "Ada prefers tea", user_id: "ada" }),
      }),
      runtime,
    );

    expect(response?.status).toBe(400);
    const requestId = response?.headers.get("x-request-id");
    expect(requestId).toEqual(expect.any(String));
    expect(memory.add).not.toHaveBeenCalled();
    await expect(response?.json()).resolves.toMatchObject({
      code: "INVALID_IDEMPOTENCY_KEY",
      request_id: requestId,
    });
  });

  it("returns 409 for an idempotency payload conflict", async () => {
    const {
      auth,
      enqueueInference,
      reserveUsage,
      runtime,
      settleUsage,
    } = dependencies();
    reserveUsage.mockResolvedValue({ credits: 2 });
    enqueueInference.mockRejectedValueOnce(
      new Error("idempotency key conflict: add-1 was used for a different add command"),
    );
    const response = await addMemories(
      new Request("https://fishmem.test/v1/memories", {
        method: "POST",
        headers: {
          authorization: "Bearer sk-test",
          "Idempotency-Key": "add-1",
        },
        body: JSON.stringify({ content: "different", user_id: "ada" }),
      }),
      runtime,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      request_id: expect.any(String),
    });
    expect(settleUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        auth,
        operation: "memories.add",
        outcome: "failed",
        reservation: { credits: 2 },
      }),
    );
  });

  it("routes the dashboard adapter through the same application contract", async () => {
    const { engine, enqueueInference, notifyTask } = dependencies();
    const request = new Request(
      "https://fishmem.test/api/app/memories?workspace=ws_1",
      {
        method: "POST",
        headers: { "Idempotency-Key": "dashboard-add" },
        body: JSON.stringify({ content: "Ada prefers tea", user_id: "ada" }),
      },
    );
    const response = await appMemoriesHandler(
      request,
      ["memories"],
      new URL(request.url),
      {} as never,
      { workspaces: [{ documentId: "ws_1" }] },
      async () => engine as never,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(true),
      undefined,
      {
        enqueue: enqueueInference as never,
        notify: notifyTask,
      },
    );

    expect(response.status).toBe(202);
    expect(enqueueInference).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        command: expect.objectContaining({
          content: "Ada prefers tea",
          infer: true,
          user_id: "ada",
        }),
        idempotencyKey: "dashboard-add",
        workspaceId: "ws_1",
      }),
    );
    expect(notifyTask).toHaveBeenCalledWith("task_infer");
    expect(engine.forNamespace).not.toHaveBeenCalled();
  });

  it("returns exact dashboard statistics without listing memories", async () => {
    const { engine } = dependencies();
    const statsQuery = vi.fn().mockResolvedValue({
      totalMemories: 12,
      totalEntities: 4,
    });
    const request = new Request(
      "https://fishmem.test/api/app/memories?workspace=ws_1&stats=1",
    );
    const response = await appMemoriesHandler(
      request,
      ["memories"],
      new URL(request.url),
      {} as never,
      { workspaces: [{ documentId: "ws_1" }] },
      async () => engine as never,
      undefined,
      undefined,
      undefined,
      undefined,
      statsQuery,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      totalMemories: 12,
      totalEntities: 4,
    });
    expect(statsQuery).toHaveBeenCalledWith({}, "ws_1");
    expect(engine.forNamespace).not.toHaveBeenCalled();
  });

  it("serves the governed belief audit shape through the dashboard adapter", async () => {
    const { engine, memory } = dependencies();
    const request = new Request(
      "https://fishmem.test/api/app/memories/beliefs?workspace=ws_1&user_id=ada&subject=Ada&attribute=editor_theme&view=audit",
    );
    const response = await appMemoriesHandler(
      request,
      ["memories", "beliefs"],
      new URL(request.url),
      {} as never,
      { workspaces: [{ documentId: "ws_1" }] },
      async () => engine as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        projection_status: "ready",
        winner: {
          id: "belief_1",
          evidence: [
            {
              source_id: "mem_1",
              applicability: { kind: "project", key: "ws_1" },
              active: true,
            },
          ],
        },
        shadow: { outcome: "belief_only", winner_id: "belief_1" },
      },
    });
    expect(memory.getBeliefView).toHaveBeenCalledWith(
      "Ada",
      "editor_theme",
      expect.objectContaining({ userId: "ada", mode: "audit" }),
    );
  });

  it("serves dashboard scope entities from the canonical application", async () => {
    const { engine, memory } = dependencies();
    const request = new Request(
      "https://fishmem.test/api/app/entities?workspace=ws_1&type=user",
    );
    const response = await appEntitiesHandler(
      request,
      ["entities"],
      new URL(request.url),
      {} as never,
      { workspaces: [{ documentId: "ws_1" }] },
      async () => engine as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        results: [{ id: "ada", type: "user", total_memories: 2 }],
      },
    });
    expect(memory.listScopeEntities).toHaveBeenCalledWith({
      type: "user",
      cursor: undefined,
      limit: 51,
    });
  });

  it("releases dashboard inference authorization when enqueue conflicts", async () => {
    const { engine } = dependencies();
    const release = vi.fn().mockResolvedValue(undefined);
    const authorize = vi.fn().mockResolvedValue({ release });
    const enqueue = vi
      .fn()
      .mockRejectedValue(
        new Error("idempotency key conflict: dashboard-add was reused"),
      );
    const request = new Request(
      "https://fishmem.test/api/app/memories?workspace=ws_1",
      {
        method: "POST",
        headers: { "Idempotency-Key": "dashboard-add" },
        body: JSON.stringify({ content: "Ada prefers tea", user_id: "ada" }),
      },
    );

    const response = await appMemoriesHandler(
      request,
      ["memories"],
      new URL(request.url),
      {} as never,
      { id: "user_1", workspaces: [{ documentId: "ws_1" }] },
      async () => engine as never,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(true),
      undefined,
      {
        authorize,
        enqueue: enqueue as never,
        notify: vi.fn(),
      },
    );

    expect(response.status).toBe(409);
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "dashboard-add",
        workspaceId: "ws_1",
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps distilled dashboard writes synchronous", async () => {
    const { engine, memory } = dependencies();
    const request = new Request(
      "https://fishmem.test/api/app/memories?workspace=ws_1",
      {
        method: "POST",
        body: JSON.stringify({
          content: "Ada prefers tea",
          infer: false,
          user_id: "ada",
        }),
      },
    );

    const response = await appMemoriesHandler(
      request,
      ["memories"],
      new URL(request.url),
      {} as never,
      { workspaces: [{ documentId: "ws_1" }] },
      async () => engine as never,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(false),
    );

    expect(response.status).toBe(200);
    expect(memory.add).toHaveBeenCalledWith("Ada prefers tea", {
      userId: "ada",
      agentId: undefined,
      runId: undefined,
      infer: false,
      idempotencyKey: undefined,
      metadata: undefined,
    });
  });

  it("searches the authenticated dashboard workspace without weakening public scope rules", async () => {
    const { engine, memory } = dependencies();
    const request = new Request(
      "https://fishmem.test/api/app/memories?workspace=ws_1&query=tea&limit=200",
    );

    const response = await appMemoriesHandler(
      request,
      ["memories"],
      new URL(request.url),
      {} as never,
      { workspaces: [{ documentId: "ws_1" }] },
      async () => engine as never,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(false),
    );

    expect(response.status).toBe(200);
    expect(memory.search).toHaveBeenCalledWith("tea", {
      limit: 50,
    });
    await expect(response.json()).resolves.toMatchObject({
      results: [{ id: "mem_1", memory: "Ada prefers tea", score: 0.9 }],
    });
  });

  it("queues dashboard bulk deletion as one durable operation", async () => {
    const { engine } = dependencies();
    const enqueue = vi.fn().mockImplementation(
      async (
        _db,
        input: {
          workspaceId: string;
          operationId: string;
          kind: string;
          payload: Record<string, unknown>;
        },
      ) => ({
        id: "task_dashboard_batch",
        documentId: "task_dashboard_batch",
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: input.kind,
        status: "pending",
        payload: input.payload,
        result: null,
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date("2026-07-30T00:00:00.000Z"),
        leaseExpiresAt: null,
        error: null,
        createdAt: new Date("2026-07-30T00:00:00.000Z"),
        updatedAt: new Date("2026-07-30T00:00:00.000Z"),
      }),
    );
    const notify = vi.fn().mockResolvedValue(undefined);
    const request = new Request(
      "https://fishmem.test/api/app/memories/batch?workspace=ws_1",
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "dashboard-delete-1",
        },
        body: JSON.stringify({
          memories: [{ memory_id: "mem_1" }, { memory_id: "mem_2" }],
        }),
      },
    );

    const response = await appMemoriesHandler(
      request,
      ["memories", "batch"],
      new URL(request.url),
      {} as never,
      { workspaces: [{ documentId: "ws_1" }] },
      async () => engine as never,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(true),
      {
        enqueue: enqueue as never,
        notify,
      },
    );

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(
      {},
      {
        workspaceId: "ws_1",
        operationId: "batch_delete:dashboard-delete-1",
        kind: "batch_delete",
        payload: {
          memories: [{ memory_id: "mem_1" }, { memory_id: "mem_2" }],
        },
      },
    );
    expect(notify).toHaveBeenCalledWith("task_dashboard_batch");
    await expect(response.json()).resolves.toMatchObject({
      data: {
        id: "task_dashboard_batch",
        kind: "batch_delete",
        status: "pending",
      },
    });
  });
});
