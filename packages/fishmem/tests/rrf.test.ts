import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, type ScoredMemory } from "../src/core/rrf.js";
import type { Memory } from "../src/types.js";

function scored(id: string): ScoredMemory {
  const now = new Date();
  const memory: Memory = {
    id,
    content: `content for ${id}`,
    memoryType: "fact",
    importance: 0.5,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    forgotten: false,
  };
  return { memory, score: 0 };
}

describe("reciprocalRankFusion", () => {
  it("ranks a single list by position", () => {
    const fused = reciprocalRankFusion([[scored("a"), scored("b")]], 60);
    expect(fused.map((f) => f.memory.id)).toEqual(["a", "b"]);
    // First item: 1/(60+1)
    expect(fused[0]!.score).toBeCloseTo(1 / 61, 10);
  });

  it("sums scores for items in multiple lists", () => {
    const fused = reciprocalRankFusion([[scored("a")], [scored("a")]], 60);
    expect(fused).toHaveLength(1);
    expect(fused[0]!.score).toBeCloseTo(2 / 61, 10);
  });

  it("ranks multi-list items above single-list items", () => {
    const vector = [scored("a"), scored("b")];
    const fts = [scored("a")];
    const graph = [scored("a")];
    const fused = reciprocalRankFusion([vector, fts, graph], 60);
    expect(fused[0]!.memory.id).toBe("a");
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score);
  });

  it("handles empty input", () => {
    expect(reciprocalRankFusion([[], [], []], 60)).toHaveLength(0);
  });

  it("applies per-list weights", () => {
    // "b" is rank 1 in the down-weighted list; "a" is rank 1 in the full-weight
    // list — a must win despite identical ranks.
    const fused = reciprocalRankFusion(
      [[scored("a")], [scored("b")]],
      60,
      [1.0, 0.5],
    );
    expect(fused[0]!.memory.id).toBe("a");
    expect(fused[0]!.score).toBeCloseTo(1 / 61, 10);
    expect(fused[1]!.score).toBeCloseTo(0.5 / 61, 10);
  });

  it("weight of 1 for every list equals unweighted behaviour", () => {
    const lists = [[scored("a"), scored("b")], [scored("a")]];
    const unweighted = reciprocalRankFusion(lists, 60);
    const weighted = reciprocalRankFusion(lists, 60, [1, 1]);
    expect(weighted).toEqual(unweighted);
  });
});
