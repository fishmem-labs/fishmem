import { describe, expect, it } from "vitest";
import { SqliteVectorStore } from "../src/vector/sqlite.js";

describe("SqliteVectorStore scores", () => {
  it("reports raw cosine similarity like every other vector store", async () => {
    const store = new SqliteVectorStore({ url: ":memory:" });
    await store.init(2);
    await store.upsert([
      { id: "same", vector: [1, 0], content: "same", payload: {} },
      { id: "orthogonal", vector: [0, 1], content: "orthogonal", payload: {} },
      { id: "opposite", vector: [-1, 0], content: "opposite", payload: {} },
    ]);
    const hits = await store.search([1, 0], 3);
    const score = (id: string) => hits.find((hit) => hit.id === id)?.score;
    expect(score("same")).toBeCloseTo(1, 5);
    expect(score("orthogonal")).toBeCloseTo(0, 5);
    expect(score("opposite")).toBeCloseTo(-1, 5);
  });
});
