import { describe, expect, it } from "vitest";
import { type MemoryWarning, resolveProviders } from "../src/config.js";
import type { Embedder } from "../src/embeddings/base.js";
import { CenteredEmbedder } from "../src/embeddings/centered.js";
import { MockEmbedder } from "../src/embeddings/mock.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import * as api from "../src/index.js";
import type { LLM } from "../src/llms/base.js";
import { MockLLM } from "../src/llms/mock.js";
import { Memory } from "../src/memory.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";

describe("public API contract", () => {
  it("exports the derivation-era API and does not re-export removed update prompts", () => {
    expect(api.Memory).toBe(Memory);
    expect(api.buildExtractionMessages).toBeTypeOf("function");
    expect(api.FACT_EXTRACTION_SYSTEM).toContain("FISHMEM_TASK: extract");
    expect(api.FACT_EXTRACTION_SYSTEM).toContain("extract EVERY distinct fact");
    expect(api.FACT_EXTRACTION_SYSTEM).not.toContain(
      'must also include "value"',
    );
    expect(api.BELIEF_FACT_EXTRACTION_SYSTEM).toContain(
      'must also include "value"',
    );
    expect(api.SELECTIVE_FACT_EXTRACTION_SYSTEM).toContain(
      "The user's memory controls have highest priority",
    );
    expect(api.SELECTIVE_FACT_EXTRACTION_SYSTEM).toContain(
      "Never emit\n   credentials",
    );
    expect(api.SELECTIVE_FACT_EXTRACTION_SYSTEM).toContain(
      "Assistant claims are not user facts",
    );
    expect(api.SELECTIVE_FACT_EXTRACTION_SYSTEM).toContain(
      "summarize/rewrite/translate payloads are source",
    );
    expect(api.SELECTIVE_FACT_EXTRACTION_SYSTEM).toContain(
      "An explicit self-identification",
    );
    expect(api.SELECTIVE_FACT_EXTRACTION_SYSTEM).toContain(
      'Resolve "I" from its message role',
    );
    expect(api.SELECTIVE_FACT_EXTRACTION_SYSTEM).toContain(
      "Current-turn filter",
    );
    expect(api.SELECTIVE_FACT_EXTRACTION_SYSTEM).not.toContain(
      "extract EVERY distinct fact",
    );
    expect("buildUpdateMessages" in api).toBe(false);
    expect("UPDATE_MEMORY_SYSTEM" in api).toBe(false);
  });
});

describe("resolveProviders", () => {
  it("builds explicit mock providers without environment-dependent fallbacks", async () => {
    const providers = await resolveProviders({
      embedder: { provider: "mock", config: { dimensions: 7 } },
      llm: { provider: "mock" },
      vectorStore: { provider: "memory" },
      graphStore: { provider: "memory" },
    });

    expect(providers.embedder).toBeInstanceOf(MockEmbedder);
    expect(providers.embedder.dimensions).toBe(7);
    expect(providers.llm).toBeInstanceOf(MockLLM);
    expect(providers.vectorStore).toBeInstanceOf(InMemoryVectorStore);
    expect(providers.graphStore).toBeInstanceOf(InMemoryGraphStore);
  });

  it("wraps mock embedders with centering when requested", async () => {
    const providers = await resolveProviders({
      embedder: {
        provider: "mock",
        config: { dimensions: 5 },
        centering: true,
      },
      llm: { provider: "mock" },
      vectorStore: { provider: "memory" },
      graphStore: { provider: "memory" },
    });

    expect(providers.embedder).toBeInstanceOf(CenteredEmbedder);
    expect(providers.embedder.dimensions).toBe(5);
  });

  it("preserves caller-supplied provider instances", async () => {
    const embedder: Embedder = new MockEmbedder(3);
    const llm: LLM = new MockLLM();
    const vectorStore = new InMemoryVectorStore();
    const graphStore = new InMemoryGraphStore();

    const providers = await resolveProviders({
      embedder,
      llm,
      vectorStore,
      graphStore,
    });

    expect(providers.embedder).toBe(embedder);
    expect(providers.llm).toBe(llm);
    expect(providers.vectorStore).toBe(vectorStore);
    expect(providers.graphStore).toBe(graphStore);
  });

  it("rejects missing providers instead of silently selecting mocks", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      await expect(resolveProviders()).rejects.toThrow(
        "No embedder configured",
      );
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    }
  });
});

describe("Memory.create declarative config", () => {
  it("initializes from provider specs and runs canonical inference by default", async () => {
    const memory = await Memory.create({
      embedder: { provider: "mock", config: { dimensions: 16 } },
      llm: { provider: "mock" },
      vectorStore: { provider: "memory" },
      graphStore: { provider: "memory" },
    });

    const added = await memory.add("Sam likes tea", { userId: "u1" });
    expect(added.results).toHaveLength(1);
    expect(added.results[0]!.memory).toBe("Sam likes tea");
    expect((await memory.getAll({ userId: "u1" })).results[0]?.content).toBe(
      "Sam likes tea",
    );
    expect(
      await memory.getState("Sam", "preference", { userId: "u1" }),
    ).toBeUndefined();
  });

  it("routes pgvector performance warnings through top-level onWarning", async () => {
    const warnings: MemoryWarning[] = [];
    const pool = {
      async query(sql: string): Promise<{ rows: unknown[] }> {
        if (sql.includes("USING ivfflat")) {
          throw new Error("ivfflat unavailable");
        }
        return { rows: [] };
      },
    };

    await Memory.create({
      embedder: { provider: "mock", config: { dimensions: 16 } },
      llm: { provider: "mock" },
      vectorStore: {
        provider: "pgvector",
        config: { pool, tableName: "fishmem_config_vectors" },
      },
      graphStore: { provider: "memory" },
      onWarning: (warning) => warnings.push(warning),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "pgvector_ivfflat_index_failed",
      recoverable: true,
      context: { tableName: "fishmem_config_vectors", dimensions: 16 },
    });
  });
});
