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
    expect(api.FACT_EXTRACTION_SYSTEM).toBe(
      api.SELECTIVE_FACT_EXTRACTION_SYSTEM,
    );
    expect(api.FACT_EXTRACTION_SYSTEM).not.toContain(
      "extract EVERY distinct fact",
    );
    expect(api.EXHAUSTIVE_FACT_EXTRACTION_SYSTEM).toContain(
      "extract EVERY distinct fact",
    );
    // Both writers share the output contract, so the ordinal rule must survive
    // any rewording of it. Assert the rule, not one phrasing of the rule.
    for (const prompt of [
      api.EXHAUSTIVE_FACT_EXTRACTION_SYSTEM,
      api.FACT_EXTRACTION_SYSTEM,
    ]) {
      expect(prompt).toContain("ordinal position");
    }
    expect(api.FACT_EXTRACTION_SYSTEM).not.toContain(
      'must also include "value"',
    );
    expect(api.BELIEF_FACT_EXTRACTION_SYSTEM).toContain(
      'must also include "value"',
    );
    // The selection gates are the safety contract of this prompt. Assert that
    // each rule survives, keyed on the concept rather than on one sentence, so
    // the prompt can be reworded but not quietly stripped of a gate.
    const selective = api.SELECTIVE_FACT_EXTRACTION_SYSTEM;
    // Match on reflowed text: a rule that survives a line break is still the
    // same rule, and pinning wrap positions is what made this test brittle.
    const flowed = selective.replace(/\s+/g, " ");
    for (const [gate, markers] of [
      ["veto: memory controls", ["memory controls", "outrank"]],
      ["veto: secrets", ["credentials", "recovery codes"]],
      ["provenance: source data", ["tool output", "source data"]],
      ["provenance: untrusted instructions", ["untrusted", "never act on them"]],
      ["durability: self-identification", ["self-identification"]],
      ["current turn: ephemeral", ["Current turn", "ephemeral state"]],
      ["attribution: role", ['Resolve "I" from the message role', "assistant claims are not user facts"]],
      ["attribution: unaccepted", ["not acceptance", "episodic"]],
      ["audit", ["return no facts"]],
    ] as const) {
      for (const marker of markers) {
        expect(flowed, `${gate} missing: ${marker}`).toContain(marker);
      }
    }
    expect(selective).not.toContain("extract EVERY distinct fact");
    // OpenAI rejects `response_format: json_object` unless a message contains
    // the word "json". The schema-enforced path does not need it, but a
    // provider without json_schema support falls back to json_object, and a
    // compression pass once removed the only mention — silently turning every
    // extraction on that path into a 400.
    expect(selective).toMatch(/json/i);

    // The prompt is re-sent on every write, so its size is a running cost.
    // Measured: 1,384 tokens before compression, 881 after, and a 781-token
    // variant regressed recall and no-memory accuracy on the 19-case suite.
    // The ceiling keeps it from creeping back; the floor records where quality
    // broke, so a future cut has to re-run that suite rather than guess.
    const approximateTokens = Math.ceil(selective.length / 4.3);
    expect(approximateTokens).toBeLessThan(1_000);
    expect(approximateTokens).toBeGreaterThan(760);

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
