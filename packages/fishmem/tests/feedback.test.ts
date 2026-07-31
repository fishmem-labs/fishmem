import { describe, expect, it } from "vitest";
import { MockEmbedder } from "../src/embeddings/mock.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import { MockLLM } from "../src/llms/mock.js";
import { Memory } from "../src/memory.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";

async function newMemory() {
  return Memory.create({
    embedder: new MockEmbedder(32),
    graphStore: new InMemoryGraphStore(),
    llm: new MockLLM(),
    vectorStore: new InMemoryVectorStore(),
  });
}

describe("memory feedback", () => {
  it("stores one current signal in the immutable memory history", async () => {
    const engine = await newMemory();
    const memory = engine.forNamespace("workspace-a");
    const added = await memory.add("Ada prefers tea", {
      infer: false,
      userId: "ada",
    });
    const memoryId = added.results[0]!.id;

    const first = await memory.setFeedback(
      memoryId,
      {
        rating: "positive",
        reason: "Correctly recalled the preference",
        requestId: "req-search-1",
      },
      { idempotencyKey: "feedback-1" },
    );
    const replay = await memory.setFeedback(
      memoryId,
      {
        rating: "positive",
        reason: "Correctly recalled the preference",
        requestId: "req-search-1",
      },
      { idempotencyKey: "feedback-1" },
    );

    expect(replay).toEqual(first);
    await expect(memory.getFeedback(memoryId)).resolves.toEqual(first);
    const feedbackHistory = (await memory.history(memoryId)).filter(
      (entry) => entry.event === "FEEDBACK",
    );
    expect(feedbackHistory).toHaveLength(1);
    expect(JSON.parse(feedbackHistory[0]!.newValue!)).toMatchObject({
      memoryId,
      rating: "positive",
      requestId: "req-search-1",
    });
  });

  it("rejects idempotency conflicts and keeps namespace isolation", async () => {
    const engine = await newMemory();
    const owner = engine.forNamespace("workspace-a");
    const outsider = engine.forNamespace("workspace-b");
    const added = await owner.add("Ada prefers tea", {
      infer: false,
      userId: "ada",
    });
    const memoryId = added.results[0]!.id;

    await owner.setFeedback(
      memoryId,
      { rating: "negative" },
      { idempotencyKey: "feedback-same-key" },
    );
    await expect(
      owner.setFeedback(
        memoryId,
        { rating: "very_negative" },
        { idempotencyKey: "feedback-same-key" },
      ),
    ).rejects.toThrow("idempotency key conflict");
    await expect(outsider.getFeedback(memoryId)).resolves.toBeNull();
    await expect(
      outsider.setFeedback(memoryId, { rating: "positive" }),
    ).rejects.toThrow(`memory not found: ${memoryId}`);
  });

  it("clears current feedback without deleting its audit trail", async () => {
    const engine = await newMemory();
    const memory = engine.forNamespace("workspace-a");
    const added = await memory.add("Ada prefers tea", {
      infer: false,
      userId: "ada",
    });
    const memoryId = added.results[0]!.id;
    await memory.setFeedback(
      memoryId,
      { rating: "negative", reason: "Out of date" },
      { idempotencyKey: "feedback-set" },
    );

    await expect(
      memory.clearFeedback(memoryId, {
        idempotencyKey: "feedback-clear",
      }),
    ).resolves.toBe(true);
    await expect(memory.getFeedback(memoryId)).resolves.toBeNull();
    const feedbackHistory = (await memory.history(memoryId)).filter(
      (entry) => entry.event === "FEEDBACK",
    );
    expect(feedbackHistory).toHaveLength(2);
    expect(feedbackHistory[1]?.newValue).toBeNull();
  });

  it("round-trips current feedback and its audit event in a namespace snapshot", async () => {
    const sourceEngine = await newMemory();
    const source = sourceEngine.forNamespace("workspace-a");
    const added = await source.add("Ada prefers tea", {
      infer: false,
      userId: "ada",
    });
    const memoryId = added.results[0]!.id;
    const feedback = await source.setFeedback(
      memoryId,
      {
        rating: "negative",
        reason: "Preference changed",
        requestId: "req-search-2",
      },
      { idempotencyKey: "feedback-before-export" },
    );

    const snapshot = await source.exportSnapshot();
    expect(snapshot.data.events.at(-1)?.eventType).toBe("FEEDBACK");
    expect(snapshot.data.operations.at(-1)?.kind).toBe("feedback");

    const targetEngine = await newMemory();
    const target = targetEngine.forNamespace("workspace-restored");
    await expect(
      target.importSnapshot(snapshot, {
        idempotencyKey: "feedback-snapshot-import",
      }),
    ).resolves.toMatchObject({ imported: 1, vectors: 1 });
    await expect(target.getFeedback(memoryId)).resolves.toMatchObject({
      ...feedback,
      memoryId,
    });
    const restoredHistory = (await target.history(memoryId)).filter(
      (entry) => entry.event === "FEEDBACK",
    );
    expect(restoredHistory).toHaveLength(1);
  });
});
