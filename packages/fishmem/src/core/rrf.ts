import type { Memory } from "../types.js";

export interface ScoredMemory {
  memory: Memory;
  score: number;
}

/**
 * Reciprocal Rank Fusion. Combines several ranked lists into one:
 *
 *   RRF(d) = Σ_lists 1 / (k + rank_list(d))
 *
 * A document appearing in multiple lists has its contributions summed. This is
 * a port of spacebot's `reciprocal_rank_fusion` (search.rs:385-431), including
 * the default `k = 60`, extended with optional per-list weights (weight 1 for
 * every list = exact spacebot behaviour).
 */
export function reciprocalRankFusion(
  lists: ScoredMemory[][],
  k = 60,
  weights?: number[],
): ScoredMemory[] {
  const scores = new Map<string, { score: number; memory: Memory }>();

  lists.forEach((list, listIndex) => {
    const weight = weights?.[listIndex] ?? 1;
    list.forEach((scored, index) => {
      const rank = index + 1; // ranks are 1-based
      const contribution = weight / (k + rank);
      const entry = scores.get(scored.memory.id);
      if (entry) {
        entry.score += contribution;
      } else {
        scores.set(scored.memory.id, {
          score: contribution,
          memory: scored.memory,
        });
      }
    });
  });

  return [...scores.values()]
    .map(({ score, memory }) => ({ memory, score }))
    .sort((a, b) => b.score - a.score);
}
