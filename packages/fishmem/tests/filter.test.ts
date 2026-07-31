import { describe, expect, it } from "vitest";
import { matchesMemoryFilter } from "../src/core/filter.js";
import { MockEmbedder } from "../src/embeddings/mock.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import { MockLLM } from "../src/llms/mock.js";
import { Memory } from "../src/memory.js";
import type { Memory as MemoryRecord } from "../src/types.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "memory-1",
    content: "Priority support ticket for Ada",
    memoryType: "observation",
    importance: 0.8,
    namespaceId: "workspace-a",
    userId: "ada",
    metadata: {
      channel: "support",
      labels: ["vip", "billing"],
      source: { system: "zendesk" },
    },
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    eventDate: new Date("2026-06-30T00:00:00.000Z"),
    lastAccessedAt: new Date("2026-07-03T00:00:00.000Z"),
    accessCount: 2,
    forgotten: false,
    ...overrides,
  };
}

describe("canonical memory filter", () => {
  it("evaluates nested logic, dates, arrays, and nested metadata deterministically", () => {
    const memory = record();
    expect(
      matchesMemoryFilter(memory, {
        kind: "and",
        conditions: [
          {
            kind: "condition",
            field: "metadata.source.system",
            operator: "eq",
            value: "zendesk",
          },
          {
            kind: "condition",
            field: "metadata.labels",
            operator: "contains",
            value: "vip",
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
      }),
    ).toBe(true);
    expect(
      matchesMemoryFilter(memory, {
        kind: "condition",
        field: "subject",
        operator: "exists",
        value: false,
      }),
    ).toBe(true);
  });

  it("always ANDs the advanced predicate with structural scope", async () => {
    const engine = await Memory.create({
      embedder: new MockEmbedder(32),
      graphStore: new InMemoryGraphStore(),
      llm: new MockLLM(),
      vectorStore: new InMemoryVectorStore(),
    });
    const memories = engine.forNamespace("workspace-a");
    const ada = await memories.add("Ada support ticket", {
      infer: false,
      userId: "ada",
      metadata: { channel: "support", priority: 9 },
    });
    await memories.add("Bob support ticket", {
      infer: false,
      userId: "bob",
      metadata: { channel: "support", priority: 10 },
    });
    await memories.add("Ada sales note", {
      infer: false,
      userId: "ada",
      metadata: { channel: "sales", priority: 10 },
    });

    const filter = {
      kind: "and" as const,
      conditions: [
        {
          kind: "condition" as const,
          field: "metadata.channel" as const,
          operator: "eq" as const,
          value: "support",
        },
        {
          kind: "condition" as const,
          field: "metadata.priority" as const,
          operator: "gte" as const,
          value: 8,
        },
      ],
    };
    const listed = await memories.getAll({ userId: "ada", filter });
    expect(listed.results.map((memory) => memory.id)).toEqual([
      ada.results[0]!.id,
    ]);
    const searched = await memories.search("ticket", {
      userId: "ada",
      mode: "recent",
      filter,
    });
    expect(searched.results.map((result) => result.memory.id)).toEqual([
      ada.results[0]!.id,
    ]);
  });
});
