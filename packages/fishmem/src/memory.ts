import {
  type MemoryConfig,
  type MemoryWarningCode,
  type MemoryWarningHandler,
  type ResolvedProviders,
  resolveProviders,
} from "./config.js";
import {
  type ApplicabilityContext,
  type BeliefProjectionView,
  BeliefReconciler,
  type BeliefViewMode,
  normalizeApplicability,
  restoreApplicability,
  storeApplicability,
} from "./core/belief-reconciler.js";
import {
  DocumentCorpus,
  type DocumentDeleteResult,
  type DocumentIngestInput,
  type DocumentIngestOptions,
  type DocumentIngestResult,
  type DocumentScope,
  type DocumentSearchHit,
  type DocumentSearchOptions,
} from "./core/documents.js";
import type {
  MemoryJournalEvent,
  MemoryOperation,
  ProjectionStatus,
} from "./core/journal.js";
import { MemoryMaintenance } from "./core/maintenance.js";
import { ProfileManager, type ProfileSection } from "./core/profile.js";
import {
  DEFAULT_SEARCH_CONFIG,
  MemorySearch,
  type SearchConfig,
  type SearchStrategy,
  type SearchTrace,
} from "./core/search.js";
import {
  InMemoryStateSidecar,
  type StateSidecar,
  type StateSlot,
} from "./core/sidecar.js";
import {
  createNamespaceSnapshot,
  type NamespaceSnapshotV1,
  parseNamespaceSnapshot,
} from "./core/snapshot.js";
import { parseEventDate } from "./core/temporal.js";
import { contentHash, uuid } from "./core/util.js";
import type { Embedder } from "./embeddings/base.js";
import type { GraphStore } from "./graph/base.js";
import type { LLM, LLMJsonSchema } from "./llms/base.js";
import {
  applyMemoryExtractionPolicy,
  BELIEF_FACT_EXTRACTION_SYSTEM,
  buildExtractionMessages,
  EPISODE_GIST_SYSTEM,
  FACT_EXTRACTION_SYSTEM,
  type MemoryExtractionPolicy,
  messagesToTranscript,
} from "./prompts/index.js";
import {
  type AddInput,
  type AddResult,
  type AddResultItem,
  type Association,
  DEFAULT_IMPORTANCE,
  type DocumentFilters,
  type DocumentSource,
  type Episode,
  type HistoryEntry,
  MEMORY_TYPES,
  type MemoryFeedback,
  type MemoryFeedbackRating,
  type MemoryFilterExpression,
  type MemoryFilters,
  type MemoryProjectionHints,
  type Memory as MemoryRecord,
  type MemorySearchResult,
  type MemoryType,
  type Message,
  type RelationType,
  type ScopeEntity,
  type ScopeEntityType,
  type SearchMode,
  type SearchSort,
} from "./types.js";
import {
  deleteVectorRecords,
  getVectorRecords,
  type VectorStore,
} from "./vector/base.js";

const OPERATION_LEASE_MS = 5 * 60 * 1_000;
export const DELETE_ALL_MAX_TARGETS = 25_000;
const DELETE_ALL_MAX_PLAN_BYTES = 1_024 * 1_024;
// Conservative character cap for embedding providers with an 8k-token input
// ceiling. Fixed (rather than configurable) so retrieval-document ids remain
// deterministically deletable and rebuildable across deployments.
const EPISODE_INDEX_MAX_CHARS = 16_000;
const EPISODE_INDEX_OVERLAP_CHARS = 512;

export class DeleteAllLimitError extends Error {
  readonly code = "DELETE_ALL_TOO_LARGE";

  constructor(
    readonly targets: number,
    readonly maxTargets = DELETE_ALL_MAX_TARGETS,
  ) {
    super(
      `delete-all target set exceeds the synchronous limit of ${maxTargets}; narrow the scope`,
    );
    this.name = "DeleteAllLimitError";
  }
}

// ── Public option types ──────────────────────────────────────────────────────

export interface Scope {
  namespaceId?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
}

export interface AssociationInput {
  targetId: string;
  relationType?: RelationType;
  weight?: number;
}

export interface MemoryFeedbackInput {
  rating: MemoryFeedbackRating;
  reason?: string;
  requestId?: string;
}

type StoredMemoryFeedback = Omit<MemoryFeedback, "createdAt"> & {
  createdAt: string;
};

function storeFeedback(feedback: MemoryFeedback): StoredMemoryFeedback {
  return { ...feedback, createdAt: feedback.createdAt.toISOString() };
}

function restoreFeedback(value: unknown): MemoryFeedback | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StoredMemoryFeedback>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.memoryId !== "string" ||
    !["positive", "negative", "very_negative"].includes(
      String(candidate.rating),
    ) ||
    typeof candidate.createdAt !== "string"
  ) {
    return null;
  }
  const createdAt = new Date(candidate.createdAt);
  if (Number.isNaN(createdAt.getTime())) return null;
  return {
    id: candidate.id,
    memoryId: candidate.memoryId,
    rating: candidate.rating as MemoryFeedbackRating,
    ...(typeof candidate.reason === "string"
      ? { reason: candidate.reason }
      : {}),
    ...(typeof candidate.requestId === "string"
      ? { requestId: candidate.requestId }
      : {}),
    createdAt,
  };
}

function parseFeedbackHistory(entries: HistoryEntry[]): MemoryFeedback | null {
  let latest: HistoryEntry | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.event === "FEEDBACK") {
      latest = entries[index];
      break;
    }
  }
  if (!latest?.newValue) return null;
  try {
    return restoreFeedback(JSON.parse(latest.newValue));
  } catch {
    return null;
  }
}

export interface AddOptions extends Scope {
  /** Deduplicates retries within a structural namespace. Reusing a key with a
   * different command is rejected. */
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  memoryType?: MemoryType;
  importance?: number;
  source?: string;
  /**
   * Controls canonical storage semantics. The default (`true`) makes one LLM
   * extraction call and stores only the refined records. `false` stores every
   * non-empty input message verbatim and never calls the LLM.
   */
  infer?: boolean;
  /** Explicit graph edges from each created memory to existing memories. */
  associations?: AssociationInput[];
  /**
   * Fallback event time when extraction does not produce one, or the event
   * time assigned directly to a verbatim (`infer: false`) record.
   */
  eventDate?: Date;
  /** Semantic applicability of inferred preferences/rules. It never widens
   * authenticated owner scope. Omitted values resolve conservatively to the
   * current conversation/project rather than global. */
  applicability?: ApplicabilityContext;
  /** Echoes of one underlying source share this key and count once. */
  evidenceKey?: string;
  /** Independent task/conversation identity used by the promotion gate. */
  evidenceContextId?: string;
  /** Optional evidence weight in (0, 1]. Default 1. */
  evidenceWeight?: number;
  /** Project-level retention and categorization policy for inferred records. */
  extractionPolicy?: MemoryExtractionPolicy;
  /**
   * Per-add override for the opt-in raw episode archive. Set false for a
   * sensitive conversation even when the project default archives episodes.
   */
  archiveEpisode?: boolean;
}

export interface SearchOptions extends Scope {
  limit?: number;
  memoryType?: MemoryType;
  mode?: SearchMode;
  /**
   * Retrieval lane for this query. Defaults to the instance search config.
   * "precision" is narrow point-fact retrieval; "recall" enables graph/PPR;
   * "auto" routes by query intent and remains opt-in.
   */
  searchStrategy?: SearchStrategy;
  sortBy?: SearchSort;
  minScore?: number;
  /** Extra metadata-equality filters. */
  filters?: Record<string, unknown>;
  /** Advanced predicate, always ANDed with structural scope and `filters`. */
  filter?: MemoryFilterExpression;
  /** Return the per-source retrieval trace alongside results. */
  trace?: boolean;
}

export interface GetAllOptions extends Scope {
  limit?: number;
  offset?: number;
  cursor?: { createdAt: Date; id: string };
  memoryType?: MemoryType;
  sort?: SearchSort;
  /** Extra metadata-equality filters (mem0 parity). */
  filters?: Record<string, unknown>;
  /** Advanced predicate, always ANDed with structural scope and `filters`. */
  filter?: MemoryFilterExpression;
}

export interface UpdateData {
  content?: string;
  metadata?: Record<string, unknown>;
  importance?: number;
  memoryType?: MemoryType;
}

export interface MutationOptions extends Scope {
  idempotencyKey?: string;
}

export interface ImportOptions {
  idempotencyKey: string;
}

interface MutationOutcome<T> {
  result: T;
  payload: Record<string, unknown>;
  projections: {
    raw: ProjectionStatus;
    vector: ProjectionStatus;
    derived: ProjectionStatus;
  };
}

/** A fact extracted by the LLM, with time and structure annotations. */
interface ExtractedFact {
  text: string;
  /** Project-defined bucket selected during extraction. */
  categories: string[];
  /** Semantic assertion value used only by governed belief competition. */
  beliefValue: string | null;
  eventDate: Date | null;
  /** Named entities the fact mentions. */
  entities: string[];
  /** The main entity (belief-key part 1). */
  subject: string | null;
  /** The aspect of the subject (belief-key part 2). */
  attribute: string | null;
  /** Classified type (spacebot's 8) — drives importance defaults + sidecar
   * supersession semantics. Null when the LLM didn't classify. */
  memoryType: MemoryType | null;
  /** Attribute cardinality (LLM-judged): "single" → new value supersedes;
   * "multi" → values coexist (append). Null → treated as single. */
  cardinality: "single" | "multi" | null;
}

/** JSON-safe canonical record frozen into an idempotent add operation. */
interface PreparedAddRecord {
  content: string;
  categories: string[];
  beliefValue: string | null;
  eventDate: string | null;
  entities: string[];
  subject: string | null;
  attribute: string | null;
  memoryType: MemoryType | null;
  cardinality: "single" | "multi" | null;
  /** Raw episode provenance when the opt-in archive is enabled. */
  episodeId: string | null;
}

interface AddExecutionPlan {
  records: PreparedAddRecord[];
  memoryIds: string[];
  createdAt: Date;
  episodeId?: string;
}

interface EpisodeIndexChunk {
  id: string;
  content: string;
  index: number;
  count: number;
}

/**
 * A reconstructed belief slot: every retrieved (and chain-followed) fact
 * sharing one (subject, attribute) key, ordered on the event timeline, with
 * the currently-valid entry marked. This is the thesis made concrete —
 * "what is believed now, what was believed before, when it changed".
 */
export interface BeliefChain {
  subject: string;
  attribute: string;
  /** Timeline order: oldest first. */
  entries: Array<{
    id: string;
    content: string;
    eventDate?: Date;
    validFrom?: Date;
    validTo?: Date;
    /** True for the entry with no validTo (still believed). */
    current: boolean;
  }>;
}

export type BeliefShadowOutcome =
  | "agreement"
  | "disagreement"
  | "state_only"
  | "belief_only"
  | "unresolved"
  | "empty";

export interface BeliefShadowDiff {
  outcome: BeliefShadowOutcome;
  state?: StateSlot;
  winnerId?: string;
}

export interface BeliefViewResult extends BeliefProjectionView {
  shadow: BeliefShadowDiff;
}

export interface BeliefQueryOptions extends Scope {
  mode?: BeliefViewMode;
  applicability?: ApplicabilityContext;
  at?: Date;
  allApplicability?: boolean;
}

/**
 * The memory layer. Public API mirrors mem0
 * (`add/search/get/getAll/update/delete/deleteAll/history/reset`); the engine
 * underneath is spacebot's relational-graph + vector hybrid-recall design.
 */
export class Memory {
  readonly embedder: Embedder;
  readonly llm: LLM;
  readonly vectors: VectorStore;
  readonly store: GraphStore;

  private readonly search_: MemorySearch;
  private readonly documents_: DocumentCorpus;
  private readonly maintenance_: MemoryMaintenance;
  private readonly profile_: ProfileManager;
  private readonly searchDefaults: SearchConfig;
  private readonly defaultMemoryType: MemoryType;
  private readonly heuristicEntities: boolean;
  private readonly factExtractionPrompt?: string;
  private readonly onWarning?: MemoryWarningHandler;
  private readonly autoAssociate: {
    enabled: boolean;
    threshold: number;
    max: number;
  };
  private readonly typedGraph: {
    enabled: boolean;
    sameSlot: boolean;
    sameEntity: boolean;
    sameEpisode: boolean;
    maxEdgesPerType: number;
  };
  private readonly tiersEnabled: boolean;
  private readonly entitySynonymThreshold: number;
  private readonly beliefChains: boolean;
  private readonly retrievalDocs: { slotSummary: boolean };
  private readonly episodeArchive: { archive: boolean; searchable: boolean };
  /** Derived-structure layer: enabled flag + schedule (see config.derivation). */
  private readonly derivationEnabled: boolean;
  /** Derived-structure sidecar (state slots) — populated when derivation is on. */
  readonly sidecar: StateSidecar;
  /** Governed evidence projection. It is read-only with respect to canonical
   * records and remains shadow-only until an external rollout gate promotes it. */
  readonly beliefReconciler: BeliefReconciler;
  private readonly beliefProjection: {
    configured: boolean;
    memoryTypes: ReadonlySet<MemoryType>;
    namespaceAllowlist?: ReadonlySet<string>;
    killSwitch?: () => boolean;
  };
  private readonly derivationSchedule: "inline" | "deferred";
  private readonly derivationHook?: (promise: Promise<unknown>) => void;
  private readonly vectorProjectionSchedule: "inline" | "deferred";
  private readonly vectorProjectionHook?: (promise: Promise<unknown>) => void;
  private pendingVectorProjections: Promise<void>[] = [];
  private pendingDerivations: Promise<boolean>[] = [];
  private initialized?: Promise<void>;

  constructor(providers: ResolvedProviders, config: MemoryConfig = {}) {
    this.embedder = providers.embedder;
    this.llm = providers.llm;
    this.vectors = providers.vectorStore;
    this.store = providers.graphStore;
    this.onWarning = config.onWarning;
    this.search_ = new MemorySearch(
      this.store,
      this.vectors,
      this.embedder,
      this.llm,
      this.onWarning,
    );
    this.documents_ = new DocumentCorpus(
      this.store,
      this.vectors,
      this.embedder,
      () => this.init(),
      this.onWarning,
      config.documentOriginalStore,
    );
    this.tiersEnabled = config.tiers?.enabled ?? false;
    this.maintenance_ = new MemoryMaintenance(
      this.store,
      this.vectors,
      this.embedder,
      {
        ...(this.tiersEnabled
          ? {
              tiersEnabled: true,
              ...(config.tiers?.ttlDays !== undefined
                ? { tierTtlDays: config.tiers.ttlDays }
                : {}),
              ...(config.tiers?.capacity !== undefined
                ? { tierCapacity: config.tiers.capacity }
                : {}),
            }
          : {}),
        ...config.maintenance,
      },
      this.llm,
      this.onWarning,
    );
    this.profile_ = new ProfileManager(
      this.store,
      this.llm,
      config.profile,
      this.onWarning,
    );
    this.searchDefaults = { ...DEFAULT_SEARCH_CONFIG, ...config.search };
    this.defaultMemoryType = config.defaultMemoryType ?? "fact";
    this.heuristicEntities = config.heuristicEntities ?? false;
    this.factExtractionPrompt = config.customFactExtractionPrompt;
    this.autoAssociate = {
      enabled: config.autoAssociate?.enabled ?? true,
      threshold: config.autoAssociate?.threshold ?? 0.6,
      max: config.autoAssociate?.max ?? 3,
    };
    this.typedGraph = {
      enabled: config.typedGraph?.enabled ?? false,
      sameSlot: config.typedGraph?.sameSlot ?? true,
      sameEntity: config.typedGraph?.sameEntity ?? true,
      sameEpisode: config.typedGraph?.sameEpisode ?? true,
      maxEdgesPerType: config.typedGraph?.maxEdgesPerType ?? 4,
    };
    this.entitySynonymThreshold = config.entitySynonymThreshold ?? 0.88;
    this.beliefChains = config.beliefChains ?? true;
    this.retrievalDocs = {
      slotSummary: config.retrievalDocs?.slotSummary ?? false,
    };
    this.episodeArchive = {
      archive: config.episodes?.archive ?? false,
      searchable: config.episodes?.searchable ?? false,
    };
    // One architecture: add defaults to a single extraction pass whose
    // refined facts become canonical records. `infer: false` is the explicit,
    // zero-LLM verbatim path. The optional state sidecar is a projection of
    // those same extracted facts, never a second writer.
    const removedMode = (config as { mode?: unknown }).mode;
    if (removedMode !== undefined) {
      throw new TypeError(
        "[fishmem] config `mode` was removed. There is one storage architecture: " +
          "infer=true stores refined records and infer=false stores verbatim input. " +
          "Remove `mode`; use `derivation: { enabled: true }` for the optional " +
          "state projection.",
      );
    }
    const derivation = config.derivation;
    this.derivationEnabled = derivation?.enabled ?? false;
    this.sidecar = derivation?.sidecar ?? new InMemoryStateSidecar();
    const beliefConfig = derivation?.beliefs;
    if (beliefConfig?.enabled && !this.derivationEnabled) {
      throw new TypeError(
        "belief reconciliation requires derivation.enabled so it can consume the frozen extraction plan",
      );
    }
    if (beliefConfig?.reconciler && beliefConfig.policy) {
      throw new TypeError(
        "configure belief policy on the supplied reconciler, not in both places",
      );
    }
    const beliefMemoryTypes = beliefConfig?.memoryTypes ?? ["preference"];
    if (
      beliefMemoryTypes.length === 0 ||
      beliefMemoryTypes.some((type) => !MEMORY_TYPES.includes(type))
    ) {
      throw new TypeError("belief reconciliation memoryTypes are invalid");
    }
    const namespaceAllowlist = beliefConfig?.namespaceAllowlist
      ?.map((value) => value.trim())
      .filter(Boolean);
    this.beliefProjection = {
      configured: beliefConfig?.enabled ?? false,
      memoryTypes: new Set(beliefMemoryTypes),
      ...(namespaceAllowlist
        ? { namespaceAllowlist: new Set(namespaceAllowlist) }
        : {}),
      ...(beliefConfig?.killSwitch
        ? { killSwitch: beliefConfig.killSwitch }
        : {}),
    };
    this.beliefReconciler =
      beliefConfig?.reconciler ??
      new BeliefReconciler({ policy: beliefConfig?.policy });
    this.derivationSchedule = derivation?.schedule ?? "inline";
    this.derivationHook = derivation?.hook;
    this.vectorProjectionSchedule =
      config.vectorProjection?.schedule ?? "inline";
    this.vectorProjectionHook = config.vectorProjection?.hook;
    if (
      this.vectorProjectionSchedule === "deferred" &&
      !this.vectors.upsertText
    ) {
      throw new TypeError(
        "Deferred vector projection requires a vector store with upsertText support",
      );
    }
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

  private async deleteVectorIndexEntry(
    memoryId: string,
    context?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await this.vectors.delete(memoryId);
      return true;
    } catch (error) {
      this.warn(
        "memory_vector_delete_failed",
        "Memory row was removed or hidden, but its vector index entry could not be deleted.",
        error,
        { memoryId, ...context },
      );
      return false;
    }
  }

  private async deleteVectorIndexByFilter(
    filters: MemoryFilters,
    context?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.vectors.deleteByFilter(filters);
    } catch (error) {
      this.warn(
        "memory_vector_delete_by_filter_failed",
        "Memory store was reset, but vector index entries could not be deleted by filter.",
        error,
        { filters, ...context },
      );
    }
  }

  private async deleteVectorIndexEntries(
    ids: string[],
    context?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await deleteVectorRecords(this.vectors, ids);
      return true;
    } catch (error) {
      this.warn(
        "memory_vector_delete_failed",
        "Canonical rows were removed or hidden, but known vector index entries could not be deleted.",
        error,
        { memoryIds: ids, ...context },
      );
      return false;
    }
  }

  private async removeBeliefEvidence(
    sourceId: string,
    operation: string,
  ): Promise<boolean> {
    if (!this.beliefProjection.configured) return true;
    try {
      await this.beliefReconciler.removeSource(sourceId);
      return true;
    } catch (error) {
      this.warn(
        "belief_reconciliation_failed",
        "Governed belief evidence cleanup failed; the rebuildable projection needs repair.",
        error,
        { sourceId, operation },
      );
      return false;
    }
  }

  private async removeBeliefEvidenceMany(
    sourceIds: string[],
    operation: string,
  ): Promise<boolean> {
    let ready = true;
    for (const sourceId of sourceIds) {
      ready = (await this.removeBeliefEvidence(sourceId, operation)) && ready;
    }
    return ready;
  }

  private async invalidateBeliefEvidence(
    sourceId: string,
    validTo: Date,
  ): Promise<boolean> {
    if (!this.beliefProjection.configured) return true;
    try {
      await this.beliefReconciler.invalidateSource(sourceId, validTo);
      return true;
    } catch (error) {
      this.warn(
        "belief_reconciliation_failed",
        "Governed belief evidence invalidation failed; the rebuildable projection needs repair.",
        error,
        { sourceId, validTo: validTo.toISOString() },
      );
      return false;
    }
  }

  private async clearBeliefEvidence(
    scope: Scope | undefined,
    operation: string,
  ): Promise<boolean> {
    if (!this.beliefProjection.configured) return true;
    try {
      await this.beliefReconciler.clear(scope);
      return true;
    } catch (error) {
      this.warn(
        "belief_reconciliation_failed",
        "Governed belief evidence reset failed; the rebuildable projection needs repair.",
        error,
        { operation, ...(scope ? { ...scope } : {}) },
      );
      return false;
    }
  }

  /** Build and initialise a Memory from a declarative config. */
  static async create(config: MemoryConfig = {}): Promise<Memory> {
    const providers = await resolveProviders(config);
    const memory = new Memory(providers, config);
    await memory.init();
    return memory;
  }

  /** Idempotently initialise the underlying stores. */
  init(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.store.init();
        await this.vectors.init(this.embedder.dimensions);
      })();
    }
    return this.initialized;
  }

  /**
   * Bind every operation to one structural namespace. The returned module is
   * the multi-tenant interface: caller-supplied options cannot override the
   * namespace, and id-addressed operations verify ownership before mutation.
   */
  forNamespace(namespaceId: string): NamespacedMemory {
    const normalized = namespaceId.trim();
    if (!normalized) throw new TypeError("namespaceId must not be empty");
    return new NamespacedMemory(this, normalized);
  }

  ingestDocument(
    input: DocumentIngestInput,
    options: DocumentIngestOptions,
  ): Promise<DocumentIngestResult> {
    return this.documents_.ingest(input, options);
  }

  getDocument(
    documentId: string,
    namespaceId: string,
  ): Promise<DocumentSource | null> {
    return this.documents_.get(documentId, namespaceId);
  }

  listDocuments(filters: DocumentFilters, options: GetAllOptions = {}) {
    return this.documents_.list(filters, options);
  }

  searchDocuments(
    namespaceId: string,
    query: string,
    options: DocumentSearchOptions = {},
  ): Promise<DocumentSearchHit[]> {
    return this.documents_.search(namespaceId, query, options);
  }

  deleteDocument(
    documentId: string,
    options: DocumentScope & { idempotencyKey: string },
  ): Promise<DocumentDeleteResult> {
    return this.documents_.delete(documentId, options);
  }

  rebuildDocument(documentId: string, namespaceId: string) {
    return this.documents_.rebuild(documentId, namespaceId);
  }

  // ── add ─────────────────────────────────────────────────────────────────────

  /**
   * Store content through the single canonical write path. `infer` defaults to
   * true: one LLM call extracts additive facts and only those refined records
   * are stored. `infer: false` stores non-empty messages verbatim without an
   * LLM call. Extraction failures are fail-closed and never fall back to raw.
   */
  async add(input: AddInput, options: AddOptions = {}): Promise<AddResult> {
    const idempotencyKey = options.idempotencyKey?.trim();
    if (!idempotencyKey) return this.performAdd(input, options);
    await this.init();
    const namespaceId = options.namespaceId?.trim();
    if (!namespaceId) {
      throw new TypeError("idempotent add requires a structural namespace");
    }
    const { idempotencyKey: _ignored, ...writeOptions } = options;
    const messages = normalizeInput(input);
    const infer = options.infer !== false;
    const derive = this.derivationEnabled && infer;
    const requestHash = contentHash(
      stableJson({ messages, options: writeOptions }),
    );
    const now = new Date();
    const candidate: MemoryOperation = {
      id: uuid(),
      namespaceId,
      idempotencyKey,
      kind: "add",
      requestHash,
      command: JSON.parse(
        stableJson({ messages, options: writeOptions }),
      ) as Record<string, unknown>,
      // The number of refined records is unknown until extraction. The
      // claimed writer freezes addPlan + ids atomically before any record or
      // projection write begins.
      memoryIds: [],
      status: "pending",
      rawStatus: "pending",
      vectorStatus: "pending",
      derivedStatus: derive ? "pending" : "not_requested",
      leaseExpiresAt: new Date(now.getTime() + OPERATION_LEASE_MS),
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    };
    const claim = await this.store.claimOperation(candidate);
    let operation = claim.operation;
    if (operation.requestHash !== requestHash) {
      throw new Error(
        `idempotency key conflict: ${idempotencyKey} was used for a different add command`,
      );
    }
    if (!claim.claimed) {
      if (operation.status === "committed" && operation.result) {
        return structuredClone(operation.result) as AddResult;
      }
      if (operation.status === "failed") {
        if (
          !(await this.store.retryOperation(
            operation.id,
            candidate.leaseExpiresAt!,
          ))
        ) {
          throw new Error(
            `idempotent operation ${operation.id} is already being repaired`,
          );
        }
      } else {
        throw new Error(
          `idempotent operation ${operation.id} is pending; repair is required before retry`,
        );
      }
    }
    try {
      let records = readAddPlan(operation.command);
      const episodeId = this.shouldArchiveEpisode(options, messages)
        ? `episode:${operation.id}`
        : undefined;
      if (records === null) {
        records = await this.prepareAddRecords(
          messages,
          options,
          scopeOf(options),
          episodeId,
        );
        const memoryIds = records.map(() => uuid());
        operation = await this.store.planOperation(
          operation.id,
          {
            ...operation.command,
            addPlan: {
              version: 1,
              records,
            },
          },
          memoryIds,
        );
      } else if (records.length !== operation.memoryIds.length) {
        throw new Error(
          `idempotent add plan is corrupt: ${records.length} records for ${operation.memoryIds.length} ids`,
        );
      }
      const projection = { derivedReady: !derive };
      const result = await this.performAdd(
        input,
        options,
        {
          records,
          memoryIds: operation.memoryIds,
          createdAt: operation.createdAt,
          ...(episodeId ? { episodeId } : {}),
        },
        projection,
      );
      const occurredAt = new Date();
      const events: MemoryJournalEvent[] = [];
      for (const item of result.results) {
        const record = await this.store.getMemory(item.id);
        if (!record) {
          throw new Error(
            `committed memory missing before journal: ${item.id}`,
          );
        }
        events.push({
          id: `${operation.id}:add:${item.id}`,
          namespaceId,
          operationId: operation.id,
          memoryId: item.id,
          eventType: "ADD",
          payload: JSON.parse(JSON.stringify(record)) as Record<
            string,
            unknown
          >,
          occurredAt,
        });
      }
      await this.store.completeOperation(
        operation.id,
        result,
        {
          raw: "ready",
          vector:
            this.vectorProjectionSchedule === "inline" ? "ready" : "pending",
          derived: derive
            ? projection.derivedReady
              ? "ready"
              : "pending"
            : "not_requested",
        },
        events,
      );
      return result;
    } catch (error) {
      const projectionStatus = !hasAddPlan(operation.command)
        ? {
            raw: "pending" as const,
            vector: "pending" as const,
            derived: derive ? ("pending" as const) : ("not_requested" as const),
          }
        : await this.inspectAddProjections(operation.memoryIds, derive);
      await this.store.failOperation(
        operation.id,
        error instanceof Error ? error.message : String(error),
        projectionStatus,
      );
      throw error;
    }
  }

  private async performAdd(
    input: AddInput,
    options: AddOptions,
    plan?: AddExecutionPlan,
    projection?: { derivedReady: boolean },
  ): Promise<AddResult> {
    await this.init();
    const scope = scopeOf(options);
    const messages = normalizeInput(input);
    const infer = options.infer !== false;
    const derive = this.derivationEnabled && infer;
    const episodeId = plan
      ? plan.episodeId
      : this.shouldArchiveEpisode(options, messages)
        ? uuid()
        : undefined;
    const records =
      plan?.records ??
      (await this.prepareAddRecords(messages, options, scope, episodeId));
    const episodeCreatedAt = plan?.createdAt ?? new Date();
    const episode = episodeId
      ? this.prepareEpisode(
          episodeId,
          messages,
          options,
          scope,
          episodeCreatedAt,
        )
      : undefined;
    const episodeChunks =
      episode && this.episodeArchive.searchable
        ? buildEpisodeIndexChunks(episode)
        : [];
    const beliefBatchId = plan?.memoryIds[0] ?? uuid();
    // One add commonly yields several refined facts. Embed them in one provider
    // request, then preserve the existing sequential store/auto-link order.
    // This changes only network batching: every record keeps its own vector and
    // associations still see exactly the previously committed records.
    const projectionContents = [
      ...records.map((record) => record.content),
      ...episodeChunks.map((chunk) => chunk.content),
    ];
    const projectionVectors =
      this.vectorProjectionSchedule === "inline" &&
      projectionContents.length > 0
        ? await this.embedder.embedBatch(projectionContents, {
            context: {
              namespaceId: scope.namespaceId,
              operation: "memory.embedding",
            },
          })
        : [];
    if (
      this.vectorProjectionSchedule === "inline" &&
      projectionVectors.length !== projectionContents.length
    ) {
      throw new Error(
        `embedding batch returned ${projectionVectors.length} vectors for ${projectionContents.length} records`,
      );
    }
    const recordVectors = projectionVectors.slice(0, records.length);
    const episodeVectors = projectionVectors.slice(records.length);

    const results: AddResultItem[] = [];
    const entityIdsBySource = new Map<string, string[]>();
    for (let index = 0; index < records.length; index++) {
      const prepared = records[index]!;
      const plannedId = plan?.memoryIds[index];
      if (plan && !plannedId)
        throw new Error("idempotent add plan does not match record count");
      const recordOptions = prepared.categories.length
        ? {
            ...options,
            metadata: {
              ...(options.metadata ?? {}),
              categories: [...prepared.categories],
            },
          }
        : options;
      const record = await this.createRecord(
        prepared.content,
        recordOptions,
        scope,
        prepared.eventDate ? new Date(prepared.eventDate) : undefined,
        {
          subject: prepared.subject,
          attribute: prepared.attribute,
          memoryType: prepared.memoryType,
          episodeId: prepared.episodeId ?? undefined,
          projectionHints: this.prepareBeliefProjectionHints(
            prepared.memoryType,
            prepared.beliefValue ?? prepared.content,
            options,
            scope,
            beliefBatchId,
            infer,
          ),
        },
        plannedId ? { id: plannedId, createdAt: plan.createdAt } : undefined,
        recordVectors[index],
      );
      await this.linkAssociations(record.id, options.associations);
      const extractedNames = infer
        ? [
            ...new Set([
              ...prepared.entities,
              ...(prepared.subject ? [prepared.subject] : []),
            ]),
          ]
        : [];
      const names =
        extractedNames.length > 0
          ? extractedNames
          : this.heuristicEntities
            ? extractEntitiesHeuristic(prepared.content)
            : [];
      if (names.length) {
        entityIdsBySource.set(
          record.id,
          await this.linkEntities(record.id, names, scope),
        );
      }
      results.push({ id: record.id, memory: record.content, event: "ADD" });
    }
    if (plan && records.length !== plan.memoryIds.length) {
      throw new Error("idempotent add plan does not match record count");
    }

    // The optional state/typed-graph projection consumes the exact extraction
    // that produced the canonical records. It never performs a second LLM call.
    if (derive && records.length) {
      const sources = results.map((r) => r.id);
      const facts = preparedRecordsToFacts(records);
      if (this.derivationSchedule === "inline") {
        const derivedReady = await this.projectDerivedFacts(
          facts,
          options,
          scope,
          sources,
          entityIdsBySource,
        );
        if (projection) projection.derivedReady = derivedReady;
      } else {
        const p = this.projectDerivedFacts(
          facts,
          options,
          scope,
          sources,
          entityIdsBySource,
        );
        if (projection) projection.derivedReady = false;
        this.pendingDerivations.push(p);
        p.finally(() => {
          this.pendingDerivations = this.pendingDerivations.filter(
            (x) => x !== p,
          );
        });
        this.derivationHook?.(p);
      }
    }
    // Raw Episode authority is deliberately committed last. Extraction,
    // canonical storage, linking, and any inline derived projection must all
    // succeed before an opt-in raw transcript is retained. This prevents a
    // failed canonical add from leaving privacy-sensitive history behind.
    if (episode) {
      await this.saveEpisodeIdempotently(episode);
      if (episodeChunks.length) {
        await this.projectEpisodeChunks(episode, episodeChunks, episodeVectors);
      }
    }
    return { results };
  }

  private async prepareAddRecords(
    messages: Message[],
    options: AddOptions,
    scope: Scope,
    episodeId?: string,
  ): Promise<PreparedAddRecord[]> {
    if (options.infer === false) {
      return messages
        .filter((message) => message.content.trim().length > 0)
        .map((message) => ({
          // Keep the input byte-for-byte; trim is only the emptiness check.
          content: message.content,
          categories: [],
          beliefValue: null,
          eventDate: options.eventDate?.toISOString() ?? null,
          entities: [],
          subject: null,
          attribute: null,
          memoryType: options.memoryType ?? null,
          cardinality: null,
          episodeId: episodeId ?? null,
        }));
    }

    const facts = await this.extractFacts(
      messagesToTranscript(messages),
      scope,
      options.extractionPolicy,
    );
    const seen = new Set<string>();
    const records: PreparedAddRecord[] = [];
    for (const fact of facts) {
      if (seen.has(fact.text)) continue;
      seen.add(fact.text);
      records.push({
        content: fact.text,
        categories: [...fact.categories],
        beliefValue: fact.beliefValue,
        eventDate: (fact.eventDate ?? options.eventDate)?.toISOString() ?? null,
        entities: [...new Set(fact.entities.map((name) => name.trim()))].filter(
          Boolean,
        ),
        subject: fact.subject,
        attribute: fact.attribute,
        memoryType: fact.memoryType,
        cardinality: fact.cardinality,
        episodeId: episodeId ?? null,
      });
    }
    return records;
  }

  private shouldArchiveEpisode(
    options: AddOptions,
    messages: Message[],
  ): boolean {
    return (
      (options.archiveEpisode ?? this.episodeArchive.archive) &&
      episodeConversationMessages(messages).length > 0
    );
  }

  private prepareEpisode(
    id: string,
    messages: Message[],
    options: AddOptions,
    scope: Scope,
    createdAt: Date,
  ): Episode {
    return {
      id,
      namespaceId: scope.namespaceId,
      userId: scope.userId,
      agentId: scope.agentId,
      runId: scope.runId,
      messages: episodeConversationMessages(messages),
      source: options.source,
      createdAt,
    };
  }

  private async saveEpisodeIdempotently(episode: Episode): Promise<void> {
    const existing = await this.store.getEpisode(episode.id);
    if (existing) {
      if (
        stableJson({ ...existing, createdAt: existing.createdAt }) !==
        stableJson({ ...episode, createdAt: episode.createdAt })
      ) {
        throw new Error(`idempotent episode collision: ${episode.id}`);
      }
      return;
    }
    await this.store.saveEpisode(episode);
  }

  private async projectEpisodeChunks(
    episode: Episode,
    chunks: EpisodeIndexChunk[],
    precomputedVectors: number[][],
  ): Promise<void> {
    const payloads = chunks.map((chunk) => ({
      id: chunk.id,
      content: chunk.content,
      payload: episodeIndexPayload(episode, chunk),
    }));
    if (this.vectorProjectionSchedule === "inline") {
      if (precomputedVectors.length !== chunks.length) {
        throw new Error(
          `episode projection received ${precomputedVectors.length} vectors for ${chunks.length} chunks`,
        );
      }
      await this.vectors.upsert(
        payloads.map((record, index) => ({
          ...record,
          vector: precomputedVectors[index]!,
        })),
      );
      return;
    }

    await this.vectors.upsertText!(payloads);
    const projection = this.embedder
      .embedBatch(
        chunks.map((chunk) => chunk.content),
        {
          context: {
            namespaceId: episode.namespaceId,
            operation: "episode.embedding",
          },
        },
      )
      .then(async (vectors) => {
        if (vectors.length !== chunks.length) {
          throw new Error(
            `episode embedding batch returned ${vectors.length} vectors for ${chunks.length} chunks`,
          );
        }
        await this.vectors.upsert(
          payloads.map((record, index) => ({
            ...record,
            vector: vectors[index]!,
          })),
        );
      })
      .catch((error: unknown) => {
        this.warn(
          "episode_index_failed",
          "Deferred episode semantic indexing failed; the archived episode and lexical index remain available.",
          error,
          { episodeId: episode.id, ...scopeOf(episode) },
        );
      });
    this.pendingVectorProjections.push(projection);
    projection.finally(() => {
      this.pendingVectorProjections = this.pendingVectorProjections.filter(
        (candidate) => candidate !== projection,
      );
    });
    this.vectorProjectionHook?.(projection);
  }

  private async executeMutation<T>(spec: {
    namespaceId: string;
    idempotencyKey?: string;
    kind: "update" | "feedback" | "invalidate" | "delete" | "purge";
    memoryId: string;
    request: Record<string, unknown>;
    command: Record<string, unknown>;
    projectsBeliefs?: boolean;
    perform: (operation: MemoryOperation) => Promise<MutationOutcome<T>>;
  }): Promise<T> {
    const now = new Date();
    const candidate: MemoryOperation = {
      id: uuid(),
      namespaceId: spec.namespaceId,
      idempotencyKey: spec.idempotencyKey?.trim() || `automatic:${uuid()}`,
      kind: spec.kind,
      requestHash: contentHash(stableJson(spec.request)),
      command: spec.command,
      memoryIds: [spec.memoryId],
      status: "pending",
      rawStatus: "pending",
      vectorStatus: "pending",
      derivedStatus:
        spec.projectsBeliefs && this.beliefProjection.configured
          ? "pending"
          : "not_requested",
      leaseExpiresAt: new Date(now.getTime() + OPERATION_LEASE_MS),
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    };
    const claim = await this.store.claimOperation(candidate);
    const operation = claim.operation;
    if (
      operation.kind !== spec.kind ||
      operation.requestHash !== candidate.requestHash
    ) {
      throw new Error(
        `idempotency key conflict: ${candidate.idempotencyKey} was used for a different command`,
      );
    }
    if (!claim.claimed) {
      if (operation.status === "committed") {
        return structuredClone(operation.result) as T;
      }
      if (
        operation.status !== "failed" ||
        !(await this.store.retryOperation(
          operation.id,
          candidate.leaseExpiresAt!,
        ))
      ) {
        throw new Error(
          `idempotent operation ${operation.id} is already being processed`,
        );
      }
    }
    try {
      const outcome = await spec.perform(operation);
      const event: MemoryJournalEvent = {
        id: `${operation.id}:${spec.kind}:${spec.memoryId}`,
        namespaceId: spec.namespaceId,
        operationId: operation.id,
        memoryId: spec.memoryId,
        eventType: spec.kind.toUpperCase() as MemoryJournalEvent["eventType"],
        payload: outcome.payload,
        occurredAt: operation.createdAt,
      };
      await this.store.completeOperation(
        operation.id,
        outcome.result,
        outcome.projections,
        [event],
      );
      return outcome.result;
    } catch (error) {
      const projections = await this.inspectMutationProjections(operation);
      await this.store.failOperation(
        operation.id,
        error instanceof Error ? error.message : String(error),
        projections,
      );
      throw error;
    }
  }

  private async inspectMutationProjections(
    operation: MemoryOperation,
  ): Promise<{
    raw: ProjectionStatus;
    vector: ProjectionStatus;
    derived: ProjectionStatus;
  }> {
    const memoryId = operation.memoryIds[0]!;
    const recordResult = await Promise.allSettled([
      this.store.getMemory(memoryId),
    ]);
    const record =
      recordResult[0]?.status === "fulfilled" ? recordResult[0].value : null;
    let rawReady = false;
    if (operation.kind === "update" && record) {
      const patch = operation.command.patch as UpdateData;
      rawReady =
        (patch.content === undefined || record.content === patch.content) &&
        (patch.metadata === undefined ||
          stableJson(record.metadata) === stableJson(patch.metadata)) &&
        (patch.importance === undefined ||
          record.importance === clamp01(patch.importance)) &&
        (patch.memoryType === undefined ||
          record.memoryType === patch.memoryType);
    } else if (operation.kind === "invalidate" && record) {
      rawReady =
        record.validTo?.toISOString() === operation.command.validTo &&
        record.supersededBy === operation.command.supersededBy;
    } else if (operation.kind === "delete") {
      rawReady = record?.forgotten === true;
    } else if (operation.kind === "purge") {
      rawReady = record === null;
    }
    let vectorReady = operation.kind === "invalidate" && rawReady;
    if (rawReady && operation.kind !== "invalidate") {
      const vectorResult = await Promise.allSettled([
        this.vectors.get(memoryId),
      ]);
      const vector =
        vectorResult[0]?.status === "fulfilled"
          ? vectorResult[0].value
          : undefined;
      vectorReady =
        operation.kind === "update"
          ? Boolean(
              record && vector && vectorProjectsContent(vector, record.content),
            )
          : vector === null;
    }
    return {
      raw: rawReady ? "ready" : "pending",
      vector: vectorReady ? "ready" : "pending",
      derived: "not_requested",
    };
  }

  // ── search ───────────────────────────────────────────────────────────────────

  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<{
    results: MemorySearchResult[];
    /** Belief timelines for results sharing a (subject, attribute) key. */
    beliefs?: BeliefChain[];
    /** Per-source retrieval trace (when requested). */
    trace?: SearchTrace;
  }> {
    await this.init();
    const filters: MemoryFilters = {
      ...scopeOf(options),
      ...(options.memoryType ? { memoryType: options.memoryType } : {}),
      ...(options.filters ? { metadata: options.filters } : {}),
      ...(options.filter ? { predicate: options.filter } : {}),
    };
    const config: SearchConfig = {
      ...this.searchDefaults,
      mode: options.mode ?? this.searchDefaults.mode,
      searchStrategy:
        options.searchStrategy ?? this.searchDefaults.searchStrategy,
      sortBy: options.sortBy ?? this.searchDefaults.sortBy,
      maxResults: options.limit ?? this.searchDefaults.maxResults,
      minScore: options.minScore ?? this.searchDefaults.minScore,
      memoryType: options.memoryType,
      traceRetrieval: options.trace ?? this.searchDefaults.traceRetrieval,
    };
    const results = await this.search_.search(query, config, filters);
    // Record access on recalled memories (spacebot parity).
    await Promise.all(results.map((r) => this.store.recordAccess(r.memory.id)));

    // Belief-chain assembly (read-time reconstruction): group results that
    // share a (subject, attribute) key, pull in their supersession chains,
    // and order each slot on the event timeline. Pure lookups, no LLM.
    let beliefs: BeliefChain[] | undefined;
    if (this.beliefChains) {
      beliefs = await this.assembleBeliefChains(results.map((r) => r.memory));
      if (!beliefs.length) beliefs = undefined;
    }

    // Gist substitution (context-assembly policy, NOT a retrieval source):
    // under a token budget, several facts from the same episode collapse
    // into that episode's gist when the gist is cheaper.
    let finalResults = results;
    if (
      this.searchDefaults.gistSubstitution &&
      (this.searchDefaults.contextBudgetTokens ?? 0) > 0
    ) {
      finalResults = await this.substituteGists(results);
    }
    return {
      results: finalResults,
      ...(beliefs ? { beliefs } : {}),
      ...(this.searchDefaults.traceRetrieval || options.trace
        ? { trace: this.search_.lastTrace ?? undefined }
        : {}),
    };
  }

  /** Replace ≥2 same-episode facts with the episode gist when cheaper. */
  private async substituteGists(
    results: MemorySearchResult[],
  ): Promise<MemorySearchResult[]> {
    const byEpisode = new Map<string, MemorySearchResult[]>();
    for (const r of results) {
      const epId = r.memory.episodeId;
      if (
        !epId ||
        (r.memory.metadata as Record<string, unknown> | undefined)?.__gist
      )
        continue;
      const group = byEpisode.get(epId) ?? [];
      group.push(r);
      byEpisode.set(epId, group);
    }
    const replaceable = [...byEpisode.entries()].filter(
      ([, g]) => g.length >= 2,
    );
    if (!replaceable.length) return results;

    // Gists are few — fetch the flagged ones once.
    const gists = await this.store.listMemories(
      { metadata: { __gist: true } },
      { limit: 1_000 },
    );
    const gistByEpisode = new Map(
      gists.filter((g) => g.episodeId).map((g) => [g.episodeId!, g]),
    );

    const tokens = (text: string) => Math.ceil(text.length / 4);
    const out: MemorySearchResult[] = [];
    const dropped = new Set<string>();
    const insertedGist = new Set<string>();
    for (const r of results) {
      if (dropped.has(r.memory.id)) continue;
      const epId = r.memory.episodeId;
      const group = epId ? byEpisode.get(epId) : undefined;
      const gist = epId ? gistByEpisode.get(epId) : undefined;
      if (
        epId &&
        gist &&
        group &&
        group.length >= 2 &&
        !insertedGist.has(epId) &&
        tokens(gist.content) <
          group.reduce((sum, g) => sum + tokens(g.memory.content), 0)
      ) {
        insertedGist.add(epId);
        for (const g of group) dropped.add(g.memory.id);
        out.push({ memory: gist, score: r.score, rank: out.length + 1 });
      } else {
        out.push({ ...r, rank: out.length + 1 });
      }
    }
    return out;
  }

  /** Group memories by belief key, follow supersession chains, timeline-sort. */
  private async assembleBeliefChains(
    memories: MemoryRecord[],
  ): Promise<BeliefChain[]> {
    const byKey = new Map<string, Map<string, MemoryRecord>>();
    const keyOf = (m: MemoryRecord) =>
      m.subject && m.attribute
        ? `${m.subject.toLowerCase()}|${m.attribute.toLowerCase()}`
        : null;

    const addToKey = (key: string, m: MemoryRecord) => {
      const slot = byKey.get(key) ?? new Map<string, MemoryRecord>();
      slot.set(m.id, m);
      byKey.set(key, slot);
    };

    for (const m of memories) {
      if (isRetrievalDocMemory(m)) continue;
      const key = keyOf(m);
      if (!key) continue;
      addToKey(key, m);
      // Follow the supersession chain in both directions (bounded).
      let cursor: MemoryRecord | null = m;
      for (let hop = 0; hop < 5 && cursor?.supersededBy; hop++) {
        cursor = await this.store.getMemory(cursor.supersededBy);
        if (cursor && !cursor.forgotten && keyOf(cursor) === key) {
          addToKey(key, cursor);
        }
      }
    }

    const chains: BeliefChain[] = [];
    for (const [key, slot] of byKey) {
      if (slot.size < 2 && ![...slot.values()].some((m) => m.validTo)) continue;
      const [subject, attribute] = key.split("|") as [string, string];
      const entries = [...slot.values()]
        .sort((a, b) => {
          const ta = (a.eventDate ?? a.validFrom ?? a.createdAt).getTime();
          const tb = (b.eventDate ?? b.validFrom ?? b.createdAt).getTime();
          return ta - tb;
        })
        .map((m) => ({
          id: m.id,
          content: m.content,
          eventDate: m.eventDate,
          validFrom: m.validFrom,
          validTo: m.validTo,
          current: !m.validTo,
        }));
      chains.push({ subject, attribute, entries });
    }
    return chains;
  }

  // ── read ─────────────────────────────────────────────────────────────────────

  async get(memoryId: string): Promise<MemoryRecord | null> {
    await this.init();
    const memory = await this.store.getMemory(memoryId);
    if (!memory || memory.forgotten) return null;
    return memory;
  }

  async getAll(
    options: GetAllOptions = {},
  ): Promise<{ results: MemoryRecord[] }> {
    await this.init();
    const filters: MemoryFilters = {
      ...scopeOf(options),
      ...(options.memoryType ? { memoryType: options.memoryType } : {}),
      ...(options.filters ? { metadata: options.filters } : {}),
      ...(options.filter ? { predicate: options.filter } : {}),
    };
    const results = await this.store.listMemories(filters, {
      sort: options.sort ?? "recent",
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
      cursor: options.cursor,
    });
    return { results };
  }

  // ── update ─────────────────────────────────────────────────────────────────

  async update(
    memoryId: string,
    data: string | UpdateData,
    options: MutationOptions = {},
  ): Promise<AddResultItem> {
    await this.init();
    const record = await this.store.getMemory(memoryId);
    if (!record) throw new Error(`memory not found: ${memoryId}`);
    if (!memoryInScope(record, options)) {
      throw new Error(`memory not found: ${memoryId}`);
    }
    const patch: UpdateData =
      typeof data === "string" ? { content: data } : data;
    const namespaceId = options.namespaceId ?? record.namespaceId;
    if (namespaceId) {
      const updatedAt = new Date();
      return this.executeMutation({
        namespaceId,
        idempotencyKey: options.idempotencyKey,
        kind: "update",
        projectsBeliefs: true,
        memoryId,
        request: { memoryId, patch },
        command: {
          before: JSON.parse(JSON.stringify(record)) as Record<string, unknown>,
          patch,
          updatedAt: updatedAt.toISOString(),
        },
        perform: async (operation) => {
          const current = await this.store.getMemory(memoryId);
          if (!current || current.forgotten) {
            throw new Error(`memory not found: ${memoryId}`);
          }
          const storedPatch = operation.command.patch as UpdateData;
          const previous = (
            operation.command.before as { content?: string } | undefined
          )?.content;
          if (storedPatch.content !== undefined) {
            current.content = storedPatch.content;
            current.hash = contentHash(storedPatch.content);
          }
          if (storedPatch.metadata !== undefined) {
            current.metadata = storedPatch.metadata;
          }
          if (storedPatch.importance !== undefined) {
            current.importance = clamp01(storedPatch.importance);
          }
          if (storedPatch.memoryType !== undefined) {
            current.memoryType = storedPatch.memoryType;
          }
          current.projectionHints = withoutBeliefProjectionHint(
            current.projectionHints,
          );
          current.updatedAt = new Date(String(operation.command.updatedAt));
          await this.store.updateMemory(current);
          const beliefReady = await this.removeBeliefEvidence(
            memoryId,
            "update",
          );
          if (
            storedPatch.content !== undefined ||
            storedPatch.metadata !== undefined
          ) {
            await this.embedAndStore(current);
          }
          await this.refreshSlotSummaryFor(current);
          await this.store.addHistory({
            id: `${operation.id}:history`,
            memoryId,
            event: "UPDATE",
            previousValue: previous ?? current.content,
            newValue: current.content,
            createdAt: operation.createdAt,
          });
          const result: AddResultItem = {
            id: memoryId,
            memory: current.content,
            event: "UPDATE",
            previousMemory: previous,
          };
          return {
            result,
            payload: {
              before: operation.command.before,
              after: JSON.parse(JSON.stringify(current)) as Record<
                string,
                unknown
              >,
            },
            projections: {
              raw: "ready",
              vector: "ready",
              derived: this.beliefProjection.configured
                ? beliefReady
                  ? "ready"
                  : "pending"
                : "not_requested",
            },
          };
        },
      });
    }
    const previous = record.content;

    if (patch.content !== undefined) {
      record.content = patch.content;
      record.hash = contentHash(patch.content);
    }
    if (patch.metadata !== undefined) record.metadata = patch.metadata;
    if (patch.importance !== undefined) {
      record.importance = clamp01(patch.importance);
    }
    if (patch.memoryType !== undefined) record.memoryType = patch.memoryType;
    record.projectionHints = withoutBeliefProjectionHint(
      record.projectionHints,
    );
    record.updatedAt = new Date();

    await this.store.updateMemory(record);
    await this.removeBeliefEvidence(memoryId, "update");
    if (patch.content !== undefined || patch.metadata !== undefined) {
      await this.embedAndStore(record);
    }
    await this.refreshSlotSummaryFor(record);
    await this.store.addHistory({
      memoryId,
      event: "UPDATE",
      previousValue: previous,
      newValue: record.content,
    });
    return {
      id: memoryId,
      memory: record.content,
      event: "UPDATE",
      previousMemory: previous,
    };
  }

  // ── delete ─────────────────────────────────────────────────────────────────

  /** Create a tombstone and remove the recall projection. */
  async delete(
    memoryId: string,
    options: MutationOptions = {},
  ): Promise<boolean> {
    await this.init();
    const record = await this.store.getMemory(memoryId);
    if (record && !memoryInScope(record, options)) {
      throw new Error(`memory not found: ${memoryId}`);
    }
    const activeRecord = record?.forgotten ? undefined : record;
    const namespaceId =
      options.namespaceId ?? activeRecord?.namespaceId ?? record?.namespaceId;
    if (namespaceId) {
      const outcome = await this.executeMutation<{ deleted: boolean }>({
        namespaceId,
        idempotencyKey: options.idempotencyKey,
        kind: "delete",
        projectsBeliefs: true,
        memoryId,
        request: { memoryId },
        command: {
          before: activeRecord
            ? (JSON.parse(JSON.stringify(activeRecord)) as Record<
                string,
                unknown
              >)
            : null,
        },
        perform: async (operation) => {
          const current = await this.store.getMemory(memoryId);
          const deleted =
            current && !current.forgotten
              ? await this.store.forget(memoryId)
              : false;
          const beliefReady = await this.removeBeliefEvidence(
            memoryId,
            "delete",
          );
          const vectorReady = await this.deleteVectorIndexEntry(memoryId, {
            operation: "delete",
            operationId: operation.id,
          });
          const before = operation.command.before as {
            content?: string;
          } | null;
          if (before) {
            await this.store.addHistory({
              id: `${operation.id}:history`,
              memoryId,
              event: "DELETE",
              previousValue: before.content ?? null,
              newValue: null,
              createdAt: operation.createdAt,
            });
          }
          return {
            result: { deleted: deleted || Boolean(before) },
            payload: { before: operation.command.before, tombstone: true },
            projections: {
              raw: "ready",
              vector: vectorReady ? "ready" : "pending",
              derived: this.beliefProjection.configured
                ? beliefReady
                  ? "ready"
                  : "pending"
                : "not_requested",
            },
          };
        },
      });
      return outcome.deleted;
    }
    if (activeRecord) {
      await this.store.addHistory({
        memoryId,
        event: "DELETE",
        previousValue: activeRecord.content,
        newValue: null,
      });
    }
    const deleted = activeRecord ? await this.store.forget(memoryId) : false;
    await this.removeBeliefEvidence(memoryId, "delete");
    await this.deleteVectorIndexEntry(memoryId, { operation: "delete" });
    if (activeRecord) await this.refreshSlotSummaryFor(activeRecord);
    return deleted;
  }

  /** Permanently remove a memory. This is distinct from delete/tombstone. */
  async purge(
    memoryId: string,
    options: MutationOptions = {},
  ): Promise<boolean> {
    await this.init();
    const record = await this.store.getMemory(memoryId);
    if (record && !memoryInScope(record, options)) {
      throw new Error(`memory not found: ${memoryId}`);
    }
    const namespaceId = options.namespaceId ?? record?.namespaceId;
    if (!namespaceId) {
      if (!record) return false;
      await this.store.deleteMemory(memoryId);
      await this.removeBeliefEvidence(memoryId, "purge");
      await this.deleteVectorIndexEntry(memoryId, { operation: "purge" });
      return true;
    }
    const outcome = await this.executeMutation({
      namespaceId,
      idempotencyKey: options.idempotencyKey,
      kind: "purge",
      projectsBeliefs: true,
      memoryId,
      request: { memoryId },
      command: {
        before: record
          ? (JSON.parse(JSON.stringify(record)) as Record<string, unknown>)
          : null,
      },
      perform: async (operation) => {
        const current = await this.store.getMemory(memoryId);
        if (current) await this.store.deleteMemory(memoryId);
        const beliefReady = await this.removeBeliefEvidence(memoryId, "purge");
        const vectorReady = await this.deleteVectorIndexEntry(memoryId, {
          operation: "purge",
          operationId: operation.id,
        });
        return {
          result: { purged: Boolean(current || operation.command.before) },
          payload: { before: operation.command.before },
          projections: {
            raw: "ready",
            vector: vectorReady ? "ready" : "pending",
            derived: this.beliefProjection.configured
              ? beliefReady
                ? "ready"
                : "pending"
              : "not_requested",
          },
        };
      },
    });
    return outcome.purged;
  }

  /**
   * Mark a memory as no longer true (bi-temporal invalidation, Zep-style).
   * Unlike `forget()`, an invalidated memory STAYS searchable — it carries a
   * validity interval ("was true from validFrom to validTo") so history
   * questions ("where did X live before?") keep working. Logs INVALIDATE.
   */
  async invalidate(
    memoryId: string,
    opts: MutationOptions & { validTo?: Date; supersededBy?: string } = {},
  ): Promise<boolean> {
    await this.init();
    const record = await this.store.getMemory(memoryId);
    if (!record || record.forgotten) return false;
    if (!memoryInScope(record, opts)) return false;
    const namespaceId = opts.namespaceId ?? record.namespaceId;
    if (namespaceId) {
      const validTo = opts.validTo ?? new Date();
      return this.executeMutation({
        namespaceId,
        idempotencyKey: opts.idempotencyKey,
        kind: "invalidate",
        projectsBeliefs: true,
        memoryId,
        request: {
          memoryId,
          supersededBy: opts.supersededBy,
          validTo: opts.validTo?.toISOString(),
        },
        command: {
          before: JSON.parse(JSON.stringify(record)) as Record<string, unknown>,
          supersededBy: opts.supersededBy,
          validTo: validTo.toISOString(),
        },
        perform: async (operation) => {
          const current = await this.store.getMemory(memoryId);
          if (!current || current.forgotten) {
            throw new Error(`memory not found: ${memoryId}`);
          }
          current.validTo = new Date(String(operation.command.validTo));
          current.supersededBy =
            typeof operation.command.supersededBy === "string"
              ? operation.command.supersededBy
              : undefined;
          current.updatedAt = operation.createdAt;
          await this.store.updateMemory(current);
          const beliefReady = await this.invalidateBeliefEvidence(
            memoryId,
            current.validTo,
          );
          await this.refreshSlotSummaryFor(current);
          if (current.supersededBy) {
            const successor = await this.store.getMemory(current.supersededBy);
            if (!successor || successor.namespaceId !== namespaceId) {
              throw new Error(`memory not found: ${current.supersededBy}`);
            }
            await this.refreshSlotSummaryFor(successor);
            await this.store.createAssociation({
              id: `${operation.id}:updates`,
              sourceId: current.supersededBy,
              targetId: memoryId,
              relationType: "updates",
              weight: 1,
              createdAt: operation.createdAt,
            });
          }
          const before = operation.command.before as { content?: string };
          await this.store.addHistory({
            id: `${operation.id}:history`,
            memoryId,
            event: "INVALIDATE",
            previousValue: before.content ?? current.content,
            newValue: null,
            createdAt: operation.createdAt,
          });
          return {
            result: true,
            payload: {
              before: operation.command.before,
              after: JSON.parse(JSON.stringify(current)) as Record<
                string,
                unknown
              >,
            },
            projections: {
              raw: "ready",
              vector: "ready",
              derived: this.beliefProjection.configured
                ? beliefReady
                  ? "ready"
                  : "pending"
                : "not_requested",
            },
          };
        },
      });
    }
    record.validTo = opts.validTo ?? new Date();
    if (opts.supersededBy) record.supersededBy = opts.supersededBy;
    record.updatedAt = new Date();
    await this.store.updateMemory(record);
    await this.invalidateBeliefEvidence(memoryId, record.validTo);
    await this.refreshSlotSummaryFor(record);
    if (opts.supersededBy) {
      const successor = await this.store.getMemory(opts.supersededBy);
      if (successor) await this.refreshSlotSummaryFor(successor);
    }
    if (opts.supersededBy) {
      // successor —updates→ predecessor (spacebot relation semantics)
      await this.store.createAssociation({
        id: uuid(),
        sourceId: opts.supersededBy,
        targetId: memoryId,
        relationType: "updates",
        weight: 1,
        createdAt: new Date(),
      });
    }
    await this.store.addHistory({
      memoryId,
      event: "INVALIDATE",
      previousValue: record.content,
      newValue: null,
    });
    return true;
  }

  /** Soft-delete: keep the row but exclude it from search/recall. */
  async forget(memoryId: string): Promise<boolean> {
    await this.init();
    const record = await this.store.getMemory(memoryId);
    const changed = await this.store.forget(memoryId);
    if (changed) {
      await this.removeBeliefEvidence(memoryId, "forget");
      await this.deleteVectorIndexEntry(memoryId, { operation: "forget" });
      if (record) await this.refreshSlotSummaryFor(record);
    }
    return changed;
  }

  async deleteAll(
    scope: Scope = {},
    options: Pick<MutationOptions, "idempotencyKey"> = {},
  ): Promise<{ deleted: number }> {
    await this.init();
    const filters = scopeOf(scope);
    const namespaceId = scope.namespaceId?.trim();
    if (namespaceId) {
      const idempotencyKey =
        options.idempotencyKey?.trim() || `automatic:${uuid()}`;
      const requestHash = contentHash(stableJson({ filters }));
      const now = new Date();
      const candidate: MemoryOperation = {
        id: uuid(),
        namespaceId,
        idempotencyKey,
        kind: "delete_all",
        requestHash,
        command: { filters },
        memoryIds: [],
        status: "pending",
        rawStatus: "pending",
        vectorStatus: "pending",
        derivedStatus: this.beliefProjection.configured
          ? "pending"
          : "not_requested",
        leaseExpiresAt: new Date(now.getTime() + OPERATION_LEASE_MS),
        attempts: 1,
        createdAt: now,
        updatedAt: now,
      };
      const claim = await this.store.claimOperation(candidate);
      let operation = claim.operation;
      if (
        operation.kind !== "delete_all" ||
        operation.requestHash !== requestHash
      ) {
        throw new Error(
          `idempotency key conflict: ${idempotencyKey} was used for a different command`,
        );
      }
      if (!claim.claimed) {
        if (operation.status === "committed") {
          return structuredClone(operation.result) as { deleted: number };
        }
        if (
          operation.status !== "failed" ||
          !(await this.store.retryOperation(
            operation.id,
            candidate.leaseExpiresAt!,
          ))
        ) {
          throw new Error(
            `idempotent operation ${operation.id} is already being processed`,
          );
        }
      }
      try {
        if (operation.command.planned !== true) {
          const [records, slotKeys, episodes] = await Promise.all([
            this.store.listMemories(filters, {
              limit: DELETE_ALL_MAX_TARGETS + 1,
              sort: "recent",
            }),
            this.retrievalDocs.slotSummary
              ? this.slotKeysFor(filters)
              : Promise.resolve([]),
            this.store.listEpisodes(filters, {
              limit: DELETE_ALL_MAX_TARGETS + 1,
            }),
          ]);
          if (records.length + episodes.length > DELETE_ALL_MAX_TARGETS) {
            throw new DeleteAllLimitError(records.length + episodes.length);
          }
          const memoryIds = records.map((record) => record.id);
          const plannedCommand = {
            ...operation.command,
            planned: true,
            slotKeys,
            episodeIds: episodes.map((episode) => episode.id),
            episodeVectorIds: episodes.flatMap(episodeIndexIds),
          };
          if (
            new TextEncoder().encode(
              stableJson({ command: plannedCommand, memoryIds }),
            ).byteLength > DELETE_ALL_MAX_PLAN_BYTES
          ) {
            throw new DeleteAllLimitError(memoryIds.length);
          }
          operation = await this.store.planOperation(
            operation.id,
            plannedCommand,
            memoryIds,
          );
        }
        await this.store.deleteMemories(operation.memoryIds);
        await this.store.deleteEpisodes(
          readDeleteAllStringList(operation.command, "episodeIds"),
        );
        const beliefReady = await this.removeBeliefEvidenceMany(
          operation.memoryIds,
          "deleteAll",
        );
        const vectorReady = await this.deleteVectorIndexEntries(
          [
            ...operation.memoryIds,
            ...readDeleteAllStringList(operation.command, "episodeVectorIds"),
          ],
          {
            operation: "deleteAll",
            operationId: operation.id,
            filters,
          },
        );
        for (const key of readDeleteAllSlotKeys(operation.command)) {
          await this.refreshSlotSummary(key.subject, key.attribute, key.scope);
        }
        const result = { deleted: operation.memoryIds.length };
        const event: MemoryJournalEvent = {
          id: `${operation.id}:delete_all`,
          namespaceId,
          operationId: operation.id,
          memoryId: operation.memoryIds[0] ?? operation.id,
          eventType: "PURGE",
          payload: {
            bulk: true,
            deleted: result.deleted,
            filters,
          },
          occurredAt: operation.createdAt,
        };
        await this.store.completeOperation(
          operation.id,
          result,
          {
            raw: "ready",
            vector: vectorReady ? "ready" : "pending",
            derived: this.beliefProjection.configured
              ? beliefReady
                ? "ready"
                : "pending"
              : "not_requested",
          },
          [event],
        );
        return result;
      } catch (error) {
        await this.store.failOperation(
          operation.id,
          error instanceof Error ? error.message : String(error),
          {
            raw: "pending",
            vector: "pending",
            derived: this.beliefProjection.configured
              ? "pending"
              : "not_requested",
          },
        );
        throw error;
      }
    }
    const slotKeys = this.retrievalDocs.slotSummary
      ? await this.slotKeysFor(filters)
      : [];
    const episodes = await this.store.listEpisodes(filters, {
      limit: DELETE_ALL_MAX_TARGETS + 1,
    });
    if (episodes.length > DELETE_ALL_MAX_TARGETS) {
      throw new DeleteAllLimitError(episodes.length);
    }
    const ids = await this.store.deleteAll(filters);
    await this.store.deleteEpisodes(episodes.map((episode) => episode.id));
    await this.removeBeliefEvidenceMany(ids, "deleteAll");
    await this.deleteVectorIndexEntries(
      [...ids, ...episodes.flatMap(episodeIndexIds)],
      {
        operation: "deleteAll",
        filters,
      },
    );
    for (const key of slotKeys) {
      await this.refreshSlotSummary(key.subject, key.attribute, key.scope);
    }
    return { deleted: ids.length };
  }

  /** Permanently erase one structural namespace across canonical and rebuilt
   * projections. Canonical deletion wins every race; failed projection cleanup
   * is observable and remains repairable because projections are derived. */
  async purgeNamespace(
    scope: Scope,
  ): Promise<{ purged: number; documents: number }> {
    await this.init();
    const namespaceId = scope.namespaceId?.trim();
    if (!namespaceId) {
      throw new TypeError("namespace purge requires a structural namespace");
    }
    const snapshot = await this.store.exportNamespace(namespaceId);
    const ids = [
      ...snapshot.memories.map((memory) => memory.id),
      ...snapshot.documentChunks.map((chunk) => chunk.id),
      ...snapshot.episodes.flatMap(episodeIndexIds),
    ];
    await deleteVectorRecords(this.vectors, ids);
    await this.sidecar.clear({ namespaceId });
    const purgedIds = await this.store.purgeNamespace(namespaceId);
    await this.clearBeliefEvidence({ namespaceId }, "purgeNamespace");
    await this.documents_.deleteNamespaceOriginals(namespaceId);
    return {
      purged: purgedIds.length,
      documents: snapshot.documents.length,
    };
  }

  // ── history / reset ──────────────────────────────────────────────────────────

  /** Return the current feedback state derived from the append-only history. */
  async getFeedback(
    memoryId: string,
    scope: Scope = {},
  ): Promise<MemoryFeedback | null> {
    await this.init();
    const record = await this.store.getMemory(memoryId);
    if (!record || !memoryInScope(record, scope)) return null;
    return parseFeedbackHistory(await this.store.getHistory(memoryId));
  }

  /** Set a retry-safe quality signal without mutating the memory projection. */
  async setFeedback(
    memoryId: string,
    input: MemoryFeedbackInput,
    options: MutationOptions = {},
  ): Promise<MemoryFeedback> {
    await this.init();
    const record = await this.store.getMemory(memoryId);
    if (!record || record.forgotten || !memoryInScope(record, options)) {
      throw new Error(`memory not found: ${memoryId}`);
    }
    const namespaceId = options.namespaceId ?? record.namespaceId;
    const previous = await this.getFeedback(memoryId, options);
    if (!namespaceId) {
      const feedback: MemoryFeedback = {
        id: uuid(),
        memoryId,
        rating: input.rating,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        createdAt: new Date(),
      };
      await this.store.addHistory({
        memoryId,
        event: "FEEDBACK",
        previousValue: previous
          ? JSON.stringify(storeFeedback(previous))
          : null,
        newValue: JSON.stringify(storeFeedback(feedback)),
      });
      return feedback;
    }
    const stored = await this.executeMutation<StoredMemoryFeedback>({
      namespaceId,
      idempotencyKey: options.idempotencyKey,
      kind: "feedback",
      memoryId,
      request: { memoryId, ...input },
      command: {
        before: previous ? storeFeedback(previous) : null,
        rating: input.rating,
        reason: input.reason,
        requestId: input.requestId,
      },
      perform: async (operation) => {
        const current = await this.store.getMemory(memoryId);
        if (
          !current ||
          current.forgotten ||
          current.namespaceId !== namespaceId
        ) {
          throw new Error(`memory not found: ${memoryId}`);
        }
        const feedback: StoredMemoryFeedback = {
          id: `${operation.id}:feedback`,
          memoryId,
          rating: operation.command.rating as MemoryFeedbackRating,
          ...(typeof operation.command.reason === "string"
            ? { reason: operation.command.reason }
            : {}),
          ...(typeof operation.command.requestId === "string"
            ? { requestId: operation.command.requestId }
            : {}),
          createdAt: operation.createdAt.toISOString(),
        };
        await this.store.addHistory({
          id: `${operation.id}:history`,
          memoryId,
          event: "FEEDBACK",
          previousValue: operation.command.before
            ? JSON.stringify(operation.command.before)
            : null,
          newValue: JSON.stringify(feedback),
          createdAt: operation.createdAt,
        });
        return {
          result: feedback,
          payload: { before: operation.command.before, after: feedback },
          projections: {
            raw: "ready",
            vector: "not_requested",
            derived: "not_requested",
          },
        };
      },
    });
    const feedback = restoreFeedback(stored);
    if (!feedback) throw new Error("invalid stored memory feedback");
    return feedback;
  }

  /** Clear current feedback while retaining its immutable audit history. */
  async clearFeedback(
    memoryId: string,
    options: MutationOptions = {},
  ): Promise<boolean> {
    await this.init();
    const record = await this.store.getMemory(memoryId);
    if (!record || record.forgotten || !memoryInScope(record, options)) {
      throw new Error(`memory not found: ${memoryId}`);
    }
    const namespaceId = options.namespaceId ?? record.namespaceId;
    const previous = await this.getFeedback(memoryId, options);
    if (!namespaceId) {
      await this.store.addHistory({
        memoryId,
        event: "FEEDBACK",
        previousValue: previous
          ? JSON.stringify(storeFeedback(previous))
          : null,
        newValue: null,
      });
      return Boolean(previous);
    }
    const result = await this.executeMutation<{ cleared: boolean }>({
      namespaceId,
      idempotencyKey: options.idempotencyKey,
      kind: "feedback",
      memoryId,
      request: { memoryId, clear: true },
      command: {
        before: previous ? storeFeedback(previous) : null,
        clear: true,
      },
      perform: async (operation) => {
        const current = await this.store.getMemory(memoryId);
        if (
          !current ||
          current.forgotten ||
          current.namespaceId !== namespaceId
        ) {
          throw new Error(`memory not found: ${memoryId}`);
        }
        await this.store.addHistory({
          id: `${operation.id}:history`,
          memoryId,
          event: "FEEDBACK",
          previousValue: operation.command.before
            ? JSON.stringify(operation.command.before)
            : null,
          newValue: null,
          createdAt: operation.createdAt,
        });
        return {
          result: { cleared: Boolean(operation.command.before) },
          payload: { before: operation.command.before, after: null },
          projections: {
            raw: "ready",
            vector: "not_requested",
            derived: "not_requested",
          },
        };
      },
    });
    return result.cleared;
  }

  async history(memoryId: string, scope: Scope = {}): Promise<HistoryEntry[]> {
    await this.init();
    const record = await this.store.getMemory(memoryId);
    if (!record || !memoryInScope(record, scope)) return [];
    return this.store.getHistory(memoryId);
  }

  async reset(): Promise<void> {
    await this.init();
    await this.store.reset();
    await this.clearBeliefEvidence(undefined, "reset");
    await this.documents_.clearOriginals();
    await this.deleteVectorIndexByFilter({}, { operation: "reset" });
  }

  // ── graph extras (spacebot flavour) ─────────────────────────────────────────

  /** Create a graph edge between two existing memories. */
  async link(
    sourceId: string,
    targetId: string,
    relationType: RelationType = "related_to",
    weight = 0.5,
  ): Promise<Association | null> {
    await this.init();
    const [a, b] = await Promise.all([
      this.store.getMemory(sourceId),
      this.store.getMemory(targetId),
    ]);
    if (!a || !b) return null;
    const association: Association = {
      id: uuid(),
      sourceId,
      targetId,
      relationType,
      weight: clamp01(weight),
      createdAt: new Date(),
    };
    await this.store.createAssociation(association);
    return association;
  }

  /** BFS neighbourhood around a memory. */
  async neighbors(
    memoryId: string,
    depth = 1,
    excludeIds: string[] = [],
  ): Promise<{ nodes: MemoryRecord[]; edges: Association[] }> {
    await this.init();
    return this.store.getNeighbors(memoryId, depth, excludeIds);
  }

  /** A subgraph view: scoped nodes plus the edges between them. */
  async graph(
    options: GetAllOptions = {},
  ): Promise<{ nodes: MemoryRecord[]; edges: Association[] }> {
    await this.init();
    const nodes = await this.store.listMemories(
      {
        ...scopeOf(options),
        ...(options.memoryType ? { memoryType: options.memoryType } : {}),
      },
      { sort: options.sort ?? "recent", limit: options.limit ?? 200 },
    );
    const edges = await this.store.getAssociationsBetween(
      nodes.map((n) => n.id),
    );
    return { nodes, edges };
  }

  /**
   * Run demote → decay → consolidate → prune over a scope. Optional
   * metadata-equality filters further constrain the pass. Multi-tenant hosts
   * should call this through `forNamespace()` so consolidation cannot merge
   * near-duplicates across namespaces.
   */
  async runMaintenance(
    scope: Scope = {},
    opts: { filters?: Record<string, unknown> } = {},
  ) {
    await this.init();
    return this.maintenance_.runAll({
      ...scopeOf(scope),
      ...(opts.filters ? { metadata: opts.filters } : {}),
    });
  }

  // ── profile blocks (Letta core-memory / Memobase profile-slot flavour) ─────

  /**
   * The synthesized profile for a scope (markdown), or null if
   * `refreshProfile` has never run. Inject this ahead of retrieved memories
   * when building agent context — retrieval surfaces point facts, the
   * profile carries identity/preferences/aggregations that top-k misses.
   */
  async getProfile(scope: Scope = {}): Promise<string | null> {
    await this.init();
    return this.profile_.get(scopeOf(scope));
  }

  /**
   * Current value of a `(subject, attribute)` belief slot from the derived
   * sidecar — e.g. `getState("Melanie", "residence")` → where she lives now.
   * Populated only when `derivation.enabled` is true, or after `rebuildSidecar`.
   * Pass `asOf` for a point-in-time value.
   * Recall is unaffected: this reads the sidecar, never the canonical index.
   */
  async getState(
    subject: string,
    attribute: string,
    opts: Scope & { asOf?: Date } = {},
  ): Promise<StateSlot | undefined> {
    await this.init();
    return this.sidecar.getState(scopeOf(opts), subject, attribute, opts);
  }

  /** Full timeline of a belief slot (oldest first) from the sidecar. */
  async getStateHistory(
    subject: string,
    attribute: string,
    opts: Scope = {},
  ): Promise<StateSlot[]> {
    await this.init();
    return this.sidecar.getStateHistory(scopeOf(opts), subject, attribute);
  }

  /**
   * Governed shadow view for automatically inferred preferences/rules.
   * `getState()` remains the explicit current-state interface; this method
   * reports whether repeated independent evidence agrees with that state.
   */
  async getBeliefView(
    subject: string,
    attribute: string,
    opts: BeliefQueryOptions = {},
  ): Promise<BeliefViewResult> {
    await this.init();
    const stateScope = scopeOf(opts);
    const beliefScope = this.beliefOwnerScope(stateScope);
    const applicability = opts.applicability
      ? normalizeApplicability(opts.applicability)
      : this.defaultBeliefApplicability(stateScope);
    const state = await this.sidecar.getState(stateScope, subject, attribute, {
      ...(opts.at ? { asOf: opts.at } : {}),
    });
    if (!this.beliefProjectionEnabled(stateScope)) {
      return {
        projectionStatus: "disabled",
        mode: opts.mode ?? "default",
        subject,
        attribute,
        applicability,
        candidates: [],
        unresolved: false,
        reasonCodes: ["projection_disabled"],
        shadow: {
          outcome: state ? "state_only" : "empty",
          ...(state ? { state } : {}),
        },
      };
    }
    const view = await this.beliefReconciler.view(
      beliefScope,
      subject,
      attribute,
      {
        mode: opts.mode,
        applicability,
        at: opts.at,
        allApplicability: opts.allApplicability,
      },
    );
    const winner = view.winner;
    let outcome: BeliefShadowOutcome;
    if (view.unresolved) outcome = "unresolved";
    else if (state && winner) {
      outcome =
        winner.sourceIds.some((sourceId) => state.sources.includes(sourceId)) ||
        normalizeBeliefValue(state.value) === normalizeBeliefValue(winner.value)
          ? "agreement"
          : "disagreement";
    } else if (state) outcome = "state_only";
    else if (winner) outcome = "belief_only";
    else outcome = "empty";
    return {
      ...view,
      shadow: {
        outcome,
        ...(state ? { state } : {}),
        ...(winner ? { winnerId: winner.id } : {}),
      },
    };
  }

  /** Await all in-flight `"deferred"` sidecar derivations (Node shutdown/tests). */
  async flushDerivations(): Promise<void> {
    await Promise.all(this.pendingDerivations);
  }

  /**
   * Rebuild the state sidecar from canonical records (materialized-view
   * refresh): clear derived state for the scope, then replay every record through
   * derivation in event-time order so supersession resolves correctly. Use after
   * a prompt/schema change, or to backfill state for memories added before
   * derivation was enabled.
   * (Re-runs extraction per record — cost scales with corpus size.)
   */
  async rebuildSidecar(scope: Scope = {}): Promise<void> {
    await this.init();
    const s = scopeOf(scope);
    const scoped = Boolean(s.namespaceId || s.userId || s.agentId || s.runId);
    await this.sidecar.clear(scoped ? s : undefined);
    const all = (await this.getAll({ ...scope, limit: 1_000_000 })).results;
    all.sort(
      (a, b) =>
        (a.eventDate ?? a.createdAt).getTime() -
        (b.eventDate ?? b.createdAt).getTime(),
    );
    for (const rec of all) {
      const rebuilt = await this.deriveState(
        [{ role: "user", content: rec.content }],
        { eventDate: rec.eventDate },
        {
          namespaceId: rec.namespaceId,
          userId: rec.userId,
          agentId: rec.agentId,
          runId: rec.runId,
        },
        [rec.id],
      );
      if (!rebuilt) {
        throw new Error(`sidecar rebuild failed for memory ${rec.id}`);
      }
    }
  }

  /** Rebuild governed belief evidence from JSON-safe hints frozen on inferred
   * canonical records. This performs zero LLM calls. */
  async rebuildBeliefs(
    scope: Scope = {},
  ): Promise<{ evidence: number; slots: number }> {
    await this.init();
    const requestedScope = scopeOf(scope);
    const normalizedScope = this.beliefOwnerScope(requestedScope);
    const scoped = Boolean(
      normalizedScope.namespaceId ||
        normalizedScope.userId ||
        normalizedScope.agentId ||
        normalizedScope.runId,
    );
    if (!this.beliefProjectionEnabled(requestedScope)) {
      return { evidence: 0, slots: 0 };
    }
    await this.beliefReconciler.clear(scoped ? normalizedScope : undefined);
    const records = await this.store.listMemories(normalizedScope, {
      limit: 1_000_000,
      sort: "recent",
    });
    records.sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
    const slots = new Set<string>();
    let evidence = 0;
    try {
      for (const record of records) {
        const hint = record.projectionHints?.belief;
        if (!hint || !record.subject || !record.attribute) continue;
        evidence += await this.projectBeliefSources([record.id]);
        slots.add(
          `${normalizeBeliefValue(record.subject)}\u0000${normalizeBeliefValue(
            record.attribute,
          )}\u0000${JSON.stringify(hint.applicability)}`,
        );
      }
    } catch (error) {
      await this.beliefReconciler.clear(scoped ? normalizedScope : undefined);
      throw error;
    }
    return { evidence, slots: slots.size };
  }

  /** Rebuild and verify all rebuildable projections for one namespace. */
  async rebuildProjections(scope: Scope): Promise<{
    vectors: number;
    sidecar: "rebuilt" | "not_configured";
    beliefs: "rebuilt" | "not_configured";
  }> {
    await this.init();
    const namespaceId = scope.namespaceId?.trim();
    if (!namespaceId) {
      throw new TypeError("projection rebuild requires a structural namespace");
    }
    const filters = scopeOf(scope);
    const beliefsEnabledForScope =
      this.derivationEnabled && this.beliefProjectionEnabled(filters);
    const records = await this.store.listMemories(filters, {
      limit: 1_000_000,
      sort: "recent",
    });
    const documents = await this.store.listCurrentDocuments(
      { namespaceId },
      { limit: 1_000_000 },
    );
    const documentChunks = (
      await Promise.all(
        documents.map((document) => this.store.listDocumentChunks(document.id)),
      )
    ).flat();
    const episodes = this.episodeArchive.searchable
      ? await this.store.listEpisodes(filters, { limit: 1_000_000 })
      : [];
    const episodeChunks = episodes.flatMap((episode) =>
      buildEpisodeIndexChunks(episode).map((chunk) => ({ episode, chunk })),
    );
    // Vectorize cannot delete by filter or enumerate. Search results are
    // always rehydrated through the canonical graph/document store, so unknown
    // orphan ids remain invisible; rebuild known canonical ids in place and
    // verify each one directly instead.
    if (this.vectors.capabilities?.filterDelete !== false) {
      await this.vectors.deleteByFilter(filters);
    }
    for (const record of records) await this.embedAndStore(record);
    for (const document of documents) {
      await this.documents_.rebuild(document.id, namespaceId);
    }
    for (const episode of episodes) {
      const chunks = buildEpisodeIndexChunks(episode);
      if (!chunks.length) continue;
      const vectors = await this.embedder.embedBatch(
        chunks.map((chunk) => chunk.content),
        {
          context: {
            namespaceId,
            operation: "episode.embedding.rebuild",
          },
        },
      );
      if (vectors.length !== chunks.length) {
        throw new Error(
          `episode embedding batch returned ${vectors.length} vectors for ${chunks.length} chunks`,
        );
      }
      await this.vectors.upsert(
        chunks.map((chunk, index) => ({
          id: chunk.id,
          content: chunk.content,
          payload: episodeIndexPayload(episode, chunk),
          vector: vectors[index]!,
        })),
      );
    }
    const expected = new Map([
      ...records.map((record) => [record.id, record.content] as const),
      ...documentChunks.map((chunk) => [chunk.id, chunk.content] as const),
      ...episodeChunks.map(({ chunk }) => [chunk.id, chunk.content] as const),
    ]);
    const rebuilt =
      this.vectors.capabilities?.enumeration === false
        ? await getVectorRecords(this.vectors, [...expected.keys()])
        : await this.vectors.list(
            filters,
            records.length + documentChunks.length + episodeChunks.length + 1,
          );
    const verificationFailed =
      rebuilt.length !== expected.size ||
      rebuilt.some(
        (record) =>
          !record ||
          !vectorProjectsContent(record, expected.get(record.id) ?? "") ||
          record.payload.namespaceId !== namespaceId,
      );
    if (verificationFailed) {
      throw new Error(
        `vector projection verification failed for ${namespaceId}`,
      );
    }
    await this.store.markProjectionReady(namespaceId, "vector");
    if (this.derivationEnabled) {
      await this.rebuildSidecar(scope);
      if (beliefsEnabledForScope) await this.rebuildBeliefs(scope);
      await this.store.markProjectionReady(namespaceId, "derived");
    }
    return {
      vectors: expected.size,
      sidecar: this.derivationEnabled ? "rebuilt" : "not_configured",
      beliefs: beliefsEnabledForScope ? "rebuilt" : "not_configured",
    };
  }

  /** Query-addressed profile sections (zero LLM, zero embedding call). */
  async getProfileSections(
    query: string,
    scope: Scope = {},
    opts: { limit?: number; minScore?: number } = {},
  ): Promise<ProfileSection[]> {
    await this.init();
    return this.profile_.relevantSections(query, scopeOf(scope), opts);
  }

  /**
   * Re-synthesize the scope's profile from its memories (one LLM call).
   * Call after ingesting a batch/session, or on your own schedule.
   */
  async refreshProfile(scope: Scope = {}): Promise<string | null> {
    await this.init();
    return this.profile_.refresh(scopeOf(scope));
  }

  /** Raw archived conversation chunks (non-lossy episode store). */
  async episodes(
    scope: Scope = {},
    options: { limit?: number; offset?: number } = {},
  ) {
    await this.init();
    return this.store.listEpisodes(scopeOf(scope), options);
  }

  /** Permanently delete one archived episode and its hidden retrieval docs. */
  async deleteEpisode(episodeId: string, scope: Scope = {}): Promise<boolean> {
    await this.init();
    const episode = await this.store.getEpisode(episodeId);
    if (!episode || !episodeInScope(episode, scope)) return false;
    await this.store.deleteEpisodes([episodeId]);
    await this.deleteVectorIndexEntries(episodeIndexIds(episode), {
      operation: "deleteEpisode",
      episodeId,
      ...scopeOf(scope),
    });
    return true;
  }

  /** Export the complete authoritative graph state for one namespace. Vector
   * and sidecar projections are marked for rebuild instead of duplicated. */
  async exportSnapshot(scope: Scope): Promise<NamespaceSnapshotV1> {
    await this.init();
    const namespaceId = scope.namespaceId?.trim();
    if (!namespaceId) {
      throw new TypeError("exportSnapshot requires a structural namespace");
    }
    const data = await this.store.exportNamespace(namespaceId);
    data.documents = await this.documents_.hydrateForSnapshot(data.documents);
    return createNamespaceSnapshot(namespaceId, data);
  }

  async importSnapshot(
    snapshot: unknown,
    scope: Scope,
    options: ImportOptions,
  ): Promise<{ imported: number; documents: number; vectors: number }> {
    await this.init();
    const namespaceId = scope.namespaceId?.trim();
    if (!namespaceId) {
      throw new TypeError("snapshot import requires a structural namespace");
    }
    const idempotencyKey = options.idempotencyKey?.trim();
    if (!idempotencyKey) {
      throw new TypeError("snapshot import requires an idempotency key");
    }
    const data = parseNamespaceSnapshot(snapshot, namespaceId);
    const requestHash = contentHash(stableJson(snapshot));
    const now = new Date();
    const candidate: MemoryOperation = {
      id: uuid(),
      namespaceId,
      idempotencyKey,
      kind: "import",
      requestHash,
      command: { snapshotHash: requestHash },
      memoryIds: data.memories.map((memory) => memory.id),
      status: "pending",
      rawStatus: "pending",
      vectorStatus: "pending",
      derivedStatus: this.derivationEnabled ? "pending" : "not_requested",
      leaseExpiresAt: new Date(now.getTime() + OPERATION_LEASE_MS),
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    };
    const claim = await this.store.claimOperation(candidate);
    const operation = claim.operation;
    if (operation.kind !== "import" || operation.requestHash !== requestHash) {
      throw new Error(
        `idempotency key conflict: ${idempotencyKey} was used for a different command`,
      );
    }
    if (!claim.claimed) {
      if (operation.status === "committed") {
        return structuredClone(operation.result) as {
          imported: number;
          documents: number;
          vectors: number;
        };
      }
      if (
        operation.status !== "failed" ||
        !(await this.store.retryOperation(
          operation.id,
          candidate.leaseExpiresAt!,
        ))
      ) {
        throw new Error(
          `idempotent operation ${operation.id} is already being processed`,
        );
      }
    }
    const stagingNamespaceId = `__fishmem_import__:${operation.id}`;
    try {
      if (operation.rawStatus !== "ready") {
        const current = await this.store.exportNamespace(namespaceId);
        const foreignOperations = current.operations.filter(
          (entry) => entry.id !== operation.id,
        );
        if (
          current.memories.length ||
          current.associations.length ||
          current.history.length ||
          current.entities.length ||
          current.memoryEntities.length ||
          current.episodes.length ||
          current.documents.length ||
          current.documentHeads.length ||
          current.documentChunks.length ||
          foreignOperations.length ||
          current.events.length
        ) {
          throw new Error("snapshot import target namespace must be empty");
        }
        const stagedData = {
          ...data,
          documents: await this.documents_.prepareSnapshotImport(
            data.documents,
          ),
        };
        await this.store.stageNamespaceImport(stagingNamespaceId, stagedData);
        await this.store.commitNamespaceImport(stagingNamespaceId, namespaceId);
      }
      const rebuilt = await this.rebuildProjections(scope);
      const result = {
        imported: data.memories.length,
        documents: data.documents.length,
        vectors: rebuilt.vectors,
      };
      await this.store.completeOperation(
        operation.id,
        result,
        {
          raw: "ready",
          vector: "ready",
          derived: this.derivationEnabled ? "ready" : "not_requested",
        },
        [],
      );
      return result;
    } catch (error) {
      const current = await this.store.exportNamespace(namespaceId);
      const importedIds = new Set(data.memories.map((memory) => memory.id));
      const importedDocumentIds = new Set(
        data.documents.map((document) => document.id),
      );
      const rawReady =
        current.memories.filter((memory) => importedIds.has(memory.id))
          .length === importedIds.size &&
        current.documents.filter((document) =>
          importedDocumentIds.has(document.id),
        ).length === importedDocumentIds.size;
      await this.store.failOperation(
        operation.id,
        error instanceof Error ? error.message : String(error),
        {
          raw: rawReady ? "ready" : "pending",
          vector: "pending",
          derived: this.derivationEnabled ? "pending" : "not_requested",
        },
      );
      throw error;
    }
  }

  async getOperation(
    operationId: string,
    scope: Scope,
  ): Promise<MemoryOperation | null> {
    const namespaceId = scope.namespaceId?.trim();
    if (!namespaceId) {
      throw new TypeError("operation lookup requires a structural namespace");
    }
    const operation = await this.store.getOperation(operationId);
    return operation?.namespaceId === namespaceId ? operation : null;
  }

  async listOperations(scope: Scope, limit = 100): Promise<MemoryOperation[]> {
    const namespaceId = scope.namespaceId?.trim();
    if (!namespaceId) {
      throw new TypeError("operation listing requires a structural namespace");
    }
    return this.store.listOperations(
      namespaceId,
      Math.min(Math.max(limit, 1), 100),
    );
  }

  async summarizeOperations(scope: Scope) {
    const namespaceId = scope.namespaceId?.trim();
    if (!namespaceId) {
      throw new TypeError("operation summary requires a structural namespace");
    }
    return this.store.summarizeOperations(namespaceId);
  }

  /**
   * Summarize one archived episode into a gist memory (one LLM call,
   * explicit — constitution budget law). The gist is an `observation`
   * flagged `metadata["__gist"]`, carrying the episode's provenance and
   * date; under a context token budget, search substitutes several
   * same-episode facts with their gist.
   */
  async summarizeEpisode(
    episodeId: string,
    scope: Scope = {},
  ): Promise<{ id: string; gist: string } | null> {
    await this.init();
    const episode = await this.store.getEpisode(episodeId);
    if (!episode) return null;
    const transcript = messagesToTranscript(episode.messages);
    let gist: string;
    try {
      gist = (
        await this.llm.chat(
          [
            { role: "system", content: EPISODE_GIST_SYSTEM },
            { role: "user", content: transcript },
          ],
          {
            temperature: 0,
            context: {
              namespaceId: episode.namespaceId,
              operation: "episode.gist",
            },
          },
        )
      ).trim();
    } catch (error) {
      this.warn(
        "episode_gist_failed",
        "Episode gist generation failed; no gist memory was written.",
        error,
        { episodeId, ...scopeOf(scope) },
      );
      return null;
    }
    if (!gist) return null;
    const record = await this.createRecord(
      gist,
      {
        ...scope,
        memoryType: "observation",
        metadata: { __gist: true },
        eventDate: episode.createdAt,
      },
      scope,
      episode.createdAt,
      { episodeId },
    );
    return { id: record.id, gist };
  }

  /**
   * Point-in-time belief query (Allen interval algebra, zero LLM): what was
   * believed about (subject, attribute) at instant `at`?
   *
   *   current(at) = memories with validFrom ≤ at < validTo (or no validTo)
   *
   * Returns the belief(s) valid at that instant plus the full timeline —
   * deterministic and provably consistent with the stored intervals. This
   * is the thesis as an operator: "what is believed now, what was believed
   * before, and when it changed".
   */
  async beliefAt(
    subject: string,
    attribute: string,
    at: Date,
    scope: Scope = {},
  ): Promise<{
    valid: MemoryRecord[];
    timeline: MemoryRecord[];
  }> {
    await this.init();
    const all = await this.store.listMemories(
      { ...scopeOf(scope), subject, attribute },
      { limit: 1_000, sort: "recent" },
    );
    const t = at.getTime();
    const timeline = all.sort((a, b) => {
      const ta = (a.eventDate ?? a.validFrom ?? a.createdAt).getTime();
      const tb = (b.eventDate ?? b.validFrom ?? b.createdAt).getTime();
      return ta - tb;
    });
    const valid = timeline.filter((m) => {
      const from = (m.validFrom ?? m.eventDate ?? m.createdAt).getTime();
      const to = m.validTo?.getTime() ?? Infinity;
      return from <= t && t < to;
    });
    return { valid, timeline };
  }

  /**
   * Hebbian reinforcement: strengthen the edges among memories that were
   * used together SUCCESSFULLY (the caller supplies the success signal —
   * e.g. the answer built from these memories was accepted/judged correct).
   * Existing edges grow `w ← w + η(cap − w)`; co-used pairs without an edge
   * get a weak `related_to` seeded at η. Pure computation; capped growth.
   */
  async reinforce(
    memoryIds: string[],
    opts: { eta?: number; cap?: number } = {},
  ): Promise<{ strengthened: number; created: number }> {
    await this.init();
    const eta = opts.eta ?? 0.1;
    const cap = opts.cap ?? 0.95;
    const ids = [...new Set(memoryIds)];
    let strengthened = 0;
    let created = 0;
    if (ids.length < 2) return { strengthened, created };
    const edges = await this.store.getAssociationsBetween(ids);
    const edgeKey = (a: string, b: string) =>
      a < b ? `${a}|${b}` : `${b}|${a}`;
    const existing = new Map(
      edges.map((e) => [edgeKey(e.sourceId, e.targetId), e]),
    );
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = edgeKey(ids[i]!, ids[j]!);
        const edge = existing.get(key);
        if (edge) {
          edge.weight = Math.min(cap, edge.weight + eta * (cap - edge.weight));
          await this.store.createAssociation(edge); // upsert semantics
          strengthened++;
        } else {
          await this.store.createAssociation({
            id: uuid(),
            sourceId: ids[i]!,
            targetId: ids[j]!,
            relationType: "related_to",
            weight: eta,
            createdAt: new Date(),
          });
          created++;
        }
      }
    }
    return { strengthened, created };
  }

  /**
   * Promote a memory back into the hot `working` tier (spacebot
   * tiered-memory design). Returns false if the memory doesn't exist.
   */
  async promote(memoryId: string): Promise<boolean> {
    await this.init();
    const record = await this.store.getMemory(memoryId);
    if (!record || record.forgotten) return false;
    record.tier = "working";
    record.demotedAt = undefined;
    record.lastAccessedAt = new Date();
    record.updatedAt = new Date();
    await this.store.updateMemory(record);
    return true;
  }

  async close(): Promise<void> {
    await Promise.all(this.pendingVectorProjections);
    await Promise.all([this.store.close(), this.beliefReconciler.close()]);
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  private async createRecord(
    content: string,
    options: AddOptions,
    scope: Scope,
    eventDate?: Date,
    structured?: {
      subject?: string | null;
      attribute?: string | null;
      episodeId?: string;
      memoryType?: MemoryType | null;
      projectionHints?: MemoryProjectionHints;
    },
    identity?: { id: string; createdAt: Date },
    precomputedVector?: number[],
  ): Promise<MemoryRecord> {
    const now = identity?.createdAt ?? new Date();
    const resolvedEventDate = eventDate ?? options.eventDate;
    // Precedence: explicit per-call > structured caller metadata > engine default.
    const memoryType =
      options.memoryType ?? structured?.memoryType ?? this.defaultMemoryType;
    const importance =
      options.importance !== undefined
        ? clamp01(options.importance)
        : DEFAULT_IMPORTANCE[memoryType];
    if (identity) {
      const existing = await this.store.getMemory(identity.id);
      if (existing) {
        if (
          existing.content !== content ||
          existing.namespaceId !== scope.namespaceId ||
          existing.userId !== scope.userId ||
          existing.agentId !== scope.agentId ||
          existing.runId !== scope.runId ||
          existing.memoryType !== memoryType ||
          existing.importance !== importance ||
          existing.source !== options.source ||
          stableJson(existing.metadata) !== stableJson(options.metadata) ||
          stableJson(existing.projectionHints) !==
            stableJson(structured?.projectionHints) ||
          existing.episodeId !== structured?.episodeId ||
          existing.subject !== (structured?.subject ?? undefined) ||
          existing.attribute !== (structured?.attribute ?? undefined) ||
          existing.eventDate?.getTime() !== resolvedEventDate?.getTime()
        ) {
          throw new Error(`idempotent memory collision: ${identity.id}`);
        }
        await this.projectRecord(existing, scope, precomputedVector);
        const history = await this.store.getHistory(existing.id);
        if (!history.some((entry) => entry.event === "ADD")) {
          await this.store.addHistory({
            memoryId: existing.id,
            event: "ADD",
            previousValue: null,
            newValue: content,
          });
        }
        await this.refreshSlotSummaryFor(existing);
        return existing;
      }
    }
    const record: MemoryRecord = {
      id: identity?.id ?? uuid(),
      content,
      memoryType,
      importance,
      hash: contentHash(content),
      namespaceId: scope.namespaceId,
      userId: scope.userId,
      agentId: scope.agentId,
      runId: scope.runId,
      source: options.source,
      metadata: options.metadata,
      projectionHints: structured?.projectionHints,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      forgotten: false,
      // New memories enter the hot working tier (identity stays permanent in
      // the graph tier — spacebot tiered-memory design).
      tier:
        this.tiersEnabled && memoryType !== "identity" ? "working" : "graph",
      // Bi-temporal anchors: event time, and validity starting at event time.
      eventDate: resolvedEventDate,
      validFrom: resolvedEventDate ?? now,
      subject: structured?.subject ?? undefined,
      attribute: structured?.attribute ?? undefined,
      episodeId: structured?.episodeId,
    };
    await this.store.saveMemory(record);
    await this.projectRecord(record, scope, precomputedVector);
    await this.store.addHistory({
      memoryId: record.id,
      event: "ADD",
      previousValue: null,
      newValue: content,
    });
    await this.refreshSlotSummaryFor(record);
    return record;
  }

  private async inspectAddProjections(
    memoryIds: string[],
    derive: boolean,
  ): Promise<{
    raw: ProjectionStatus;
    vector: ProjectionStatus;
    derived: ProjectionStatus;
  }> {
    const rawRecords = await Promise.allSettled(
      memoryIds.map((id) => this.store.getMemory(id)),
    );
    const rawReady = rawRecords.every(
      (record) => record.status === "fulfilled" && record.value !== null,
    );
    let vectorReady = false;
    if (rawReady) {
      try {
        vectorReady = (await getVectorRecords(this.vectors, memoryIds)).every(
          (record) => record !== null,
        );
      } catch {
        // A failed projection read is reported as pending so the durable
        // operation can be retried instead of making status inspection fail.
      }
    }
    return {
      raw: rawReady ? "ready" : "pending",
      vector: vectorReady ? "ready" : "pending",
      derived: derive ? "pending" : "not_requested",
    };
  }

  private async refreshSlotSummaryFor(record: MemoryRecord): Promise<void> {
    if (!this.retrievalDocs.slotSummary) return;
    if (!record.subject || !record.attribute) return;
    await this.refreshSlotSummary(
      record.subject,
      record.attribute,
      scopeFromMemory(record),
    );
  }

  /**
   * Materialize the sidecar's belief slot as a slot-summary retrieval doc
   * (opt-in via `retrievalDocs.slotSummary`). Called from the derivation pass;
   * the slots are adapted into the record shape the renderer expects.
   */
  private async refreshSlotSummaryFromSidecar(
    scope: Scope,
    subject: string,
    attribute: string,
  ): Promise<void> {
    if (!this.retrievalDocs.slotSummary) return;
    try {
      const slots = await this.sidecar.getStateHistory(
        scope,
        subject,
        attribute,
      );
      const pseudo: MemoryRecord[] = slots.map((s) => ({
        id: s.id,
        content: s.value,
        memoryType: "fact",
        importance: 0.65,
        namespaceId: scope.namespaceId,
        userId: scope.userId,
        agentId: scope.agentId,
        runId: scope.runId,
        createdAt: s.validFrom,
        updatedAt: s.validFrom,
        lastAccessedAt: s.validFrom,
        accessCount: 0,
        forgotten: false,
        validFrom: s.validFrom,
        validTo: s.validTo,
        subject,
        attribute,
      }));
      await this.refreshSlotSummary(subject, attribute, scope, pseudo);
    } catch (error) {
      this.warn(
        "slot_summary_failed",
        "Derived slot-summary retrieval doc refresh from the sidecar failed; the sidecar remains authoritative.",
        error,
        { subject, attribute, ...scopeOf(scope) },
      );
    }
  }

  private async refreshSlotSummary(
    subject: string,
    attribute: string,
    scope: Scope,
    factsOverride?: MemoryRecord[],
  ): Promise<void> {
    if (!this.retrievalDocs.slotSummary) return;
    const normalizedSubject = normalizeSlotPart(subject);
    const normalizedAttribute = normalizeSlotPart(attribute);
    if (!normalizedSubject || !normalizedAttribute) return;
    const docId = slotSummaryDocId(
      scope,
      normalizedSubject,
      normalizedAttribute,
    );
    try {
      const facts =
        factsOverride ??
        (await this.store.listMemories(
          {
            ...scopeOf(scope),
            subject: normalizedSubject,
            attribute: normalizedAttribute,
          },
          { limit: 1_000, sort: "recent" },
        ));
      if (!facts.length) {
        try {
          await this.vectors.delete(docId);
        } catch (error) {
          this.warn(
            "slot_summary_delete_failed",
            "Stale slot-summary retrieval doc deletion failed.",
            error,
            {
              docId,
              subject: normalizedSubject,
              attribute: normalizedAttribute,
            },
          );
        }
        return;
      }
      const ordered = facts.sort((a, b) => {
        const ta = (a.eventDate ?? a.validFrom ?? a.createdAt).getTime();
        const tb = (b.eventDate ?? b.validFrom ?? b.createdAt).getTime();
        return ta - tb;
      });
      const displaySubject =
        ordered.find((m) => !m.validTo)?.subject ??
        ordered[ordered.length - 1]?.subject ??
        subject;
      const displayAttribute =
        ordered.find((m) => !m.validTo)?.attribute ??
        ordered[ordered.length - 1]?.attribute ??
        attribute;
      const content = buildSlotSummaryContent(
        displaySubject,
        displayAttribute,
        ordered,
      );
      const vector = await this.embedder.embed(content);
      const latest = ordered[ordered.length - 1]!;
      await this.vectors.upsert([
        {
          id: docId,
          vector,
          content,
          payload: {
            namespaceId: scope.namespaceId,
            recordKind: "memory",
            userId: scope.userId,
            agentId: scope.agentId,
            runId: scope.runId,
            memoryType: "fact",
            source: "belief_slot",
            subject: normalizedSubject,
            attribute: normalizedAttribute,
            eventDate: latest.eventDate?.toISOString(),
            validFrom: latest.validFrom?.toISOString(),
            createdAt: ordered[0]!.createdAt.toISOString(),
            updatedAt: new Date().toISOString(),
            importance: Math.max(0.65, ...ordered.map((m) => m.importance)),
            metadata: {
              __retrievalDoc: "slot_summary",
              __slotSubject: displaySubject,
              __slotAttribute: normalizedAttribute,
              __sourceIds: ordered.map((m) => m.id).join(","),
            },
          },
        },
      ]);
    } catch (error) {
      this.warn(
        "slot_summary_failed",
        "Derived slot-summary retrieval doc refresh failed; source facts remain authoritative.",
        error,
        {
          docId,
          subject: normalizedSubject,
          attribute: normalizedAttribute,
          ...scopeOf(scope),
        },
      );
    }
  }

  private async slotKeysFor(
    filters: MemoryFilters,
  ): Promise<Array<{ subject: string; attribute: string; scope: Scope }>> {
    const records = await this.store.listMemories(filters, {
      limit: 100_000,
      sort: "recent",
    });
    const keys = new Map<
      string,
      { subject: string; attribute: string; scope: Scope }
    >();
    for (const record of records) {
      if (!record.subject || !record.attribute) continue;
      const scope = scopeFromMemory(record);
      const subject = normalizeSlotPart(record.subject);
      const attribute = normalizeSlotPart(record.attribute);
      const key = slotSummaryKey(scope, subject, attribute);
      keys.set(key, { subject, attribute, scope });
    }
    return [...keys.values()];
  }

  private async embedAndStore(record: MemoryRecord): Promise<number[]> {
    const vector = await this.embedder.embed(record.content, {
      context: {
        namespaceId: record.namespaceId,
        operation: "memory.embedding",
      },
    });
    await this.storeVector(record, vector);
    return vector;
  }

  private async storeVector(
    record: MemoryRecord,
    vector: number[],
  ): Promise<void> {
    await this.vectors.upsert([
      {
        id: record.id,
        vector,
        content: record.content,
        payload: {
          namespaceId: record.namespaceId,
          recordKind: "memory",
          userId: record.userId,
          agentId: record.agentId,
          runId: record.runId,
          memoryType: record.memoryType,
          source: record.source,
          metadata: record.metadata ?? {},
        },
      },
    ]);
  }

  private async projectRecord(
    record: MemoryRecord,
    scope: Scope,
    precomputedVector?: number[],
  ): Promise<void> {
    if (this.vectorProjectionSchedule === "inline") {
      const vector = precomputedVector ?? (await this.embedAndStore(record));
      if (precomputedVector) await this.storeVector(record, precomputedVector);
      await this.autoLink(record, vector, scope);
      return;
    }

    await this.vectors.upsertText!([
      {
        id: record.id,
        content: record.content,
        payload: {
          namespaceId: record.namespaceId,
          recordKind: "memory",
          userId: record.userId,
          agentId: record.agentId,
          runId: record.runId,
          memoryType: record.memoryType,
          source: record.source,
          metadata: record.metadata ?? {},
        },
      },
    ]);
    const projection = this.embedAndStore(record)
      .then((vector) => this.autoLink(record, vector, scope))
      .catch((error: unknown) => {
        this.warn(
          "maintenance_reembed_failed",
          "Deferred semantic indexing failed; raw and keyword-searchable memory remains available.",
          error,
          { memoryId: record.id, ...scopeOf(scope) },
        );
      });
    this.pendingVectorProjections.push(projection);
    projection.finally(() => {
      this.pendingVectorProjections = this.pendingVectorProjections.filter(
        (candidate) => candidate !== projection,
      );
    });
    this.vectorProjectionHook?.(projection);
  }

  /**
   * Resolve entity surface forms to entity rows (exact normalized match →
   * embedding-synonym match ≥ threshold → create) and link the memory to
   * them. Embedding cost only — no LLM calls (constitution budget law).
   */
  private async linkEntities(
    memoryId: string,
    names: string[],
    scope: Scope,
  ): Promise<string[]> {
    if (!names.length) return [];
    try {
      const scoped = await this.store.listEntities(scopeOf(scope));
      const byNorm = new Map(scoped.map((e) => [e.normalized, e]));
      const missingNames: Array<{ name: string; normalized: string }> = [];
      const queued = new Set<string>();
      for (const raw of names) {
        const name = raw.trim();
        const normalized = name.toLowerCase();
        if (name && !byNorm.has(normalized) && !queued.has(normalized)) {
          queued.add(normalized);
          missingNames.push({ name, normalized });
        }
      }
      const missingVectors = await this.embedder.embedBatch(
        missingNames.map(({ name }) => name),
        {
          context: {
            namespaceId: scope.namespaceId,
            operation: "memory.entity_embedding",
          },
        },
      );
      if (missingVectors.length !== missingNames.length) {
        throw new Error(
          `entity embedding batch returned ${missingVectors.length} vectors for ${missingNames.length} names`,
        );
      }
      const vectorByNorm = new Map(
        missingNames.map(({ normalized }, index) => [
          normalized,
          missingVectors[index]!,
        ]),
      );
      const ids: string[] = [];
      for (const raw of names) {
        const name = raw.trim();
        if (!name) continue;
        const normalized = name.toLowerCase();
        let entity = byNorm.get(normalized);
        if (!entity) {
          const embedding = vectorByNorm.get(normalized);
          if (!embedding) {
            throw new Error(`missing entity embedding for ${name}`);
          }
          // Synonym resolution: nearest existing entity name in scope.
          let best: { e: (typeof scoped)[number]; sim: number } | null = null;
          for (const candidate of scoped) {
            if (!candidate.embedding) continue;
            const sim = cosineSim(embedding, candidate.embedding);
            if (!best || sim > best.sim) best = { e: candidate, sim };
          }
          if (best && best.sim >= this.entitySynonymThreshold) {
            entity = best.e;
          } else {
            entity = {
              id: uuid(),
              name,
              normalized,
              namespaceId: scope.namespaceId,
              userId: scope.userId,
              agentId: scope.agentId,
              runId: scope.runId,
              embedding,
              mentionCount: 0,
              createdAt: new Date(),
            };
            await this.store.saveEntity(entity);
            scoped.push(entity);
            byNorm.set(normalized, entity);
          }
        }
        entity.mentionCount += 1;
        await this.store.updateEntity(entity);
        ids.push(entity.id);
      }
      if (ids.length)
        await this.store.linkMemoryEntities(memoryId, [...new Set(ids)]);
      return [...new Set(ids)];
    } catch (error) {
      this.warn(
        "entity_link_failed",
        "Entity linking failed; the memory remains stored and searchable without entity graph edges.",
        error,
        { memoryId, names, ...scopeOf(scope) },
      );
      return [];
    }
  }

  /**
   * Link a new memory (`related_to`, weight = similarity) to its most similar
   * in-scope neighbours, so the association graph grows organically and graph
   * recall can surface sibling facts.
   */
  private async autoLink(
    record: MemoryRecord,
    vector: number[],
    scope: Scope,
  ): Promise<void> {
    if (!this.autoAssociate.enabled) return;
    try {
      const hits = await this.vectors.search(
        vector,
        this.autoAssociate.max + 1,
        scopeOf(scope),
      );
      let linked = 0;
      for (const hit of hits) {
        if (hit.id === record.id) continue;
        if (hit.score < this.autoAssociate.threshold) continue;
        if (linked >= this.autoAssociate.max) break;
        const target = await this.store.getMemory(hit.id);
        if (!target || target.forgotten) continue;
        await this.store.createAssociation({
          id: uuid(),
          sourceId: record.id,
          targetId: hit.id,
          relationType: "related_to",
          weight: clamp01(hit.score),
          createdAt: new Date(),
        });
        linked++;
      }
    } catch (error) {
      this.warn(
        "auto_associate_failed",
        "Automatic association linking failed; the memory remains stored and vector-searchable.",
        error,
        { memoryId: record.id, ...scopeOf(scope) },
      );
    }
  }

  private async linkTypedGraph(
    record: MemoryRecord,
    scope: Scope,
    opts: { entityIds?: string[] } = {},
  ): Promise<void> {
    if (!this.typedGraph.enabled) return;
    try {
      if (this.typedGraph.sameSlot && record.subject && record.attribute) {
        const sameSlot = await this.store.listMemories(
          {
            ...scopeOf(scope),
            subject: record.subject,
            attribute: record.attribute,
          },
          { limit: this.typedGraph.maxEdgesPerType + 1, sort: "recent" },
        );
        await this.linkTypedCandidates(record, sameSlot, "same_slot", 0.95);
      }

      if (this.typedGraph.sameEpisode && record.episodeId) {
        const scoped = await this.store.listMemories(scopeOf(scope), {
          limit: 1_000,
          sort: "recent",
        });
        const sameEpisode = scoped
          .filter((m) => m.episodeId === record.episodeId)
          .slice(0, this.typedGraph.maxEdgesPerType + 1);
        await this.linkTypedCandidates(
          record,
          sameEpisode,
          "same_episode",
          0.45,
        );
      }

      if (this.typedGraph.sameEntity && opts.entityIds?.length) {
        const byEntity = await this.store.getMemoryIdsForEntities(
          opts.entityIds,
        );
        const ids = [...new Set([...byEntity.values()].flat())];
        const candidates: MemoryRecord[] = [];
        for (const id of ids) {
          if (id === record.id) continue;
          const memory = await this.store.getMemory(id);
          if (!memory || memory.forgotten || !memoryInScope(memory, scope)) {
            continue;
          }
          candidates.push(memory);
        }
        candidates.sort(
          (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
        );
        await this.linkTypedCandidates(
          record,
          candidates.slice(0, this.typedGraph.maxEdgesPerType),
          "same_entity",
          0.6,
        );
      }
    } catch (error) {
      this.warn(
        "typed_graph_failed",
        "Typed graph link refresh failed; canonical storage and retrieval remain intact.",
        error,
        { memoryId: record.id, ...scopeOf(scope) },
      );
    }
  }

  private async linkTypedCandidates(
    record: MemoryRecord,
    candidates: MemoryRecord[],
    relationType: RelationType,
    weight: number,
  ): Promise<void> {
    let linked = 0;
    for (const candidate of candidates) {
      if (candidate.id === record.id || candidate.forgotten) continue;
      if (linked >= this.typedGraph.maxEdgesPerType) break;
      await this.store.createAssociation({
        id: uuid(),
        sourceId: record.id,
        targetId: candidate.id,
        relationType,
        weight,
        createdAt: new Date(),
      });
      linked++;
    }
  }

  private async linkAssociations(
    sourceId: string,
    associations?: AssociationInput[],
  ): Promise<void> {
    if (!associations?.length) return;
    for (const a of associations) {
      const target = await this.store.getMemory(a.targetId);
      if (!target) continue; // skip dangling targets (hallucination guard)
      await this.store.createAssociation({
        id: uuid(),
        sourceId,
        targetId: a.targetId,
        relationType: a.relationType ?? "related_to",
        weight: clamp01(a.weight ?? 0.5),
        createdAt: new Date(),
      });
    }
  }

  private prepareBeliefProjectionHints(
    extractedType: MemoryType | null,
    claimValue: string,
    options: AddOptions,
    scope: Scope,
    batchId: string,
    inferred: boolean,
  ): MemoryProjectionHints | undefined {
    const memoryType =
      options.memoryType ?? extractedType ?? this.defaultMemoryType;
    if (
      !inferred ||
      !this.beliefProjectionEnabled(scope) ||
      !this.beliefProjection.memoryTypes.has(memoryType)
    ) {
      return undefined;
    }
    const applicability = options.applicability
      ? normalizeApplicability(options.applicability)
      : this.defaultBeliefApplicability(scope);
    const explicitEvidenceKey = options.evidenceKey?.trim();
    if (options.evidenceKey !== undefined && !explicitEvidenceKey) {
      throw new TypeError("evidenceKey must not be empty");
    }
    const explicitContextId = options.evidenceContextId?.trim();
    if (options.evidenceContextId !== undefined && !explicitContextId) {
      throw new TypeError("evidenceContextId must not be empty");
    }
    const weight = options.evidenceWeight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1) {
      throw new TypeError("evidenceWeight must be within (0, 1]");
    }
    return {
      belief: {
        version: 1,
        origin: "inferred",
        applicability: storeApplicability(applicability),
        claimValue,
        evidenceKey: explicitEvidenceKey ?? `add:${batchId}`,
        contextId:
          explicitContextId ??
          scope.runId ??
          applicability.key ??
          `add:${batchId}`,
        weight,
      },
    };
  }

  private defaultBeliefApplicability(scope: Scope): ApplicabilityContext {
    if (scope.namespaceId) return { kind: "project", key: scope.namespaceId };
    if (scope.runId) return { kind: "conversation", key: scope.runId };
    if (scope.userId) return { kind: "custom", key: `user:${scope.userId}` };
    if (scope.agentId) return { kind: "custom", key: `agent:${scope.agentId}` };
    return { kind: "custom", key: "unscoped" };
  }

  /**
   * Learned preferences aggregate across observation runs while retaining the
   * authenticated namespace/user (or agent) ownership fence. Run identity is
   * evidence context, not long-term owner identity.
   */
  private beliefOwnerScope(scope: Scope): Scope {
    if (scope.userId) {
      return {
        ...(scope.namespaceId ? { namespaceId: scope.namespaceId } : {}),
        userId: scope.userId,
      };
    }
    if (scope.agentId) {
      return {
        ...(scope.namespaceId ? { namespaceId: scope.namespaceId } : {}),
        agentId: scope.agentId,
      };
    }
    return {
      ...(scope.namespaceId ? { namespaceId: scope.namespaceId } : {}),
      ...(scope.runId ? { runId: scope.runId } : {}),
    };
  }

  private beliefProjectionRuntimeEnabled(scope: Scope): boolean {
    if (!this.beliefProjection.configured) return false;
    try {
      if (this.beliefProjection.killSwitch?.()) return false;
    } catch (error) {
      this.warn(
        "belief_reconciliation_failed",
        "Belief reconciliation kill switch failed closed.",
        error,
        { ...scopeOf(scope) },
      );
      return false;
    }
    return true;
  }

  private beliefProjectionNamespaceAllowed(scope: Scope): boolean {
    const allowlist = this.beliefProjection.namespaceAllowlist;
    return (
      !allowlist ||
      (scope.namespaceId !== undefined && allowlist.has(scope.namespaceId))
    );
  }

  private beliefProjectionEnabled(scope: Scope): boolean {
    return (
      this.beliefProjectionRuntimeEnabled(scope) &&
      this.beliefProjectionNamespaceAllowed(scope)
    );
  }

  private async projectDerivedFacts(
    facts: ExtractedFact[],
    options: AddOptions,
    scope: Scope,
    sources: string[],
    prelinkedEntities = new Map<string, string[]>(),
  ): Promise<boolean> {
    const structuralReady = await this.projectExtractedFacts(
      facts,
      options,
      scope,
      sources,
      prelinkedEntities,
    );
    let beliefReady = true;
    try {
      await this.projectBeliefSources(sources);
    } catch (error) {
      beliefReady = false;
      this.warn(
        "belief_reconciliation_failed",
        "Belief evidence projection failed; canonical records and ordinary recall remain intact.",
        error,
        { sourceIds: sources.join(","), ...scopeOf(scope) },
      );
    }
    return structuralReady && beliefReady;
  }

  private async projectBeliefSources(sources: string[]): Promise<number> {
    // Belief reconciliation is opt-in and normally disabled. Avoid one
    // canonical-store read per inferred record when the projection is not
    // configured or the runtime kill switch is active.
    if (!this.beliefProjectionRuntimeEnabled({})) return 0;

    let projected = 0;
    for (const sourceId of sources) {
      const record = await this.store.getMemory(sourceId);
      const hint = record?.projectionHints?.belief;
      if (
        !record ||
        !hint ||
        hint.version !== 1 ||
        hint.origin !== "inferred" ||
        !this.beliefProjection.memoryTypes.has(record.memoryType)
      ) {
        continue;
      }
      const sourceScope = scopeFromMemory(record);
      if (!this.beliefProjectionNamespaceAllowed(sourceScope)) continue;
      if (!record.subject || !record.attribute) continue;
      await this.beliefReconciler.observe({
        scope: this.beliefOwnerScope(sourceScope),
        subject: record.subject,
        attribute: record.attribute,
        value: hint.claimValue ?? record.content,
        sourceId: record.id,
        evidenceKey: hint.evidenceKey,
        contextId: hint.contextId,
        applicability: restoreApplicability(hint.applicability),
        observedAt: record.createdAt,
        validFrom: record.validFrom ?? record.eventDate ?? record.createdAt,
        ...(record.validTo ? { validTo: record.validTo } : {}),
        weight: hint.weight,
      });
      // Canonical mutation is authoritative. Recheck after projection so a
      // deferred add racing update/delete/invalidate cannot resurrect stale
      // evidence after mutation cleanup has already run.
      const current = await this.store.getMemory(sourceId);
      const currentHint = current?.projectionHints?.belief;
      if (
        !current ||
        current.forgotten ||
        !currentHint ||
        stableJson(currentHint) !== stableJson(hint)
      ) {
        await this.beliefReconciler.removeSource(sourceId);
        continue;
      }
      if (current.validTo) {
        await this.beliefReconciler.invalidateSource(sourceId, current.validTo);
      }
      projected++;
    }
    return projected;
  }

  /**
   * Re-extract one or more existing canonical records for an explicit sidecar
   * rebuild. Normal adds do not use this method: they pass their already
   * extracted facts directly to projectExtractedFacts.
   */
  private async deriveState(
    messages: Message[],
    options: AddOptions,
    scope: Scope,
    sources: string[],
  ): Promise<boolean> {
    try {
      const facts = await this.extractFacts(
        messagesToTranscript(messages),
        scope,
      );
      return this.projectExtractedFacts(facts, options, scope, sources);
    } catch (error) {
      this.warn(
        "derivation_failed",
        "State projection extraction failed; canonical records remain intact.",
        error,
        { sourceIds: sources.join(","), ...scopeOf(scope) },
      );
      return false;
    }
  }

  /**
   * Build optional state and typed-graph projections from the exact facts that
   * were stored canonically. This stage is best-effort and never calls an LLM.
   */
  private async projectExtractedFacts(
    facts: ExtractedFact[],
    options: AddOptions,
    scope: Scope,
    sources: string[],
    prelinkedEntities = new Map<string, string[]>(),
  ): Promise<boolean> {
    try {
      const now = new Date();
      const entityIdsBySource = new Map(prelinkedEntities);
      const touchedSlots = new Map<
        string,
        { subject: string; attribute: string }
      >();
      for (let index = 0; index < facts.length; index++) {
        const f = facts[index]!;
        const factSources =
          facts.length === sources.length ? [sources[index]!] : sources;
        const names = [
          ...new Set([
            ...(f.entities ?? []),
            ...(f.subject ? [f.subject] : []),
          ]),
        ];
        if (names.length) {
          for (const id of factSources) {
            if (!entityIdsBySource.has(id)) {
              entityIdsBySource.set(
                id,
                await this.linkEntities(id, names, scope),
              );
            }
          }
        }
        if (!f.subject || !f.attribute) continue;
        // Only single-valued, mutable-state types use the supersession slot.
        // Point/multi-valued types (event, observation, goal, todo) are NOT
        // single-state — superseding them would wrongly collapse coexisting
        // facts (e.g. two marathons). They stay recall-only (raw) until an
        // append-style timeline sidecar slice. (null type → assume stateful.)
        if (f.memoryType && !STATE_SLOT_TYPES.has(f.memoryType)) continue;
        await this.sidecar.upsert({
          scope,
          subject: f.subject,
          attribute: f.attribute,
          value: f.text,
          validFrom: f.eventDate ?? options.eventDate ?? now,
          sources: factSources,
          // LLM-judged: "multi" (pets, hobbies) coexist; "single" (residence,
          // job) supersede. Default single.
          cardinality: f.cardinality ?? "single",
        });
        touchedSlots.set(
          `${f.subject.toLowerCase()}|${f.attribute.toLowerCase()}`,
          { subject: f.subject, attribute: f.attribute },
        );
      }
      // Materialize touched slots as slot-summary retrieval docs (opt-in).
      for (const { subject, attribute } of touchedSlots.values()) {
        await this.refreshSlotSummaryFromSidecar(scope, subject, attribute);
      }
      if (this.typedGraph.enabled) {
        for (const id of sources) {
          const rec = await this.store.getMemory(id);
          if (!rec || rec.forgotten) continue;
          await this.linkTypedGraph(rec, scope, {
            entityIds: entityIdsBySource.get(id) ?? [],
          });
        }
      }
      return true;
    } catch (error) {
      this.warn(
        "derivation_failed",
        "State projection failed; canonical storage and recall remain intact.",
        error,
        { sourceIds: sources.join(","), ...scopeOf(scope) },
      );
      return false;
    }
  }

  private async extractFacts(
    transcript: string,
    scope: Scope,
    extractionPolicy?: MemoryExtractionPolicy,
  ): Promise<ExtractedFact[]> {
    const projectBeliefs = this.beliefProjectionEnabled(scope);
    const baseSystemPrompt =
      this.factExtractionPrompt ??
      (projectBeliefs ? BELIEF_FACT_EXTRACTION_SYSTEM : FACT_EXTRACTION_SYSTEM);
    const systemPrompt = applyMemoryExtractionPolicy(
      baseSystemPrompt,
      extractionPolicy,
    );
    const allowedCategories = new Map<string, string>();
    for (const value of extractionPolicy?.categories ?? []) {
      const category = value.trim();
      const key = category.toLowerCase();
      if (category && !allowedCategories.has(key)) {
        allowedCategories.set(key, category);
      }
    }
    const raw = await this.llm.chat(
      buildExtractionMessages(transcript, systemPrompt),
      {
        responseFormat: "json",
        jsonSchema: factExtractionJsonSchema(
          [...allowedCategories.values()],
          projectBeliefs,
        ),
        context: {
          namespaceId: scope.namespaceId,
          operation: "memory.extract",
        },
      },
    );
    const parsed = safeJson(raw);
    const facts = parsed?.facts;
    if (!Array.isArray(facts)) {
      throw new Error(
        `fact extraction returned invalid JSON: expected facts[] (${describeExtractionShape(raw, parsed)})`,
      );
    }
    const out: ExtractedFact[] = [];
    for (let index = 0; index < facts.length; index++) {
      const f = facts[index];
      // Accept both plain strings and {text, event_date} objects.
      if (typeof f === "string") {
        if (f.trim()) {
          if (allowedCategories.size) {
            throw new Error(
              `fact extraction returned invalid facts[${index}]: expected a project category`,
            );
          }
          out.push({
            text: f.trim(),
            categories: [],
            beliefValue: null,
            eventDate: null,
            entities: [],
            subject: null,
            attribute: null,
            memoryType: null,
            cardinality: null,
          });
        }
      } else if (f && typeof f === "object" && typeof f.text === "string") {
        if (f.text.trim()) {
          const category =
            typeof f.category === "string"
              ? allowedCategories.get(f.category.trim().toLowerCase())
              : undefined;
          if (allowedCategories.size && !category) {
            throw new Error(
              `fact extraction returned invalid facts[${index}].category`,
            );
          }
          out.push({
            text: f.text.trim(),
            categories: category ? [category] : [],
            beliefValue:
              typeof f.value === "string" && f.value.trim()
                ? f.value.trim()
                : null,
            eventDate: parseEventDate(f.event_date),
            entities: Array.isArray(f.entities)
              ? f.entities.filter(
                  (e: unknown): e is string =>
                    typeof e === "string" && !!e.trim(),
                )
              : [],
            subject:
              typeof f.subject === "string" && f.subject.trim()
                ? f.subject.trim()
                : null,
            attribute:
              typeof f.attribute === "string" && f.attribute.trim()
                ? f.attribute.trim().toLowerCase()
                : null,
            memoryType: parseMemoryType(f.type),
            cardinality:
              f.cardinality === "multi"
                ? "multi"
                : f.cardinality === "single"
                  ? "single"
                  : null,
          });
        }
      } else {
        throw new Error(
          `fact extraction returned invalid facts[${index}]: expected string or object with text`,
        );
      }
    }
    return out;
  }
}

export class NamespacedMemory {
  constructor(
    private readonly memory: Memory,
    readonly namespaceId: string,
  ) {}

  private scope<T extends Scope>(options?: T): T & { namespaceId: string } {
    return { ...(options ?? ({} as T)), namespaceId: this.namespaceId };
  }

  private async owns(memoryId: string): Promise<boolean> {
    const record = await this.memory.get(memoryId);
    return record?.namespaceId === this.namespaceId;
  }

  async add(input: AddInput, options: AddOptions = {}) {
    for (const association of options.associations ?? []) {
      if (!(await this.owns(association.targetId))) {
        throw new Error(`memory not found: ${association.targetId}`);
      }
    }
    return this.memory.add(input, this.scope(options));
  }

  ingestDocument(
    input: DocumentIngestInput,
    options: Omit<DocumentIngestOptions, "namespaceId">,
  ) {
    return this.memory.ingestDocument(input, this.scope(options));
  }

  getDocument(documentId: string) {
    return this.memory.getDocument(documentId, this.namespaceId);
  }

  listDocuments(
    filters: Omit<DocumentFilters, "namespaceId"> = {},
    options: GetAllOptions = {},
  ) {
    return this.memory.listDocuments(
      { ...filters, namespaceId: this.namespaceId },
      options,
    );
  }

  searchDocuments(query: string, options: DocumentSearchOptions = {}) {
    return this.memory.searchDocuments(this.namespaceId, query, options);
  }

  deleteDocument(
    documentId: string,
    options: Omit<DocumentScope, "namespaceId"> & {
      idempotencyKey: string;
    },
  ) {
    return this.memory.deleteDocument(documentId, this.scope(options));
  }

  rebuildDocument(documentId: string) {
    return this.memory.rebuildDocument(documentId, this.namespaceId);
  }

  search(query: string, options: SearchOptions = {}) {
    return this.memory.search(query, this.scope(options));
  }

  async get(memoryId: string): Promise<MemoryRecord | null> {
    const record = await this.memory.get(memoryId);
    return record?.namespaceId === this.namespaceId ? record : null;
  }

  getAll(options: GetAllOptions = {}) {
    return this.memory.getAll(this.scope(options));
  }

  async listScopeEntities(
    options: {
      type?: ScopeEntityType;
      id?: string;
      limit?: number;
      cursor?: { updatedAt: Date; type: ScopeEntityType; id: string };
    } = {},
  ): Promise<ScopeEntity[]> {
    await this.memory.init();
    return this.memory.store.listScopeEntities(this.namespaceId, options);
  }

  async stats(): Promise<{ totalMemories: number; totalEntities: number }> {
    await this.memory.init();
    const [totalMemories, totalEntities] = await Promise.all([
      this.memory.store.countMemories({ namespaceId: this.namespaceId }),
      this.countScopeEntities(),
    ]);
    return { totalMemories, totalEntities };
  }

  private async countScopeEntities(): Promise<number> {
    if (this.memory.store.countScopeEntities) {
      return this.memory.store.countScopeEntities(this.namespaceId);
    }

    let total = 0;
    let cursor:
      | { updatedAt: Date; type: ScopeEntityType; id: string }
      | undefined;
    do {
      const page = await this.memory.store.listScopeEntities(this.namespaceId, {
        cursor,
        limit: 1_000,
      });
      total += page.length;
      const last = page.at(-1);
      cursor =
        page.length === 1_000 && last
          ? { updatedAt: last.updatedAt, type: last.type, id: last.id }
          : undefined;
    } while (cursor);
    return total;
  }

  async getScopeEntity(
    type: ScopeEntityType,
    id: string,
  ): Promise<ScopeEntity | null> {
    const [entity] = await this.listScopeEntities({ type, id, limit: 1 });
    return entity ?? null;
  }

  async update(
    memoryId: string,
    data: string | UpdateData,
    options: MutationOptions = {},
  ) {
    if (!(await this.owns(memoryId))) {
      throw new Error(`memory not found: ${memoryId}`);
    }
    return this.memory.update(memoryId, data, this.scope(options));
  }

  async delete(
    memoryId: string,
    options: MutationOptions = {},
  ): Promise<boolean> {
    const record = await this.memory.store.getMemory(memoryId);
    if (record && record.namespaceId !== this.namespaceId) return false;
    return this.memory.delete(memoryId, this.scope(options));
  }

  purge(memoryId: string, options: MutationOptions = {}) {
    return this.memory.purge(memoryId, this.scope(options));
  }

  async invalidate(
    memoryId: string,
    opts: MutationOptions & { validTo?: Date; supersededBy?: string } = {},
  ): Promise<boolean> {
    if (!(await this.owns(memoryId))) return false;
    if (opts.supersededBy && !(await this.owns(opts.supersededBy))) {
      throw new Error(`memory not found: ${opts.supersededBy}`);
    }
    return this.memory.invalidate(memoryId, this.scope(opts));
  }

  async forget(memoryId: string): Promise<boolean> {
    return (await this.owns(memoryId)) ? this.memory.forget(memoryId) : false;
  }

  deleteAll(
    scope: Scope = {},
    options: Pick<MutationOptions, "idempotencyKey"> = {},
  ) {
    return this.memory.deleteAll(this.scope(scope), options);
  }

  purgeAll() {
    return this.memory.purgeNamespace({ namespaceId: this.namespaceId });
  }

  async history(memoryId: string): Promise<HistoryEntry[]> {
    return this.memory.history(memoryId, {
      namespaceId: this.namespaceId,
    });
  }

  getFeedback(memoryId: string) {
    return this.memory.getFeedback(memoryId, {
      namespaceId: this.namespaceId,
    });
  }

  async setFeedback(
    memoryId: string,
    input: MemoryFeedbackInput,
    options: MutationOptions = {},
  ) {
    if (!(await this.owns(memoryId))) {
      throw new Error(`memory not found: ${memoryId}`);
    }
    return this.memory.setFeedback(memoryId, input, this.scope(options));
  }

  async clearFeedback(memoryId: string, options: MutationOptions = {}) {
    if (!(await this.owns(memoryId))) {
      throw new Error(`memory not found: ${memoryId}`);
    }
    return this.memory.clearFeedback(memoryId, this.scope(options));
  }

  async link(
    sourceId: string,
    targetId: string,
    relationType: RelationType = "related_to",
    weight = 0.5,
  ): Promise<Association | null> {
    if (!(await this.owns(sourceId)) || !(await this.owns(targetId)))
      return null;
    return this.memory.link(sourceId, targetId, relationType, weight);
  }

  async neighbors(memoryId: string, depth = 1, excludeIds: string[] = []) {
    if (!(await this.owns(memoryId))) return { nodes: [], edges: [] };
    const graph = await this.memory.neighbors(memoryId, depth, excludeIds);
    const nodes = graph.nodes.filter(
      (node) => node.namespaceId === this.namespaceId,
    );
    const ids = new Set([memoryId, ...nodes.map((node) => node.id)]);
    return {
      nodes,
      edges: graph.edges.filter(
        (edge) => ids.has(edge.sourceId) && ids.has(edge.targetId),
      ),
    };
  }

  graph(options: GetAllOptions = {}) {
    return this.memory.graph(this.scope(options));
  }

  runMaintenance(
    scope: Scope = {},
    opts: { filters?: Record<string, unknown> } = {},
  ) {
    return this.memory.runMaintenance(this.scope(scope), opts);
  }

  getProfile(scope: Scope = {}) {
    return this.memory.getProfile(this.scope(scope));
  }

  getState(
    subject: string,
    attribute: string,
    opts: Scope & { asOf?: Date } = {},
  ) {
    return this.memory.getState(subject, attribute, this.scope(opts));
  }

  getStateHistory(subject: string, attribute: string, scope: Scope = {}) {
    return this.memory.getStateHistory(subject, attribute, this.scope(scope));
  }

  getBeliefView(
    subject: string,
    attribute: string,
    options: BeliefQueryOptions = {},
  ) {
    return this.memory.getBeliefView(subject, attribute, this.scope(options));
  }

  rebuildSidecar(scope: Scope = {}) {
    return this.memory.rebuildSidecar(this.scope(scope));
  }

  rebuildBeliefs(scope: Scope = {}) {
    return this.memory.rebuildBeliefs(this.scope(scope));
  }

  rebuildProjections(scope: Scope = {}) {
    return this.memory.rebuildProjections(this.scope(scope));
  }

  getProfileSections(
    query: string,
    scope: Scope = {},
    opts: { limit?: number; minScore?: number } = {},
  ) {
    return this.memory.getProfileSections(query, this.scope(scope), opts);
  }

  refreshProfile(scope: Scope = {}) {
    return this.memory.refreshProfile(this.scope(scope));
  }

  episodes(
    scope: Scope = {},
    options: { limit?: number; offset?: number } = {},
  ) {
    return this.memory.episodes(this.scope(scope), options);
  }

  deleteEpisode(episodeId: string) {
    return this.memory.deleteEpisode(episodeId, {
      namespaceId: this.namespaceId,
    });
  }

  exportSnapshot() {
    return this.memory.exportSnapshot({ namespaceId: this.namespaceId });
  }

  importSnapshot(snapshot: unknown, options: ImportOptions) {
    return this.memory.importSnapshot(
      snapshot,
      { namespaceId: this.namespaceId },
      options,
    );
  }

  getOperation(operationId: string) {
    return this.memory.getOperation(operationId, {
      namespaceId: this.namespaceId,
    });
  }

  listOperations(limit = 100) {
    return this.memory.listOperations({ namespaceId: this.namespaceId }, limit);
  }

  summarizeOperations() {
    return this.memory.summarizeOperations({ namespaceId: this.namespaceId });
  }

  async summarizeEpisode(episodeId: string, scope: Scope = {}) {
    const episode = await this.memory.store.getEpisode(episodeId);
    if (episode?.namespaceId !== this.namespaceId) return null;
    return this.memory.summarizeEpisode(episodeId, this.scope(scope));
  }

  beliefAt(subject: string, attribute: string, at: Date, scope: Scope = {}) {
    return this.memory.beliefAt(subject, attribute, at, this.scope(scope));
  }

  async reinforce(
    memoryIds: string[],
    opts: { eta?: number; cap?: number } = {},
  ) {
    for (const id of new Set(memoryIds)) {
      if (!(await this.owns(id))) throw new Error(`memory not found: ${id}`);
    }
    return this.memory.reinforce(memoryIds, opts);
  }

  async promote(memoryId: string): Promise<boolean> {
    return (await this.owns(memoryId)) ? this.memory.promote(memoryId) : false;
  }

  flushDerivations(): Promise<void> {
    return this.memory.flushDerivations();
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

// Cheap, no-LLM proper-noun extractor for verbatim-record entity edges
// (config.heuristicEntities). Maximal runs of Title-Case words, per sentence
// (so a sentence-initial capital can't glue onto the next proper noun), minus
// conversational sentence-initial stopwords. Noisy by design: a rare false hit
// links nothing (no cross-chunk edge); a frequent one is damped by entity-
// frequency down-weighting in entity-graph PPR. Proper-noun only (misses
// lowercase concepts) — the high-value people/place/org links for memory.
const ENTITY_STOPWORDS = new Set([
  "i",
  "i'm",
  "i've",
  "i'd",
  "i'll",
  "the",
  "a",
  "an",
  "and",
  "but",
  "or",
  "so",
  "well",
  "yeah",
  "yes",
  "no",
  "oh",
  "hey",
  "hi",
  "hello",
  "ok",
  "okay",
  "thanks",
  "thank",
  "please",
  "what",
  "when",
  "where",
  "who",
  "why",
  "how",
  "that",
  "this",
  "it",
  "its",
  "he",
  "she",
  "they",
  "we",
  "you",
  "my",
  "your",
  "his",
  "her",
  "their",
  "our",
  "me",
  "us",
  "them",
  "do",
  "does",
  "did",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "have",
  "has",
  "had",
  "if",
  "then",
  "also",
  "just",
  "really",
  "maybe",
  "sure",
  "right",
  "good",
  "great",
  "yesterday",
  "today",
  "tomorrow",
  "now",
  "not",
  "never",
  "always",
  "sorry",
  "dr",
  "mr",
  "mrs",
  "ms",
]);
function extractEntitiesHeuristic(content: string): string[] {
  const out = new Set<string>();
  for (const raw of content.split(/[.!?\n]+/)) {
    const sent = raw.trim();
    if (!sent) continue;
    const re = /[A-Z][a-zA-Z'’]*(?:\s+[A-Z][a-zA-Z'’]*)*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sent)) !== null) {
      // Strip leading/trailing stopword-capitals so sentence-initial pronouns
      // don't fragment names ("I'm Alice" → "Alice", "Well I" → dropped).
      const words = m[0].split(/\s+/).filter(Boolean);
      while (words.length && ENTITY_STOPWORDS.has(words[0]!.toLowerCase()))
        words.shift();
      while (
        words.length &&
        ENTITY_STOPWORDS.has(words[words.length - 1]!.toLowerCase())
      )
        words.pop();
      const phrase = words.join(" ");
      if (phrase.length < 2) continue;
      out.add(phrase);
      if (out.size >= 16) return [...out];
    }
  }
  return [...out];
}

function scopeOf(scope: Scope): MemoryFilters {
  const f: MemoryFilters = {};
  if (scope.namespaceId !== undefined) f.namespaceId = scope.namespaceId;
  if (scope.userId !== undefined) f.userId = scope.userId;
  if (scope.agentId !== undefined) f.agentId = scope.agentId;
  if (scope.runId !== undefined) f.runId = scope.runId;
  return f;
}

function scopeFromMemory(record: MemoryRecord): Scope {
  return {
    namespaceId: record.namespaceId,
    userId: record.userId,
    agentId: record.agentId,
    runId: record.runId,
  };
}

function memoryInScope(record: MemoryRecord, scope: Scope): boolean {
  if (
    scope.namespaceId !== undefined &&
    record.namespaceId !== scope.namespaceId
  )
    return false;
  if (scope.userId !== undefined && record.userId !== scope.userId)
    return false;
  if (scope.agentId !== undefined && record.agentId !== scope.agentId)
    return false;
  if (scope.runId !== undefined && record.runId !== scope.runId) return false;
  return true;
}

function episodeInScope(episode: Episode, scope: Scope): boolean {
  if (
    scope.namespaceId !== undefined &&
    episode.namespaceId !== scope.namespaceId
  )
    return false;
  if (scope.userId !== undefined && episode.userId !== scope.userId)
    return false;
  if (scope.agentId !== undefined && episode.agentId !== scope.agentId)
    return false;
  if (scope.runId !== undefined && episode.runId !== scope.runId) return false;
  return true;
}

function vectorProjectsContent(
  record: { content: string; payload: Record<string, unknown> },
  expectedContent: string,
): boolean {
  return (
    record.content === expectedContent ||
    record.payload.projectionContentHash === contentHash(expectedContent)
  );
}

function normalizeSlotPart(value: string): string {
  return value.trim().toLowerCase();
}

function slotSummaryKey(
  scope: Scope,
  subject: string,
  attribute: string,
): string {
  return [
    scope.userId ?? "",
    scope.agentId ?? "",
    scope.runId ?? "",
    normalizeSlotPart(subject),
    normalizeSlotPart(attribute),
  ].join("|");
}

function slotSummaryDocId(
  scope: Scope,
  subject: string,
  attribute: string,
): string {
  const key = slotSummaryKey(scope, subject, attribute);
  const hex = [0, 1, 2, 3]
    .map((i) => contentHash(`${i}:${key}`))
    .join("")
    .slice(0, 32);
  const variant = ((Number.parseInt(hex[16] ?? "8", 16) & 0x3) | 0x8).toString(
    16,
  );
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function buildSlotSummaryContent(
  subject: string,
  attribute: string,
  facts: MemoryRecord[],
): string {
  const label = attribute.replace(/[_-]+/g, " ");
  const current = facts.filter((m) => !m.validTo);
  const currentLine = current.length
    ? `Current ${label} for ${subject}: ${current.map((m) => m.content).join(" | ")}.`
    : `Current ${label} for ${subject}: unknown from active facts.`;
  const timeline = facts
    .map((m) => {
      const date = (m.eventDate ?? m.validFrom ?? m.createdAt)
        .toISOString()
        .slice(0, 10);
      const state = m.validTo
        ? `past until ${m.validTo.toISOString().slice(0, 10)}`
        : "current";
      return `${date} ${state}: ${m.content}`;
    })
    .join(" ; ");
  return [
    `Belief slot: ${subject} ${label}.`,
    currentLine,
    `Timeline for ${subject} ${label}: ${timeline}.`,
    `Evidence facts: ${facts.map((m) => m.content).join(" | ")}.`,
  ].join("\n");
}

function isRetrievalDocMemory(record: MemoryRecord): boolean {
  return typeof record.metadata?.__retrievalDoc === "string";
}

function normalizeInput(input: AddInput): Message[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (Array.isArray(input)) return input;
  return [input];
}

function episodeConversationMessages(messages: Message[]): Message[] {
  return messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        message.content.trim().length > 0,
    )
    .map((message) => ({ ...message }));
}

function buildEpisodeIndexChunks(episode: Episode): EpisodeIndexChunk[] {
  const transcript = messagesToTranscript(episode.messages);
  if (!transcript) return [];
  const contents: string[] = [];
  let start = 0;
  while (start < transcript.length) {
    let end = Math.min(start + EPISODE_INDEX_MAX_CHARS, transcript.length);
    if (end < transcript.length) {
      const boundary = transcript.lastIndexOf("\n", end);
      if (boundary > start + Math.floor(EPISODE_INDEX_MAX_CHARS / 2)) {
        end = boundary;
      }
    }
    contents.push(transcript.slice(start, end));
    if (end >= transcript.length) break;
    const overlapStart = Math.max(start + 1, end - EPISODE_INDEX_OVERLAP_CHARS);
    const nextBoundary = transcript.indexOf("\n", overlapStart);
    start =
      nextBoundary >= overlapStart && nextBoundary < end
        ? nextBoundary + 1
        : overlapStart;
  }
  return contents.map((content, index) => ({
    id: `episode-index:${episode.id}:${index}`,
    content,
    index,
    count: contents.length,
  }));
}

function episodeIndexPayload(
  episode: Episode,
  chunk: EpisodeIndexChunk,
): Record<string, unknown> {
  return {
    namespaceId: episode.namespaceId,
    recordKind: "memory",
    userId: episode.userId,
    agentId: episode.agentId,
    runId: episode.runId,
    memoryType: "observation",
    source: episode.source ?? "episode",
    episodeId: episode.id,
    eventDate: episode.createdAt.toISOString(),
    validFrom: episode.createdAt.toISOString(),
    createdAt: episode.createdAt.toISOString(),
    updatedAt: episode.createdAt.toISOString(),
    importance: 0.7,
    metadata: {
      __retrievalDoc: "episode",
      __episodeId: episode.id,
      __episodeChunk: chunk.index,
      __episodeChunkCount: chunk.count,
    },
  };
}

function episodeIndexIds(episode: Episode): string[] {
  return buildEpisodeIndexChunks(episode).map((chunk) => chunk.id);
}

function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) {
        const normalized = normalize((item as Record<string, unknown>)[key]);
        if (normalized !== undefined) out[key] = normalized;
      }
      return out;
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function normalizeBeliefValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function withoutBeliefProjectionHint(
  hints?: MemoryProjectionHints,
): MemoryProjectionHints | undefined {
  if (!hints?.belief) return hints;
  const { belief: _ignored, ...remaining } = hints;
  return Object.keys(remaining).length ? remaining : undefined;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const MEMORY_TYPE_SET = new Set<string>(MEMORY_TYPES);
/** Validate an LLM-provided type string against the 8 memory types. */
function parseMemoryType(value: unknown): MemoryType | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return MEMORY_TYPE_SET.has(v) ? (v as MemoryType) : null;
}

function readDeleteAllSlotKeys(
  command: Record<string, unknown>,
): Array<{ subject: string; attribute: string; scope: Scope }> {
  const value = command.slotKeys;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("idempotent delete-all slot plan is corrupt");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`idempotent delete-all slot ${index} is invalid`);
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.subject !== "string" ||
      typeof record.attribute !== "string" ||
      !record.scope ||
      typeof record.scope !== "object"
    ) {
      throw new Error(`idempotent delete-all slot ${index} is invalid`);
    }
    const scopeValue = record.scope as Record<string, unknown>;
    const scope: Scope = {};
    for (const key of ["namespaceId", "userId", "agentId", "runId"] as const) {
      const field = scopeValue[key];
      if (field !== undefined && typeof field !== "string") {
        throw new Error(
          `idempotent delete-all slot ${index} has invalid scope`,
        );
      }
      if (field !== undefined) scope[key] = field;
    }
    return {
      subject: record.subject,
      attribute: record.attribute,
      scope,
    };
  });
}

function readDeleteAllStringList(
  command: Record<string, unknown>,
  key: "episodeIds" | "episodeVectorIds",
): string[] {
  const value = command[key];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error(`idempotent delete-all ${key} plan is corrupt`);
  }
  return [...new Set(value)];
}

function hasAddPlan(command: Record<string, unknown>): boolean {
  return Object.hasOwn(command, "addPlan");
}

function readAddPlan(
  command: Record<string, unknown>,
): PreparedAddRecord[] | null {
  if (!hasAddPlan(command)) return null;
  const plan = command.addPlan;
  if (
    !plan ||
    typeof plan !== "object" ||
    (plan as { version?: unknown }).version !== 1 ||
    !Array.isArray((plan as { records?: unknown }).records)
  ) {
    throw new Error("idempotent add plan is corrupt");
  }
  return (plan as { records: unknown[] }).records.map((value, index) => {
    if (!value || typeof value !== "object") {
      throw new Error(`idempotent add plan record ${index} is invalid`);
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.content !== "string" ||
      record.content.trim().length === 0
    ) {
      throw new Error(
        `idempotent add plan record ${index} has invalid content`,
      );
    }
    const beliefValue =
      record.beliefValue === undefined || record.beliefValue === null
        ? null
        : typeof record.beliefValue === "string" && record.beliefValue.trim()
          ? record.beliefValue.trim()
          : undefined;
    if (beliefValue === undefined) {
      throw new Error(
        `idempotent add plan record ${index} has invalid beliefValue`,
      );
    }
    if (
      record.eventDate !== null &&
      (typeof record.eventDate !== "string" ||
        Number.isNaN(new Date(record.eventDate).getTime()))
    ) {
      throw new Error(
        `idempotent add plan record ${index} has invalid eventDate`,
      );
    }
    if (
      !Array.isArray(record.entities) ||
      !record.entities.every((entity) => typeof entity === "string")
    ) {
      throw new Error(
        `idempotent add plan record ${index} has invalid entities`,
      );
    }
    for (const key of ["subject", "attribute"] as const) {
      if (record[key] !== null && typeof record[key] !== "string") {
        throw new Error(
          `idempotent add plan record ${index} has invalid ${key}`,
        );
      }
    }
    const memoryType =
      record.memoryType === null ? null : parseMemoryType(record.memoryType);
    if (record.memoryType !== null && memoryType === null) {
      throw new Error(
        `idempotent add plan record ${index} has invalid memoryType`,
      );
    }
    if (
      record.cardinality !== null &&
      record.cardinality !== "single" &&
      record.cardinality !== "multi"
    ) {
      throw new Error(
        `idempotent add plan record ${index} has invalid cardinality`,
      );
    }
    const episodeId =
      record.episodeId === undefined || record.episodeId === null
        ? null
        : typeof record.episodeId === "string" && record.episodeId.trim()
          ? record.episodeId
          : undefined;
    if (episodeId === undefined) {
      throw new Error(
        `idempotent add plan record ${index} has invalid episodeId`,
      );
    }
    const categories = record.categories ?? [];
    if (
      !Array.isArray(categories) ||
      !categories.every(
        (category) =>
          typeof category === "string" && category.trim().length > 0,
      )
    ) {
      throw new Error(
        `idempotent add plan record ${index} has invalid categories`,
      );
    }
    return {
      content: record.content,
      categories: [...categories],
      beliefValue,
      eventDate: record.eventDate,
      entities: [...record.entities],
      subject: record.subject,
      attribute: record.attribute,
      memoryType,
      cardinality: record.cardinality,
      episodeId,
    } as PreparedAddRecord;
  });
}

function preparedRecordsToFacts(records: PreparedAddRecord[]): ExtractedFact[] {
  return records.map((record) => ({
    text: record.content,
    categories: [...record.categories],
    beliefValue: record.beliefValue,
    eventDate: record.eventDate ? new Date(record.eventDate) : null,
    entities: [...record.entities],
    subject: record.subject,
    attribute: record.attribute,
    memoryType: record.memoryType,
    cardinality: record.cardinality,
  }));
}

/** Types that are single-valued mutable state → use the supersession slot in
 * the sidecar. Excluded (point/multi-valued, append-style): event, observation,
 * goal, todo. See deriveState. */
const STATE_SLOT_TYPES = new Set<MemoryType>([
  "fact",
  "preference",
  "identity",
  "decision",
]);

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    // Tolerate models that wrap JSON in prose/code fences.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function factExtractionJsonSchema(
  categories: string[],
  includeBeliefValue: boolean,
): LLMJsonSchema {
  const properties: Record<string, unknown> = {
    text: { type: "string" },
    event_date: { type: ["string", "null"] },
    entities: { type: "array", items: { type: "string" } },
    subject: { type: ["string", "null"] },
    attribute: { type: ["string", "null"] },
    type: { type: "string", enum: [...MEMORY_TYPES] },
    cardinality: { type: "string", enum: ["single", "multi"] },
  };
  const required = Object.keys(properties);
  if (includeBeliefValue) {
    properties.value = { type: ["string", "null"] };
    required.push("value");
  }
  if (categories.length > 0) {
    properties.category = { type: "string", enum: categories };
    required.push("category");
  }
  return {
    name: "fishmem_fact_extraction",
    description:
      "Atomic durable memories extracted from one conversation chunk.",
    strict: true,
    schema: {
      type: "object",
      properties: {
        facts: {
          type: "array",
          items: {
            type: "object",
            properties,
            required,
            additionalProperties: false,
          },
        },
      },
      required: ["facts"],
      additionalProperties: false,
    },
  };
}

function describeExtractionShape(raw: string, parsed: unknown): string {
  if (parsed === null || parsed === undefined) {
    const trimmed = raw.trim();
    return `shape=unparseable,chars=${raw.length},objectBoundaries=${trimmed.startsWith("{") && trimmed.endsWith("}")}`;
  }
  if (Array.isArray(parsed)) {
    return `shape=array,items=${parsed.length},chars=${raw.length}`;
  }
  if (typeof parsed !== "object") {
    return `shape=${typeof parsed},chars=${raw.length}`;
  }
  const facts = (parsed as { facts?: unknown }).facts;
  return `shape=object,facts=${Array.isArray(facts) ? "array" : typeof facts},chars=${raw.length}`;
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}
