import { beforeEach, describe, expect, it } from "vitest";
import { MockEmbedder } from "../src/embeddings/mock.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import type { MemoryFilters, MemoryWarning } from "../src/index.js";
import { MockLLM, type MockResponder } from "../src/llms/mock.js";
import { Memory } from "../src/memory.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";

class FailingDeleteVectorStore extends InMemoryVectorStore {
  override async delete(_id: string): Promise<void> {
    throw new Error("vector delete failed");
  }

  override async deleteByFilter(_filters: MemoryFilters): Promise<void> {
    throw new Error("vector deleteByFilter failed");
  }
}

class FailingSaveGraphStore extends InMemoryGraphStore {
  override async saveMemory(): Promise<void> {
    throw new Error("memory save failed");
  }
}

class CountingBatchEmbedder extends MockEmbedder {
  readonly batchSizes: number[] = [];
  singleCalls = 0;

  override async embed(text: string): Promise<number[]> {
    this.singleCalls++;
    return super.embed(text);
  }

  override async embedBatch(texts: string[]): Promise<number[][]> {
    this.batchSizes.push(texts.length);
    return super.embedBatch(texts);
  }
}

async function newMemory(llm = new MockLLM()): Promise<Memory> {
  return Memory.create({
    embedder: new MockEmbedder(128),
    llm,
    vectorStore: new InMemoryVectorStore(),
    graphStore: new InMemoryGraphStore(),
  });
}

let m: Memory;
beforeEach(async () => {
  m = await newMemory();
});

describe("add (raw / infer:false)", () => {
  it("stores content verbatim with defaults by type", async () => {
    const res = await m.add("I work at Acme Corp", {
      infer: false,
      userId: "u1",
      memoryType: "fact",
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.event).toBe("ADD");

    const got = await m.get(res.results[0]!.id);
    expect(got?.content).toBe("I work at Acme Corp");
    expect(got?.memoryType).toBe("fact");
    expect(got?.importance).toBeCloseTo(0.6, 6); // fact default
    expect(got?.userId).toBe("u1");
    expect(got?.hash).toBeTruthy();
  });

  it("stores one memory per message for a message array", async () => {
    const res = await m.add(
      [
        { role: "user", content: "fact one" },
        { role: "assistant", content: "fact two" },
      ],
      { infer: false },
    );
    expect(res.results).toHaveLength(2);
  });

  it("attaches explicit associations, skipping dangling targets", async () => {
    const a = await m.add("anchor", { infer: false });
    const anchorId = a.results[0]!.id;
    const b = await m.add("linked", {
      infer: false,
      associations: [
        { targetId: anchorId, relationType: "related_to" },
        { targetId: "does-not-exist" },
      ],
    });
    const linkedId = b.results[0]!.id;
    const neighbors = await m.neighbors(linkedId, 1);
    expect(neighbors.nodes.map((n) => n.id)).toContain(anchorId);
  });
});

describe("canonical add semantics", () => {
  const TEXT = "Sam lives in Paris and has a grey cat named Mochi.";

  it("defaults infer to true and stores only refined records", async () => {
    let extractionCalls = 0;
    const mem = await newMemory(
      new MockLLM((_messages, options) => {
        extractionCalls++;
        expect(options?.context?.operation).toBe("memory.extract");
        expect(
          (options as unknown as { jsonSchema?: unknown })?.jsonSchema,
        ).toMatchObject({
          name: "fishmem_fact_extraction",
          strict: true,
          schema: {
            type: "object",
            required: ["facts"],
            additionalProperties: false,
          },
        });
        return JSON.stringify({
          facts: [
            {
              text: "Sam lives in Paris",
              subject: "Sam",
              attribute: "residence",
              type: "fact",
              event_date: null,
            },
            {
              text: "Sam has a grey cat named Mochi",
              subject: "Sam",
              attribute: "pets",
              type: "fact",
              cardinality: "multi",
              event_date: null,
            },
          ],
        });
      }),
    );

    const added = await mem.add(TEXT, { userId: "u1" });
    const stored = (await mem.getAll({ userId: "u1" })).results;

    expect(added.results.map((result) => result.memory)).toEqual([
      "Sam lives in Paris",
      "Sam has a grey cat named Mochi",
    ]);
    expect(stored.map((record) => record.content).sort()).toEqual(
      ["Sam lives in Paris", "Sam has a grey cat named Mochi"].sort(),
    );
    expect(stored.some((record) => record.content === TEXT)).toBe(false);
    expect(extractionCalls).toBe(1);
  });

  it("embeds all refined records from one add in a single batch", async () => {
    const embedder = new CountingBatchEmbedder(128);
    const mem = await Memory.create({
      embedder,
      llm: new MockLLM(() =>
        JSON.stringify({
          facts: [
            { text: "Sam lives in Paris", type: "fact" },
            { text: "Sam has a cat", type: "fact" },
          ],
        }),
      ),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
    });

    await mem.add(TEXT, { userId: "u1" });

    expect(embedder.batchSizes).toEqual([2]);
    expect(embedder.singleCalls).toBe(0);
  });

  it("opt-in episodes preserve roles, stay out of canonical counts, and remain searchable", async () => {
    const embedder = new CountingBatchEmbedder(128);
    const mem = await Memory.create({
      embedder,
      llm: new MockLLM(() =>
        JSON.stringify({
          facts: [{ text: "Atlas is evaluating cache options" }],
        }),
      ),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      episodes: { archive: true, searchable: true },
      autoAssociate: { enabled: false },
    });

    const added = await mem.add(
      [
        { role: "user", content: "How should Atlas handle its cache?" },
        {
          role: "assistant",
          content: "I recommend that Atlas migrate its cache to Redis.",
        },
      ],
      { namespaceId: "project-a", userId: "u1" },
    );
    const canonical = (await mem.getAll({ namespaceId: "project-a" })).results;
    const episodes = await mem.episodes({ namespaceId: "project-a" });

    expect(canonical).toHaveLength(1);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.messages).toEqual([
      { role: "user", content: "How should Atlas handle its cache?" },
      {
        role: "assistant",
        content: "I recommend that Atlas migrate its cache to Redis.",
      },
    ]);
    expect((await mem.get(added.results[0]!.id))?.episodeId).toBe(
      episodes[0]!.id,
    );
    // One extraction-memory vector and one hidden episode retrieval vector are
    // prepared in the same provider batch.
    expect(embedder.batchSizes).toEqual([2]);

    const recalled = await mem.search(
      "What cache did you recommend for Atlas?",
      {
        namespaceId: "project-a",
        userId: "u1",
        limit: 10,
      },
    );
    expect(
      recalled.results.some(
        (result) =>
          result.memory.metadata?.__retrievalDoc === "episode" &&
          result.memory.content.includes("assistant: I recommend") &&
          result.memory.content.includes("Redis"),
      ),
    ).toBe(true);
  });

  it("supports per-add episode opt-out and makes deleted episode vectors invisible", async () => {
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(() => JSON.stringify({ facts: [] })),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      episodes: { archive: true, searchable: true },
      autoAssociate: { enabled: false },
    });

    await mem.add("do not archive this request", {
      namespaceId: "project-a",
      archiveEpisode: false,
    });
    expect(await mem.episodes({ namespaceId: "project-a" })).toEqual([]);

    await mem.add(
      [
        { role: "user", content: "Need a codename" },
        { role: "assistant", content: "Use the codename Cormorant." },
      ],
      { namespaceId: "project-a" },
    );
    const [episode] = await mem.episodes({ namespaceId: "project-a" });
    expect(episode).toBeDefined();
    await expect(
      mem.deleteEpisode(episode!.id, { namespaceId: "other-project" }),
    ).resolves.toBe(false);
    await expect(
      mem.deleteEpisode(episode!.id, { namespaceId: "project-a" }),
    ).resolves.toBe(true);
    expect(await mem.episodes({ namespaceId: "project-a" })).toEqual([]);
    const recalled = await mem.search("What was the codename?", {
      namespaceId: "project-a",
    });
    expect(
      recalled.results.some(
        (result) => result.memory.metadata?.__retrievalDoc === "episode",
      ),
    ).toBe(false);
  });

  it("rejects an episode retrieval pointer whose payload widens authority scope", async () => {
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(() => JSON.stringify({ facts: [] })),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      episodes: { archive: true, searchable: true },
      autoAssociate: { enabled: false },
    });
    await mem.add(
      [
        { role: "user", content: "Need a launch codename" },
        { role: "assistant", content: "Use Project Kingfisher." },
      ],
      { namespaceId: "project-a", userId: "u1" },
    );
    const [pointer] = await mem.vectors.list({ namespaceId: "project-a" }, 10);
    expect(
      (pointer?.payload.metadata as Record<string, unknown> | undefined)
        ?.__retrievalDoc,
    ).toBe("episode");
    await mem.vectors.upsert([
      {
        ...pointer!,
        payload: { ...pointer!.payload, namespaceId: "project-b" },
      },
    ]);

    const leaked = await mem.search("What was the launch codename?", {
      namespaceId: "project-b",
      userId: "u1",
    });
    expect(
      leaked.results.some(
        (result) => result.memory.metadata?.__retrievalDoc === "episode",
      ),
    ).toBe(false);
  });

  it("does not retain a raw episode when canonical storage fails", async () => {
    const store = new FailingSaveGraphStore();
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(() =>
        JSON.stringify({ facts: [{ text: "Atlas uses Redis" }] }),
      ),
      vectorStore: new InMemoryVectorStore(),
      graphStore: store,
      episodes: { archive: true, searchable: true },
      autoAssociate: { enabled: false },
    });

    await expect(
      mem.add(
        [
          { role: "user", content: "Which cache does Atlas use?" },
          { role: "assistant", content: "Atlas uses Redis." },
        ],
        { namespaceId: "project-a", userId: "u1" },
      ),
    ).rejects.toThrow("memory save failed");
    expect(await store.listEpisodes({ namespaceId: "project-a" })).toEqual([]);
  });

  it("infer:false stores input verbatim and never calls the LLM", async () => {
    let llmCalls = 0;
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(() => {
        llmCalls++;
        throw new Error("LLM must not be called");
      }),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      derivation: { enabled: true },
    });
    const raw = `  ${TEXT}\n`;
    const added = await mem.add(raw, { userId: "u1", infer: false });

    expect((await mem.get(added.results[0]!.id))?.content).toBe(raw);
    expect(llmCalls).toBe(0);
    expect(
      await mem.getState("Sam", "residence", { userId: "u1" }),
    ).toBeUndefined();
  });

  it("reuses the canonical extraction for the optional state projection", async () => {
    let extractionCalls = 0;
    const responder: MockResponder = () => {
      extractionCalls++;
      return JSON.stringify({
        facts: [
          {
            text: "Sam lives in Paris",
            subject: "Sam",
            attribute: "residence",
            type: "fact",
            event_date: null,
          },
        ],
      });
    };
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      derivation: { enabled: true },
    });

    const added = await mem.add(TEXT, { userId: "u1" });

    expect(added.results).toHaveLength(1);
    expect((await mem.get(added.results[0]!.id))?.content).toBe(
      "Sam lives in Paris",
    );
    expect(
      (await mem.getState("Sam", "residence", { userId: "u1" }))?.value,
    ).toBe("Sam lives in Paris");
    expect(extractionCalls).toBe(1);
  });

  it("uses a custom fact-extraction prompt for canonical inference", async () => {
    const systemPrompts: string[] = [];
    const responder: MockResponder = (messages) => {
      const system = messages.find((x) => x.role === "system")?.content ?? "";
      systemPrompts.push(system);
      return JSON.stringify({
        facts: [
          {
            text: "custom fact",
            subject: "User",
            attribute: "note",
            event_date: null,
          },
        ],
      });
    };
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      derivation: { enabled: true },
      customFactExtractionPrompt:
        'CUSTOM_EXTRACT — return {"facts": [...]} JSON.',
    });
    const added = await mem.add("hello world", { userId: "u1" });

    expect(systemPrompts[0]).toContain("CUSTOM_EXTRACT");
    expect(added.results[0]?.memory).toBe("custom fact");
    expect((await mem.getState("User", "note", { userId: "u1" }))?.value).toBe(
      "custom fact",
    );
  });

  it("applies project extraction rules and stores the selected category", async () => {
    let systemPrompt = "";
    const mem = await newMemory(
      new MockLLM((messages) => {
        systemPrompt =
          messages.find((message) => message.role === "system")?.content ?? "";
        return JSON.stringify({
          facts: [
            {
              text: "Ada prefers tea",
              category: "USER PREFERENCE",
              subject: "Ada",
              attribute: "drink preference",
              type: "preference",
            },
          ],
        });
      }),
    );

    const result = await mem.add("Ada prefers tea", {
      userId: "ada",
      metadata: { source: "support-chat" },
      extractionPolicy: {
        instructions: "Remember durable food and drink preferences only.",
        categories: ["User preference", "Account detail"],
      },
    });

    expect(systemPrompt).toContain("PROJECT_MEMORY_POLICY_V1");
    expect(systemPrompt).toContain(
      "Remember durable food and drink preferences only.",
    );
    expect(systemPrompt).toContain('["User preference","Account detail"]');
    await expect(mem.get(result.results[0]!.id)).resolves.toMatchObject({
      metadata: {
        source: "support-chat",
        categories: ["User preference"],
      },
    });
  });

  it("fails closed when a categorized extraction omits its category", async () => {
    const mem = await newMemory(
      new MockLLM(() =>
        JSON.stringify({ facts: [{ text: "Ada prefers tea" }] }),
      ),
    );

    await expect(
      mem.add("Ada prefers tea", {
        userId: "ada",
        extractionPolicy: {
          categories: ["User preference"],
        },
      }),
    ).rejects.toThrow("facts[0].category");
    expect((await mem.getAll({ userId: "ada" })).results).toHaveLength(0);
  });

  it("rejects removed storage mode config instead of mapping it", async () => {
    await expect(
      Memory.create({
        embedder: new MockEmbedder(128),
        llm: new MockLLM(),
        vectorStore: new InMemoryVectorStore(),
        graphStore: new InMemoryGraphStore(),
        ...({ mode: "hybrid" } as object),
      }),
    ).rejects.toThrow("config `mode` was removed");
  });

  it("fails closed when extraction throws and stores no raw fallback", async () => {
    const warnings: MemoryWarning[] = [];
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(() => {
        throw new Error("extract failed");
      }),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      derivation: { enabled: true },
      episodes: { archive: true, searchable: true },
      onWarning: (warning) => warnings.push(warning),
    });

    await expect(mem.add(TEXT, { userId: "u1" })).rejects.toThrow(
      "extract failed",
    );
    expect((await mem.getAll({ userId: "u1" })).results).toHaveLength(0);
    expect(await mem.episodes({ userId: "u1" })).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("rejects malformed extraction output instead of silently losing input", async () => {
    const mem = await newMemory(new MockLLM(() => "not json"));

    await expect(mem.add(TEXT)).rejects.toThrow(
      "fact extraction returned invalid JSON",
    );
    expect((await mem.getAll()).results).toHaveLength(0);
  });
});

describe("tiered memory (spacebot tiered-memory design)", () => {
  async function tieredMemory(): Promise<Memory> {
    return Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      tiers: { enabled: true, ttlDays: 3, capacity: 2 },
      autoAssociate: { enabled: false },
    });
  }

  it("new memories enter the working tier; identity stays in graph", async () => {
    const mem = await tieredMemory();
    const fact = await mem.add("likes green tea", {
      infer: false,
      userId: "u1",
    });
    const identity = await mem.add("I am Ada", {
      infer: false,
      userId: "u1",
      memoryType: "identity",
    });
    expect((await mem.get(fact.results[0]!.id))?.tier).toBe("working");
    expect((await mem.get(identity.results[0]!.id))?.tier).toBe("graph");
  });

  it("working memories are exempt from decay until demoted", async () => {
    const mem = await tieredMemory();
    const res = await mem.add("hot fact", { infer: false, userId: "u1" });
    const id = res.results[0]!.id;
    // Back-date so decay would normally apply.
    const record = (await mem.get(id))!;
    record.updatedAt = new Date(Date.now() - 20 * 86_400_000);
    record.lastAccessedAt = new Date(); // recently accessed → stays working
    await mem.store.updateMemory(record);

    const report = await mem.runMaintenance({ userId: "u1" });
    expect(report.demoted).toBe(0);
    expect((await mem.get(id))!.importance).toBeCloseTo(0.6, 5);
  });

  it("demotes working memories after the TTL since last access", async () => {
    const mem = await tieredMemory();
    const res = await mem.add("stale fact", { infer: false, userId: "u1" });
    const id = res.results[0]!.id;
    const record = (await mem.get(id))!;
    record.lastAccessedAt = new Date(Date.now() - 5 * 86_400_000); // > 3d TTL
    await mem.store.updateMemory(record);

    const report = await mem.runMaintenance({ userId: "u1" });
    expect(report.demoted).toBe(1);
    const after = (await mem.get(id))!;
    expect(after.tier).toBe("graph");
    expect(after.demotedAt).toBeInstanceOf(Date);
  });

  it("LRU-demotes overflow beyond working-set capacity", async () => {
    const mem = await tieredMemory(); // capacity 2
    const ids: string[] = [];
    for (const text of ["fact one", "fact two", "fact three"]) {
      const res = await mem.add(text, { infer: false, userId: "u1" });
      ids.push(res.results[0]!.id);
    }
    // Stagger lastAccessedAt: ids[0] is least recently used.
    for (let i = 0; i < ids.length; i++) {
      const r = (await mem.get(ids[i]!))!;
      r.lastAccessedAt = new Date(Date.now() - (ids.length - i) * 3_600_000);
      await mem.store.updateMemory(r);
    }

    const report = await mem.runMaintenance({ userId: "u1" });
    expect(report.demoted).toBe(1);
    expect((await mem.get(ids[0]!))!.tier).toBe("graph");
    expect((await mem.get(ids[1]!))!.tier).toBe("working");
    expect((await mem.get(ids[2]!))!.tier).toBe("working");
  });

  it("promote() returns a memory to the working tier", async () => {
    const mem = await tieredMemory();
    const res = await mem.add("demoted fact", { infer: false, userId: "u1" });
    const id = res.results[0]!.id;
    const record = (await mem.get(id))!;
    record.lastAccessedAt = new Date(Date.now() - 5 * 86_400_000);
    await mem.store.updateMemory(record);
    await mem.runMaintenance({ userId: "u1" });
    expect((await mem.get(id))!.tier).toBe("graph");

    expect(await mem.promote(id)).toBe(true);
    const after = (await mem.get(id))!;
    expect(after.tier).toBe("working");
    expect(after.demotedAt).toBeUndefined();
  });

  it("tiers are off by default — everything lands in graph tier", async () => {
    const res = await m.add("plain fact", { infer: false, userId: "u1" });
    expect((await m.get(res.results[0]!.id))?.tier).toBe("graph");
  });
});

describe("profile blocks", () => {
  it("refreshProfile synthesizes and getProfile returns it; recall is unpolluted", async () => {
    const responder: MockResponder = (messages) => {
      const joined = messages.map((x) => x.content).join("\n");
      if (joined.includes("FISHMEM_TASK: profile")) {
        return "### Melanie\n- Paintings: a horse, a sunset, a sunrise";
      }
      if (joined.includes("FISHMEM_TASK: extract")) {
        return JSON.stringify({ facts: [] });
      }
      return JSON.stringify({ memory: [] });
    };
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
    });
    await mem.add("melanie painted a horse", { infer: false, userId: "u1" });
    await mem.add("melanie painted a sunset", { infer: false, userId: "u1" });

    expect(await mem.getProfile({ userId: "u1" })).toBeNull();
    const profile = await mem.refreshProfile({ userId: "u1" });
    expect(profile).toContain("Paintings");
    expect(await mem.getProfile({ userId: "u1" })).toBe(profile);

    // The reserved profile row must not leak into search or getAll.
    const { results } = await mem.search("paintings horse sunset", {
      userId: "u1",
    });
    expect(
      results.every((r) => !r.memory.id.startsWith("fishmem-profile")),
    ).toBe(true);
    const all = await mem.getAll({ userId: "u1" });
    expect(all.results.every((r) => !r.id.startsWith("fishmem-profile"))).toBe(
      true,
    );
  });

  it("profiles are scope-isolated and refresh overwrites in place", async () => {
    let calls = 0;
    const responder: MockResponder = (messages) => {
      const joined = messages.map((x) => x.content).join("\n");
      if (joined.includes("FISHMEM_TASK: profile"))
        return `profile v${++calls}`;
      return JSON.stringify({ facts: [], memory: [] });
    };
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
    });
    await mem.add("fact a", { infer: false, userId: "u1" });
    await mem.add("fact b", { infer: false, userId: "u2" });

    await mem.refreshProfile({ userId: "u1" });
    await mem.refreshProfile({ userId: "u1" });
    expect(await mem.getProfile({ userId: "u1" })).toBe("profile v2");
    expect(await mem.getProfile({ userId: "u2" })).toBeNull();
  });

  it("reports profile refresh failures through onWarning and keeps the previous profile", async () => {
    const warnings: MemoryWarning[] = [];
    let profileCalls = 0;
    const responder: MockResponder = (messages) => {
      const joined = messages.map((x) => x.content).join("\n");
      if (joined.includes("FISHMEM_TASK: profile")) {
        profileCalls++;
        if (profileCalls === 1) return "### Melanie\n- Hobbies: painting";
        throw new Error("profile failed");
      }
      return JSON.stringify({ facts: [] });
    };
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      onWarning: (warning) => warnings.push(warning),
    });
    await mem.add("melanie paints landscapes", {
      infer: false,
      userId: "u1",
    });

    const first = await mem.refreshProfile({ userId: "u1" });
    const second = await mem.refreshProfile({ userId: "u1" });

    expect(first).toContain("painting");
    expect(second).toBe(first);
    expect(warnings.map((w) => w.code)).toContain("profile_refresh_failed");
  });

  it("getProfileSections returns query-matched profile bullets", async () => {
    const responder: MockResponder = (messages) => {
      const joined = messages.map((x) => x.content).join("\n");
      if (joined.includes("FISHMEM_TASK: profile")) {
        return [
          "### Melanie",
          "- Work & goals: Melanie runs the ceramics studio.",
          "- Possessions & pets: Melanie has a cat named Oliver.",
          "- Activities & hobbies: Melanie paints landscapes.",
        ].join("\n");
      }
      return JSON.stringify({ facts: [], memory: [] });
    };
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
    });
    await mem.add("melanie profile source", { infer: false, userId: "u1" });
    await mem.refreshProfile({ userId: "u1" });

    const sections = await mem.getProfileSections(
      "What pet does Melanie have?",
      { userId: "u1" },
      { limit: 1 },
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toContain("Possessions & pets");
    expect(sections[0]!.content).toContain("Oliver");
    expect(sections[0]!.content).not.toContain("ceramics studio");
  });
});

describe("update / delete / history", () => {
  it("updates content and records history", async () => {
    const res = await m.add("draft note", { infer: false });
    const id = res.results[0]!.id;

    const updated = await m.update(id, "final note");
    expect(updated.event).toBe("UPDATE");
    expect(updated.previousMemory).toBe("draft note");
    expect((await m.get(id))?.content).toBe("final note");

    const history = await m.history(id);
    expect(history.map((h) => h.event)).toEqual(["ADD", "UPDATE"]);
  });

  it("hard-deletes a memory", async () => {
    const res = await m.add("temporary", { infer: false });
    const id = res.results[0]!.id;
    await m.delete(id);
    expect(await m.get(id)).toBeNull();
  });

  it("soft-deletes (forget) a memory", async () => {
    const res = await m.add("private", { infer: false });
    const id = res.results[0]!.id;
    expect(await m.forget(id)).toBe(true);
    expect(await m.get(id)).toBeNull(); // excluded from get
    const { results } = await m.search("private");
    expect(results.find((r) => r.memory.id === id)).toBeUndefined();
  });

  it("reports vector cleanup failures during hard and soft deletes", async () => {
    const warnings: MemoryWarning[] = [];
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      vectorStore: new FailingDeleteVectorStore(),
      graphStore: new InMemoryGraphStore(),
      onWarning: (warning) => warnings.push(warning),
    });

    const hard = await mem.add("temporary", { infer: false });
    const hardId = hard.results[0]!.id;
    await mem.delete(hardId);
    expect(await mem.get(hardId)).toBeNull();

    const soft = await mem.add("private", { infer: false });
    const softId = soft.results[0]!.id;
    expect(await mem.forget(softId)).toBe(true);
    expect(await mem.get(softId)).toBeNull();

    expect(warnings.map((w) => w.code)).toEqual([
      "memory_vector_delete_failed",
      "memory_vector_delete_failed",
    ]);
    expect(warnings.map((w) => w.context?.operation)).toEqual([
      "delete",
      "forget",
    ]);
  });
});

describe("scoping + bulk ops", () => {
  it("isolates memories by user and supports deleteAll / reset", async () => {
    await m.add("u1 memory", { infer: false, userId: "u1" });
    await m.add("u2 memory", { infer: false, userId: "u2" });

    expect((await m.getAll({ userId: "u1" })).results).toHaveLength(1);
    expect((await m.getAll({ userId: "u2" })).results).toHaveLength(1);

    const del = await m.deleteAll({ userId: "u1" });
    expect(del.deleted).toBe(1);
    expect((await m.getAll({ userId: "u1" })).results).toHaveLength(0);
    expect((await m.getAll({ userId: "u2" })).results).toHaveLength(1);

    await m.reset();
    expect((await m.getAll({ userId: "u2" })).results).toHaveLength(0);
  });

  it("reports vector cleanup failures during deleteAll and reset", async () => {
    const warnings: MemoryWarning[] = [];
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      vectorStore: new FailingDeleteVectorStore(),
      graphStore: new InMemoryGraphStore(),
      onWarning: (warning) => warnings.push(warning),
    });
    await mem.add("u1 memory", { infer: false, userId: "u1" });
    await mem.add("u2 memory", { infer: false, userId: "u2" });

    expect(await mem.deleteAll({ userId: "u1" })).toEqual({ deleted: 1 });
    expect((await mem.getAll({ userId: "u1" })).results).toHaveLength(0);
    expect((await mem.getAll({ userId: "u2" })).results).toHaveLength(1);

    await mem.reset();
    expect((await mem.getAll({ userId: "u2" })).results).toHaveLength(0);
    expect(warnings.map((w) => w.code)).toEqual([
      "memory_vector_delete_failed",
      "memory_vector_delete_by_filter_failed",
    ]);
    expect(warnings.map((w) => w.context?.operation)).toEqual([
      "deleteAll",
      "reset",
    ]);
  });
});

describe("memoryType classification", () => {
  it("stores the extracted record with its classified type and importance", async () => {
    const responder: MockResponder = (messages) => {
      const joined = messages.map((x) => x.content).join("\n");
      if (joined.includes("FISHMEM_TASK: extract"))
        return JSON.stringify({
          facts: [
            {
              text: "Sam prefers tea",
              subject: "Sam",
              attribute: "beverage",
              type: "preference",
              event_date: null,
            },
          ],
        });
      return JSON.stringify({ facts: [] });
    };
    const m = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      derivation: { enabled: true },
    });
    const res = await m.add("I prefer tea", { userId: "u1" });
    const added = res.results.find((r) => r.event === "ADD");
    const rec = await m.get(added!.id);
    expect(rec?.content).toBe("Sam prefers tea");
    expect(rec?.memoryType).toBe("preference");
    expect(rec?.importance).toBeCloseTo(0.7, 6);
  });
});
