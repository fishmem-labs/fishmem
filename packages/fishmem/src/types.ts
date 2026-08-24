/**
 * Core type system for fishmem.
 *
 * The data model unifies two designs:
 *  - spacebot's relational graph + vector hybrid recall engine
 *    (`MemoryType`, `importance`, `accessCount`, soft-delete `forgotten`,
 *     memory↔memory `Association` edges, RRF hybrid search).
 *  - mem0's public API and multi-tenant scoping
 *    (`userId` / `agentId` / `runId` / `metadata`, content `hash`, history log).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Memory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classification of a memory. Drives default importance and decay behaviour.
 * Mirrors spacebot's `MemoryType` exactly.
 */
export type MemoryType =
  | "fact" // Something that is true.
  | "preference" // Something the user likes or dislikes.
  | "decision" // A choice that was made.
  | "identity" // Core information about who the user/agent is. Never decays.
  | "event" // Something that happened.
  | "observation" // Something the system noticed.
  | "goal" // Something the user or agent wants to achieve.
  | "todo"; // An actionable task or reminder.

export const MEMORY_TYPES: readonly MemoryType[] = [
  "fact",
  "preference",
  "decision",
  "identity",
  "event",
  "observation",
  "goal",
  "todo",
] as const;

/** Default importance for each memory type (spacebot types.rs:75-89). */
export const DEFAULT_IMPORTANCE: Record<MemoryType, number> = {
  identity: 1.0,
  goal: 0.9,
  decision: 0.8,
  todo: 0.8,
  preference: 0.7,
  fact: 0.6,
  event: 0.4,
  observation: 0.3,
};

/** A single memory record — the node in the memory graph. */
export interface BeliefProjectionHint {
  version: 1;
  origin: "inferred";
  applicability: import("./core/belief-reconciler.js").StoredApplicabilityContext;
  /** Semantic assertion value frozen by the one-pass extractor. */
  claimValue?: string;
  evidenceKey: string;
  contextId: string;
  weight: number;
}

/** Internal, JSON-safe inputs required to rebuild optional projections without
 * another LLM call. Kept separate from user metadata and stripped from hosted
 * REST memory/snapshot wire objects. */
export interface MemoryProjectionHints {
  belief?: BeliefProjectionHint;
}

export interface Memory {
  /** UUID. */
  id: string;
  /** The remembered content (mem0 calls this `memory`; exposed as both). */
  content: string;
  memoryType: MemoryType;
  /** Relevance/importance in [0, 1]. Decays over time except for `identity`. */
  importance: number;
  /** md5 of content, used for fast exact-duplicate detection (mem0 parity). */
  hash?: string;

  // Structural tenant boundary plus mem0-compatible subject scoping.
  namespaceId?: string;
  userId?: string;
  agentId?: string;
  runId?: string;

  /** Free-form provenance string (spacebot parity). */
  source?: string;
  /** Arbitrary structured metadata stored alongside the memory (mem0 parity). */
  metadata?: Record<string, unknown>;
  /** Frozen, implementation-owned projection inputs. */
  projectionHints?: MemoryProjectionHints;

  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;
  accessCount: number;

  /**
   * Soft-delete flag. Forgotten memories stay in the database but are excluded
   * from search and recall (spacebot parity).
   */
  forgotten: boolean;

  /**
   * Memory tier (spacebot tiered-memory design). `working` = hot window:
   * exempt from decay, demoted to `graph` after a TTL since last access or by
   * LRU when the working set exceeds capacity. Default `graph`; only assigned
   * `working` when tiers are enabled in config.
   */
  tier?: MemoryTier;
  /** When this memory was last demoted from `working` to `graph`. */
  demotedAt?: Date;

  // Bi-temporal model (Zep/Graphiti-style). `createdAt` is transaction time
  // (when the system learned the fact); the fields below are event time.
  /** When the fact occurred / began to be true in the world. */
  eventDate?: Date;
  /** Start of the validity interval (defaults to eventDate). */
  validFrom?: Date;
  /**
   * End of the validity interval. A non-null value means the fact is no
   * longer true ("was true from validFrom to validTo") — invalidated
   * memories stay searchable, unlike `forgotten` ones.
   */
  validTo?: Date;
  /** Id of the memory that superseded this one (set on invalidation). */
  supersededBy?: string;

  // Structured-fact fields (Phase 1): emitted by the same extraction call.
  /** The main entity this fact is about ("Melanie"). */
  subject?: string;
  /** The aspect of the subject ("residence", "pet", "job"). Together with
   * `subject` this forms the deterministic conflict-candidate key. */
  attribute?: string;
  /** Provenance: the raw episode this fact was extracted from. */
  episodeId?: string;
}

/** A named entity referenced by memories (the belief graph's node set). */
export interface Entity {
  id: string;
  /** Display name as first seen ("Melanie"). */
  name: string;
  /** Lowercased, trimmed key used for exact matching. */
  normalized: string;
  namespaceId?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  /** Name embedding for synonym resolution (cosine across scope entities). */
  embedding?: number[];
  mentionCount: number;
  createdAt: Date;
}

/** A structural memory owner, distinct from a named graph entity. */
export type ScopeEntityType = "user" | "agent" | "run";

/** Derived from canonical, non-forgotten memories in one namespace. */
export interface ScopeEntity {
  id: string;
  type: ScopeEntityType;
  totalMemories: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A raw conversation chunk archived after a successful add (non-lossy store). */
export interface Episode {
  id: string;
  namespaceId?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  messages: Message[];
  source?: string;
  createdAt: Date;
}

/** Immutable, non-lossy version of a long-text or textual file source. */
export interface DocumentSource {
  /** Deterministic UUID for this source identity + immutable source version. */
  id: string;
  namespaceId: string;
  /** Caller-owned stable identity, for example a canonical URL or file id. */
  sourceKey: string;
  /** SHA-256 of the exact original UTF-8 content. */
  contentHash: string;
  /** SHA-256 of contentHash plus normalized scope and source metadata. */
  versionHash: string;
  /** Exact original UTF-8 content. Chunks never replace this value. */
  content: string;
  title?: string;
  mimeType: string;
  sourceUri?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
  sizeBytes: number;
  createdAt: Date;
}

/** Deterministic, rebuildable retrieval projection over a DocumentSource. */
export interface DocumentChunk {
  id: string;
  namespaceId: string;
  documentId: string;
  sourceKey: string;
  index: number;
  content: string;
  startOffset: number;
  endOffset: number;
  contentHash: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  createdAt: Date;
}

/** Current-version pointer for one stable source identity. */
export interface DocumentHead {
  id: string;
  namespaceId: string;
  sourceKey: string;
  documentId: string;
  updatedAt: Date;
}

export interface DocumentFilters {
  namespaceId: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  sourceKey?: string;
}

/** Memory tier (spacebot docs/design-docs/tiered-memory.md). */
export type MemoryTier = "working" | "graph";

// ─────────────────────────────────────────────────────────────────────────────
// Associations (the graph, stored relationally)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Relationship type between two memories. Drives graph-traversal scoring.
 * Mirrors spacebot's `RelationType`.
 */
export type RelationType =
  | "related_to" // General semantic connection.
  | "updates" // Newer version of the same information.
  | "contradicts" // Conflicting information.
  | "caused_by" // Causal relationship.
  | "result_of" // Result relationship.
  | "part_of" // Hierarchical relationship.
  | "same_entity" // Facts mention the same named entity.
  | "same_slot" // Facts share the same (subject, attribute) belief slot.
  | "same_episode"; // Facts came from the same archived episode.

export const RELATION_TYPES: readonly RelationType[] = [
  "related_to",
  "updates",
  "contradicts",
  "caused_by",
  "result_of",
  "part_of",
  "same_entity",
  "same_slot",
  "same_episode",
] as const;

/** An edge between two memories — the graph is the set of these rows. */
export interface Association {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: RelationType;
  /** Edge strength in [0, 1]. */
  weight: number;
  createdAt: Date;
}

/** Graph-traversal score multiplier per relation type (spacebot search.rs:310-316). */
export const RELATION_TYPE_MULTIPLIER: Record<RelationType, number> = {
  updates: 1.5,
  caused_by: 1.3,
  result_of: 1.3,
  related_to: 1.0,
  part_of: 0.8,
  contradicts: 0.5,
  same_slot: 1.25,
  same_entity: 0.85,
  same_episode: 0.65,
};

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

export type SearchMode = "hybrid" | "recent" | "important" | "typed" | "deep";
export type SearchSort =
  | "recent"
  | "importance"
  | "most_accessed"
  | "last_accessed";

/** A scored search hit. */
export interface MemorySearchResult {
  memory: Memory;
  /** Higher is more relevant. */
  score: number;
  rank: number;
}

/** Filters that scope memories to a tenant/session. */
export interface MemoryFilters {
  namespaceId?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  memoryType?: MemoryType;
  /** Internal vector projection discriminator. */
  recordKind?: "memory" | "document_chunk";
  /** Internal document projection filter. */
  documentId?: string;
  /** Internal stable document identity filter. */
  sourceKey?: string;
  /** Match against `metadata` keys (exact-equality on each provided key). */
  metadata?: Record<string, unknown>;
  /**
   * Canonical residual predicate. Structural scope fields above are always
   * ANDed with this expression, so logical filters can never widen a tenant,
   * user, agent, or run boundary.
   */
  predicate?: MemoryFilterExpression;
  /** Only memories whose eventDate is at/after this instant. */
  eventDateFrom?: Date;
  /** Only memories whose eventDate is at/before this instant. */
  eventDateTo?: Date;
  /** Only memories created at/after this instant. */
  createdAtFrom?: Date;
  /** Only memories created at/before this instant. */
  createdAtTo?: Date;
  /** Only memories last accessed at/after this instant. */
  lastAccessedAtFrom?: Date;
  /** Only memories last accessed at/before this instant. */
  lastAccessedAtTo?: Date;
  /** Select memories that have or have not been recalled at least once. */
  accessed?: boolean;
  /** Belief-key filters (case-insensitive exact match). */
  subject?: string;
  attribute?: string;
}

/** Fields exposed to the native advanced-filter evaluator. */
export type MemoryFilterField =
  | "id"
  | "content"
  | "memoryType"
  | "importance"
  | "createdAt"
  | "updatedAt"
  | "eventDate"
  | "lastAccessedAt"
  | "accessCount"
  | "subject"
  | "attribute"
  | `metadata.${string}`;

export type MemoryFilterOperator =
  | "eq"
  | "ne"
  | "in"
  | "nin"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "icontains"
  | "exists";

export type MemoryFilterValue = string | number | boolean | null | Date;

/** Backend-independent predicate AST. */
export type MemoryFilterExpression =
  | {
      kind: "condition";
      field: MemoryFilterField;
      operator: MemoryFilterOperator;
      value: MemoryFilterValue | MemoryFilterValue[];
    }
  | { kind: "and"; conditions: MemoryFilterExpression[] }
  | { kind: "or"; conditions: MemoryFilterExpression[] }
  | { kind: "not"; condition: MemoryFilterExpression };

// ─────────────────────────────────────────────────────────────────────────────
// History (mem0 parity)
// ─────────────────────────────────────────────────────────────────────────────

export type MemoryEvent =
  | "ADD"
  | "UPDATE"
  | "DELETE"
  | "INVALIDATE"
  | "FEEDBACK"
  | "NONE";

/** A row in the change log returned by `Memory.history(id)`. */
export interface HistoryEntry {
  id: string;
  memoryId: string;
  event: MemoryEvent;
  previousValue: string | null;
  newValue: string | null;
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feedback
// ─────────────────────────────────────────────────────────────────────────────

/** A quality signal attached to one durable memory. */
export type MemoryFeedbackRating = "positive" | "negative" | "very_negative";

/**
 * Current feedback state. The authoritative audit trail is stored as FEEDBACK
 * history events so it is included in namespace export/import automatically.
 */
export interface MemoryFeedback {
  id: string;
  memoryId: string;
  rating: MemoryFeedbackRating;
  reason?: string;
  /** Optional request trace that produced the retrieved memory. */
  requestId?: string;
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// add() results (mem0-shaped)
// ─────────────────────────────────────────────────────────────────────────────

export interface AddResultItem {
  id: string;
  memory: string;
  event: MemoryEvent;
  previousMemory?: string;
}

export interface AddResult {
  results: AddResultItem[];
}

/** A chat message, as accepted by `add()`. */
export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export type AddInput = string | Message | Message[];
