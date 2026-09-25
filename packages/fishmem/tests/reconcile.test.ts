import { describe, expect, it } from "vitest";
import { MockEmbedder } from "../src/embeddings/mock.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import type { MemoryWarning } from "../src/index.js";
import type { LLMChatOptions } from "../src/llms/base.js";
import { MockLLM } from "../src/llms/mock.js";
import { Memory } from "../src/memory.js";
import {
  FACT_EXTRACTION_SYSTEM,
  RECONCILE_EXTRACTION_ADDENDUM,
} from "../src/prompts/index.js";
import type { Message } from "../src/types.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";

interface Call {
  system: string;
  user: string;
  candidates: string[];
  options?: LLMChatOptions;
}

type Script = (conversation: string, candidates: string[]) => unknown[];

/** Parse the numbered reference block the engine sends to the extractor. */
function parseCandidates(user: string): string[] {
  const block = /<existing_memories>\n([\s\S]*?)\n<\/existing_memories>/u.exec(
    user,
  );
  if (!block) return [];
  return block[1]!
    .split("\n")
    .map((line) => JSON.parse(line.replace(/^\[\d+\] /u, "")) as string);
}

function conversationOf(user: string): string {
  const match = /<conversation>\n([\s\S]*?)\n<\/conversation>/u.exec(user);
  return (match ? match[1]! : user).replace(/^user:\s*/gmu, "");
}

function scriptedLLM(script: Script) {
  const calls: Call[] = [];
  const llm = new MockLLM((messages: Message[], options) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    const candidates = parseCandidates(user);
    calls.push({ system, user, candidates, options });
    return JSON.stringify({
      facts: script(conversationOf(user), candidates),
    });
  });
  return { llm, calls };
}

function fact(
  text: string,
  labels: { duplicate_of?: unknown; supersedes?: unknown } = {},
) {
  return {
    text,
    event_date: null,
    entities: ["Ada"],
    subject: "Ada",
    attribute: "residence",
    type: "fact",
    cardinality: "single",
    duplicate_of: labels.duplicate_of ?? null,
    supersedes: labels.supersedes ?? [],
  };
}

async function createMemory(
  script: Script,
  reconcile: { enabled?: boolean; minScore?: number } = { enabled: true },
) {
  const { llm, calls } = scriptedLLM(script);
  const warnings: MemoryWarning[] = [];
  const memory = await Memory.create({
    embedder: new MockEmbedder(64),
    llm,
    vectorStore: new InMemoryVectorStore(),
    graphStore: new InMemoryGraphStore(),
    autoAssociate: { enabled: false },
    // The mock embedder is lexical; accept any overlap so the scripted
    // extractor, not the vector threshold, is what these tests exercise.
    reconcile: { minScore: -1, ...reconcile },
    onWarning: (warning) => warnings.push(warning),
  });
  return { memory, calls, warnings };
}

/** Seeds verbatim, then lets the scripted extractor decide on later adds. */
const residenceScript: Script = (conversation, candidates) => {
  const berlin = candidates.indexOf("Ada lives in Berlin") + 1;
  if (conversation.includes("moved to Paris")) {
    return [fact("Ada lives in Paris", { supersedes: berlin ? [berlin] : [] })];
  }
  if (conversation.includes("still in Berlin")) {
    return [fact("Ada lives in Berlin", { duplicate_of: berlin || null })];
  }
  return [fact(conversation.trim())];
};

describe("write-time reconcile (opt-in)", () => {
  it("is off by default: prompt, schema, and user content stay unchanged", async () => {
    const { llm, calls } = scriptedLLM(() => [fact("Ada lives in Paris")]);
    const memory = await Memory.create({
      embedder: new MockEmbedder(64),
      llm,
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
    });
    await memory.add("Ada lives in Berlin", { infer: false, userId: "ada" });
    await memory.add("Ada moved to Paris", { userId: "ada" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toBe(FACT_EXTRACTION_SYSTEM);
    expect(calls[0]!.user).toBe("user: Ada moved to Paris");
    const schema = calls[0]!.options?.jsonSchema?.schema as {
      properties: { facts: { items: { properties: Record<string, unknown> } } };
    };
    expect(schema.properties.facts.items.properties).not.toHaveProperty(
      "supersedes",
    );
    const all = await memory.getAll({ userId: "ada" });
    expect(all.results.every((record) => !record.validTo)).toBe(true);
  });

  it("supersedes a contradicted fact with validTo + supersededBy in one LLM call", async () => {
    const { memory, calls } = await createMemory(residenceScript);
    const seeded = await memory.add("Ada lives in Berlin", {
      infer: false,
      userId: "ada",
    });
    const oldId = seeded.results[0]!.id;

    const result = await memory.add("Ada moved to Paris last month", {
      userId: "ada",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain(RECONCILE_EXTRACTION_ADDENDUM);
    expect(calls[0]!.candidates).toEqual(["Ada lives in Berlin"]);
    const schema = calls[0]!.options?.jsonSchema?.schema as {
      properties: { facts: { items: { required: string[] } } };
    };
    expect(schema.properties.facts.items.required).toEqual(
      expect.arrayContaining(["duplicate_of", "supersedes"]),
    );

    const added = result.results.find((item) => item.event === "ADD")!;
    expect(added.memory).toBe("Ada lives in Paris");
    expect(result.results).toContainEqual({
      id: oldId,
      memory: "Ada lives in Berlin",
      event: "INVALIDATE",
    });
    const old = await memory.get(oldId);
    expect(old?.validTo).toBeInstanceOf(Date);
    expect(old?.supersededBy).toBe(added.id);
    expect(old?.forgotten).toBe(false);
    expect(old?.content).toBe("Ada lives in Berlin");
    expect((await memory.history(oldId)).map((entry) => entry.event)).toEqual([
      "ADD",
      "INVALIDATE",
    ]);
  });

  it("skips a duplicate fact and reports NONE without writing", async () => {
    const { memory } = await createMemory(residenceScript);
    const seeded = await memory.add("Ada lives in Berlin", {
      infer: false,
      userId: "ada",
    });
    const oldId = seeded.results[0]!.id;

    const result = await memory.add("Ada is still in Berlin", {
      userId: "ada",
    });

    expect(result.results).toEqual([
      { id: oldId, memory: "Ada lives in Berlin", event: "NONE" },
    ]);
    expect((await memory.getAll({ userId: "ada" })).results).toHaveLength(1);
    expect((await memory.get(oldId))?.validTo).toBeUndefined();
    expect((await memory.history(oldId)).map((entry) => entry.event)).toEqual([
      "ADD",
    ]);
  });

  it("uses the default prompt when no in-scope candidate exists", async () => {
    const { memory, calls } = await createMemory(residenceScript);
    const result = await memory.add("Ada moved to Paris", { userId: "ada" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toBe(FACT_EXTRACTION_SYSTEM);
    expect(calls[0]!.user).toBe("user: Ada moved to Paris");
    expect(result.results.map((item) => item.event)).toEqual(["ADD"]);
  });

  it("ignores invalid candidate references and stores additively", async () => {
    const { memory, warnings } = await createMemory(() => [
      fact("Ada lives in Paris", { supersedes: [0, 2, 1.5, "1"] }),
      fact("Ada works at Acme", { duplicate_of: 7 }),
    ]);
    const seeded = await memory.add("Ada lives in Berlin", {
      infer: false,
      userId: "ada",
    });

    const result = await memory.add("Ada moved to Paris and works at Acme", {
      userId: "ada",
    });

    expect(result.results.map((item) => [item.memory, item.event])).toEqual([
      ["Ada lives in Paris", "ADD"],
      ["Ada works at Acme", "ADD"],
    ]);
    expect((await memory.get(seeded.results[0]!.id))?.validTo).toBeUndefined();
    expect(
      warnings.filter(
        (warning) => warning.code === "reconcile_invalid_reference",
      ),
    ).toHaveLength(2);
  });

  it("never lets a fact supersede a candidate another fact marked duplicate", async () => {
    const { memory } = await createMemory(() => [
      fact("Ada lives in Berlin", { duplicate_of: 1 }),
      fact("Ada lives in Paris", { supersedes: [1] }),
    ]);
    const seeded = await memory.add("Ada lives in Berlin", {
      infer: false,
      userId: "ada",
    });
    const oldId = seeded.results[0]!.id;

    const result = await memory.add("Ada lives in Berlin and Paris", {
      userId: "ada",
    });

    expect(result.results.map((item) => item.event)).toEqual(["ADD", "NONE"]);
    expect((await memory.get(oldId))?.validTo).toBeUndefined();
  });

  it("never reconciles across namespace, user, agent, or run", async () => {
    const { memory, calls } = await createMemory(residenceScript);
    const alpha = memory.forNamespace("alpha");
    const beta = memory.forNamespace("beta");
    const seeds = [
      await beta.add("Ada lives in Berlin", { infer: false, userId: "ada" }),
      await alpha.add("Ada lives in Berlin", { infer: false, userId: "bob" }),
      await alpha.add("Ada lives in Berlin", {
        infer: false,
        userId: "ada",
        agentId: "planner",
      }),
      await alpha.add("Ada lives in Berlin", {
        infer: false,
        userId: "ada",
        runId: "run-1",
      }),
      await alpha.add("Ada lives in Berlin", { infer: false }),
    ].map((result) => result.results[0]!.id);

    const result = await alpha.add("Ada moved to Paris", { userId: "ada" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.candidates).toEqual([]);
    expect(result.results.map((item) => item.event)).toEqual(["ADD"]);
    for (const id of seeds) {
      const record = (await alpha.get(id)) ?? (await beta.get(id)) ?? undefined;
      expect(record?.validTo).toBeUndefined();
    }

    // The exact same scope is reconciled.
    const own = await alpha.add("Ada lives in Berlin", {
      infer: false,
      userId: "ada",
      runId: "run-2",
    });
    const scoped = await alpha.add("Ada moved to Paris", {
      userId: "ada",
      runId: "run-2",
    });
    expect(calls.at(-1)!.candidates).toEqual(["Ada lives in Berlin"]);
    expect(scoped.results).toContainEqual({
      id: own.results[0]!.id,
      memory: "Ada lives in Berlin",
      event: "INVALIDATE",
    });
  });

  it("excludes already-invalidated records from candidates", async () => {
    const { memory, calls } = await createMemory(residenceScript);
    const seeded = await memory.add("Ada lives in Berlin", {
      infer: false,
      userId: "ada",
    });
    await memory.invalidate(seeded.results[0]!.id, { userId: "ada" });

    await memory.add("Ada moved to Paris", { userId: "ada" });
    expect(calls[0]!.candidates).toEqual([]);
  });

  it("freezes reconcile decisions in the idempotent plan and replays without the LLM", async () => {
    const { memory, calls } = await createMemory(residenceScript);
    const alpha = memory.forNamespace("alpha");
    const seeded = await alpha.add("Ada lives in Berlin", {
      infer: false,
      userId: "ada",
    });
    const oldId = seeded.results[0]!.id;

    const first = await alpha.add("Ada moved to Paris", {
      userId: "ada",
      idempotencyKey: "reconcile-1",
    });
    const replay = await alpha.add("Ada moved to Paris", {
      userId: "ada",
      idempotencyKey: "reconcile-1",
    });

    expect(replay).toEqual(first);
    expect(calls).toHaveLength(1);
    const snapshot = await alpha.exportSnapshot();
    const addOperation = snapshot.data.operations.find(
      (operation) => operation.idempotencyKey === "reconcile-1",
    )!;
    const plan = addOperation.command.addPlan as {
      records: Array<{ supersedes?: Array<{ id: string }> }>;
    };
    expect(plan.records[0]!.supersedes).toEqual([
      { id: oldId, memory: "Ada lives in Berlin" },
    ]);
    const invalidateOperation = snapshot.data.operations.find(
      (operation) => operation.kind === "invalidate",
    )!;
    expect(invalidateOperation.idempotencyKey).toBe(
      `${addOperation.id}:reconcile:${oldId}`,
    );
    expect(
      snapshot.data.events
        .filter((event) => event.operationId === addOperation.id)
        .map((event) => event.eventType),
    ).toEqual(["ADD"]);
    expect(
      snapshot.data.events
        .filter((event) => event.operationId === invalidateOperation.id)
        .map((event) => event.eventType),
    ).toEqual(["INVALIDATE"]);
  });

  it("repairs a failed reconcile write from the frozen plan without a second LLM call", async () => {
    const { memory, calls } = await createMemory(residenceScript);
    const alpha = memory.forNamespace("alpha");
    const seeded = await alpha.add("Ada lives in Berlin", {
      infer: false,
      userId: "ada",
    });
    const oldId = seeded.results[0]!.id;
    const original = memory.invalidate.bind(memory);
    let failures = 1;
    memory.invalidate = async (...args) => {
      if (failures-- > 0) throw new Error("injected invalidate failure");
      return original(...args);
    };

    await expect(
      alpha.add("Ada moved to Paris", {
        userId: "ada",
        idempotencyKey: "reconcile-retry",
      }),
    ).rejects.toThrow("injected invalidate failure");
    expect((await alpha.get(oldId))?.validTo).toBeUndefined();

    const retried = await alpha.add("Ada moved to Paris", {
      userId: "ada",
      idempotencyKey: "reconcile-retry",
    });
    expect(calls).toHaveLength(1);
    const added = retried.results.find((item) => item.event === "ADD")!;
    expect((await alpha.get(oldId))?.supersededBy).toBe(added.id);
    expect(
      (await alpha.getAll({ userId: "ada" })).results.filter(
        (record) => record.content === "Ada lives in Paris",
      ),
    ).toHaveLength(1);
  });

  it("validates reconcile configuration", async () => {
    await expect(
      Memory.create({
        embedder: new MockEmbedder(8),
        llm: new MockLLM(),
        vectorStore: new InMemoryVectorStore(),
        graphStore: new InMemoryGraphStore(),
        reconcile: { enabled: true, candidates: 0 },
      }),
    ).rejects.toThrow("reconcile.candidates");
  });
});
