import type {
  BeliefPolicy,
  BeliefReconciler,
} from "./core/belief-reconciler.js";
import type { DocumentOriginalStore } from "./core/document-originals.js";
import type { MaintenanceConfig } from "./core/maintenance.js";
import type { SearchConfig } from "./core/search.js";
import type { StateSidecar } from "./core/sidecar.js";
import type { Embedder } from "./embeddings/base.js";
import { CenteredEmbedder } from "./embeddings/centered.js";
import { MockEmbedder } from "./embeddings/mock.js";
import {
  OpenAIEmbedder,
  type OpenAIEmbedderConfig,
} from "./embeddings/openai.js";
import type { GraphStore } from "./graph/base.js";
import { createD1GraphStore } from "./graph/d1.js";
import { InMemoryGraphStore } from "./graph/memory-store.js";
import { createPostgresGraphStore } from "./graph/postgres.js";
import { createSqliteGraphStore } from "./graph/sqlite.js";
import { AnthropicLLM, type AnthropicLLMConfig } from "./llms/anthropic.js";
import type { LLM } from "./llms/base.js";
import { MockLLM } from "./llms/mock.js";
import { OpenAILLM, type OpenAILLMConfig } from "./llms/openai.js";
import type { MemoryType } from "./types.js";
import type { VectorStore } from "./vector/base.js";
import { InMemoryVectorStore } from "./vector/memory.js";
import { type PgVectorConfig, PgVectorStore } from "./vector/pgvector.js";
import { type QdrantConfig, QdrantStore } from "./vector/qdrant.js";
import { type SqliteVectorConfig, SqliteVectorStore } from "./vector/sqlite.js";
import { type VectorizeConfig, VectorizeStore } from "./vector/vectorize.js";

// ── Declarative provider specs ──────────────────────────────────────────────

export type EmbedderSpec =
  | Embedder
  | { provider: "mock"; config?: { dimensions?: number }; centering?: boolean }
  | { provider: "openai"; config?: OpenAIEmbedderConfig; centering?: boolean };

export type LLMSpec =
  | LLM
  | { provider: "mock" }
  | { provider: "openai"; config?: OpenAILLMConfig }
  | { provider: "anthropic"; config?: AnthropicLLMConfig };

export type VectorStoreSpec =
  | VectorStore
  | { provider: "memory" }
  | { provider: "sqlite"; config?: SqliteVectorConfig }
  | { provider: "pgvector"; config?: PgVectorConfig }
  | { provider: "qdrant"; config?: QdrantConfig }
  | { provider: "vectorize"; config: VectorizeConfig };

export type GraphStoreSpec =
  | GraphStore
  | { provider: "memory" }
  | { provider: "sqlite"; config?: { url?: string; authToken?: string } }
  | { provider: "postgres"; config?: { connectionString?: string; pool?: any } }
  | { provider: "d1"; config: { binding: any; autoMigrate?: boolean } };

export type MemoryWarningCode =
  | "episode_gist_failed"
  | "episode_index_failed"
  | "slot_summary_failed"
  | "slot_summary_delete_failed"
  | "entity_link_failed"
  | "auto_associate_failed"
  | "typed_graph_failed"
  | "derivation_failed"
  | "belief_reconciliation_failed"
  | "memory_vector_delete_failed"
  | "memory_vector_delete_by_filter_failed"
  | "document_vector_cleanup_failed"
  | "document_search_lane_failed"
  | "document_search_failed"
  | "profile_refresh_failed"
  | "maintenance_reembed_failed"
  | "maintenance_vector_delete_failed"
  | "maintenance_mdl_failed"
  | "pgvector_ivfflat_index_failed"
  | "search_deep_followup_failed"
  | "search_fts_failed"
  | "search_vector_failed"
  | "search_entity_boost_failed"
  | "search_context_vector_failed"
  | "search_rerank_failed"
  | "search_diversity_vector_failed"
  | "search_entity_graph_failed"
  | "search_retrieval_doc_load_failed";

export interface MemoryWarning {
  code: MemoryWarningCode;
  message: string;
  recoverable: boolean;
  error?: unknown;
  context?: Record<string, unknown>;
}

export type MemoryWarningHandler = (warning: MemoryWarning) => void;

/** Top-level configuration object (mem0-style). */
export interface MemoryConfig {
  embedder?: EmbedderSpec;
  llm?: LLMSpec;
  vectorStore?: VectorStoreSpec;
  graphStore?: GraphStoreSpec;
  /**
   * Optional exact-original object store for long-text documents. When set,
   * canonical source bytes live behind this seam while relational stores keep
   * immutable descriptors and deterministic retrieval chunks. Desktop and
   * ordinary Node deployments leave it unset and keep originals inline.
   */
  documentOriginalStore?: DocumentOriginalStore;
  /**
   * Recoverable diagnostics. fishmem calls this instead of silently swallowing
   * degraded optional work such as derived indexes or derivation overlays.
   * Exceptions thrown by this callback are
   * not caught, so callers may deliberately promote a warning to a hard failure.
   */
  onWarning?: MemoryWarningHandler;
  /**
   * Controls the rebuildable semantic projection. "inline" keeps the library
   * default. "deferred" commits canonical + lexical data first and prepares
   * the embedding in the background; it requires vectorStore.upsertText.
   */
  vectorProjection?: {
    schedule?: "inline" | "deferred";
    hook?: (promise: Promise<unknown>) => void;
  };
  /**
   * Optional projections built from canonical inferred records: state slots
   * (current value / history / supersession) and typed graph edges. Normal
   * `add()` calls reuse their one extraction result; no second LLM call or
   * alternate writer is introduced. Projections are provenance-linked,
   * rebuildable, and cannot replace canonical record content.
   *
   * Do not pass the removed storage `mode` config. Storage behavior is selected
   * per add: `infer=true` (default) stores refined records; `infer=false`
   * stores input verbatim without calling an LLM.
   */
  derivation?: {
    /** Enable the derived state sidecar. Default false. */
    enabled?: boolean;
    /**
     * Sidecar store (state slots). Defaults to in-memory; provide a persistent
     * implementation to survive restarts.
     */
    sidecar?: StateSidecar;
    /**
     * - `"inline"` (default): `add()` awaits derivation — read-after-write
     *   consistency for `getState` (Node, tests).
     * - `"deferred"`: `add()` returns after canonical storage and projects in
     *   the background. Drain with `flushDerivations()`; on Workers pass
     *   `hook`.
     */
    schedule?: "inline" | "deferred";
    /**
     * Background-task registrar for `"deferred"` derivation. On Cloudflare
     * Workers pass `ctx.waitUntil`.
     */
    hook?: (promise: Promise<unknown>) => void;
    /**
     * Opt-in shadow projection for inferred preferences / learned rules.
     * It never changes canonical records or default recall. Evidence must pass
     * the configured competition policy before a supported winner exists.
     */
    beliefs?: {
      enabled?: boolean;
      /** Persistent adapter in production; defaults to in-memory. */
      reconciler?: BeliefReconciler;
      /** Ignored when a preconfigured reconciler is supplied. */
      policy?: Partial<BeliefPolicy>;
      /** Eligible inferred record types. Default: preference only. */
      memoryTypes?: MemoryType[];
      /** Optional structural namespace rollout allowlist. */
      namespaceAllowlist?: string[];
      /** Return true to stop observation and reads at runtime. */
      killSwitch?: () => boolean;
    };
  };
  /** Overrides for hybrid-search defaults. */
  search?: Partial<SearchConfig>;
  /** Overrides for maintenance defaults. */
  maintenance?: Partial<MaintenanceConfig>;
  /**
   * Tiered memory (spacebot tiered-memory design). When enabled, new
   * non-identity memories enter the `working` tier: exempt from decay, demoted
   * to `graph` after `ttlDays` without access or LRU-first beyond `capacity`.
   * Re-promote with `memory.promote(id)`.
   */
  tiers?: { enabled?: boolean; ttlDays?: number; capacity?: number };
  /** Profile-block synthesis and query-time section recall tuning. */
  profile?: {
    maxSourceMemories?: number;
    maxProfileChars?: number;
    /** Adapter/context builders may opt into query-time section injection. */
    sectionRecall?: boolean;
    /** Default section cap for query-time profile recall. */
    maxSections?: number;
  };
  /** Name-embedding cosine at/above which entity surface forms merge (default 0.88). */
  entitySynonymThreshold?: number;
  /**
   * Assemble belief chains on search: results sharing a (subject, attribute)
   * key are grouped, supersession chains followed, and returned as a
   * timeline alongside the ranked results (default true; pure computation).
   */
  beliefChains?: boolean;
  /**
   * Materialized retrieval documents. These are vector/FTS index entries, not
   * user-visible memories, and are opt-in until paired ablations justify a
   * default.
   */
  retrievalDocs?: {
    /** Deterministic summary per (scope, subject, attribute) belief slot. */
    slotSummary?: boolean;
  };
  /**
   * Optional non-lossy conversation episodes. Disabled by default because the
   * archive preserves the original user/assistant text and therefore has a
   * different privacy/retention contract from selective fact extraction.
   *
   * `archive` stores the role-preserving episode after extraction succeeds.
   * `searchable` additionally builds hidden, rebuildable retrieval documents
   * over the transcript; they can be returned by `search()` but never appear
   * in `getAll()` or canonical memory counts.
   */
  episodes?: {
    archive?: boolean;
    searchable?: boolean;
  };
  /** Default memory type for inferred/raw adds (default "fact"). */
  defaultMemoryType?: MemoryType;
  /**
   * Automatic graph edges on add: each new memory is linked (`related_to`,
   * weight = similarity) to its most similar existing memories in scope.
   * This is what feeds graph recall when callers don't link manually.
   * Default: enabled, threshold 0.6, max 3 edges per new memory.
   */
  autoAssociate?: {
    enabled?: boolean;
    /** Minimum cosine similarity to create an edge. */
    threshold?: number;
    /** Maximum edges created per new memory. */
    max?: number;
  };
  /**
   * Deterministic typed graph edges created from structured extraction fields.
   * Disabled by default until multi-hop ablations pay. When enabled, graph
   * recall can traverse same-slot, same-entity, and same-episode links.
   */
  typedGraph?: {
    enabled?: boolean;
    sameSlot?: boolean;
    sameEntity?: boolean;
    sameEpisode?: boolean;
    /** Per relation type, cap fan-out from each newly written memory. */
    maxEdgesPerType?: number;
  };
  /**
   * Heuristic entity extraction for records without structured entities,
   * primarily `infer:false` writes. It makes entity-graph recall available
   * without an LLM. Off by default.
   */
  heuristicEntities?: boolean;
  /**
   * Replaces the built-in fact-extraction system prompt used by the
   * canonical `infer:true` path and explicit sidecar rebuilds. Must instruct
   * the model to return `{"facts": [...]}` JSON.
   */
  customFactExtractionPrompt?: string;
}

export interface ResolvedProviders {
  embedder: Embedder;
  llm: LLM;
  vectorStore: VectorStore;
  graphStore: GraphStore;
}

function _isInstance<T>(spec: unknown, marker: keyof any): spec is T {
  return (
    typeof spec === "object" &&
    spec !== null &&
    !("provider" in (spec as Record<string, unknown>)) &&
    marker in (spec as Record<string, unknown>)
  );
}

function hasOpenAIKey(): boolean {
  return Boolean(process.env?.OPENAI_API_KEY);
}

export async function resolveProviders(
  config: MemoryConfig = {},
): Promise<ResolvedProviders> {
  return {
    embedder: resolveEmbedder(config.embedder),
    llm: resolveLLM(config.llm),
    vectorStore: resolveVectorStore(config.vectorStore, config.onWarning),
    graphStore: await resolveGraphStore(config.graphStore),
  };
}

function resolveEmbedder(spec?: EmbedderSpec): Embedder {
  if (spec && typeof (spec as Embedder).embed === "function") {
    return spec as Embedder;
  }
  if (spec && "provider" in spec) {
    const center = (e: Embedder) =>
      spec.centering ? new CenteredEmbedder(e) : e;
    if (spec.provider === "openai")
      return center(new OpenAIEmbedder(spec.config));
    if (spec.provider === "mock")
      return center(new MockEmbedder(spec.config?.dimensions));
  }
  if (hasOpenAIKey()) return new OpenAIEmbedder();
  throw new Error(
    "[fishmem] No embedder configured. Provide an explicit embedder; MockEmbedder is available only when explicitly selected.",
  );
}

function resolveLLM(spec?: LLMSpec): LLM {
  if (spec && typeof (spec as LLM).chat === "function") {
    return spec as LLM;
  }
  if (spec && "provider" in spec) {
    if (spec.provider === "openai") return new OpenAILLM(spec.config);
    if (spec.provider === "anthropic") return new AnthropicLLM(spec.config);
    if (spec.provider === "mock") return new MockLLM();
  }
  if (hasOpenAIKey()) return new OpenAILLM();
  throw new Error(
    "[fishmem] No LLM configured. Provide an explicit LLM; MockLLM is available only when explicitly selected.",
  );
}

function resolveVectorStore(
  spec?: VectorStoreSpec,
  onWarning?: MemoryWarningHandler,
): VectorStore {
  if (spec && typeof (spec as VectorStore).search === "function") {
    return spec as VectorStore;
  }
  if (spec && "provider" in spec) {
    switch (spec.provider) {
      case "memory":
        return new InMemoryVectorStore();
      case "sqlite":
        return new SqliteVectorStore(spec.config);
      case "pgvector":
        return new PgVectorStore({ ...spec.config, onWarning });
      case "qdrant":
        return new QdrantStore(spec.config);
      case "vectorize":
        return new VectorizeStore(spec.config);
    }
  }
  return new InMemoryVectorStore();
}

async function resolveGraphStore(spec?: GraphStoreSpec): Promise<GraphStore> {
  if (spec && typeof (spec as GraphStore).saveMemory === "function") {
    return spec as GraphStore;
  }
  if (spec && "provider" in spec) {
    switch (spec.provider) {
      case "memory":
        return new InMemoryGraphStore();
      case "sqlite":
        return createSqliteGraphStore(spec.config);
      case "postgres":
        return createPostgresGraphStore(spec.config ?? {});
      case "d1":
        return createD1GraphStore(spec.config);
    }
  }
  return new InMemoryGraphStore();
}
