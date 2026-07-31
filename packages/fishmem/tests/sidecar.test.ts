import { describe, expect, it } from "vitest";
import { InMemoryStateSidecar } from "../src/core/sidecar.js";
import { MockEmbedder } from "../src/embeddings/mock.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import { MockLLM, type MockResponder } from "../src/llms/mock.js";
import { Memory } from "../src/memory.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";

describe("InMemoryStateSidecar (unit)", () => {
  const scope = { userId: "u1" };

  it("reads current, merges identical, supersedes, keeps history, honours asOf", async () => {
    const sc = new InMemoryStateSidecar();
    await sc.upsert({
      scope,
      subject: "Mel",
      attribute: "residence",
      value: "lives in Beijing",
      validFrom: new Date("2023-01-01"),
      sources: ["r1"],
    });
    expect((await sc.getState(scope, "Mel", "residence"))?.value).toBe(
      "lives in Beijing",
    );

    // identical value → merge provenance only, no new slot
    await sc.upsert({
      scope,
      subject: "Mel",
      attribute: "residence",
      value: "lives in Beijing",
      validFrom: new Date("2023-02-01"),
      sources: ["r2"],
    });
    expect(await sc.getStateHistory(scope, "Mel", "residence")).toHaveLength(1);
    expect((await sc.getState(scope, "Mel", "residence"))?.sources).toEqual([
      "r1",
      "r2",
    ]);

    // different value → supersede (close old, open new)
    await sc.upsert({
      scope,
      subject: "Mel",
      attribute: "residence",
      value: "lives in Shanghai",
      validFrom: new Date("2024-08-01"),
      sources: ["r3"],
    });
    expect((await sc.getState(scope, "Mel", "residence"))?.value).toBe(
      "lives in Shanghai",
    );
    const hist = await sc.getStateHistory(scope, "Mel", "residence");
    expect(hist).toHaveLength(2);
    expect(hist[0]!.value).toBe("lives in Beijing");
    expect(hist[0]!.validTo).toEqual(new Date("2024-08-01")); // closed
    expect(hist[1]!.validTo).toBeUndefined(); // open

    // point-in-time
    expect(
      (
        await sc.getState(scope, "Mel", "residence", {
          asOf: new Date("2023-06-01"),
        })
      )?.value,
    ).toBe("lives in Beijing");
  });

  it("is case-insensitive on subject/attribute and isolated by scope", async () => {
    const sc = new InMemoryStateSidecar();
    await sc.upsert({
      scope: { userId: "a" },
      subject: "Mel",
      attribute: "Residence",
      value: "Beijing",
      validFrom: new Date("2023-01-01"),
      sources: [],
    });
    expect(
      (await sc.getState({ userId: "a" }, "mel", "residence"))?.value,
    ).toBe("Beijing");
    expect(
      await sc.getState({ userId: "b" }, "Mel", "Residence"),
    ).toBeUndefined();
  });
});

describe("canonical inference + derived state sidecar", () => {
  // Scripted extraction so canonical facts carry subject/attribute.
  const responder: MockResponder = (messages) => {
    const joined = messages.map((x) => x.content).join("\n");
    if (joined.includes("FISHMEM_TASK: extract")) {
      if (joined.includes("Shanghai"))
        return JSON.stringify({
          facts: [
            {
              text: "Mel lives in Shanghai",
              subject: "Mel",
              attribute: "residence",
              event_date: null,
            },
          ],
        });
      if (joined.includes("Beijing"))
        return JSON.stringify({
          facts: [
            {
              text: "Mel lives in Beijing",
              subject: "Mel",
              attribute: "residence",
              event_date: null,
            },
          ],
        });
    }
    return JSON.stringify({ facts: [] });
  };
  const build = () =>
    Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      derivation: { enabled: true },
    });

  it("stores the refined fact and projects the same fact into the state slot", async () => {
    const m = await build();
    await m.add("Mel lives in Beijing now.", { userId: "u1" });
    const all = (await m.getAll({ userId: "u1" })).results;
    expect(all).toHaveLength(1);
    expect(all[0]!.content).toBe("Mel lives in Beijing");
    expect(
      (await m.getState("Mel", "residence", { userId: "u1" }))?.value,
    ).toBe("Mel lives in Beijing");
  });

  it("supersedes state across adds (current + history)", async () => {
    const m = await build();
    await m.add("Mel lives in Beijing.", {
      userId: "u1",
      eventDate: new Date("2023-01-01"),
    });
    await m.add("Mel moved to Shanghai.", {
      userId: "u1",
      eventDate: new Date("2024-08-01"),
    });
    expect(
      (await m.getState("Mel", "residence", { userId: "u1" }))?.value,
    ).toBe("Mel lives in Shanghai");
    expect(
      await m.getStateHistory("Mel", "residence", { userId: "u1" }),
    ).toHaveLength(2);
  });

  it("derivation disabled (default) does NOT populate the sidecar", async () => {
    const m = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
    });
    await m.add("Mel lives in Beijing now.", { userId: "u1" });
    expect(
      await m.getState("Mel", "residence", { userId: "u1" }),
    ).toBeUndefined();
  });
});

describe("sidecar derivation seam (deferred + rebuild)", () => {
  const responder: MockResponder = (messages) => {
    const joined = messages.map((x) => x.content).join("\n");
    if (joined.includes("FISHMEM_TASK: extract") && joined.includes("Beijing"))
      return JSON.stringify({
        facts: [
          {
            text: "Mel lives in Beijing",
            subject: "Mel",
            attribute: "residence",
            event_date: null,
          },
        ],
      });
    return JSON.stringify({ facts: [] });
  };
  const make = (over: Record<string, unknown>) =>
    Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      ...over,
    });

  it("deferred derivation: add returns first, flushDerivations awaits it", async () => {
    const m = await make({
      derivation: { enabled: true, schedule: "deferred" },
    });
    await m.add("Mel lives in Beijing.", { userId: "u1" });
    await m.flushDerivations();
    expect(
      (await m.getState("Mel", "residence", { userId: "u1" }))?.value,
    ).toBe("Mel lives in Beijing");
  });

  it("rebuildSidecar replays canonical records into the sidecar", async () => {
    // derivation off by default: nothing auto-derives...
    const m = await make({});
    await m.add("Mel lives in Beijing.", { userId: "u1" });
    expect(
      await m.getState("Mel", "residence", { userId: "u1" }),
    ).toBeUndefined();
    // ...but an explicit rebuild backfills state from canonical records.
    await m.rebuildSidecar({ userId: "u1" });
    expect(
      (await m.getState("Mel", "residence", { userId: "u1" }))?.value,
    ).toBe("Mel lives in Beijing");
  });
});

describe("memoryType gates sidecar state slots (event vs mutable-state)", () => {
  const typed: MockResponder = (messages) => {
    // Match the USER message only — the system prompt now contains example
    // facts ("marathon", "tea"), which would otherwise always match.
    const joined = messages
      .filter((x) => x.role === "user")
      .map((x) => x.content)
      .join("\n");
    const isExtract = messages.some((x) =>
      x.content.includes("FISHMEM_TASK: extract"),
    );
    if (isExtract) {
      if (joined.includes("marathon"))
        return JSON.stringify({
          facts: [
            {
              text: "Sam ran a marathon",
              subject: "Sam",
              attribute: "event",
              type: "event",
              event_date: null,
            },
          ],
        });
      if (joined.includes("tea"))
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
    }
    return JSON.stringify({ facts: [] });
  };
  const build = () =>
    Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(typed),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      derivation: { enabled: true },
    });

  it("stateful type → state slot; point type (event) → NOT a slot", async () => {
    const m = await build();
    await m.add("Sam prefers tea.", { userId: "u1" });
    await m.add("Sam ran a marathon yesterday.", { userId: "u1" });
    // preference is single-valued mutable state → slot
    expect((await m.getState("Sam", "beverage", { userId: "u1" }))?.value).toBe(
      "Sam prefers tea",
    );
    // event is point-in-time → excluded (no false supersession across events)
    expect(await m.getState("Sam", "event", { userId: "u1" })).toBeUndefined();

    // canonical records retain the type produced by extraction
    const all = (await m.getAll({ userId: "u1" })).results;
    const tea = all.find((r) => r.content.includes("tea"));
    const marathon = all.find((r) => r.content.includes("marathon"));
    expect(tea?.memoryType).toBe("preference");
    expect(marathon?.memoryType).toBe("event");
  });
});

describe("attribute cardinality (multi-valued coexist vs single supersede)", () => {
  it("sidecar: multi-valued append/coexist, single supersede", async () => {
    const sc = new InMemoryStateSidecar();
    const s = { userId: "u1" };
    // multi-valued: two pets coexist (no supersession)
    await sc.upsert({
      scope: s,
      subject: "Mel",
      attribute: "pet",
      value: "has a cat",
      validFrom: new Date("2023-01-01"),
      sources: [],
      cardinality: "multi",
    });
    await sc.upsert({
      scope: s,
      subject: "Mel",
      attribute: "pet",
      value: "has a dog",
      validFrom: new Date("2023-02-01"),
      sources: [],
      cardinality: "multi",
    });
    const pets = await sc.getStateHistory(s, "Mel", "pet");
    expect(pets).toHaveLength(2);
    expect(pets.every((p) => p.validTo === undefined)).toBe(true); // both still true
    // single-valued: residence supersedes
    await sc.upsert({
      scope: s,
      subject: "Mel",
      attribute: "residence",
      value: "Beijing",
      validFrom: new Date("2023-01-01"),
      sources: [],
      cardinality: "single",
    });
    await sc.upsert({
      scope: s,
      subject: "Mel",
      attribute: "residence",
      value: "Shanghai",
      validFrom: new Date("2024-08-01"),
      sources: [],
      cardinality: "single",
    });
    const res = await sc.getStateHistory(s, "Mel", "residence");
    expect(res).toHaveLength(2);
    expect(res.filter((r) => r.validTo === undefined)).toHaveLength(1); // only one current
  });

  it("engine: known multi attribute (pet) coexists end-to-end in hybrid", async () => {
    const resp: MockResponder = (messages) => {
      const user = messages
        .filter((x) => x.role === "user")
        .map((x) => x.content)
        .join("\n");
      if (messages.some((x) => x.content.includes("FISHMEM_TASK: extract"))) {
        if (user.includes("cat"))
          return JSON.stringify({
            facts: [
              {
                text: "Mel has a cat",
                subject: "Mel",
                attribute: "pet",
                type: "fact",
                cardinality: "multi",
                event_date: null,
              },
            ],
          });
        if (user.includes("dog"))
          return JSON.stringify({
            facts: [
              {
                text: "Mel has a dog",
                subject: "Mel",
                attribute: "pet",
                type: "fact",
                cardinality: "multi",
                event_date: null,
              },
            ],
          });
      }
      return JSON.stringify({ facts: [] });
    };
    const m = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(resp),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      derivation: { enabled: true },
    });
    await m.add("Mel has a cat.", { userId: "u1" });
    await m.add("Mel has a dog.", { userId: "u1" });
    // both pets coexist (not superseded) — the cardinality fix
    const pets = await m.getStateHistory("Mel", "pet", { userId: "u1" });
    expect(pets).toHaveLength(2);
    expect(pets.every((p) => p.validTo === undefined)).toBe(true);
  });
});
