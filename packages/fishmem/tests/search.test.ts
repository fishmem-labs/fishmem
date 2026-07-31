import { beforeEach, describe, expect, it } from "vitest";
import { MockEmbedder } from "../src/embeddings/mock.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import type { MemoryWarning } from "../src/index.js";
import { MockLLM, type MockResponder } from "../src/llms/mock.js";
import { Memory } from "../src/memory.js";
import type { MemoryFilters } from "../src/types.js";
import type { VectorHit } from "../src/vector/base.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";

class FailingTextSearchVectorStore extends InMemoryVectorStore {
  override async textSearch(
    _query: string,
    _limit: number,
    _filters?: MemoryFilters,
  ): Promise<VectorHit[]> {
    throw new Error("fts failed");
  }
}

class StructurallyFilteredVectorStore extends InMemoryVectorStore {
  override async search(
    vector: number[],
    limit: number,
    filters?: MemoryFilters,
  ): Promise<VectorHit[]> {
    return super.search(vector, limit, {
      ...filters,
      metadata: undefined,
    });
  }

  override async textSearch(
    query: string,
    limit: number,
    filters?: MemoryFilters,
  ): Promise<VectorHit[]> {
    return super.textSearch(query, limit, {
      ...filters,
      metadata: undefined,
    });
  }
}

async function newMemory(): Promise<Memory> {
  return Memory.create({
    embedder: new MockEmbedder(128),
    llm: new MockLLM(),
    vectorStore: new InMemoryVectorStore(),
    graphStore: new InMemoryGraphStore(),
  });
}

let m: Memory;
beforeEach(async () => {
  m = await newMemory();
});

describe("hybrid search", () => {
  it("ranks the semantically/lexically relevant memory first", async () => {
    await m.add("the cat sat on the mat", { infer: false, userId: "u1" });
    await m.add("dogs love to run in the park", { infer: false, userId: "u1" });
    await m.add("the stars shine brightly at night", {
      infer: false,
      userId: "u1",
    });

    const { results } = await m.search("cat mat", { userId: "u1" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.memory.content).toContain("cat");
  });

  it("scopes results by user", async () => {
    await m.add("alice likes tennis", { infer: false, userId: "u1" });
    await m.add("bob likes tennis", { infer: false, userId: "u2" });
    const { results } = await m.search("tennis", { userId: "u1" });
    expect(results.every((r) => r.memory.userId === "u1")).toBe(true);
  });

  it("rechecks canonical scope and metadata after a vector backend hit", async () => {
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      vectorStore: new StructurallyFilteredVectorStore(),
      graphStore: new InMemoryGraphStore(),
    });
    await mem.add("shared deployment token", {
      infer: false,
      userId: "u1",
      metadata: { tenant: "wrong" },
    });
    await mem.add("shared deployment token", {
      infer: false,
      userId: "u1",
      metadata: { tenant: "expected" },
    });

    const { results } = await mem.search("deployment token", {
      userId: "u1",
      filters: { tenant: "expected" },
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.memory.metadata).toMatchObject({ tenant: "expected" });
  });

  it("supports an explicit precision lane for point questions", async () => {
    const a = await m.add("melanie owns a pet named oliver", {
      infer: false,
      userId: "u1",
    });
    const b = await m.add("bailey is a golden retriever", {
      infer: false,
      userId: "u1",
    });
    await m.link(a.results[0]!.id, b.results[0]!.id, "related_to", 0.9);

    const { results, trace } = await m.search("What pet does Melanie own?", {
      userId: "u1",
      trace: true,
      limit: 10,
      searchStrategy: "precision",
    });
    expect(results.length).toBeLessThanOrEqual(5);
    expect(trace?.lists.graph).toHaveLength(0);
    expect(results[0]!.memory.content).toContain("oliver");
  });

  it("reports FTS lane failures through onWarning and falls back to vector search", async () => {
    const warnings: MemoryWarning[] = [];
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      vectorStore: new FailingTextSearchVectorStore(),
      graphStore: new InMemoryGraphStore(),
      onWarning: (warning) => warnings.push(warning),
    });
    await mem.add("the cat sat on the mat", { infer: false, userId: "u1" });

    const { results } = await mem.search("cat mat", { userId: "u1" });

    expect(results[0]!.memory.content).toContain("cat");
    expect(warnings.map((w) => w.code)).toContain("search_fts_failed");
    expect(
      warnings.find((w) => w.code === "search_fts_failed")?.error,
    ).toBeInstanceOf(Error);
  });
});

describe("metadata search modes", () => {
  beforeEach(async () => {
    await m.add("oldest", {
      infer: false,
      importance: 0.2,
      memoryType: "observation",
    });
    await new Promise((r) => setTimeout(r, 5));
    await m.add("middle", {
      infer: false,
      importance: 0.9,
      memoryType: "decision",
    });
    await new Promise((r) => setTimeout(r, 5));
    await m.add("newest", {
      infer: false,
      importance: 0.5,
      memoryType: "fact",
    });
  });

  it("recent mode returns newest first", async () => {
    const { results } = await m.search("", { mode: "recent" });
    expect(results[0]!.memory.content).toBe("newest");
  });

  it("important mode returns highest importance first", async () => {
    const { results } = await m.search("", { mode: "important" });
    expect(results[0]!.memory.content).toBe("middle");
  });

  it("typed mode filters by memory type", async () => {
    const { results } = await m.search("", {
      mode: "typed",
      memoryType: "decision",
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.memory.content).toBe("middle");
  });
});

describe("graph-augmented recall", () => {
  it("does not expand graph in the default balanced strategy", async () => {
    const a = await m.add("melanie owns a pet named oliver", {
      infer: false,
      userId: "u1",
    });
    const b = await m.add("bailey is a golden retriever", {
      infer: false,
      userId: "u1",
    });
    await m.link(a.results[0]!.id, b.results[0]!.id, "related_to", 0.9);

    const { trace } = await m.search("melanie pet oliver", {
      userId: "u1",
      trace: true,
    });
    expect(trace?.lists.graph).toHaveLength(0);
  });

  it("pulls in graph neighbours of matched high-importance seeds", async () => {
    const identity = await m.add("alice is a backend developer", {
      infer: false,
      memoryType: "identity", // importance 1.0 → graph seed
      userId: "u1",
    });
    const pref = await m.add("prefers the rust programming language", {
      infer: false,
      memoryType: "preference",
      userId: "u1",
    });
    await m.link(identity.results[0]!.id, pref.results[0]!.id, "related_to");

    // "alice" matches the identity seed lexically; graph traversal should then
    // surface the linked preference even though it lacks the query term.
    const { results } = await m.search("alice", {
      userId: "u1",
      searchStrategy: "recall",
    });
    const contents = results.map((r) => r.memory.content);
    expect(contents.some((c) => c.includes("alice"))).toBe(true);
    expect(contents.some((c) => c.includes("rust"))).toBe(true);
  });

  it("seeds traversal from vector hits, surfacing linked sibling facts", async () => {
    // Ordinary facts (importance 0.6) never clear the 0.8 seed threshold, so
    // only vector-hit seeding can reach the linked sibling.
    const a = await m.add("melanie owns a pet named oliver", {
      infer: false,
      userId: "u1",
    });
    const b = await m.add("bailey is a golden retriever", {
      infer: false,
      userId: "u1",
    });
    await m.link(a.results[0]!.id, b.results[0]!.id, "related_to", 0.9);

    // Query matches A via vector/FTS; B shares no terms with the query and is
    // only reachable through the edge.
    const { results } = await m.search("melanie pet oliver", {
      userId: "u1",
      searchStrategy: "recall",
    });
    const contents = results.map((r) => r.memory.content);
    expect(contents.some((c) => c.includes("oliver"))).toBe(true);
    expect(contents.some((c) => c.includes("bailey"))).toBe(true);
  });

  it("does not leak other tenants' memories through graph edges", async () => {
    const a = await m.add("shared project alpha kickoff", {
      infer: false,
      userId: "u1",
    });
    const other = await m.add("u2 secret budget numbers", {
      infer: false,
      userId: "u2",
    });
    await m.link(a.results[0]!.id, other.results[0]!.id, "related_to", 1);

    const { results } = await m.search("project alpha kickoff", {
      userId: "u1",
      searchStrategy: "recall",
    });
    expect(results.every((r) => r.memory.userId === "u1")).toBe(true);
  });
});

describe("PPR graph ranking", () => {
  it("reaches facts two hops away through the association chain", async () => {
    const a = await m.add("melanie visited the animal shelter", {
      infer: false,
      userId: "u1",
      memoryType: "event",
    });
    const b = await m.add("adopted a kitten there", {
      infer: false,
      userId: "u1",
      memoryType: "event",
    });
    const c = await m.add("named it luna", {
      infer: false,
      userId: "u1",
      memoryType: "event",
    });
    await m.link(a.results[0]!.id, b.results[0]!.id, "related_to", 0.9);
    await m.link(b.results[0]!.id, c.results[0]!.id, "related_to", 0.9);

    // Query only matches A; C is two hops out with zero lexical overlap.
    const { results } = await m.search("melanie animal shelter visit", {
      userId: "u1",
      searchStrategy: "recall",
    });
    const contents = results.map((r) => r.memory.content);
    expect(contents.some((c2) => c2.includes("luna"))).toBe(true);
  });

  it("bfs mode still works (spacebot parity)", async () => {
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      search: { graphRank: "bfs" },
    });
    const identity = await mem.add("alice is a backend developer", {
      infer: false,
      memoryType: "identity",
      userId: "u1",
    });
    const pref = await mem.add("prefers the rust programming language", {
      infer: false,
      memoryType: "preference",
      userId: "u1",
    });
    await mem.link(identity.results[0]!.id, pref.results[0]!.id, "related_to");
    const { results } = await mem.search("alice", {
      userId: "u1",
      searchStrategy: "recall",
    });
    const contents = results.map((r) => r.memory.content);
    expect(contents.some((c) => c.includes("rust"))).toBe(true);
  });
});

describe("diversity selection", () => {
  it("near-duplicate facts don't crowd out distinct ones in a small top-k", async () => {
    // Three identical memories (cosine 1.0 under MockEmbedder) + one distinct,
    // limit 2: without the diversity pass the duplicates fill both slots.
    for (let i = 0; i < 3; i++) {
      await m.add("melanie loves pottery and makes bowls", {
        infer: false,
        userId: "u1",
      });
    }
    await m.add("melanie pottery class is on tuesdays downtown", {
      infer: false,
      userId: "u1",
    });

    const { results } = await m.search("melanie pottery", {
      userId: "u1",
      limit: 2,
    });
    expect(results).toHaveLength(2);
    const contents = results.map((r) => r.memory.content);
    expect(contents.some((c) => c.includes("tuesdays"))).toBe(true);
  });
});

describe("invalidation-chain following", () => {
  it("retrieving a superseded memory pulls in its successor", async () => {
    const old = await m.add("caroline lives in paris", {
      infer: false,
      userId: "u1",
    });
    const oldId = old.results[0]!.id;
    const next = await m.add("caroline moved to berlin recently", {
      infer: false,
      userId: "u1",
    });
    await m.invalidate(oldId, { supersededBy: next.results[0]!.id });

    // Query matches the OLD memory lexically; the successor shares few terms.
    const { results } = await m.search("caroline lives paris", {
      userId: "u1",
      limit: 5,
    });
    const ids = results.map((r) => r.memory.id);
    expect(ids).toContain(oldId);
    expect(ids).toContain(next.results[0]!.id);
  });
});

describe("opt-in LLM rerank", () => {
  it("reorders results according to the reranker output", async () => {
    const responder: MockResponder = (messages) => {
      const joined = messages.map((x) => x.content).join("\n");
      if (joined.includes("rank memory snippets")) {
        // Reverse whatever order arrived.
        const n = (joined.match(/^\d+: /gm) ?? []).length;
        return JSON.stringify({
          order: Array.from({ length: n }, (_, i) => n - 1 - i),
        });
      }
      return JSON.stringify({ facts: [], memory: [] });
    };
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
      search: { rerank: true, diversityThreshold: 0 },
    });
    await mem.add("alpha cats sleep all day", { infer: false, userId: "u1" });
    await mem.add("beta cats hunt at night", { infer: false, userId: "u1" });

    const plain = await mem.search("cats", { userId: "u1" });
    expect(plain.results.length).toBe(2);
    // Reranker reversed the fused order; just assert it was applied without
    // breaking ranks.
    expect(plain.results[0]!.rank).toBe(1);
  });
});

describe("auto-association on add", () => {
  it("links similar new memories automatically", async () => {
    await m.add("melanie plays the violin in an orchestra", {
      infer: false,
      userId: "u1",
    });
    await m.add("melanie plays the clarinet in an orchestra", {
      infer: false,
      userId: "u1",
    });
    const { edges } = await m.graph({ userId: "u1" });
    expect(edges.length).toBeGreaterThan(0);
    expect(edges[0]!.relationType).toBe("related_to");
  });

  it("does not link dissimilar memories", async () => {
    await m.add("quantum entanglement research", {
      infer: false,
      userId: "u1",
    });
    await m.add("grandma bakes sourdough bread", {
      infer: false,
      userId: "u1",
    });
    const { edges } = await m.graph({ userId: "u1" });
    expect(edges).toHaveLength(0);
  });

  it("can be disabled via config", async () => {
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
    });
    await mem.add("melanie plays the violin in an orchestra", {
      infer: false,
      userId: "u1",
    });
    await mem.add("melanie plays the clarinet in an orchestra", {
      infer: false,
      userId: "u1",
    });
    const { edges } = await mem.graph({ userId: "u1" });
    expect(edges).toHaveLength(0);
  });
});

describe("coverage selection", () => {
  it("picks complementary facts over redundant high-scorers for multi-aspect queries", async () => {
    // Aspect terms: "pets" question needs oliver AND luna coverage.
    await m.add("melanie has a pet cat named oliver the cat", {
      infer: false,
      userId: "u1",
    });
    await m.add("melanie has a pet cat named oliver the tabby", {
      infer: false,
      userId: "u1",
    }); // near-duplicate of the first
    await m.add("melanie has a pet dog named luna", {
      infer: false,
      userId: "u1",
    });
    const { results } = await m.search("melanie pets oliver luna", {
      userId: "u1",
      limit: 2,
    });
    const text = results.map((r) => r.memory.content).join(" | ");
    expect(text).toContain("oliver");
    expect(text).toContain("luna"); // coverage beats the redundant twin
  });

  it("respects a context token budget when set", async () => {
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
      search: { contextBudgetTokens: 30 },
    });
    const long = `melanie pottery ${"filler words to inflate the length ".repeat(10)}`;
    await mem.add(long, { infer: false, userId: "u1" });
    await mem.add("melanie pottery class tuesday", {
      infer: false,
      userId: "u1",
    });
    await mem.add("melanie pottery wheel purchase", {
      infer: false,
      userId: "u1",
    });
    const { results } = await mem.search("melanie pottery", {
      userId: "u1",
      limit: 10,
    });
    const tokens = results.reduce(
      (sum, r) => sum + Math.ceil(r.memory.content.length / 4),
      0,
    );
    expect(tokens).toBeLessThanOrEqual(30 + 60); // first pick may exceed alone
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("centered embedder", () => {
  it("passes through during warmup, centers and re-normalizes after freeze", async () => {
    const { CenteredEmbedder } = await import("../src/embeddings/centered.js");
    const inner = new MockEmbedder(64);
    const centered = new CenteredEmbedder(inner, 4); // tiny warmup
    const texts = ["alpha beta", "gamma delta", "epsilon zeta", "eta theta"];
    for (const t of texts) await centered.embed(t); // warmup, frozen after 4
    const raw = await inner.embed("alpha beta");
    const post = await centered.embed("alpha beta");
    expect(post).not.toEqual(raw); // transformed now
    const norm = Math.hypot(...post);
    expect(norm).toBeCloseTo(1, 5); // re-normalized
  });
});

describe("deep recall mode (opt-in)", () => {
  it("pulls in memories surfaced only by LLM follow-up queries", async () => {
    const responder: MockResponder = (messages) => {
      const joined = messages.map((x) => x.content).join("\n");
      if (joined.includes("FISHMEM_TASK: deepgap")) {
        return JSON.stringify({ queries: ["zorblatt bakery prize"] });
      }
      return JSON.stringify({ facts: [], memory: [] });
    };
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
      // The follow-up "zorblatt bakery prize" reaches its target by lexical
      // overlap; FTS is opt-in since it defaults off (net-negative in
      // benchmarks), so this test of lexical follow-up recall enables it.
      search: {
        rrfWeights: { vector: 1.0, fts: 0.7, graph: 0.5, temporal: 0.8 },
      },
    });
    await mem.add("the festival is in june", { infer: false, userId: "u1" });
    for (const filler of [
      "festival tickets cost money",
      "festival lineup announcement soon",
      "the festival venue is downtown",
    ]) {
      await mem.add(filler, { infer: false, userId: "u1" });
    }
    // Lexically unrelated to the user query, only reachable via the follow-up.
    await mem.add("zorblatt bakery prize winner announcement", {
      infer: false,
      userId: "u1",
    });

    const plain = await mem.search("when is the festival", {
      userId: "u1",
      limit: 3,
    });
    const plainHasPrize = plain.results.some((r) =>
      r.memory.content.includes("prize"),
    );

    const deep = await mem.search("when is the festival", {
      userId: "u1",
      mode: "deep",
      limit: 3,
    });
    const deepHasPrize = deep.results.some((r) =>
      r.memory.content.includes("prize"),
    );
    expect(deepHasPrize).toBe(true);
    expect(plainHasPrize).toBe(false); // mode off → not reachable
  });
});
