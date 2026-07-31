import { describe, expect, it } from "vitest";
import { extractDateRange, parseEventDate } from "../src/core/temporal.js";
import { MockEmbedder } from "../src/embeddings/mock.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import { MockLLM, type MockResponder } from "../src/llms/mock.js";
import { Memory } from "../src/memory.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";

describe("extractDateRange", () => {
  it("parses '7 May 2023' as that day", () => {
    const r = extractDateRange("When did Caroline go on 7 May 2023?")!;
    expect(r.from.toISOString().slice(0, 10)).toBe("2023-05-07");
    expect(r.to.toISOString().slice(0, 10)).toBe("2023-05-07");
  });

  it("parses 'May 7, 2023' (US order)", () => {
    const r = extractDateRange("the concert on May 7, 2023")!;
    expect(r.from.toISOString().slice(0, 10)).toBe("2023-05-07");
  });

  it("parses 'October 2023' as the whole month", () => {
    const r = extractDateRange(
      "What setback did Melanie face in October 2023?",
    )!;
    expect(r.from.toISOString().slice(0, 10)).toBe("2023-10-01");
    expect(r.to.toISOString().slice(0, 10)).toBe("2023-10-31");
  });

  it("parses 'in 2023' as the whole year", () => {
    const r = extractDateRange("what happened in 2023")!;
    expect(r.from.toISOString().slice(0, 10)).toBe("2023-01-01");
    expect(r.to.toISOString().slice(0, 10)).toBe("2023-12-31");
  });

  it("parses 'summer of 2023' as a season", () => {
    const r = extractDateRange("during the summer of 2023")!;
    expect(r.from.toISOString().slice(0, 10)).toBe("2023-06-01");
    expect(r.to.toISOString().slice(0, 10)).toBe("2023-08-31");
  });

  it("returns null when no absolute date is present", () => {
    expect(extractDateRange("what are melanie's hobbies")).toBeNull();
    expect(extractDateRange("what happened last week")).toBeNull();
  });
});

describe("parseEventDate", () => {
  it("accepts full, month, and year precision", () => {
    expect(parseEventDate("2023-05-07")!.toISOString().slice(0, 10)).toBe(
      "2023-05-07",
    );
    expect(parseEventDate("2023-05")!.toISOString().slice(0, 10)).toBe(
      "2023-05-01",
    );
    expect(parseEventDate("2023")!.toISOString().slice(0, 10)).toBe(
      "2023-01-01",
    );
  });

  it("rejects garbage", () => {
    expect(parseEventDate("soon")).toBeNull();
    expect(parseEventDate(null)).toBeNull();
    expect(parseEventDate(42)).toBeNull();
  });
});

describe("bi-temporal pipeline", () => {
  async function newMemory(llm: MockLLM): Promise<Memory> {
    return Memory.create({
      derivation: { enabled: true },
      embedder: new MockEmbedder(128),
      llm,
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
    });
  }

  it("extraction-derived event dates anchor the state slot's validFrom", async () => {
    const responder: MockResponder = (messages) => {
      const joined = messages.map((x) => x.content).join("\n");
      if (joined.includes("FISHMEM_TASK: extract")) {
        return JSON.stringify({
          facts: [
            {
              text: "caroline lives in berlin",
              subject: "caroline",
              attribute: "residence",
              event_date: "2023-05-07",
            },
          ],
        });
      }
      return JSON.stringify({ facts: [] });
    };
    const mem = await newMemory(new MockLLM(responder));
    await mem.add("transcript", { userId: "u1" });
    const slot = await mem.getState("caroline", "residence", { userId: "u1" });
    expect(slot?.validFrom.toISOString().slice(0, 10)).toBe("2023-05-07");
    expect(slot?.validTo).toBeUndefined();
  });

  it("invalidate() keeps the old memory searchable with a validity end", async () => {
    const mem = await newMemory(new MockLLM());
    const seed = await mem.add("caroline lives in paris", {
      infer: false,
      userId: "u1",
    });
    const oldId = seed.results[0]!.id;
    const next = await mem.add("caroline lives in berlin", {
      infer: false,
      userId: "u1",
      eventDate: new Date("2023-06-20"),
    });
    const newId = next.results[0]!.id;

    const ok = await mem.invalidate(oldId, {
      validTo: new Date("2023-06-20"),
      supersededBy: newId,
    });
    expect(ok).toBe(true);

    // Old memory still exists and is searchable (unlike forget()).
    const old = (await mem.get(oldId))!;
    expect(old.validTo?.toISOString().slice(0, 10)).toBe("2023-06-20");
    expect(old.supersededBy).toBe(newId);

    const { results } = await mem.search("caroline lives paris", {
      userId: "u1",
    });
    expect(results.some((r) => r.memory.id === oldId)).toBe(true);

    // successor —updates→ predecessor edge exists.
    const { edges } = await mem.neighbors(oldId);
    expect(edges.some((e) => e.relationType === "updates")).toBe(true);

    // History records the invalidation.
    const history = await mem.history(oldId);
    expect(history.some((h) => h.event === "INVALIDATE")).toBe(true);
  });

  it("raw adds accept an explicit eventDate option", async () => {
    const mem = await newMemory(new MockLLM());
    const res = await mem.add("the wedding happened", {
      infer: false,
      userId: "u1",
      eventDate: new Date("2018-09-01"),
    });
    const stored = (await mem.get(res.results[0]!.id))!;
    expect(stored.eventDate?.toISOString().slice(0, 10)).toBe("2018-09-01");
  });
});

describe("time-aware retrieval", () => {
  it("a query naming a month surfaces date-matching memories with weak lexical overlap", async () => {
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
    });
    await mem.add("melanie got hurt and paused pottery", {
      infer: false,
      userId: "u1",
      eventDate: new Date(Date.UTC(2023, 9, 12)), // 12 Oct 2023
    });
    for (const filler of [
      "melanie plays the violin",
      "melanie likes hiking trails",
      "melanie bakes sourdough bread",
    ]) {
      await mem.add(filler, { infer: false, userId: "u1" });
    }

    // No lexical/semantic overlap with the stored event other than the date.
    const { results } = await mem.search(
      "what setback happened in October 2023",
      {
        userId: "u1",
      },
    );
    expect(results.some((r) => r.memory.content.includes("hurt"))).toBe(true);
  });
});

describe("temporal kernel", () => {
  it("scores 1 inside the range and decays smoothly outside", async () => {
    const { temporalKernel, extractDateRange } = await import(
      "../src/core/temporal.js"
    );
    const range = extractDateRange("what happened in October 2023")!;
    const inside = temporalKernel(new Date(Date.UTC(2023, 9, 15)), range, 7);
    const nearMiss = temporalKernel(new Date(Date.UTC(2023, 10, 3)), range, 7); // 3d out
    const far = temporalKernel(new Date(Date.UTC(2024, 3, 1)), range, 7);
    expect(inside).toBe(1);
    expect(nearMiss).toBeGreaterThan(0.5);
    expect(nearMiss).toBeLessThan(1);
    expect(far).toBeLessThan(0.01);
  });

  it("near-miss dated memories still surface for a month query", async () => {
    const { Memory } = await import("../src/memory.js");
    const { MockEmbedder } = await import("../src/embeddings/mock.js");
    const { MockLLM } = await import("../src/llms/mock.js");
    const { InMemoryGraphStore } = await import("../src/graph/memory-store.js");
    const { InMemoryVectorStore } = await import("../src/vector/memory.js");
    const mem = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
      search: { temporalKernelTauDays: 7 }, // kernel is opt-in post-ablation
    });
    // Event dated 2 Nov — OUTSIDE October, 2 days past the boundary.
    await mem.add("the gallery accident happened then", {
      infer: false,
      userId: "u1",
      eventDate: new Date(Date.UTC(2023, 10, 2)),
    });
    for (const filler of ["likes tea", "plays chess", "owns a bike"]) {
      await mem.add(filler, { infer: false, userId: "u1" });
    }
    const { results } = await mem.search(
      "what accident happened in October 2023",
      { userId: "u1" },
    );
    expect(results.some((r) => r.memory.content.includes("gallery"))).toBe(
      true,
    );
  });
});
