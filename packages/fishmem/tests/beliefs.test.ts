import { describe, expect, it } from "vitest";
import { MockEmbedder } from "../src/embeddings/mock.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import { MockLLM } from "../src/llms/mock.js";
import { Memory } from "../src/memory.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";

async function newMemory(overrides: Record<string, unknown> = {}) {
  return Memory.create({
    embedder: new MockEmbedder(128),
    llm: new MockLLM(),
    vectorStore: new InMemoryVectorStore(),
    graphStore: new InMemoryGraphStore(),
    autoAssociate: { enabled: false },
    ...overrides,
  });
}

describe("belief-chain assembly", () => {
  it("returns a timeline with the superseded entry marked not-current", async () => {
    const mem = await newMemory();
    // Two residence beliefs: Paris (superseded) → Berlin (current).
    const paris = await mem.add("Caroline lives in Paris", {
      infer: false,
      userId: "u1",
      eventDate: new Date("2022-03-01"),
    });
    const parisId = paris.results[0]!.id;
    const berlin = await mem.add("Caroline lives in Berlin", {
      infer: false,
      userId: "u1",
      eventDate: new Date("2023-06-20"),
    });
    const berlinId = berlin.results[0]!.id;
    // Stamp the belief keys (raw adds don't extract structure).
    for (const [id, city] of [
      [parisId, "Paris"],
      [berlinId, "Berlin"],
    ] as const) {
      const rec = (await mem.get(id))!;
      rec.subject = "Caroline";
      rec.attribute = "residence";
      await mem.store.updateMemory(rec);
      void city;
    }
    await mem.invalidate(parisId, {
      validTo: new Date("2023-06-20"),
      supersededBy: berlinId,
    });

    const res = await mem.search("where does caroline live", { userId: "u1" });
    expect(res.beliefs).toBeDefined();
    const chain = res.beliefs!.find((b) => b.attribute === "residence");
    expect(chain).toBeDefined();
    expect(chain!.subject).toBe("caroline");
    expect(chain!.entries).toHaveLength(2);
    expect(chain!.entries[0]!.content).toContain("Paris");
    expect(chain!.entries[0]!.current).toBe(false);
    expect(chain!.entries[1]!.content).toContain("Berlin");
    expect(chain!.entries[1]!.current).toBe(true);
  });

  it("omits chains for single uncontested beliefs and respects the config flag", async () => {
    const mem = await newMemory();
    const r = await mem.add("Caroline likes tea", {
      infer: false,
      userId: "u1",
    });
    const rec = (await mem.get(r.results[0]!.id))!;
    rec.subject = "Caroline";
    rec.attribute = "drink";
    await mem.store.updateMemory(rec);
    const res = await mem.search("caroline tea", { userId: "u1" });
    expect(res.beliefs).toBeUndefined(); // single current entry → no chain

    const off = await newMemory({ beliefChains: false });
    await off.add("x", { infer: false, userId: "u1" });
    const res2 = await off.search("x", { userId: "u1" });
    expect(res2.beliefs).toBeUndefined();
  });
});

describe("retrieval trace", () => {
  it("returns per-source lists when requested", async () => {
    const mem = await newMemory();
    await mem.add("alpha fact about cats", { infer: false, userId: "u1" });
    await mem.add("beta fact about dogs", { infer: false, userId: "u1" });
    const res = await mem.search("cats", { userId: "u1", trace: true });
    expect(res.trace).toBeDefined();
    expect(res.trace!.lists.vector.length).toBeGreaterThan(0);
    expect(res.trace!.selected.length).toBe(res.results.length);
  });

  it("is absent by default", async () => {
    const mem = await newMemory();
    await mem.add("gamma fact", { infer: false, userId: "u1" });
    const res = await mem.search("gamma", { userId: "u1" });
    expect(res.trace).toBeUndefined();
  });
});

describe("Hebbian reinforcement", () => {
  it("strengthens existing edges with capped growth and seeds missing ones", async () => {
    const mem = await newMemory();
    const a = await mem.add("fact a", { infer: false, userId: "u1" });
    const b = await mem.add("fact b", { infer: false, userId: "u1" });
    const c = await mem.add("fact c", { infer: false, userId: "u1" });
    const idA = a.results[0]!.id;
    const idB = b.results[0]!.id;
    const idC = c.results[0]!.id;
    await mem.link(idA, idB, "related_to", 0.5);

    const report = await mem.reinforce([idA, idB, idC]);
    expect(report.strengthened).toBe(1); // A—B grew
    expect(report.created).toBe(2); // A—C, B—C seeded weak

    const { edges } = await mem.graph({ userId: "u1" });
    const ab = edges.find(
      (e) =>
        (e.sourceId === idA && e.targetId === idB) ||
        (e.sourceId === idB && e.targetId === idA),
    )!;
    expect(ab.weight).toBeGreaterThan(0.5);
    expect(ab.weight).toBeLessThanOrEqual(0.95);

    // Repeated reinforcement converges below the cap.
    for (let i = 0; i < 50; i++) await mem.reinforce([idA, idB]);
    const after = (await mem.graph({ userId: "u1" })).edges.find(
      (e) =>
        (e.sourceId === idA && e.targetId === idB) ||
        (e.sourceId === idB && e.targetId === idA),
    )!;
    expect(after.weight).toBeLessThanOrEqual(0.95);
  });
});

describe("beliefAt point-in-time query", () => {
  it("returns the belief valid at the queried instant plus the timeline", async () => {
    const mem = await newMemory();
    const mk = async (content: string, from: string, to?: string) => {
      const r = await mem.add(content, { infer: false, userId: "u1" });
      const rec = (await mem.get(r.results[0]!.id))!;
      rec.subject = "Caroline";
      rec.attribute = "residence";
      rec.validFrom = new Date(from);
      rec.eventDate = new Date(from);
      if (to) rec.validTo = new Date(to);
      await mem.store.updateMemory(rec);
      return rec.id;
    };
    await mk("Caroline lives in Paris", "2022-01-01", "2023-06-20");
    await mk("Caroline lives in Berlin", "2023-06-20");

    const before = await mem.beliefAt(
      "Caroline",
      "residence",
      new Date("2023-01-01"),
      { userId: "u1" },
    );
    expect(before.valid).toHaveLength(1);
    expect(before.valid[0]!.content).toContain("Paris");

    const after = await mem.beliefAt(
      "caroline",
      "RESIDENCE",
      new Date("2024-01-01"),
      { userId: "u1" },
    );
    expect(after.valid).toHaveLength(1);
    expect(after.valid[0]!.content).toContain("Berlin");
    expect(after.timeline).toHaveLength(2);
  });
});

describe("slot summary retrieval docs", () => {
  it("materializes a deterministic slot_summary without exposing it as a memory", async () => {
    let llmCalls = 0;
    const responder = (messages: Array<{ role: string; content: string }>) => {
      llmCalls++;
      const joined = messages.map((m) => m.content).join("\n");
      if (joined.includes("FISHMEM_TASK: extract")) {
        const moved = joined.includes("moved");
        return JSON.stringify({
          facts: [
            moved
              ? {
                  text: "Caroline lives in Berlin",
                  event_date: "2023-06-20",
                  entities: ["Caroline", "Berlin"],
                  subject: "Caroline",
                  attribute: "residence",
                }
              : {
                  text: "Caroline lives in Paris",
                  event_date: "2022-03-01",
                  entities: ["Caroline", "Paris"],
                  subject: "Caroline",
                  attribute: "residence",
                },
          ],
        });
      }
      return JSON.stringify({ facts: [] });
    };
    const mem = await Memory.create({
      derivation: { enabled: true },
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
      retrievalDocs: { slotSummary: true },
    });

    await mem.add("Caroline intro", { userId: "u1" });
    await mem.add("Caroline moved", { userId: "u1" });

    const all = await mem.getAll({ userId: "u1" });
    expect(all.results).toHaveLength(2);
    expect(llmCalls).toBe(2); // one extraction per add; no update stage, no slot-summary LLM

    const { results } = await mem.search("current residence for Caroline", {
      userId: "u1",
    });
    const slot = results.find(
      (r) => r.memory.metadata?.__retrievalDoc === "slot_summary",
    );
    expect(slot).toBeDefined();
    expect(slot!.memory.content).toContain("Current residence for Caroline");
    expect(slot!.memory.content).toContain("Caroline lives in Paris");
    expect(slot!.memory.content).toContain("Caroline lives in Berlin");
  });
});

describe("calibrated fusion", () => {
  it("isotonic fit is monotone and noisy-OR favours multi-source candidates", async () => {
    const { fitIsotonic, calibrate, noisyOr } = await import(
      "../src/core/calibration.js"
    );
    const curve = fitIsotonic([
      { score: 0.1, label: 0 },
      { score: 0.2, label: 0 },
      { score: 0.5, label: 1 },
      { score: 0.6, label: 0 },
      { score: 0.8, label: 1 },
      { score: 0.9, label: 1 },
    ]);
    for (let i = 1; i < curve.y.length; i++) {
      expect(curve.y[i]!).toBeGreaterThanOrEqual(curve.y[i - 1]!);
    }
    expect(calibrate(curve, 0.95)).toBeGreaterThan(calibrate(curve, 0.15));
    const two = noisyOr([
      { p: 0.5, weight: 1 },
      { p: 0.5, weight: 1 },
    ]);
    expect(two).toBeCloseTo(0.75, 5);
    expect(two).toBeGreaterThan(noisyOr([{ p: 0.5, weight: 1 }]));
  });

  it("search runs end-to-end in calibrated mode with synthetic tables", async () => {
    const mem = await newMemory({
      search: {
        fusion: "calibrated",
        calibration: {
          vector: { x: [0, 1], y: [0.05, 0.9] },
          fts: { x: [0, 1], y: [0.05, 0.6] },
          graph: { x: [0, 1], y: [0.05, 0.4] },
          temporal: { x: [0, 1], y: [0.05, 0.5] },
        },
      },
    });
    await mem.add("the cat sat on the mat", { infer: false, userId: "u1" });
    await mem.add("dogs love the park", { infer: false, userId: "u1" });
    const { results } = await mem.search("cat mat", { userId: "u1" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.memory.content).toContain("cat");
  });
});

describe("episode gists", () => {
  it("summarizeEpisode creates a flagged observation for an explicitly archived episode", async () => {
    const { MockLLM } = await import("../src/llms/mock.js");
    const responder = (messages: Array<{ role: string; content: string }>) => {
      const joined = messages.map((m) => m.content).join("\n");
      if (joined.includes("FISHMEM_TASK: gist")) {
        return "Short gist of the pottery chat.";
      }
      return JSON.stringify({ facts: [] });
    };
    const mem = await Memory.create({
      derivation: { enabled: true },
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
      search: { gistSubstitution: true, contextBudgetTokens: 500 },
    });
    await mem.store.saveEpisode({
      id: "episode-pottery",
      userId: "u1",
      messages: [
        {
          role: "user",
          content: "melanie bought a pottery wheel for her home studio setup",
        },
        {
          role: "assistant",
          content: "melanie pottery class meets every tuesday at the studio",
        },
      ],
      createdAt: new Date("2026-01-10T00:00:00.000Z"),
    });
    const episodes = await mem.episodes({ userId: "u1" });
    expect(episodes).toHaveLength(1);

    const gist = await mem.summarizeEpisode(episodes[0]!.id, { userId: "u1" });
    expect(gist).not.toBeNull();
    const gistRec = (await mem.get(gist!.id))!;
    expect(gistRec.memoryType).toBe("observation");
    expect((gistRec.metadata as Record<string, unknown>).__gist).toBe(true);
    expect(gistRec.episodeId).toBe(episodes[0]!.id);

    const { results } = await mem.search("melanie pottery studio", {
      userId: "u1",
    });
    const contents = results.map((r) => r.memory.content);
    expect(contents).toContain("Short gist of the pottery chat.");
  });
});
