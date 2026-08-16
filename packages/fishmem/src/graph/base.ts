import type {
  MemoryJournalEvent,
  MemoryOperation,
  OperationClaim,
  OperationSummary,
  ProjectionStatus,
} from "../core/journal.js";
import type {
  Association,
  DocumentChunk,
  DocumentFilters,
  DocumentHead,
  DocumentSource,
  Entity,
  Episode,
  HistoryEntry,
  Memory,
  MemoryEvent,
  MemoryFilters,
  MemoryType,
  ScopeEntity,
  ScopeEntityType,
  SearchSort,
} from "../types.js";

export interface ListOptions {
  sort?: SearchSort;
  limit?: number;
  offset?: number;
  cursor?: { createdAt: Date; id: string };
}

export interface ScopeEntityCursor {
  updatedAt: Date;
  type: ScopeEntityType;
  id: string;
}

export interface ScopeEntityListOptions {
  type?: ScopeEntityType;
  /** Internal exact lookup constraint. */
  id?: string;
  limit?: number;
  cursor?: ScopeEntityCursor;
}

/** Complete authoritative graph data for one namespace. Vector and sidecar
 * projections are excluded because they are rebuildable. */
export interface GraphSnapshotData {
  memories: Memory[];
  documents: DocumentSource[];
  documentHeads: DocumentHead[];
  documentChunks: DocumentChunk[];
  associations: Association[];
  history: HistoryEntry[];
  entities: Entity[];
  memoryEntities: Array<{ memoryId: string; entityId: string }>;
  episodes: Episode[];
  operations: MemoryOperation[];
  events: MemoryJournalEvent[];
}

/**
 * The relational store: holds memories, the association graph, and the
 * history log. This is where "graph memory" lives — edges are ordinary rows
 * in an `associations` table, not a separate graph database.
 *
 * Implementations: in-memory (default/testing), and Drizzle-backed adapters
 * for Postgres, SQLite (better-sqlite3 / libSQL), and Cloudflare D1.
 */
export interface GraphStore {
  /** Create tables/indexes if needed. Idempotent. */
  init(): Promise<void>;

  // ── Memory CRUD ──────────────────────────────────────────────────────────
  saveMemory(memory: Memory): Promise<void>;
  getMemory(id: string): Promise<Memory | null>;
  updateMemory(memory: Memory): Promise<void>;
  /** Hard delete (also removes incident associations). */
  deleteMemory(id: string): Promise<void>;
  /** last_accessed_at = now, access_count += 1. */
  recordAccess(id: string): Promise<void>;
  /** Soft-delete: mark `forgotten = true`. Returns true if it changed state. */
  forget(id: string): Promise<boolean>;

  /** List non-forgotten memories matching filters, with sort/paging. */
  listMemories(
    filters: MemoryFilters,
    options?: ListOptions,
  ): Promise<Memory[]>;
  countMemories(filters: MemoryFilters): Promise<number>;
  /** Non-forgotten memories with importance >= threshold (graph seeds). */
  getHighImportance(
    threshold: number,
    limit: number,
    filters: MemoryFilters,
  ): Promise<Memory[]>;

  /** Aggregate structural user/agent/run owners from canonical memories. */
  listScopeEntities(
    namespaceId: string,
    options?: ScopeEntityListOptions,
  ): Promise<ScopeEntity[]>;
  /** Exact number of structural user/agent/run owners in a namespace. */
  countScopeEntities?(namespaceId: string): Promise<number>;

  // ── Associations (graph edges) ─────────────────────────────────────────────
  createAssociation(association: Association): Promise<void>;
  /** All edges incident to `memoryId` (incoming + outgoing). */
  getAssociations(memoryId: string): Promise<Association[]>;
  /** Edges where both endpoints are in the provided set (subgraph view). */
  getAssociationsBetween(memoryIds: string[]): Promise<Association[]>;
  deleteAssociationsForMemory(memoryId: string): Promise<number>;
  /** BFS neighbourhood up to `depth`, excluding `excludeIds`. */
  getNeighbors(
    memoryId: string,
    depth: number,
    excludeIds: string[],
  ): Promise<{ nodes: Memory[]; edges: Association[] }>;

  // ── Entities (belief-graph nodes) & mentions ───────────────────────────────
  saveEntity(entity: Entity): Promise<void>;
  updateEntity(entity: Entity): Promise<void>;
  /** Non-deleted entities in scope (for synonym resolution / query matching). */
  listEntities(filters: MemoryFilters, limit?: number): Promise<Entity[]>;
  /** Idempotently link a memory to the entities it mentions. */
  linkMemoryEntities(memoryId: string, entityIds: string[]): Promise<void>;
  /** memoryId → entityIds for the given memories. */
  getEntityIdsForMemories(memoryIds: string[]): Promise<Map<string, string[]>>;
  /** entityId → memoryIds for the given entities. */
  getMemoryIdsForEntities(entityIds: string[]): Promise<Map<string, string[]>>;

  // ── Episodes (raw, non-lossy archive) ───────────────────────────────────────
  saveEpisode(episode: Episode): Promise<void>;
  getEpisode(id: string): Promise<Episode | null>;
  listEpisodes(
    filters: MemoryFilters,
    options?: ListOptions,
  ): Promise<Episode[]>;

  /**
   * Merge `merged` into `survivor` atomically: update survivor, rewire
   * `merged`'s edges onto the survivor, add an `updates` edge survivor→merged,
   * and mark `merged` forgotten. Mirrors spacebot's `merge_memories_atomic`.
   */
  mergeMemoriesAtomic(survivor: Memory, merged: Memory): Promise<void>;

  // ── History log ────────────────────────────────────────────────────────────
  addHistory(entry: {
    id?: string;
    memoryId: string;
    event: MemoryEvent;
    previousValue: string | null;
    newValue: string | null;
    createdAt?: Date;
  }): Promise<void>;
  getHistory(memoryId: string): Promise<HistoryEntry[]>;

  /** Export every authoritative row for one structural namespace, including
   * forgotten memories and their history. */
  exportNamespace(namespaceId: string): Promise<GraphSnapshotData>;
  /** Idempotently stage an import under an internal, non-routable namespace. */
  stageNamespaceImport(
    stagingNamespaceId: string,
    data: GraphSnapshotData,
  ): Promise<void>;
  /** Atomically make a fully staged namespace visible as the target. */
  commitNamespaceImport(
    stagingNamespaceId: string,
    targetNamespaceId: string,
  ): Promise<void>;

  /** Atomically persist an immutable source version, its deterministic chunks,
   * and move the stable source head to that version. */
  commitDocumentVersion(
    source: DocumentSource,
    chunks: DocumentChunk[],
    head: DocumentHead,
  ): Promise<void>;
  getDocument(id: string): Promise<DocumentSource | null>;
  getCurrentDocument(
    namespaceId: string,
    sourceKey: string,
  ): Promise<DocumentSource | null>;
  listDocumentVersions(
    namespaceId: string,
    sourceKey: string,
  ): Promise<DocumentSource[]>;
  listCurrentDocuments(
    filters: DocumentFilters,
    options?: ListOptions,
  ): Promise<DocumentSource[]>;
  getDocumentChunk(id: string): Promise<DocumentChunk | null>;
  listDocumentChunks(documentId: string): Promise<DocumentChunk[]>;
  /** Permanently remove every version and chunk for the addressed source key. */
  purgeDocument(documentId: string): Promise<{
    documentIds: string[];
    chunkIds: string[];
  }>;

  claimOperation(operation: MemoryOperation): Promise<OperationClaim>;
  /** Persist the canonical write plan while the claimed operation is pending.
   * This freezes LLM-produced records and their ids before projections begin,
   * so a repair replays the same command instead of inferring again. */
  planOperation(
    operationId: string,
    command: Record<string, unknown>,
    memoryIds: string[],
  ): Promise<MemoryOperation>;
  getOperation(operationId: string): Promise<MemoryOperation | null>;
  listOperations(
    namespaceId: string,
    limit?: number,
  ): Promise<MemoryOperation[]>;
  /** Exact journal health for one structural namespace. */
  summarizeOperations(namespaceId: string): Promise<OperationSummary>;
  markProjectionReady(
    namespaceId: string,
    projection: "vector" | "derived",
  ): Promise<number>;
  /** Atomically transition a failed operation back to pending. */
  retryOperation(operationId: string, leaseExpiresAt: Date): Promise<boolean>;
  completeOperation(
    operationId: string,
    result: unknown,
    projections: {
      raw: ProjectionStatus;
      vector: ProjectionStatus;
      derived: ProjectionStatus;
    },
    events: MemoryJournalEvent[],
  ): Promise<void>;
  failOperation(
    operationId: string,
    error: string,
    projections?: {
      raw: ProjectionStatus;
      vector: ProjectionStatus;
      derived: ProjectionStatus;
    },
  ): Promise<void>;
  listEvents(namespaceId: string): Promise<MemoryJournalEvent[]>;

  // ── Bulk ────────────────────────────────────────────────────────────────────
  /** Permanently delete an exact, already-authorized set of memory ids. */
  deleteMemories(ids: string[]): Promise<void>;
  /** Delete all memories/associations matching filters; returns ids removed. */
  deleteAll(filters: MemoryFilters): Promise<string[]>;
  /** Permanently remove every canonical row owned by one structural namespace. */
  purgeNamespace(namespaceId: string): Promise<string[]>;
  /** Drop everything (history included). Used by `reset()`. */
  reset(): Promise<void>;

  /** Release any underlying connection/handle. */
  close(): Promise<void>;
}

/** Re-export for adapter convenience. */
export type { MemoryType };
