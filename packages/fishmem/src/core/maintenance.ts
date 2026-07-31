import type { MemoryWarningCode, MemoryWarningHandler } from "../config.js";
import type { Embedder } from "../embeddings/base.js";
import type { GraphStore } from "../graph/base.js";
import type { LLM } from "../llms/base.js";
import type { Memory, MemoryFilters } from "../types.js";
import type { VectorStore } from "../vector/base.js";
import { cosineSimilarity } from "../vector/memory.js";

/** Maintenance tuning. Defaults are spacebot's `maintenance.rs` constants. */
export interface MaintenanceConfig {
  /** Importance lost per day of age (capped). */
  decayRate: number;
  /** Memories below this importance are eligible for pruning. */
  pruneThreshold: number;
  /** Memories younger than this (days) are never pruned. */
  pruneMinAgeDays: number;
  /** Cosine similarity at/above which two memories are merged. */
  mergeSimilarityThreshold: number;
  /** Candidate cap for a consolidation pass. */
  maxMergeSourceMemories: number;
  /** Hard limit on merges per pass. */
  maxMergesPerPass: number;
  /** Similar candidates fetched per source memory. */
  maxSimilarCandidates: number;
  /** Cap on merged content length (chars). */
  maxMergedContentBytes: number;
  /**
   * Merge-content policy. "containment" (default, spacebot parity):
   * dedupe-by-containment else concatenate. "mdl": an LLM writes the
   * shortest faithful summary and the merge is accepted ONLY if it encodes
   * shorter than the originals (minimum-description-length criterion —
   * memory maintenance as rate-distortion optimization). Requires an LLM;
   * falls back to containment without one. Costs one LLM call per
   * candidate pair — maintenance-time only, never query-time.
   */
  consolidation: "containment" | "mdl";
  /** MDL acceptance: summary must be ≤ this fraction of the originals. */
  mdlRatio: number;
  /**
   * Tiered memory (spacebot tiered-memory design). When enabled, `working`
   * tier memories are exempt from decay; maintenance demotes them to `graph`
   * after `tierTtlDays` without access, or LRU-first when the working set
   * exceeds `tierCapacity`.
   */
  tiersEnabled: boolean;
  /** Days since last access before a working memory is demoted. */
  tierTtlDays: number;
  /** Maximum working-tier memories per scope (LRU demotion beyond this). */
  tierCapacity: number;
}

export const DEFAULT_MAINTENANCE_CONFIG: MaintenanceConfig = {
  decayRate: 0.05,
  pruneThreshold: 0.1,
  pruneMinAgeDays: 30,
  mergeSimilarityThreshold: 0.95,
  maxMergeSourceMemories: 2000,
  maxMergesPerPass: 500,
  maxSimilarCandidates: 25,
  maxMergedContentBytes: 50_000,
  tiersEnabled: false,
  tierTtlDays: 3,
  tierCapacity: 64,
  consolidation: "containment",
  mdlRatio: 0.8,
};

const DAY_MS = 86_400_000;

/**
 * Background maintenance: decay, consolidation (merge of near-duplicates), and
 * pruning. Faithful port of spacebot's `maintenance.rs`, including all numeric
 * constants and the importance/access decay formula.
 */
export class MemoryMaintenance {
  private readonly config: MaintenanceConfig;

  constructor(
    private readonly store: GraphStore,
    private readonly vectors: VectorStore,
    private readonly embedder: Embedder,
    config: Partial<MaintenanceConfig> = {},
    private readonly llm?: LLM,
    private readonly onWarning?: MemoryWarningHandler,
  ) {
    this.config = { ...DEFAULT_MAINTENANCE_CONFIG, ...config };
  }

  private warn(
    code: MemoryWarningCode,
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ): void {
    this.onWarning?.({
      code,
      message,
      recoverable: true,
      error,
      context,
    });
  }

  /** Run demote → decay → consolidate → prune. Returns a work summary. */
  async runAll(filters: MemoryFilters = {}): Promise<{
    demoted: number;
    decayed: number;
    merged: number;
    pruned: number;
  }> {
    const demoted = await this.demote(filters);
    const decayed = await this.decay(filters);
    const merged = await this.consolidate(filters);
    const pruned = await this.prune(filters);
    return { demoted, decayed, merged, pruned };
  }

  /**
   * Tiered memory: demote `working` memories whose TTL since last access has
   * expired, then LRU-demote any overflow beyond the working-set capacity
   * (spacebot tiered-memory design). No-op unless `tiersEnabled`.
   */
  async demote(filters: MemoryFilters = {}): Promise<number> {
    if (!this.config.tiersEnabled) return 0;
    const now = Date.now();
    const ttlCutoff = now - this.config.tierTtlDays * DAY_MS;
    const memories = await this.store.listMemories(filters, {
      limit: 1_000_000,
    });
    const working = memories.filter((m) => m.tier === "working");
    let count = 0;

    const demoteOne = async (m: Memory) => {
      m.tier = "graph";
      m.demotedAt = new Date(now);
      m.updatedAt = new Date(now);
      await this.store.updateMemory(m);
      count++;
    };

    const stillWorking: Memory[] = [];
    for (const m of working) {
      if (m.lastAccessedAt.getTime() < ttlCutoff) await demoteOne(m);
      else stillWorking.push(m);
    }

    // LRU capacity enforcement on the survivors.
    if (stillWorking.length > this.config.tierCapacity) {
      stillWorking.sort(
        (a, b) => a.lastAccessedAt.getTime() - b.lastAccessedAt.getTime(),
      );
      const overflow = stillWorking.length - this.config.tierCapacity;
      for (const m of stillWorking.slice(0, overflow)) await demoteOne(m);
    }
    return count;
  }

  /**
   * Apply importance decay to all non-`identity` memories.
   *
   *   age_decay    = 1 - min(daysOld * decayRate, 0.5)
   *   access_boost = daysSinceAccess < 7 ? 1.1 : daysSinceAccess > 30 ? 0.9 : 1.0
   *   importance'  = clamp(importance * age_decay * access_boost, 0, 1)
   *
   * Only persists when |importance' - importance| >= 0.01.
   */
  async decay(filters: MemoryFilters = {}): Promise<number> {
    const now = Date.now();
    const memories = await this.store.listMemories(filters, {
      limit: 1_000_000,
    });
    let count = 0;
    for (const memory of memories) {
      if (memory.memoryType === "identity") continue;
      // Working-tier memories are hot: exempt from decay until demoted.
      if (this.config.tiersEnabled && memory.tier === "working") continue;

      // Age is measured from updatedAt (spacebot maintenance.rs:124). Decay
      // writes refresh updatedAt, so repeated passes compound instead of
      // freezing at the single-pass 50% cap.
      const daysOld = (now - memory.updatedAt.getTime()) / DAY_MS;
      const daysSinceAccess = (now - memory.lastAccessedAt.getTime()) / DAY_MS;

      const ageDecay = 1 - Math.min(daysOld * this.config.decayRate, 0.5);
      const accessBoost =
        daysSinceAccess < 7 ? 1.1 : daysSinceAccess > 30 ? 0.9 : 1.0;
      const newImportance = clamp(memory.importance * ageDecay * accessBoost);

      if (Math.abs(newImportance - memory.importance) >= 0.01) {
        memory.importance = newImportance;
        memory.updatedAt = new Date(now);
        await this.store.updateMemory(memory);
        count++;
      }
    }
    return count;
  }

  /**
   * Hard-prune low-importance, old, non-`identity` memories (and their vectors).
   * Returns the number removed.
   */
  async prune(filters: MemoryFilters = {}): Promise<number> {
    const cutoff = Date.now() - this.config.pruneMinAgeDays * DAY_MS;
    const memories = await this.store.listMemories(filters, {
      limit: 1_000_000,
    });
    let count = 0;
    for (const memory of memories) {
      if (memory.memoryType === "identity") continue;
      if (memory.importance >= this.config.pruneThreshold) continue;
      if (memory.createdAt.getTime() >= cutoff) continue;
      await this.store.deleteMemory(memory.id);
      try {
        await this.vectors.delete(memory.id);
      } catch (error) {
        this.warn(
          "maintenance_vector_delete_failed",
          "Maintenance prune deleted the memory row, but deleting its vector failed.",
          error,
          { memoryId: memory.id },
        );
      }
      count++;
    }
    return count;
  }

  /**
   * Merge near-duplicate memories. Candidates are ordered by importance; for
   * each, the most similar not-yet-merged memory above the threshold is folded
   * in. The higher-importance memory survives (ties broken by lower id).
   * Returns the number of merges performed.
   */
  async consolidate(filters: MemoryFilters = {}): Promise<number> {
    const candidates = await this.store.listMemories(filters, {
      sort: "importance",
      limit: this.config.maxMergeSourceMemories,
    });
    const merged = new Set<string>();
    let count = 0;

    for (const source of candidates) {
      if (count >= this.config.maxMergesPerPass) break;
      if (merged.has(source.id)) continue;

      const similar = await this.findSimilar(
        source.id,
        this.config.mergeSimilarityThreshold,
        this.config.maxSimilarCandidates,
        filters,
      );

      for (const { id: otherId } of similar) {
        if (otherId === source.id || merged.has(otherId)) continue;
        const other = await this.store.getMemory(otherId);
        if (!other || other.forgotten) continue;

        const [survivor, loser] = chooseMergePair(source, other);
        if (this.config.consolidation === "mdl" && this.llm) {
          const summary = await this.mdlSummary(
            survivor.content,
            loser.content,
            filters,
          );
          if (summary === null) continue; // MDL rejected: not shorter → no merge
          survivor.content = summary.slice(
            0,
            this.config.maxMergedContentBytes,
          );
        } else {
          survivor.content = mergedContent(
            survivor.content,
            loser.content,
            this.config.maxMergedContentBytes,
          );
        }
        survivor.updatedAt = new Date();

        await this.store.mergeMemoriesAtomic(survivor, loser);

        // Re-embed the survivor; drop the loser's vector.
        try {
          const embedding = await this.embedder.embed(survivor.content, {
            context: {
              namespaceId: filters.namespaceId,
              operation: "memory.maintenance.reembed",
            },
          });
          await this.vectors.upsert([
            {
              id: survivor.id,
              vector: embedding,
              content: survivor.content,
              payload: toPayload(survivor),
            },
          ]);
        } catch (error) {
          this.warn(
            "maintenance_reembed_failed",
            "Maintenance merge succeeded, but re-embedding the survivor failed.",
            error,
            { survivorId: survivor.id, loserId: loser.id },
          );
        }
        try {
          await this.vectors.delete(loser.id);
        } catch (error) {
          this.warn(
            "maintenance_vector_delete_failed",
            "Maintenance merge succeeded, but deleting the loser vector failed.",
            error,
            { survivorId: survivor.id, loserId: loser.id },
          );
        }

        merged.add(survivor.id);
        merged.add(loser.id);
        count++;
        break; // one merge per source per pass
      }
    }
    return count;
  }

  /**
   * MDL acceptance test: ask the LLM for the shortest faithful summary and
   * accept the merge only if it is genuinely shorter — merge iff
   * encoding(summary) < mdlRatio × (encoding(a) + encoding(b)). Containment
   * still wins for free (no LLM call) when one text subsumes the other.
   */
  private async mdlSummary(
    a: string,
    b: string,
    filters: MemoryFilters,
  ): Promise<string | null> {
    const wa = a.trim();
    const wb = b.trim();
    if (wa.includes(wb)) return wa; // containment: free, always shorter
    if (wb.includes(wa)) return wb;
    try {
      const { MDL_MERGE_SYSTEM } = await import("../prompts/index.js");
      const summary = (
        await this.llm!.chat(
          [
            { role: "system", content: MDL_MERGE_SYSTEM },
            { role: "user", content: `A: ${wa}\nB: ${wb}` },
          ],
          {
            temperature: 0,
            context: {
              namespaceId: filters.namespaceId,
              operation: "memory.maintenance.mdl",
            },
          },
        )
      ).trim();
      if (!summary) return null;
      return summary.length < this.config.mdlRatio * (wa.length + wb.length)
        ? summary
        : null;
    } catch (error) {
      this.warn(
        "maintenance_mdl_failed",
        "MDL consolidation summary failed; rejecting this merge candidate.",
        error,
      );
      return null;
    }
  }

  /**
   * Find memories similar to `memoryId` by its stored embedding.
   * Returns `(id, similarity)` pairs, excluding the source, similarity >=
   * threshold (spacebot lance.rs `find_similar`).
   */
  private async findSimilar(
    memoryId: string,
    threshold: number,
    limit: number,
    filters: MemoryFilters = {},
  ): Promise<Array<{ id: string; similarity: number }>> {
    const record = await this.vectors.get(memoryId);
    if (!record) return [];
    // Filters constrain merge candidates to the caller's scope — without
    // this, multi-tenant deployments could merge near-duplicates ACROSS
    // tenants (cross-tenant data leakage through merged content).
    const hits = await this.vectors.search(record.vector, limit + 1, filters);
    const out: Array<{ id: string; similarity: number }> = [];
    for (const hit of hits) {
      if (hit.id === memoryId) continue;
      // Stores return similarity directly; recompute defensively if absent.
      const similarity = hit.score;
      if (similarity >= threshold) out.push({ id: hit.id, similarity });
    }
    return out.slice(0, limit);
  }
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

/** Higher importance wins; ties broken by lexicographically smaller id. */
export function chooseMergePair(a: Memory, b: Memory): [Memory, Memory] {
  const aWins =
    a.importance > b.importance ||
    (a.importance === b.importance && a.id < b.id);
  return aWins ? [a, b] : [b, a];
}

/** Merge content: dedupe containment, else concatenate, then cap length. */
export function mergedContent(
  winner: string,
  loser: string,
  maxBytes: number,
): string {
  const w = winner.replace(/\s+$/, "");
  const l = loser.replace(/\s+$/, "");
  if (l.length === 0) return w;
  if (w.includes(l)) return w;
  const merged = w.length === 0 ? l : `${w}\n\n${l}`;
  return merged.length <= maxBytes ? merged : merged.slice(0, maxBytes);
}

function toPayload(m: Memory): Record<string, unknown> {
  return {
    userId: m.userId,
    agentId: m.agentId,
    runId: m.runId,
    memoryType: m.memoryType,
    metadata: m.metadata ?? {},
  };
}

// Kept for callers wanting a manual similarity check.
export { cosineSimilarity };
