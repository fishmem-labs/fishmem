import { describe, expect, it } from "vitest";
import {
  AddMemoryCommandSchema,
  AddMemoryResponseSchema,
  ApiErrorSchema,
  ApplicabilityContextSchema,
  AsyncMemoryReceiptSchema,
  BatchDeleteMemoriesCommandSchema,
  BatchUpdateMemoriesCommandSchema,
  BeliefQuerySchema,
  BeliefResponseSchema,
  ClearMemoryFeedbackResponseSchema,
  DeleteDocumentResponseSchema,
  DeleteMemoriesResponseSchema,
  DeleteMemoryResponseSchema,
  DeleteScopeEntityResponseSchema,
  DocumentContentSchema,
  DocumentPageSchema,
  HealthResponseSchema,
  IdempotencyKeySchema,
  IngestDocumentCommandSchema,
  IngestDocumentResponseSchema,
  ListScopeEntitiesQuerySchema,
  MemoryEventPageSchema,
  MemoryEventSchema,
  MemoryFeedbackResponseSchema,
  MemoryFilterExpressionSchema,
  MemoryHistoryResponseSchema,
  MemoryPageSchema,
  OperationPageSchema,
  OperationSchema,
  openApiDocument,
  ProfileResponseSchema,
  ScopeEntityPageSchema,
  SearchDocumentCommandSchema,
  SearchDocumentResponseSchema,
  SearchMemoryCommandSchema,
  SearchMemoryResponseSchema,
  SetMemoryFeedbackCommandSchema,
  StateHistoryResponseSchema,
  StateResponseSchema,
  UpdateMemoryResponseSchema,
  WorkspaceSearchMemoryCommandSchema,
} from "../src/index";

describe("canonical API contracts", () => {
  it("accepts canonical add/search commands", () => {
    expect(
      AddMemoryCommandSchema.parse({
        content: "fact",
        user_id: "user",
        event_date: "2026-07-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      content: "fact",
      infer: true,
      event_date: "2026-07-01T00:00:00.000Z",
    });
    expect(
      SearchMemoryCommandSchema.parse({ query: "fact", user_id: "user" }),
    ).toMatchObject({ trace: false });
    expect(
      WorkspaceSearchMemoryCommandSchema.parse({ query: "fact" }),
    ).toMatchObject({ trace: false });
    expect(
      SearchMemoryCommandSchema.parse({
        query: "fact",
        user_id: "user",
        memory_type: "preference",
        mode: "hybrid",
        search_strategy: "precision",
        sort_by: "importance",
        min_score: 0.25,
        filters: { environment: "production", active: true },
      }),
    ).toMatchObject({
      memory_type: "preference",
      search_strategy: "precision",
      filters: { environment: "production", active: true },
    });
  });

  it("sanitizes untrusted belief-write metadata and validates query controls", () => {
    const sanitized = AddMemoryCommandSchema.parse({
      content: "Ada prefers dark mode",
      user_id: "ada",
      applicability: { kind: "global" },
      evidence_key: "forged-independent-source",
      evidence_context_id: "forged-context",
      evidence_weight: 1,
    });
    expect(sanitized).not.toHaveProperty("applicability");
    expect(sanitized).not.toHaveProperty("evidence_key");
    expect(sanitized).not.toHaveProperty("evidence_context_id");
    expect(sanitized).not.toHaveProperty("evidence_weight");
    expect(ApplicabilityContextSchema.parse({ kind: "global" })).toEqual({
      kind: "global",
    });
    expect(() =>
      ApplicabilityContextSchema.parse({ kind: "global", key: "invalid" }),
    ).toThrow("must not include a key");
    expect(() => ApplicabilityContextSchema.parse({ kind: "project" })).toThrow(
      "requires a key",
    );

    expect(
      BeliefQuerySchema.parse({
        user_id: "ada",
        subject: "Ada",
        attribute: "theme",
        view: "audit",
        all_applicability: "true",
      }),
    ).toMatchObject({ view: "audit", all_applicability: true });
    expect(() =>
      BeliefQuerySchema.parse({
        user_id: "ada",
        subject: "Ada",
        attribute: "theme",
        all_applicability: "true",
      }),
    ).toThrow("only for audit view");
  });

  it("preserves verbatim raw content while rejecting blank input", () => {
    const content = "  Keep this spacing exactly.\\n";
    expect(
      AddMemoryCommandSchema.parse({
        content,
        user_id: "user",
        infer: false,
      }).content,
    ).toBe(content);
    expect(() =>
      AddMemoryCommandSchema.parse({
        content: " \n\t ",
        user_id: "user",
        infer: false,
      }),
    ).toThrow();
  });

  it("rejects missing scope and malformed idempotency keys", () => {
    expect(() => AddMemoryCommandSchema.parse({ content: "fact" })).toThrow();
    expect(() =>
      AddMemoryCommandSchema.parse({
        content: "fact",
        user_id: "user",
        event_date: "last July",
      }),
    ).toThrow();
    expect(() => SearchMemoryCommandSchema.parse({ query: "fact" })).toThrow();
    expect(() =>
      SearchMemoryCommandSchema.parse({
        query: "fact",
        user_id: "user",
        mode: "deep",
      }),
    ).toThrow();
    expect(() =>
      SearchMemoryCommandSchema.parse({
        query: "fact",
        user_id: "user",
        filters: { nested: { unsafe: true } },
      }),
    ).toThrow();
    expect(() =>
      SearchMemoryCommandSchema.parse({
        query: "fact",
        user_id: "user",
        min_score: 1.1,
      }),
    ).toThrow();
    expect(() => IdempotencyKeySchema.parse(" ")).toThrow();
    expect(() => IdempotencyKeySchema.parse("x".repeat(201))).toThrow();
  });

  it("validates bounded advanced filters without mixing structural scope", () => {
    const filters = {
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
    };
    expect(MemoryFilterExpressionSchema.parse(filters)).toEqual(filters);
    expect(
      SearchMemoryCommandSchema.parse({
        query: "ticket",
        user_id: "ada",
        filters,
      }).filters,
    ).toEqual(filters);
    expect(() =>
      MemoryFilterExpressionSchema.parse({
        field: "user_id",
        operator: "eq",
        value: "someone-else",
      }),
    ).toThrow();
    expect(() =>
      MemoryFilterExpressionSchema.parse({
        field: "metadata.__proto__.admin",
        operator: "eq",
        value: true,
      }),
    ).toThrow("unsafe metadata filter path");
    expect(() =>
      MemoryFilterExpressionSchema.parse({
        field: "created_at",
        operator: "gte",
        value: "yesterday",
      }),
    ).toThrow("ISO date strings");
    expect(() =>
      MemoryFilterExpressionSchema.parse({
        field: "metadata.channel",
        operator: "in",
        value: "support",
      }),
    ).toThrow("requires a non-empty value array");
    expect(() =>
      MemoryFilterExpressionSchema.parse({
        field: "content",
        operator: "gte",
        value: "ticket",
      }),
    ).toThrow("is not supported for content");
    expect(() =>
      MemoryFilterExpressionSchema.parse({
        field: "importance",
        operator: "icontains",
        value: "high",
      }),
    ).toThrow("is not supported for importance");
  });

  it("accepts bounded batch mutations and rejects ambiguous duplicates", () => {
    expect(
      BatchUpdateMemoriesCommandSchema.parse({
        memories: [
          { memory_id: "mem_1", content: "Updated" },
          {
            memory_id: "mem_2",
            metadata: { source: "support" },
            version: "2026-07-30T00:00:00.000Z",
          },
        ],
      }).memories,
    ).toHaveLength(2);
    expect(
      BatchDeleteMemoriesCommandSchema.parse({
        memories: [{ memory_id: "mem_1" }, { memory_id: "mem_2" }],
      }).memories,
    ).toHaveLength(2);
    expect(() =>
      BatchUpdateMemoriesCommandSchema.parse({
        memories: [
          { memory_id: "mem_1", content: "First" },
          { memory_id: "mem_1", content: "Second" },
        ],
      }),
    ).toThrow("memory_id must be unique");
    expect(() =>
      BatchDeleteMemoriesCommandSchema.parse({ memories: [] }),
    ).toThrow();
  });

  it("publishes bounded native memory feedback contracts", () => {
    expect(
      SetMemoryFeedbackCommandSchema.parse({
        rating: "negative",
        reason: "Out of date",
        request_id: "req_1",
      }),
    ).toEqual({
      rating: "negative",
      reason: "Out of date",
      request_id: "req_1",
    });
    expect(() =>
      SetMemoryFeedbackCommandSchema.parse({ rating: "VERY_NEGATIVE" }),
    ).toThrow();
    expect(MemoryFeedbackResponseSchema.parse({ feedback: null })).toEqual({
      feedback: null,
    });
    expect(ClearMemoryFeedbackResponseSchema.parse({ cleared: false })).toEqual(
      { cleared: false },
    );
  });

  it("publishes bounded structural scope-entity contracts", () => {
    expect(ListScopeEntitiesQuerySchema.parse({ type: "user" })).toEqual({
      type: "user",
      limit: 50,
    });
    expect(() => ListScopeEntitiesQuerySchema.parse({ type: "app" })).toThrow();
    expect(
      ScopeEntityPageSchema.parse({
        results: [
          {
            id: "ada",
            type: "user",
            total_memories: 2,
            created_at: "2026-07-01T00:00:00.000Z",
            updated_at: "2026-07-02T00:00:00.000Z",
          },
        ],
        next_cursor: null,
      }).results[0],
    ).toMatchObject({ id: "ada", total_memories: 2 });
    expect(
      DeleteScopeEntityResponseSchema.parse({
        id: "ada",
        type: "user",
        deleted_memories: 2,
      }),
    ).toMatchObject({ deleted_memories: 2 });
  });

  it("publishes every product-surface endpoint", () => {
    expect(Object.keys(openApiDocument.paths)).toEqual(
      expect.arrayContaining([
        "/v1/health",
        "/v1/documents",
        "/v1/documents/{id}/content",
        "/v1/memories",
        "/v1/memories/{id}/feedback",
        "/v1/entities",
        "/v1/entities/{type}/{id}",
        "/v1/events",
        "/v1/events/{id}",
        "/v1/operations/{id}",
        "/v1/operations/{id}/retry",
        "/v1/state",
        "/v1/beliefs",
        "/v1/profile",
      ]),
    );
    expect(openApiDocument.security).toEqual([{ bearerAuth: [] }]);
    const operationIds: string[] = [];
    for (const path of Object.values(openApiDocument.paths)) {
      for (const [method, operation] of Object.entries(path)) {
        if (method === "parameters") continue;
        expect(operation).toHaveProperty("operationId");
        operationIds.push(operation.operationId);
        expect(
          Object.keys(operation.responses).some((status) =>
            status.startsWith("2"),
          ),
        ).toBe(true);
        expect(operation).toHaveProperty("responses.401");
        expect(operation).toHaveProperty("responses.403");
        expect(operation).toHaveProperty("responses.429");
      }
    }
    expect(operationIds.sort()).toEqual(
      [
        "addMemory",
        "batchDeleteMemories",
        "batchUpdateMemories",
        "clearMemoryFeedback",
        "completeDocumentUpload",
        "createDocumentUpload",
        "createExport",
        "createImport",
        "deleteMemories",
        "deleteDocument",
        "deleteDocumentUpload",
        "getDocument",
        "getDocumentContent",
        "getDocumentUpload",
        "deleteMemory",
        "deleteScopeEntity",
        "getMemory",
        "getMemoryEvent",
        "getMemoryFeedback",
        "getMemoryHistory",
        "getHealth",
        "getBeliefView",
        "getOperation",
        "getScopeEntity",
        "getProfile",
        "getState",
        "getStateHistory",
        "listMemories",
        "listMemoryEvents",
        "listDocuments",
        "listOperations",
        "listScopeEntities",
        "putDocumentUploadContent",
        "retryOperation",
        "searchMemories",
        "searchDocuments",
        "setMemoryFeedback",
        "ingestDocument",
        "updateMemory",
      ].sort(),
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(openApiDocument.components.schemas.Memory).toHaveProperty(
      "properties.id",
    );
    expect(openApiDocument.components.schemas.ApiError).toHaveProperty(
      "required",
    );
    expect(openApiDocument.components.schemas.Document).toHaveProperty(
      "properties.content_hash",
    );
    const internalRefs: string[] = [];
    const collectInternalRefs = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const item of value) collectInternalRefs(item);
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (
          key === "$ref" &&
          typeof child === "string" &&
          child.startsWith("#/")
        ) {
          internalRefs.push(child);
        } else {
          collectInternalRefs(child);
        }
      }
    };
    collectInternalRefs(openApiDocument);
    for (const reference of internalRefs) {
      const target = reference
        .slice(2)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
        .reduce<unknown>((value, segment) => {
          if (!value || typeof value !== "object") return undefined;
          return (value as Record<string, unknown>)[segment];
        }, openApiDocument);
      expect(
        target,
        `Unresolved OpenAPI reference: ${reference}`,
      ).toBeDefined();
    }
    const documentIngest = openApiDocument.paths["/v1/documents"].post;
    expect(Object.keys(documentIngest.requestBody.content)).toEqual(
      expect.arrayContaining(["application/json", "multipart/form-data"]),
    );
    expect(
      documentIngest.requestBody.content["multipart/form-data"],
    ).toHaveProperty("schema.properties.file.format", "binary");
  });

  it("validates every stable success and error envelope", () => {
    const now = "2026-07-30T00:00:00.000Z";
    const memory = {
      id: "mem_1",
      memory: "Ada prefers tea",
      memory_type: "fact",
      importance: 0.7,
      user_id: "ada",
      agent_id: null,
      run_id: null,
      metadata: null,
      created_at: now,
      updated_at: now,
      event_date: null,
      valid_from: null,
      valid_to: null,
    };
    const addResult = {
      id: "mem_1",
      memory: "Ada prefers tea",
      event: "ADD" as const,
    };
    const operation = {
      id: "op_1",
      kind: "add" as const,
      status: "committed" as const,
      attempts: 1,
      error: null,
      created_at: now,
      updated_at: now,
    };
    const state = {
      id: "state_1",
      subject: "Ada",
      attribute: "drink",
      value: "tea",
      valid_from: now,
      valid_to: null,
      superseded_by: null,
      source_ids: ["mem_1"],
    };

    expect(
      AddMemoryResponseSchema.parse({ results: [addResult] }),
    ).toBeTruthy();
    expect(
      AsyncMemoryReceiptSchema.parse({
        message: "Memory inference accepted",
        status: "PENDING",
        event_id: "task_1",
      }),
    ).toBeTruthy();
    const event = {
      id: "task_1",
      event_type: "ADD" as const,
      status: "SUCCEEDED" as const,
      scope: { user_id: "ada" },
      results: [addResult],
      write_summary: {
        outcome: "STORED" as const,
        planned: 1,
        persisted: 1,
        failed: 0,
      },
      attempts: 1,
      max_attempts: 5,
      error: null,
      created_at: now,
      updated_at: now,
      started_at: now,
      completed_at: now,
      latency_ms: 10,
    };
    expect(MemoryEventSchema.parse(event)).toBeTruthy();
    expect(
      MemoryEventSchema.safeParse({
        ...event,
        write_summary: { ...event.write_summary, persisted: 0 },
      }).success,
    ).toBe(false);
    expect(
      AddMemoryResponseSchema.safeParse({
        results: [addResult, addResult],
      }).success,
    ).toBe(false);
    expect(
      MemoryEventPageSchema.parse({
        results: [event],
        next_cursor: null,
      }),
    ).toBeTruthy();
    expect(UpdateMemoryResponseSchema.parse(addResult)).toBeTruthy();
    expect(
      DeleteMemoryResponseSchema.parse({ id: "mem_1", deleted: true }),
    ).toBeTruthy();
    expect(DeleteMemoriesResponseSchema.parse({ deleted: 1 })).toBeTruthy();
    expect(
      MemoryPageSchema.parse({ results: [memory], next_cursor: null }),
    ).toBeTruthy();
    expect(
      SearchMemoryResponseSchema.parse({ results: [memory] }),
    ).toBeTruthy();
    expect(
      MemoryHistoryResponseSchema.parse({
        results: [
          {
            id: "history_1",
            memory_id: "mem_1",
            event: "ADD",
            previous_value: null,
            new_value: "Ada prefers tea",
            created_at: now,
          },
        ],
      }),
    ).toBeTruthy();
    expect(OperationSchema.parse(operation)).toBeTruthy();
    expect(OperationPageSchema.parse({ results: [operation] })).toBeTruthy();
    expect(
      HealthResponseSchema.parse({
        status: "ok",
        checked_at: now,
        engine: { configured: true, initialized: true, code: null },
        operations: {
          pending: 0,
          failed: 0,
          oldest_pending_at: null,
        },
        tasks: { pending: 0, dead: 0, oldest_pending_at: null },
        projections: { vector_pending: 0, derived_pending: 0 },
        warnings: { last_24h: 0 },
      }),
    ).toBeTruthy();
    expect(StateResponseSchema.parse({ data: state })).toBeTruthy();
    expect(StateHistoryResponseSchema.parse({ data: [state] })).toBeTruthy();
    expect(
      BeliefResponseSchema.parse({
        data: {
          projection_status: "ready",
          mode: "conflict",
          subject: "Ada",
          attribute: "drink",
          applicability: { kind: "project", key: "fishmem" },
          winner: {
            id: "belief_tea",
            subject: "Ada",
            attribute: "drink",
            value: "tea",
            applicability: { kind: "project", key: "fishmem" },
            status: "supported",
            score: 3,
            support: 0.75,
            evidence_count: 3,
            context_count: 3,
            source_ids: ["mem_1", "mem_2", "mem_3"],
            first_observed_at: now,
            last_observed_at: now,
            superseded_by: null,
            reason_codes: ["minimum_evidence_met"],
          },
          candidates: [],
          unresolved: false,
          reason_codes: ["supported_winner"],
          shadow: {
            outcome: "agreement",
            state,
            winner_id: "belief_tea",
          },
        },
      }),
    ).toBeTruthy();
    expect(ProfileResponseSchema.parse({ data: null })).toBeTruthy();
    const document = {
      id: "doc_1",
      source_key: "docs/guide.md",
      content_hash: "a".repeat(64),
      version_hash: "b".repeat(64),
      title: "Guide",
      mime_type: "text/markdown",
      source_uri: null,
      user_id: "ada",
      agent_id: null,
      run_id: null,
      metadata: null,
      size_bytes: 10,
      created_at: now,
    };
    expect(
      IngestDocumentCommandSchema.parse({
        source_key: "docs/guide.md",
        content: "exact text",
        user_id: "ada",
      }),
    ).toMatchObject({ source_key: "docs/guide.md", user_id: "ada" });
    expect(
      SearchDocumentCommandSchema.parse({
        query: "exact",
        user_id: "ada",
      }),
    ).toMatchObject({ limit: 5, neighbors: 1 });
    expect(
      IngestDocumentResponseSchema.parse({
        document,
        chunks: 1,
        created: true,
      }),
    ).toBeTruthy();
    expect(
      DocumentPageSchema.parse({ results: [document], next_cursor: null }),
    ).toBeTruthy();
    expect(
      SearchDocumentResponseSchema.parse({
        results: [
          {
            document,
            chunk: {
              id: "chunk_1",
              document_id: "doc_1",
              source_key: "docs/guide.md",
              index: 0,
              content: "exact text",
              start_byte: 0,
              end_byte: 10,
              content_hash: "c".repeat(8),
            },
            neighbors: [],
            score: 1,
          },
        ],
      }),
    ).toBeTruthy();
    expect(
      DocumentContentSchema.parse({
        id: "doc_1",
        content: "exact text",
        content_hash: "a".repeat(64),
      }),
    ).toBeTruthy();
    expect(
      DeleteDocumentResponseSchema.parse({
        id: "doc_1",
        deleted: true,
        versions: 1,
        chunks: 1,
      }),
    ).toBeTruthy();
    expect(
      ApiErrorSchema.parse({
        code: "MEMORY_NOT_FOUND",
        message: "Memory not found",
        request_id: "req_1",
      }),
    ).toBeTruthy();
  });
});
