import type { MemoryWarningCode, MemoryWarningHandler } from "../config.js";
import type { Embedder } from "../embeddings/base.js";
import type { GraphStore } from "../graph/base.js";
import type { LLM } from "../llms/base.js";
import {
  type Entity,
  type Memory,
  type MemoryFilters,
  type MemorySearchResult,
  RELATION_TYPE_MULTIPLIER,
  type SearchMode,
  type SearchSort,
} from "../types.js";
import type { VectorRecord, VectorStore } from "../vector/base.js";
import { cosineSimilarity, matchesFilters } from "../vector/memory.js";
import { type CalibrationTables, calibrate, noisyOr } from "./calibration.js";
import { matchesMemoryFilter } from "./filter.js";
import { reciprocalRankFusion, type ScoredMemory } from "./rrf.js";
import { extractDateRange, temporalKernel } from "./temporal.js";
import { contentHash } from "./util.js";

/** Per-source retrieval trace — the raw material for fusion calibration. */
export interface SearchTrace {
  lists: {
    vector: Array<{ id: string; score: number }>;
    fts: Array<{ id: string; score: number }>;
    graph: Array<{ id: string; score: number }>;
    temporal: Array<{ id: string; score: number }>;
  };
  fused: Array<{ id: string; score: number }>;
  selected: string[];
  /** Contents of the selected memories (query-map fitting needs the text). */
  selectedItems: Array<{ id: string; content: string }>;
}

/** Coarse query intent used to route between precision and recall lanes. */
export type SearchIntent =
  | "single_fact"
  | "temporal"
  | "multi_hop"
  | "synthesis";

/**
 * High-level retrieval strategy.
 * - balanced: vector + lexical + temporal, no graph expansion.
 * - precision: narrow point-fact lane, no graph expansion.
 * - recall: full graph/PPR recall lane for multi-hop/enumeration workloads.
 * - auto: query-intent routing across the lanes. Opt-in until paired
 *   holdout/cross-dataset ablations justify making it a default.
 */
export type SearchStrategy = "balanced" | "precision" | "recall" | "auto";

/** Search configuration. Defaults mirror spacebot's `SearchConfig`. */
export interface SearchConfig {
  mode: SearchMode;
  memoryType?: Memory["memoryType"];
  sortBy: SearchSort;
  /** Final number of results to return. */
  maxResults: number;
  /** Candidates fetched from each source (vector, FTS, graph) in hybrid mode. */
  maxResultsPerSource: number;
  /** RRF k parameter. */
  rrfK: number;
  /** Minimum fused score threshold. */
  minScore: number;
  /** Maximum graph-traversal depth. */
  maxGraphDepth: number;
  /** Importance threshold for graph seed memories. */
  graphSeedImportance: number;
  /** Maximum number of graph seed memories. */
  graphSeedLimit: number;
  /**
   * Also seed graph traversal from this many top vector hits (0 disables).
   * Additive on top of spacebot's importance-based seeding: it lets the
   * association graph pull in sibling facts ("enumerate all X" recall) even
   * when no memory clears the importance threshold.
   */
  graphSeedFromVectorHits: number;
  /**
   * Graph ranking algorithm. "ppr" (default) runs Personalized PageRank over
   * the seeds' neighbourhood (HippoRAG-style diffusion — markedly better
   * multi-hop recall). "bfs" is spacebot's original importance×weight×type
   * push scoring.
   */
  graphRank: "ppr" | "bfs";
  /** PPR damping factor. */
  pprDamping: number;
  /** PPR power-iteration count. */
  pprIterations: number;
  /**
   * Per-source RRF weights. Vector hits carry the precision signal; FTS and
   * graph mostly add recall, so they get lower votes and stop displacing
   * exact semantic matches from a small top-k. `temporal` weights the
   * date-filtered stream used when the query names a date range.
   * `{1, 1, 1}` + temporal 0 = spacebot parity.
   */
  rrfWeights: { vector: number; fts: number; graph: number; temporal: number };
  /**
   * Diversity pass: drop a fused result whose embedding is more similar than
   * this to an already-selected result, freeing top-k slots for distinct
   * facts (atomic extraction creates many near-duplicates). 0 disables.
   */
  diversityThreshold: number;
  /**
   * When an invalidated memory is retrieved, also pull in its successor
   * (`supersededBy` chain) so old and current state appear together. Pure
   * lookup, no LLM cost.
   */
  followInvalidation: boolean;
  /**
   * Listwise LLM rerank of the fused candidates before the final cut.
   * Costs one LLM call per search (≈300–500 ms + tokens) — OFF by default;
   * enable for offline/quality-first workloads. Requires an LLM to be
   * wired into MemorySearch (the Memory facade does this automatically).
   */
  rerank: boolean;
  /** Candidates fed to the reranker. */
  rerankCandidates: number;
  /** Follow-up sub-queries issued by deep mode (per round). */
  deepFollowups: number;
  /**
   * Recall over the entity graph (Phase 1): query-matched entities seed PPR
   * over the bipartite entity–memory graph with directional typed
   * transitions (belief mass flows old→new along `updates`, cause→effect
   * along `caused_by`/`result_of`). Falls back to the memory-association
   * graph when no entity matches the query. false = memory graph only.
   */
  entityGraph: boolean;
  /**
   * Temporal kernel width (days) for the date stream: memories outside the
   * query's date range score exp(−distance/τ) instead of being excluded —
   * near-miss dates stay retrievable. 0 = legacy boolean range filter.
   */
  temporalKernelTauDays: number;
  /**
   * Final-cut selection objective. "coverage" (default) greedily maximizes
   * relevance + coverage of the question's terms − redundancy (submodular
   * greedy, (1−1/e) guarantee on the coverage part) — built for multi-hop
   * and enumeration questions where the top-k must contain COMPLEMENTARY
   * facts. "diversity" is the legacy near-duplicate threshold pass.
   */
  selection: "coverage" | "diversity";
  /** Weight of the coverage-gain term in the selection objective. */
  coverageWeight: number;
  /** Weight of the redundancy (max-similarity-to-selected) penalty. */
  redundancyWeight: number;
  /**
   * Fusion algorithm. "rrf" (default) is rank-based; "calibrated" replaces
   * it with noisy-OR pooling of per-source isotonic probabilities — requires
   * `calibration` tables fit from retrieval traces
   * (benchmarks/fit-calibration.ts). Falls back to RRF when tables are
   * missing. Opt-in until ablation pays (constitution, law 2).
   */
  fusion: "rrf" | "calibrated";
  /** Per-source calibration curves for the "calibrated" fusion mode. */
  calibration?: CalibrationTables;
  /**
   * Learned query→statement map (questions and stored facts occupy
   * different regions of embedding space). Applied to the QUERY embedding
   * only: q' = normalize(q + U·(Vᵀ·q)). Factors are ridge-fit offline from
   * (question, evidence-memory) trace pairs — benchmarks/fit-querymap.ts.
   * Zero inference cost beyond two thin matrix products.
   */
  queryMap?: { u: number[][]; v: number[][] };
  /**
   * Record the per-source candidate lists and fused ranking on each search
   * (returned via `MemorySearch.lastTrace`). Pure bookkeeping — used by the
   * harness to collect calibration traces. Off by default.
   */
  traceRetrieval: boolean;
  /**
   * Substitute ≥2 same-episode facts with the episode's gist memory when
   * the gist costs fewer tokens (requires `contextBudgetTokens` > 0 and
   * gists created via `summarizeEpisode`). A context-assembly policy, not
   * a retrieval source. Default off.
   */
  gistSubstitution: boolean;
  /**
   * Optional context token budget (≈ chars/4). When > 0, selection packs
   * results by score density (score per token) up to the budget instead of
   * a fixed count — easy questions use fewer tokens, enumerations more.
   * maxResults remains the hard cap. 0 = off.
   */
  contextBudgetTokens: number;
  /** Retrieval lane. Defaults to "balanced"; graph/PPR and auto-routing are opt-in. */
  searchStrategy: SearchStrategy;
  /**
   * Route obvious point-fact questions through a precision lane that avoids
   * graph/profile-style recall expansion. This is query-only routing, not a
   * benchmark category switch: dates still use the temporal lane, broad/list
   * questions stay on the hybrid recall path.
   *
   * @deprecated Use `searchStrategy: "auto"` instead. Kept as a compatibility
   * alias while the router stays opt-in.
   */
  queryRouting: "auto" | "off";
  /** Maximum results returned by the single-fact precision lane. */
  singleFactMaxResults: number;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  mode: "hybrid",
  sortBy: "recent",
  maxResults: 10,
  maxResultsPerSource: 50,
  rrfK: 60,
  minScore: 0,
  maxGraphDepth: 2,
  graphSeedImportance: 0.8,
  graphSeedLimit: 20,
  graphSeedFromVectorHits: 5,
  graphRank: "ppr",
  pprDamping: 0.5,
  pprIterations: 15,
  // Lexical FTS defaults OFF (weight 0): same-store ablation showed the
  // lexical source is net-negative on LOCOMO (−7.5pt, p=0.0001) AND on
  // LongMemEval (+4.7pt with it off) — it pulls term-overlap-but-wrong facts
  // into context and hurts precision. Kept opt-in (raise this weight) for
  // exact-match-heavy workloads. Intermediate weights unexplored; 0 is the
  // validated best of {0, 0.7}.
  rrfWeights: { vector: 1.0, fts: 0, graph: 0.5, temporal: 0.8 },
  diversityThreshold: 0.92,
  followInvalidation: true,
  rerank: false,
  rerankCandidates: 30,
  deepFollowups: 2,
  temporalKernelTauDays: 0,
  entityGraph: false,
  selection: "coverage",
  coverageWeight: 0.5,
  redundancyWeight: 0.3,
  traceRetrieval: false,
  fusion: "rrf",
  gistSubstitution: false,
  contextBudgetTokens: 0,
  searchStrategy: "balanced",
  queryRouting: "off",
  singleFactMaxResults: 5,
};

/**
 * Hybrid memory search: semantic (vector) + keyword (FTS) + graph traversal,
 * fused with Reciprocal Rank Fusion. A direct port of spacebot's `MemorySearch`.
 */
export class MemorySearch {
  /** Trace of the most recent hybrid search (when `traceRetrieval` is on). */
  lastTrace: SearchTrace | null = null;

  constructor(
    private readonly store: GraphStore,
    private readonly vectors: VectorStore,
    private readonly embedder: Embedder,
    /** Optional — only needed when `rerank` is enabled. */
    private readonly llm?: LLM,
    private readonly onWarning?: MemoryWarningHandler,
  ) {}

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

  async search(
    query: string,
    config: SearchConfig,
    filters: MemoryFilters = {},
  ): Promise<MemorySearchResult[]> {
    const scoped = { ...filters, recordKind: "memory" as const };
    switch (config.mode) {
      case "recent":
        return this.metadataSearch("recent", config, scoped);
      case "important":
        return this.metadataSearch("importance", config, scoped);
      case "typed":
        return this.metadataSearch(config.sortBy, config, scoped);
      case "deep":
        return this.deepSearch(query, config, scoped);
      default:
        switch (resolveSearchStrategy(query, config)) {
          case "precision":
            return this.singleFactSearch(query, config, scoped);
          case "recall":
            return this.hybridSearch(query, config, scoped, {
              graphExpansion: true,
            });
          default:
            return this.hybridSearch(query, config, scoped, {
              graphExpansion: false,
            });
        }
    }
  }

  /**
   * Deep recall (opt-in, breaks the zero-LLM budget by design): one hybrid
   * round, then an LLM names what the retrieved set is still missing as up
   * to `deepFollowups` sub-queries, each searched and merged, with the
   * final cut re-selected over the union. For offline / quality-ceiling
   * workloads — never the default path (constitution: rejected/deferred
   * list, "opt-in only").
   */
  private async deepSearch(
    query: string,
    config: SearchConfig,
    filters: MemoryFilters,
  ): Promise<MemorySearchResult[]> {
    const round1 = await this.hybridSearch(query, config, filters, {
      graphExpansion: true,
    });
    if (!this.llm) return round1;

    let followups: string[] = [];
    try {
      const listing = round1
        .map((r) => `- ${r.memory.content.slice(0, 200)}`)
        .join("\n");
      const raw = await this.llm.chat(
        [
          {
            role: "system",
            content:
              'You analyze retrieval gaps. FISHMEM_TASK: deepgap\nGiven a question and the memories retrieved so far, name what is still MISSING to answer fully. Respond {"queries": ["<search query>", ...]} with at most ' +
              String(config.deepFollowups) +
              " short search queries (empty list if nothing is missing).",
          },
          {
            role: "user",
            content: `Question: ${query}\n\nRetrieved so far:\n${listing || "(nothing)"}`,
          },
        ],
        {
          responseFormat: "json",
          temperature: 0,
          context: {
            namespaceId: filters.namespaceId,
            operation: "memory.search.deep_followup",
          },
        },
      );
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      if (Array.isArray(parsed.queries)) {
        followups = parsed.queries
          .filter(
            (q: unknown): q is string => typeof q === "string" && !!q.trim(),
          )
          .slice(0, config.deepFollowups);
      }
    } catch (error) {
      this.warn(
        "search_deep_followup_failed",
        "Deep recall follow-up query generation failed; returning the first retrieval round.",
        error,
        { query, ...filters },
      );
      followups = [];
    }
    if (!followups.length) return round1;

    const round1Ids = new Set(round1.map((r) => r.memory.id));
    const subConfig: SearchConfig = {
      ...config,
      mode: "hybrid",
      maxResults: Math.max(3, Math.floor(config.maxResults / 2)),
    };
    const gapFills = new Map<string, MemorySearchResult>();
    for (const followup of followups) {
      const extra = await this.hybridSearch(followup, subConfig, filters, {
        graphExpansion: true,
      });
      for (const r of extra) {
        if (round1Ids.has(r.memory.id)) continue;
        const prev = gapFills.get(r.memory.id);
        if (!prev || r.score > prev.score) gapFills.set(r.memory.id, r);
      }
    }
    if (!gapFills.size) return round1;
    // Reserved-slot merge: gap-fillers exist precisely because the original
    // query could not surface them — re-cutting against the original
    // query's aspects would drop them again. Reserve up to a third of the
    // final slots for the strongest new findings.
    const reserve = Math.min(
      gapFills.size,
      Math.max(1, Math.ceil(config.maxResults / 3)),
    );
    const fills = [...gapFills.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, reserve);
    const merged = [
      ...round1.slice(0, Math.max(0, config.maxResults - fills.length)),
      ...fills,
    ];
    return merged.map((r, i) => ({
      memory: r.memory,
      score: r.score,
      rank: i + 1,
    }));
  }

  /** SQLite/relational-only search for Recent/Important/Typed modes. */
  private async metadataSearch(
    sort: SearchSort,
    config: SearchConfig,
    filters: MemoryFilters,
  ): Promise<MemorySearchResult[]> {
    const scoped: MemoryFilters = { ...filters };
    if (config.memoryType) scoped.memoryType = config.memoryType;
    const memories = await this.store.listMemories(scoped, {
      sort,
      limit: config.maxResults,
    });
    const total = memories.length;
    return memories.map((memory, rank) => ({
      memory,
      // Normalised positional score (spacebot search.rs:145-149).
      score: total > 1 ? 1 - rank / total : 1,
      rank: rank + 1,
    }));
  }

  /** Full hybrid retrieval with RRF fusion. */
  async hybridSearch(
    query: string,
    config: SearchConfig,
    filters: MemoryFilters,
    opts: { graphExpansion?: boolean } = {},
  ): Promise<MemorySearchResult[]> {
    const ftsResults: ScoredMemory[] = [];
    const vectorResults: ScoredMemory[] = [];
    const graphResults: ScoredMemory[] = [];
    const graphExpansion = opts.graphExpansion ?? true;
    const candidateLimit =
      filters.metadata || filters.predicate
        ? Math.min(
            Math.max(config.maxResultsPerSource * 8, config.maxResults * 20),
            1_000,
          )
        : config.maxResultsPerSource;

    // 1. Full-text search (if the vector store supports it).
    if (this.vectors.textSearch) {
      try {
        const hits = await this.vectors.textSearch(
          query,
          candidateLimit,
          filters,
        );
        for (const hit of hits) {
          const memory = await this.loadVisible(hit.id, filters);
          if (memory) ftsResults.push({ memory, score: hit.score });
        }
      } catch (error) {
        this.warn(
          "search_fts_failed",
          "Full-text search failed in hybrid search; falling back to vector and graph lanes.",
          error,
          { query, lane: "hybrid", ...filters },
        );
      }
    }

    // 2. Vector similarity search.
    try {
      let embedding = await this.embedder.embed(query, {
        context: {
          namespaceId: filters.namespaceId,
          operation: "memory.search.embedding",
        },
      });
      if (config.queryMap)
        embedding = applyQueryMap(embedding, config.queryMap);
      const hits = await this.vectors.search(
        embedding,
        candidateLimit,
        filters,
      );
      for (const hit of hits) {
        const memory = await this.loadVisible(hit.id, filters);
        if (memory) vectorResults.push({ memory, score: hit.score });
      }
    } catch (error) {
      this.warn(
        "search_vector_failed",
        "Vector search failed in hybrid search; falling back to graph and lexical lanes.",
        error,
        { query, lane: "hybrid", ...filters },
      );
    }

    if (graphExpansion) {
      // 3. Graph recall. Seeds: high-importance memories lexically matching the
      //    query (spacebot parity) plus top vector hits (additive). Ranking is
      //    either PPR diffusion over the seeds' neighbourhood or spacebot BFS.
      const importanceSeeds = await this.store.getHighImportance(
        config.graphSeedImportance,
        config.graphSeedLimit,
        filters,
      );
      const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const seedMass = new Map<string, { memory: Memory; mass: number }>();
      for (const seed of importanceSeeds) {
        const content = seed.content.toLowerCase();
        if (queryTerms.some((term) => content.includes(term))) {
          seedMass.set(seed.id, { memory: seed, mass: seed.importance });
        }
      }
      for (const hit of vectorResults.slice(
        0,
        config.graphSeedFromVectorHits,
      )) {
        if (!seedMass.has(hit.memory.id)) {
          seedMass.set(hit.memory.id, {
            memory: hit.memory,
            mass: Math.max(hit.score, 0.05),
          });
        }
      }

      if (config.graphRank === "ppr") {
        const entityRanked = config.entityGraph
          ? await this.pprEntityGraphRank(query, seedMass, config, filters)
          : null;
        if (entityRanked) {
          graphResults.push(...entityRanked);
        } else {
          graphResults.push(
            ...(await this.pprGraphRank(seedMass, config, filters)),
          );
        }
      } else {
        for (const { memory: seed } of seedMass.values()) {
          if (seed.importance >= config.graphSeedImportance) {
            graphResults.push({ memory: seed, score: seed.importance });
          }
          await this.traverseGraph(
            seed.id,
            config.maxGraphDepth,
            graphResults,
            filters,
          );
        }
      }
    }

    // 3.5 Time-aware stream (LongMemEval): when the query names an absolute
    //     date range, add memories near it — kernel-scored, so near-miss
    //     dates degrade smoothly instead of vanishing at the range edge.
    const temporalResults: ScoredMemory[] = [];
    if (config.rrfWeights.temporal > 0) {
      const range = extractDateRange(query);
      if (range) {
        const tau = config.temporalKernelTauDays;
        // Fetch a window widened by ~3τ on each side (kernel tail support).
        const padMs = tau > 0 ? 3 * tau * 86_400_000 : 0;
        const dated = await this.store.listMemories(
          {
            ...filters,
            eventDateFrom: new Date(range.from.getTime() - padMs),
            eventDateTo: new Date(range.to.getTime() + padMs),
          },
          { sort: "recent", limit: candidateLimit },
        );
        if (tau > 0) {
          const scored = dated
            .map((memory) => ({
              memory,
              score: memory.eventDate
                ? temporalKernel(memory.eventDate, range, tau)
                : 0,
            }))
            .filter((s) => s.score > 0.01)
            .sort((a, b) => b.score - a.score);
          temporalResults.push(...scored);
        } else {
          // Legacy boolean mode (spacebot-era behaviour).
          dated.forEach((memory, i) => {
            temporalResults.push({
              memory,
              score: dated.length > 1 ? 1 - i / dated.length : 1,
            });
          });
        }
      }
    }

    // 4. Fuse. Default: weighted RRF (rank-based). Calibrated mode: noisy-OR
    //    pooling of per-source isotonic probabilities (when tables exist).
    const lists = {
      vector: vectorResults,
      fts: ftsResults,
      graph: dedupeByBestScore(graphResults),
      temporal: temporalResults,
    };
    const fused =
      config.fusion === "calibrated" && config.calibration
        ? calibratedFusion(lists, config)
        : reciprocalRankFusion(
            [lists.vector, lists.fts, lists.graph, lists.temporal],
            config.rrfK,
            [
              config.rrfWeights.vector,
              config.rrfWeights.fts,
              config.rrfWeights.graph,
              config.rrfWeights.temporal,
            ],
          );

    // 5. Filter → optional LLM rerank → diversity pass → invalidation-chain
    //    completion → rank + limit.
    let filtered = fused
      .filter(
        (s) => !config.memoryType || s.memory.memoryType === config.memoryType,
      )
      .filter((s) => s.score >= config.minScore);
    if (config.rerank && this.llm) {
      filtered = await this.rerank(query, filtered, config, filters);
    }
    let selected =
      config.selection === "coverage"
        ? await this.coverageSelect(query, filtered, config)
        : await this.diversify(
            filtered,
            config.maxResults,
            config.diversityThreshold,
          );
    if (config.followInvalidation) {
      selected = await this.followSuccessors(selected, config.maxResults);
    }
    if (config.traceRetrieval) {
      this.lastTrace = {
        lists: {
          vector: vectorResults.map((r) => ({
            id: r.memory.id,
            score: r.score,
          })),
          fts: ftsResults.map((r) => ({ id: r.memory.id, score: r.score })),
          graph: graphResults.map((r) => ({ id: r.memory.id, score: r.score })),
          temporal: temporalResults.map((r) => ({
            id: r.memory.id,
            score: r.score,
          })),
        },
        fused: fused.map((r) => ({ id: r.memory.id, score: r.score })),
        selected: selected.map((r) => r.memory.id),
        selectedItems: selected.map((r) => ({
          id: r.memory.id,
          content: r.memory.content,
        })),
      };
    }
    return selected.map((s, i) => ({
      memory: s.memory,
      score: s.score,
      rank: i + 1,
    }));
  }

  /**
   * Precision lane for point-fact questions. It deliberately does not expand
   * through graph neighbours: for single-hop QA, the failure mode is usually
   * adjacent-but-wrong context, not missing a bridge fact. Ranking is additive
   * over semantic similarity, lexical/BM25 score, and exact subject/entity
   * matches.
   */
  private async singleFactSearch(
    query: string,
    config: SearchConfig,
    filters: MemoryFilters,
  ): Promise<MemorySearchResult[]> {
    const ftsResults: ScoredMemory[] = [];
    const vectorResults: ScoredMemory[] = [];
    const candidateLimit =
      filters.metadata || filters.predicate
        ? Math.min(
            Math.max(
              config.maxResultsPerSource * 8,
              config.maxResults * 20,
              60,
            ),
            1_000,
          )
        : Math.max(config.maxResultsPerSource, 60);

    if (this.vectors.textSearch) {
      try {
        const hits = await this.vectors.textSearch(
          query,
          candidateLimit,
          filters,
        );
        for (const hit of hits) {
          const memory = await this.loadVisible(hit.id, filters);
          if (memory) ftsResults.push({ memory, score: hit.score });
        }
      } catch (error) {
        this.warn(
          "search_fts_failed",
          "Full-text search failed in precision search; continuing without lexical candidates.",
          error,
          { query, lane: "precision", ...filters },
        );
      }
    }

    try {
      let embedding = await this.embedder.embed(query, {
        context: {
          namespaceId: filters.namespaceId,
          operation: "memory.search.precision_embedding",
        },
      });
      if (config.queryMap)
        embedding = applyQueryMap(embedding, config.queryMap);
      const hits = await this.vectors.search(
        embedding,
        candidateLimit,
        filters,
      );
      for (const hit of hits) {
        const memory = await this.loadVisible(hit.id, filters);
        if (memory) vectorResults.push({ memory, score: hit.score });
      }
    } catch (error) {
      this.warn(
        "search_vector_failed",
        "Vector search failed in precision search; continuing with lexical candidates only.",
        error,
        { query, lane: "precision", ...filters },
      );
    }

    const entityBoosts = await this.computeEntityBoosts(query, filters);
    const queryTerms = contentTerms(query);
    const byId = new Map<
      string,
      {
        memory: Memory;
        vectorScore: number;
        ftsScore: number;
        vectorRank?: number;
        ftsRank?: number;
      }
    >();

    vectorResults.forEach((s, i) => {
      const entry = byId.get(s.memory.id) ?? {
        memory: s.memory,
        vectorScore: 0,
        ftsScore: 0,
      };
      entry.vectorScore = Math.max(entry.vectorScore, s.score);
      entry.vectorRank = Math.min(entry.vectorRank ?? Infinity, i + 1);
      byId.set(s.memory.id, entry);
    });
    ftsResults.forEach((s, i) => {
      const entry = byId.get(s.memory.id) ?? {
        memory: s.memory,
        vectorScore: 0,
        ftsScore: 0,
      };
      entry.ftsScore = Math.max(entry.ftsScore, s.score);
      entry.ftsRank = Math.min(entry.ftsRank ?? Infinity, i + 1);
      byId.set(s.memory.id, entry);
    });

    const candidates = [...byId.values()];
    const maxFts = Math.max(1, ...candidates.map((c) => c.ftsScore));
    const scored: ScoredMemory[] = candidates
      .map((c) => {
        const memory = c.memory;
        const semantic = Math.max(0, Math.min(1, c.vectorScore));
        const lexical = Math.max(0, Math.min(1, c.ftsScore / maxFts));
        const slot = slotMatchBoost(memory, queryTerms, query);
        const entity = entityBoosts.get(memory.id) ?? 0;
        // Small reciprocal-rank nudge breaks ties in favour of candidates that
        // both semantic and lexical retrieval agree on.
        const agreement =
          (c.vectorRank ? 1 / (60 + c.vectorRank) : 0) +
          (c.ftsRank ? 1 / (60 + c.ftsRank) : 0);
        const score =
          0.62 * semantic +
          0.26 * lexical +
          0.08 * Math.min(1, slot + entity) +
          0.04 * agreement;
        return { memory, score };
      })
      .filter((s) => s.score >= config.minScore)
      .sort((a, b) => b.score - a.score);

    const limit = Math.min(config.maxResults, config.singleFactMaxResults);
    let selected = scored.slice(0, limit);
    if (config.followInvalidation) {
      selected = await this.followSuccessors(selected, limit);
    }
    if (config.traceRetrieval) {
      this.lastTrace = {
        lists: {
          vector: vectorResults.map((r) => ({
            id: r.memory.id,
            score: r.score,
          })),
          fts: ftsResults.map((r) => ({ id: r.memory.id, score: r.score })),
          graph: [],
          temporal: [],
        },
        fused: scored.map((r) => ({ id: r.memory.id, score: r.score })),
        selected: selected.map((r) => r.memory.id),
        selectedItems: selected.map((r) => ({
          id: r.memory.id,
          content: r.memory.content,
        })),
      };
    }
    return selected.map((s, i) => ({
      memory: s.memory,
      score: s.score,
      rank: i + 1,
    }));
  }

  private async computeEntityBoosts(
    query: string,
    filters: MemoryFilters,
  ): Promise<Map<string, number>> {
    const boosts = new Map<string, number>();
    let entities: Entity[] = [];
    try {
      entities = await this.store.listEntities(filters, 5_000);
    } catch (error) {
      this.warn(
        "search_entity_boost_failed",
        "Entity boost lookup failed; continuing without entity boosts.",
        error,
        { query, ...filters },
      );
      return boosts;
    }
    const q = query.toLowerCase();
    const queryTerms = new Set(contentTerms(query));
    const matched = entities.filter((e) => {
      if (q.includes(e.normalized)) return true;
      const words = e.normalized.split(/\s+/).filter(Boolean);
      return words.length > 0 && words.every((w) => queryTerms.has(w));
    });
    if (!matched.length) return boosts;
    const byEntity = await this.store.getMemoryIdsForEntities(
      matched.map((e) => e.id),
    );
    for (const ids of byEntity.values()) {
      const boost = Math.min(0.12, 0.3 / Math.sqrt(Math.max(ids.length, 1)));
      for (const id of ids)
        boosts.set(id, Math.max(boosts.get(id) ?? 0, boost));
    }
    return boosts;
  }

  /**
   * Greedy submodular selection: pick the result with the best marginal
   * utility  λ·relevance + β·coverageGain − γ·redundancy  until the count
   * cap (and, when set, the token budget) is reached.
   *
   * - coverageGain: how many of the query's content terms this memory covers
   *   that the already-selected set does not (normalized). This is what
   *   makes the final k COMPLEMENTARY for enumeration/multi-hop questions —
   *   greedy on a monotone submodular coverage term carries the classic
   *   (1−1/e) approximation guarantee.
   * - redundancy: max embedding cosine vs the selected set (MMR term);
   *   subsumes the legacy near-duplicate threshold.
   * Pure computation; relevance scores are min-max normalized first.
   */
  private async coverageSelect(
    query: string,
    candidates: ScoredMemory[],
    config: SearchConfig,
  ): Promise<ScoredMemory[]> {
    const limit = config.maxResults;
    if (candidates.length <= 1) return candidates.slice(0, limit);
    const pool = candidates.slice(0, Math.max(limit * 3, 30));

    // Normalize relevance by the max only — min-max would zero out the
    // weakest candidate, and the complementary fact a multi-hop question
    // needs is often exactly the lowest-relevance one in the pool.
    const max = pool[0]?.score || 1;
    const rel = pool.map((s) => s.score / max);

    // Query aspects: lowercase content terms (3+ chars — cheap stopword cut).
    const aspects = [
      ...new Set(
        query
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((t) => t.length >= 3),
      ),
    ];
    // Plural-tolerant containment ("pets" should match "pet").
    const matchesAspect = (content: string, aspect: string) =>
      content.includes(aspect) ||
      (aspect.endsWith("s") && content.includes(aspect.slice(0, -1)));
    const coversAspect = pool.map((s) => {
      const content = s.memory.content.toLowerCase();
      return new Set(aspects.filter((a) => matchesAspect(content, a)));
    });

    // Embeddings for the redundancy term (best-effort).
    const vecs: Array<number[] | undefined> = await Promise.all(
      pool.map(async (s) => {
        try {
          return (await this.vectors.get(s.memory.id))?.vector;
        } catch (error) {
          this.warn(
            "search_context_vector_failed",
            "Context-budget selection could not load a candidate vector; continuing without its redundancy penalty.",
            error,
            { memoryId: s.memory.id },
          );
          return undefined;
        }
      }),
    );

    const tokensOf = (s: ScoredMemory) =>
      Math.ceil(s.memory.content.length / 4);
    const budget = config.contextBudgetTokens;
    const covered = new Set<string>();
    const chosen: number[] = [];
    let spentTokens = 0;

    const redundancyOf = (i: number) => {
      if (!vecs[i]) return 0;
      let r = 0;
      for (const j of chosen) {
        if (!vecs[j]) continue;
        r = Math.max(r, cosineSimilarity(vecs[i]!, vecs[j]!));
      }
      return r;
    };

    while (chosen.length < limit) {
      let bestIdx = -1;
      let bestUtility = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        if (chosen.includes(i)) continue;
        if (
          budget > 0 &&
          spentTokens + tokensOf(pool[i]!) > budget &&
          chosen.length > 0
        ) {
          continue;
        }
        const redundancy = redundancyOf(i);
        // Near-identical to something already selected → hard skip (the
        // legacy diversity threshold survives as a hard constraint; the
        // soft MMR penalty below handles everything milder).
        if (
          config.diversityThreshold > 0 &&
          redundancy > config.diversityThreshold
        ) {
          continue;
        }
        let gain = 0;
        for (const a of coversAspect[i]!) if (!covered.has(a)) gain++;
        const coverageGain = aspects.length ? gain / aspects.length : 0;
        const utility =
          rel[i]! +
          config.coverageWeight * coverageGain -
          config.redundancyWeight * redundancy;
        if (utility > bestUtility) {
          bestUtility = utility;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      chosen.push(bestIdx);
      spentTokens += tokensOf(pool[bestIdx]!);
      for (const a of coversAspect[bestIdx]!) covered.add(a);
    }
    // Backfill if the hard dedupe left the quota unmet (and no budget set).
    if (budget === 0) {
      for (let i = 0; i < pool.length && chosen.length < limit; i++) {
        if (!chosen.includes(i)) chosen.push(i);
      }
    }
    return chosen.map((i) => pool[i]!);
  }

  /**
   * Listwise LLM rerank of the top fused candidates (opt-in). Falls back to
   * the fused order on any LLM/parse failure.
   */
  private async rerank(
    query: string,
    candidates: ScoredMemory[],
    config: SearchConfig,
    filters: MemoryFilters,
  ): Promise<ScoredMemory[]> {
    const pool = candidates.slice(0, config.rerankCandidates);
    if (pool.length <= 1 || !this.llm) return candidates;
    const listing = pool
      .map((s, i) => `${i}: ${s.memory.content.slice(0, 300)}`)
      .join("\n");
    try {
      const raw = await this.llm.chat(
        [
          {
            role: "system",
            content:
              'You rank memory snippets by relevance to a query. Respond with a single JSON object {"order": [indices, most relevant first]} listing EVERY index exactly once.',
          },
          {
            role: "user",
            content: `Query: ${query}\n\nMemories:\n${listing}`,
          },
        ],
        {
          responseFormat: "json",
          temperature: 0,
          context: {
            namespaceId: filters.namespaceId,
            operation: "memory.search.rerank",
          },
        },
      );
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      const order: unknown = parsed.order;
      if (!Array.isArray(order)) return candidates;
      const seen = new Set<number>();
      const reranked: ScoredMemory[] = [];
      for (const idx of order) {
        if (
          typeof idx === "number" &&
          idx >= 0 &&
          idx < pool.length &&
          !seen.has(idx)
        ) {
          seen.add(idx);
          reranked.push(pool[idx]!);
        }
      }
      for (let i = 0; i < pool.length; i++) {
        if (!seen.has(i)) reranked.push(pool[i]!);
      }
      return [...reranked, ...candidates.slice(pool.length)];
    } catch (error) {
      this.warn(
        "search_rerank_failed",
        "LLM rerank failed; returning fused retrieval order.",
        error,
        { candidateCount: candidates.length },
      );
      return candidates;
    }
  }

  /**
   * Invalidation-chain completion: when a selected memory has been
   * superseded, make sure its successor is present too (old + current state
   * answer "before/after" questions together). Tail items are dropped to
   * keep the result count at `limit`.
   */
  private async followSuccessors(
    selected: ScoredMemory[],
    limit: number,
  ): Promise<ScoredMemory[]> {
    const present = new Set(selected.map((s) => s.memory.id));
    const additions: ScoredMemory[] = [];
    for (const s of selected) {
      const successorId = s.memory.supersededBy;
      if (!successorId || present.has(successorId)) continue;
      const successor = await this.store.getMemory(successorId);
      if (!successor || successor.forgotten) continue;
      present.add(successorId);
      // Slot the successor right behind its predecessor's score.
      additions.push({ memory: successor, score: s.score * 0.999 });
    }
    if (additions.length === 0) return selected;
    return [...selected, ...additions]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Greedy diversity selection: walk the fused ranking, skipping candidates
   * whose embedding cosine vs any already-selected result exceeds the
   * threshold (MMR-lite). Skipped items backfill if the quota isn't reached.
   */
  private async diversify(
    candidates: ScoredMemory[],
    limit: number,
    threshold: number,
  ): Promise<ScoredMemory[]> {
    if (threshold <= 0 || candidates.length <= limit) {
      return candidates.slice(0, limit);
    }
    const pool = candidates.slice(0, limit * 3);
    const selected: ScoredMemory[] = [];
    const skipped: ScoredMemory[] = [];
    const chosenVectors: number[][] = [];
    for (const candidate of pool) {
      if (selected.length >= limit) break;
      let vector: number[] | undefined;
      try {
        vector = (await this.vectors.get(candidate.memory.id))?.vector;
      } catch (error) {
        this.warn(
          "search_diversity_vector_failed",
          "Diversity pass could not load a candidate vector; evaluating that candidate without duplicate suppression.",
          error,
          { memoryId: candidate.memory.id },
        );
        vector = undefined;
      }
      const dupe =
        vector !== undefined &&
        chosenVectors.some((v) => cosineSimilarity(v, vector!) > threshold);
      if (dupe) {
        skipped.push(candidate);
        continue;
      }
      selected.push(candidate);
      if (vector) chosenVectors.push(vector);
    }
    for (const s of skipped) {
      if (selected.length >= limit) break;
      selected.push(s);
    }
    return selected.slice(0, limit);
  }

  /**
   * Personalized PageRank over the seeds' graph neighbourhood (HippoRAG-style
   * diffusion). Loads nodes/edges up to `maxGraphDepth` hops from the seeds,
   * then runs damped power iteration with reset mass on the seeds. Sibling
   * facts two hops out accumulate mass through every connecting path — this
   * is what naive BFS scoring misses for multi-hop questions.
   */
  /**
   * Entity-graph recall: match the query against scope entities, then run
   * PPR over the bipartite entity–memory graph (mention edges) merged with
   * memory–memory association edges (directional, typed). Returns null when
   * no entity matches — caller falls back to the memory-association walk.
   */
  private async pprEntityGraphRank(
    query: string,
    seedMass: Map<string, { memory: Memory; mass: number }>,
    config: SearchConfig,
    filters: MemoryFilters,
  ): Promise<ScoredMemory[] | null> {
    let entities: Entity[] = [];
    try {
      entities = await this.store.listEntities(filters, 5_000);
    } catch (error) {
      this.warn(
        "search_entity_graph_failed",
        "Entity graph lookup failed; falling back to memory-association graph ranking.",
        error,
        { query, ...filters },
      );
      return null; // store without entity support
    }
    if (!entities.length) return null;

    const q = query.toLowerCase();
    const queryTerms = new Set(
      q.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2),
    );
    const matched = entities.filter((e) => {
      if (q.includes(e.normalized)) return true;
      // multi-word entity: all words present as query terms
      const words = e.normalized.split(/\s+/);
      return words.length > 0 && words.every((w) => queryTerms.has(w));
    });
    if (!matched.length) return null;

    // Collect the neighbourhood: matched entities → their memories →
    // co-mentioned entities (1 expansion) + association edges among memories.
    const entityIds = matched.map((e) => e.id);
    const memByEntity = await this.store.getMemoryIdsForEntities(entityIds);
    const memoryIds = [...new Set([...memByEntity.values()].flat())];
    if (!memoryIds.length) return null;

    const mentionsOfMems = await this.store.getEntityIdsForMemories(memoryIds);
    const allEntityIds = [
      ...new Set([...entityIds, ...[...mentionsOfMems.values()].flat()]),
    ];
    // Second hop: memories of co-mentioned entities (bounded).
    const memByEntity2 = await this.store.getMemoryIdsForEntities(allEntityIds);
    const allMemoryIds = [
      ...new Set([...memoryIds, ...[...memByEntity2.values()].flat()]),
    ].slice(0, 500);

    // Load + scope-check memory nodes.
    const memories = new Map<string, Memory>();
    for (const id of allMemoryIds) {
      const m = await this.store.getMemory(id);
      if (m && !m.forgotten && inScope(m, filters)) memories.set(id, m);
    }
    if (!memories.size) return null;

    // Edges: entity↔memory mentions (symmetric) + memory↔memory associations
    // (directional typed).
    const edges: Array<{ a: string; b: string; wab: number; wba: number }> = [];
    const mentionsAll = await this.store.getEntityIdsForMemories([
      ...memories.keys(),
    ]);
    for (const [memId, ents] of mentionsAll) {
      for (const entId of ents) {
        edges.push({ a: `e:${entId}`, b: `m:${memId}`, wab: 1, wba: 1 });
      }
    }
    const assocs = await this.store.getAssociationsBetween([
      ...memories.keys(),
    ]);
    for (const assoc of assocs) {
      const base = RELATION_TYPE_MULTIPLIER[assoc.relationType] * assoc.weight;
      const dir = DIRECTIONAL_FACTOR[assoc.relationType] ?? { fwd: 1, bwd: 1 };
      edges.push({
        a: `m:${assoc.sourceId}`,
        b: `m:${assoc.targetId}`,
        wab: base * dir.fwd,
        wba: base * dir.bwd,
      });
    }

    const nodeIds = [
      ...new Set([
        ...allEntityIds.map((id) => `e:${id}`),
        ...[...memories.keys()].map((id) => `m:${id}`),
      ]),
    ];
    const reset = new Map<string, number>();
    for (const e of matched) reset.set(`e:${e.id}`, 1);
    for (const [memId, s] of seedMass) {
      if (memories.has(memId)) {
        reset.set(`m:${memId}`, Math.max(reset.get(`m:${memId}`) ?? 0, s.mass));
      }
    }

    const mass = runPPR(
      nodeIds,
      edges,
      reset,
      config.pprDamping,
      config.pprIterations,
    );
    const ranked: ScoredMemory[] = [];
    for (const [node, score] of mass) {
      if (!node.startsWith("m:")) continue;
      const memory = memories.get(node.slice(2));
      if (memory) ranked.push({ memory, score });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.length ? ranked : null;
  }

  private async pprGraphRank(
    seedMass: Map<string, { memory: Memory; mass: number }>,
    config: SearchConfig,
    filters: MemoryFilters,
  ): Promise<ScoredMemory[]> {
    if (seedMass.size === 0) return [];

    // Collect the neighbourhood subgraph (scope-checked).
    const nodes = new Map<string, Memory>();
    const edges: Array<{ a: string; b: string; w: number }> = [];
    const seenEdges = new Set<string>();
    let frontier = [...seedMass.keys()];
    for (const [id, s] of seedMass) nodes.set(id, s.memory);

    for (
      let depth = 0;
      depth < config.maxGraphDepth && frontier.length;
      depth++
    ) {
      const next: string[] = [];
      for (const id of frontier) {
        const associations = await this.store.getAssociations(id);
        for (const assoc of associations) {
          const otherId =
            assoc.sourceId === id ? assoc.targetId : assoc.sourceId;
          const edgeKey =
            assoc.sourceId < assoc.targetId
              ? `${assoc.sourceId}|${assoc.targetId}|${assoc.relationType}`
              : `${assoc.targetId}|${assoc.sourceId}|${assoc.relationType}`;
          if (!nodes.has(otherId)) {
            const memory = await this.store.getMemory(otherId);
            if (!memory || memory.forgotten || !inScope(memory, filters))
              continue;
            nodes.set(otherId, memory);
            next.push(otherId);
          }
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            edges.push({
              a: assoc.sourceId,
              b: assoc.targetId,
              w: assoc.weight * RELATION_TYPE_MULTIPLIER[assoc.relationType],
            });
          }
        }
      }
      frontier = next;
    }

    // Sparse adjacency with per-node out-weight normalisation (undirected).
    const ids = [...nodes.keys()];
    const index = new Map(ids.map((id, i) => [id, i]));
    const outWeight = new Array(ids.length).fill(0);
    const adj: Array<Array<{ to: number; w: number }>> = ids.map(() => []);
    for (const { a, b, w } of edges) {
      const i = index.get(a);
      const j = index.get(b);
      if (i === undefined || j === undefined || w <= 0) continue;
      adj[i]!.push({ to: j, w });
      adj[j]!.push({ to: i, w });
      outWeight[i] += w;
      outWeight[j] += w;
    }

    // Personalization (reset) vector from seed mass.
    const reset = new Array(ids.length).fill(0);
    let totalMass = 0;
    for (const s of seedMass.values()) totalMass += s.mass;
    for (const [id, s] of seedMass) {
      reset[index.get(id)!] = s.mass / (totalMass || 1);
    }

    // Damped power iteration: p ← (1−d)·reset + d·Wᵀp
    const d = config.pprDamping;
    let p = [...reset];
    for (let iter = 0; iter < config.pprIterations; iter++) {
      const next = reset.map((r) => (1 - d) * r);
      for (let i = 0; i < ids.length; i++) {
        if (p[i]! === 0 || outWeight[i] === 0) {
          // Dangling mass returns to the seeds.
          if (p[i]! > 0) {
            for (let k = 0; k < ids.length; k++)
              next[k]! += d * p[i]! * reset[k]!;
          }
          continue;
        }
        const share = (d * p[i]!) / outWeight[i];
        for (const { to, w } of adj[i]!) next[to]! += share * w;
      }
      p = next;
    }

    return ids
      .map((id, i) => ({ memory: nodes.get(id)!, score: p[i]! }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  /** BFS over the association graph (iterative; spacebot search.rs:269-337). */
  private async traverseGraph(
    startId: string,
    maxDepth: number,
    results: ScoredMemory[],
    filters: MemoryFilters = {},
  ): Promise<void> {
    const queue: Array<{ id: string; depth: number }> = [
      { id: startId, depth: 0 },
    ];
    const visited = new Set<string>([startId]);

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth > maxDepth) continue;

      const associations = await this.store.getAssociations(id);
      for (const assoc of associations) {
        const relatedId =
          assoc.sourceId === id ? assoc.targetId : assoc.sourceId;
        if (visited.has(relatedId)) continue;
        visited.add(relatedId);

        const memory = await this.store.getMemory(relatedId);
        if (!memory || memory.forgotten) continue;
        if (!inScope(memory, filters)) continue; // no cross-tenant leakage via edges

        const multiplier = RELATION_TYPE_MULTIPLIER[assoc.relationType];
        const score = memory.importance * assoc.weight * multiplier;
        results.push({ memory, score });

        // Only expand along related_to / part_of edges (spacebot parity).
        if (
          assoc.relationType === "related_to" ||
          assoc.relationType === "part_of"
        ) {
          queue.push({ id: relatedId, depth: depth + 1 });
        }
      }
    }
  }

  private async loadVisible(
    id: string,
    filters?: MemoryFilters,
  ): Promise<Memory | null> {
    const memory = await this.store.getMemory(id);
    if (memory) {
      return memory.forgotten || !memoryMatchesFilters(memory, filters)
        ? null
        : memory;
    }
    let record: VectorRecord | null = null;
    try {
      record = await this.vectors.get(id);
    } catch (error) {
      this.warn(
        "search_retrieval_doc_load_failed",
        "Could not load a retrieval document vector payload; treating the id as invisible.",
        error,
        { id },
      );
      return null;
    }
    if (!record || !isRetrievalDoc(record)) return null;
    const retrievalDocument = retrievalDocToMemory(record);
    if (retrievalDocument.metadata?.__retrievalDoc === "episode") {
      const episodeId = retrievalDocument.episodeId;
      const episode = episodeId ? await this.store.getEpisode(episodeId) : null;
      // Episode vectors are rebuildable pointers, not authority. A stale
      // vector must become invisible immediately after retention deletion.
      // The authoritative Episode scope must also match its vector pointer so
      // a corrupt payload can never widen tenant/user visibility.
      if (
        !episode ||
        episode.namespaceId !== retrievalDocument.namespaceId ||
        episode.userId !== retrievalDocument.userId ||
        episode.agentId !== retrievalDocument.agentId ||
        episode.runId !== retrievalDocument.runId
      )
        return null;
    }
    return memoryMatchesFilters(retrievalDocument, filters)
      ? retrievalDocument
      : null;
  }
}

function memoryMatchesFilters(
  memory: Memory,
  filters?: MemoryFilters,
): boolean {
  return (
    matchesFilters(
      {
        namespaceId: memory.namespaceId,
        recordKind: "memory",
        userId: memory.userId,
        agentId: memory.agentId,
        runId: memory.runId,
        memoryType: memory.memoryType,
        metadata: memory.metadata ?? {},
      },
      filters,
    ) && matchesMemoryFilter(memory, filters?.predicate)
  );
}

function isRetrievalDoc(record: VectorRecord): boolean {
  const metadata = (record.payload.metadata ?? {}) as Record<string, unknown>;
  return (
    metadata.__retrievalDoc === "slot_summary" ||
    metadata.__retrievalDoc === "episode"
  );
}

function retrievalDocToMemory(record: VectorRecord): Memory {
  const payload = record.payload;
  const metadata = (payload.metadata ?? {}) as Record<string, unknown>;
  const now = parsePayloadDate(payload.updatedAt) ?? new Date(0);
  return {
    id: record.id,
    content: record.content,
    memoryType: payload.memoryType === "fact" ? "fact" : "observation",
    importance:
      typeof payload.importance === "number"
        ? Math.max(0, Math.min(1, payload.importance))
        : 0.7,
    hash: contentHash(record.content),
    namespaceId:
      typeof payload.namespaceId === "string" ? payload.namespaceId : undefined,
    userId: typeof payload.userId === "string" ? payload.userId : undefined,
    agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
    runId: typeof payload.runId === "string" ? payload.runId : undefined,
    source:
      typeof payload.source === "string"
        ? payload.source
        : metadata.__retrievalDoc === "episode"
          ? "episode"
          : "belief_slot",
    metadata,
    createdAt: parsePayloadDate(payload.createdAt) ?? now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    forgotten: false,
    tier: "graph",
    eventDate: parsePayloadDate(payload.eventDate),
    validFrom: parsePayloadDate(payload.validFrom),
    subject: typeof payload.subject === "string" ? payload.subject : undefined,
    attribute:
      typeof payload.attribute === "string" ? payload.attribute : undefined,
    episodeId:
      typeof payload.episodeId === "string"
        ? payload.episodeId
        : typeof metadata.__episodeId === "string"
          ? metadata.__episodeId
          : undefined,
  };
}

function parsePayloadDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Directional factors applied on top of RELATION_TYPE_MULTIPLIER.
 * Edges are stored source→target; "fwd" walks source→target, "bwd" walks
 * target→source. `updates` edges point successor→predecessor, so belief
 * mass should flow strongly toward the successor (bwd) and weakly back in
 * time (fwd). `caused_by`/`result_of` flow cause→effect likewise.
 */
const DIRECTIONAL_FACTOR: Record<string, { fwd: number; bwd: number }> = {
  updates: { fwd: 0.4, bwd: 1.0 },
  caused_by: { fwd: 0.6, bwd: 1.0 },
  result_of: { fwd: 0.6, bwd: 1.0 },
  related_to: { fwd: 1.0, bwd: 1.0 },
  part_of: { fwd: 1.0, bwd: 1.0 },
  contradicts: { fwd: 1.0, bwd: 1.0 },
  same_slot: { fwd: 1.0, bwd: 1.0 },
  same_entity: { fwd: 1.0, bwd: 1.0 },
  same_episode: { fwd: 1.0, bwd: 1.0 },
};

/** Damped personalized power iteration over an asymmetric weighted graph. */
function runPPR(
  nodeIds: string[],
  edges: Array<{ a: string; b: string; wab: number; wba: number }>,
  resetMass: Map<string, number>,
  damping: number,
  iterations: number,
): Map<string, number> {
  const index = new Map(nodeIds.map((id, i) => [id, i]));
  const n = nodeIds.length;
  const adj: Array<Array<{ to: number; w: number }>> = nodeIds.map(() => []);
  const outWeight = new Array(n).fill(0);
  for (const { a, b, wab, wba } of edges) {
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined) continue;
    if (wab > 0) {
      adj[i]!.push({ to: j, w: wab });
      outWeight[i] += wab;
    }
    if (wba > 0) {
      adj[j]!.push({ to: i, w: wba });
      outWeight[j] += wba;
    }
  }
  const reset = new Array(n).fill(0);
  let total = 0;
  for (const m of resetMass.values()) total += m;
  for (const [id, m] of resetMass) {
    const i = index.get(id);
    if (i !== undefined) reset[i] = m / (total || 1);
  }
  let p = [...reset];
  for (let iter = 0; iter < iterations; iter++) {
    const next = reset.map((r) => (1 - damping) * r);
    for (let i = 0; i < n; i++) {
      if (p[i]! === 0) continue;
      if (outWeight[i] === 0) {
        for (let k = 0; k < n; k++) next[k]! += damping * p[i]! * reset[k]!;
        continue;
      }
      const share = (damping * p[i]!) / outWeight[i];
      for (const { to, w } of adj[i]!) next[to]! += share * w;
    }
    p = next;
  }
  const out = new Map<string, number>();
  for (let i = 0; i < n; i++) if (p[i]! > 0) out.set(nodeIds[i]!, p[i]!);
  return out;
}

/** Scope check for graph-traversed memories (vector/FTS are store-filtered). */
function inScope(memory: Memory, filters: MemoryFilters): boolean {
  return memoryMatchesFilters(memory, filters);
}

export function classifySearchIntent(query: string): SearchIntent {
  const q = query.trim().toLowerCase();
  if (!q) return "multi_hop";

  if (
    /\b(all|every|list|summari[sz]e|summary|overall|in general)\b/.test(q) ||
    /\bwhat (?:are|were) all\b/.test(q)
  ) {
    return "synthesis";
  }

  if (
    /^(when|what date|what day|what month|what year)\b/.test(q) ||
    /^how long\b/.test(q) ||
    /\b(before or after|earlier than|later than|most recent|previously|currently)\b/.test(
      q,
    ) ||
    /\b(last|next) (?:year|month|week|summer|winter|spring|fall|autumn)\b/.test(
      q,
    )
  ) {
    return "temporal";
  }

  if (
    /^(who|what|where|which|did|does|do|is|are|was|were|has|have|had)\b/.test(
      q,
    ) ||
    /^how (?:many|much|old|does|did|is|are)\b/.test(q)
  ) {
    return "single_fact";
  }

  if (/^why\b/.test(q) || /\bcompare\b|\brelationship between\b/.test(q)) {
    return "multi_hop";
  }

  return "multi_hop";
}

function resolveSearchStrategy(
  query: string,
  config: SearchConfig,
): Exclude<SearchStrategy, "auto"> {
  const configured = config.searchStrategy;
  if (configured === "precision" || configured === "recall") {
    return configured;
  }

  const auto =
    configured === "auto" ||
    (configured === "balanced" && config.queryRouting === "auto");
  if (!auto) return "balanced";

  switch (classifySearchIntent(query)) {
    case "single_fact":
      return "precision";
    case "multi_hop":
    case "synthesis":
      return "recall";
    default:
      return "balanced";
  }
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "what",
  "who",
  "where",
  "when",
  "which",
  "does",
  "did",
  "was",
  "were",
  "are",
  "is",
  "has",
  "have",
  "had",
  "about",
  "after",
  "before",
  "during",
  "into",
  "from",
  "her",
  "his",
  "their",
  "she",
  "him",
  "they",
  "didn",
  "doesn",
  "what",
  "kind",
  "type",
]);

function contentTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
    ),
  ];
}

function slotMatchBoost(
  memory: Memory,
  queryTerms: string[],
  query: string,
): number {
  const q = query.toLowerCase();
  const content = memory.content.toLowerCase();
  let boost = 0;
  if (memory.subject && q.includes(memory.subject.toLowerCase())) boost += 0.3;
  if (memory.attribute) {
    for (const t of memory.attribute.split(/[_\s-]+/)) {
      if (t.length >= 3 && queryTerms.includes(t.toLowerCase())) {
        boost += 0.25;
        break;
      }
    }
  }
  if (queryTerms.length) {
    const overlap = queryTerms.filter((t) => content.includes(t)).length;
    boost += 0.45 * (overlap / queryTerms.length);
  }
  return Math.min(1, boost);
}

/** q' = normalize(q + U(Vᵀq)) — the learned low-rank query→statement map. */
function applyQueryMap(
  q: number[],
  map: { u: number[][]; v: number[][] },
): number[] {
  const { u, v } = map;
  const r = v.length; // factor columns stored row-major: v[k] is the k-th direction
  if (!r || u.length !== r) return q;
  const proj = new Array(r).fill(0);
  for (let k = 0; k < r; k++) {
    const vk = v[k]!;
    let dot = 0;
    const n = Math.min(vk.length, q.length);
    for (let i = 0; i < n; i++) dot += vk[i]! * q[i]!;
    proj[k] = dot;
  }
  const out = [...q];
  for (let k = 0; k < r; k++) {
    const uk = u[k]!;
    const p = proj[k]!;
    const n = Math.min(uk.length, out.length);
    for (let i = 0; i < n; i++) out[i]! += uk[i]! * p;
  }
  const norm = Math.hypot(...out) || 1;
  return out.map((x) => x / norm);
}

/** Noisy-OR fusion over calibrated per-source probabilities. */
function calibratedFusion(
  lists: {
    vector: ScoredMemory[];
    fts: ScoredMemory[];
    graph: ScoredMemory[];
    temporal: ScoredMemory[];
  },
  config: SearchConfig,
): ScoredMemory[] {
  const tables = config.calibration!;
  const weights = config.rrfWeights;
  const byId = new Map<
    string,
    {
      memory: ScoredMemory["memory"];
      contributions: Array<{ p: number; weight: number }>;
    }
  >();
  const sources: Array<["vector" | "fts" | "graph" | "temporal", number]> = [
    ["vector", weights.vector],
    ["fts", weights.fts],
    ["graph", weights.graph],
    ["temporal", weights.temporal],
  ];
  for (const [source, weight] of sources) {
    const curve = tables[source];
    if (!curve || weight <= 0) continue;
    for (const item of lists[source]) {
      const entry = byId.get(item.memory.id) ?? {
        memory: item.memory,
        contributions: [],
      };
      entry.contributions.push({ p: calibrate(curve, item.score), weight });
      byId.set(item.memory.id, entry);
    }
  }
  return [...byId.values()]
    .map(({ memory, contributions }) => ({
      memory,
      score: noisyOr(contributions),
    }))
    .sort((a, b) => b.score - a.score);
}

/** Keep the best score per memory id, sorted desc — a valid RRF input list. */
function dedupeByBestScore(list: ScoredMemory[]): ScoredMemory[] {
  const best = new Map<string, ScoredMemory>();
  for (const s of list) {
    const prev = best.get(s.memory.id);
    if (!prev || s.score > prev.score) best.set(s.memory.id, s);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}
