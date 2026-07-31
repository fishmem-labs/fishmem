import { describe, expect, it } from "vitest";
import type { MemoryConfig } from "../src/config.js";
import { MockEmbedder } from "../src/embeddings/mock.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import { MockLLM, type MockResponder } from "../src/llms/mock.js";
import { Memory } from "../src/memory.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";

function structuredResponder(
  facts: Array<{
    text: string;
    event_date?: string | null;
    entities?: string[];
    subject?: string;
    attribute?: string;
  }>,
): MockResponder {
  return (messages) => {
    const joined = messages.map((m) => m.content).join("\n");
    if (joined.includes("FISHMEM_TASK: extract")) {
      return JSON.stringify({ facts });
    }
    return JSON.stringify({ facts: [] });
  };
}

async function newMemory(llm: MockLLM, overrides: MemoryConfig = {}) {
  return Memory.create({
    derivation: { enabled: true },
    embedder: new MockEmbedder(128),
    llm,
    vectorStore: new InMemoryVectorStore(),
    graphStore: new InMemoryGraphStore(),
    autoAssociate: { enabled: false },
    // The entity-graph walk is opt-in after ablation (Δ0.0 vs memory graph);
    // these tests exercise the opt-in path.
    search: { entityGraph: true },
    ...overrides,
  });
}

describe("structured facts + entity layer (derivation)", () => {
  it("stores the refined record, links entities, and fills the state slot", async () => {
    const mem = await newMemory(
      new MockLLM(
        structuredResponder([
          {
            text: "Melanie has a pet cat named Oliver",
            entities: ["Melanie", "Oliver"],
            subject: "Melanie",
            attribute: "pet",
          },
        ]),
      ),
    );
    const res = await mem.add("conversation", { userId: "u1" });
    const stored = (await mem.get(res.results[0]!.id))!;
    expect(stored.content).toBe("Melanie has a pet cat named Oliver");
    expect(stored.episodeId).toBeUndefined();
    expect(
      (await mem.getState("Melanie", "pet", { userId: "u1" }))?.value,
    ).toBe("Melanie has a pet cat named Oliver");

    const episodes = await mem.episodes({ userId: "u1" });
    expect(episodes).toHaveLength(0);

    const entities = await mem.store.listEntities({ userId: "u1" });
    const names = entities.map((e) => e.name).sort();
    expect(names).toEqual(["Melanie", "Oliver"]);
    const mentions = await mem.store.getEntityIdsForMemories([stored.id]);
    expect(mentions.get(stored.id)?.length).toBe(2);
  });

  it("reuses entities across adds (exact normalized match)", async () => {
    const responder: MockResponder = (messages) => {
      const joined = messages.map((m) => m.content).join("\n");
      if (joined.includes("FISHMEM_TASK: extract")) {
        const which = joined.includes("violin") ? "violin" : "cat";
        return JSON.stringify({
          facts: [
            which === "cat"
              ? {
                  text: "Melanie has a cat",
                  entities: ["Melanie"],
                  subject: "Melanie",
                  attribute: "pet",
                }
              : {
                  text: "Melanie plays the violin",
                  entities: ["melanie"], // different casing on purpose
                  subject: "melanie",
                  attribute: "hobby",
                },
          ],
        });
      }
      return JSON.stringify({ facts: [] });
    };
    const mem = await newMemory(new MockLLM(responder));
    await mem.add("she got a cat", { userId: "u1" });
    await mem.add("she plays violin", { userId: "u1" });
    const entities = await mem.store.listEntities({ userId: "u1" });
    expect(entities).toHaveLength(1); // melanie === Melanie
    expect(entities[0]!.mentionCount).toBeGreaterThanOrEqual(2);
  });
});

describe("additive canonical records", () => {
  it("a colliding belief key keeps both records and supersedes only the sidecar slot", async () => {
    const responder: MockResponder = (messages) => {
      const joined = messages.map((m) => m.content).join("\n");
      if (joined.includes("FISHMEM_TASK: extract")) {
        const second = joined.includes("moved");
        return JSON.stringify({
          facts: [
            second
              ? {
                  text: "Caroline lives in Berlin",
                  entities: ["Caroline", "Berlin"],
                  subject: "Caroline",
                  attribute: "residence",
                }
              : {
                  text: "Caroline lives in Paris",
                  entities: ["Caroline", "Paris"],
                  subject: "Caroline",
                  attribute: "residence",
                },
          ],
        });
      }
      return JSON.stringify({ facts: [] });
    };
    const mem = await newMemory(new MockLLM(responder));
    await mem.add("Caroline intro", { userId: "u1" });
    await mem.add("Caroline moved", { userId: "u1" }); // same residence key
    // Canonical store: both extracted facts remain additive.
    const all = (await mem.getAll({ userId: "u1" })).results;
    expect(all.map((r) => r.content).sort()).toEqual([
      "Caroline lives in Berlin",
      "Caroline lives in Paris",
    ]);
    // Sidecar: the slot superseded — current value + full history.
    expect(
      (await mem.getState("Caroline", "residence", { userId: "u1" }))?.value,
    ).toBe("Caroline lives in Berlin");
    const hist = await mem.getStateHistory("Caroline", "residence", {
      userId: "u1",
    });
    expect(hist).toHaveLength(2);
    expect(hist[0]!.supersededBy).toBe(hist[1]!.id);
  });
});

describe("entity-graph recall", () => {
  it("reaches a memory connected only through a shared entity", async () => {
    const responder: MockResponder = (messages) => {
      const joined = messages.map((m) => m.content).join("\n");
      if (joined.includes("FISHMEM_TASK: extract")) {
        if (joined.includes("first")) {
          return JSON.stringify({
            facts: [
              {
                text: "Zorblatt runs the bakery downtown",
                entities: ["Zorblatt"],
                subject: "Zorblatt",
                attribute: "job",
              },
            ],
          });
        }
        return JSON.stringify({
          facts: [
            {
              // Deliberately shares NO content words with the query below.
              text: "the croissant recipe won a regional prize",
              entities: ["Zorblatt"],
              subject: "Zorblatt",
              attribute: "achievement",
            },
          ],
        });
      }
      return JSON.stringify({ memory: [] });
    };
    const mem = await newMemory(new MockLLM(responder));
    await mem.add("first chunk", { userId: "u1" });
    await mem.add("second chunk", { userId: "u1" });
    // Query mentions the entity but none of the second memory's words.
    const { results } = await mem.search("tell me about Zorblatt", {
      userId: "u1",
    });
    const contents = results.map((r) => r.memory.content);
    expect(contents).toContain("the croissant recipe won a regional prize");
  });
});

describe("typed graph edges", () => {
  const potteryFacts = [
    {
      text: "Caroline likes pottery",
      entities: ["Caroline"],
      subject: "Caroline",
      attribute: "hobby",
    },
    {
      text: "Caroline joined the kiln workshop",
      entities: ["Caroline"],
      subject: "Caroline",
      attribute: "activity",
    },
  ];
  // A two-message add is refined into two records sharing one entity.
  const twoTurns = [
    { role: "user" as const, content: "I like pottery" },
    {
      role: "assistant" as const,
      content: "Caroline joined the kiln workshop",
    },
  ];

  it("does not create typed graph edges by default", async () => {
    const mem = await newMemory(new MockLLM(structuredResponder(potteryFacts)));

    await mem.add(twoTurns, { userId: "u1" });

    const { edges } = await mem.graph({ userId: "u1" });
    expect(edges).toHaveLength(0);
  });

  it("creates bounded same-entity edges when enabled", async () => {
    const mem = await newMemory(
      new MockLLM(structuredResponder(potteryFacts)),
      {
        typedGraph: { enabled: true },
      },
    );

    await mem.add(twoTurns, { userId: "u1" });

    const { edges } = await mem.graph({ userId: "u1" });
    const relationTypes = new Set(edges.map((e) => e.relationType));
    expect(relationTypes.has("same_entity")).toBe(true);
    expect(relationTypes.has("same_episode")).toBe(false);
  });
});
