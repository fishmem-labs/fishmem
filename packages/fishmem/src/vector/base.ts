import type { MemoryFilters } from "../types.js";

/** A vector record: an embedding plus its content and scoping payload. */
export interface VectorRecord {
  /** Memory id this vector belongs to. */
  id: string;
  vector: number[];
  /** Original text — stored so the vector store can offer full-text search. */
  content: string;
  /** Scoping + metadata payload (userId, agentId, runId, memoryType, ...). */
  payload: Record<string, unknown>;
}

/** A vector-store hit. `score` is a similarity in [0, 1] — higher is better. */
export interface VectorHit {
  id: string;
  score: number;
  content?: string;
  payload?: Record<string, unknown>;
}

/** Optional backend capabilities used by maintenance workflows. Adapters that
 * omit this declaration are treated as supporting the full VectorStore
 * contract for compatibility with simple/custom stores. */
export interface VectorStoreCapabilities {
  /** The backend can delete every vector matching an arbitrary filter. */
  filterDelete: boolean;
  /** The backend can enumerate vectors matching an arbitrary filter. */
  enumeration: boolean;
  /** The backend can apply arbitrary user metadata equality filters. */
  metadataFilter: boolean;
}

/**
 * Pluggable vector store. Implementations: in-memory, pgvector, sqlite-vec,
 * Qdrant, Cloudflare Vectorize.
 *
 * Stores that provide FTS keep `content` alongside the vector (as in
 * spacebot's LanceDB layer). Pointer-oriented backends such as Vectorize may
 * persist only a projection hash and rehydrate every hit from the canonical
 * graph/document store.
 */
export interface VectorStore {
  /** Maintenance capabilities when the backend has platform limitations. */
  readonly capabilities?: Partial<VectorStoreCapabilities>;

  /** Create the collection/table if needed. Idempotent. */
  init(dimensions: number): Promise<void>;

  /** Insert or replace records by id. */
  upsert(records: VectorRecord[]): Promise<void>;

  /**
   * Optional lexical-only projection used while semantic embeddings are being
   * prepared asynchronously. Implementations must index the supplied content
   * without fabricating an embedding.
   */
  upsertText?(
    records: Array<Pick<VectorRecord, "id" | "content" | "payload">>,
  ): Promise<void>;

  /**
   * Nearest-neighbour search. Returns hits sorted by similarity descending.
   * `filters` restrict the candidate set by payload equality.
   */
  search(
    vector: number[],
    limit: number,
    filters?: MemoryFilters,
  ): Promise<VectorHit[]>;

  /**
   * Optional full-text/keyword search over `content`. Stores that cannot do
   * this should leave it undefined; hybrid search degrades gracefully.
   * Returns hits sorted by score descending.
   */
  textSearch?(
    query: string,
    limit: number,
    filters?: MemoryFilters,
  ): Promise<VectorHit[]>;

  get(id: string): Promise<VectorRecord | null>;
  /** Fetch known ids in backend-sized batches when supported. */
  getMany?(ids: string[]): Promise<Array<VectorRecord | null>>;
  delete(id: string): Promise<void>;
  /** Delete known ids in backend-sized batches when supported. */
  deleteMany?(ids: string[]): Promise<void>;

  /** Delete every record matching the filters (used by deleteAll/reset). */
  deleteByFilter(filters: MemoryFilters): Promise<void>;

  /** List records matching filters (used by getAll/reset). */
  list(filters: MemoryFilters, limit: number): Promise<VectorRecord[]>;
}

/** Delete a known set without forcing every caller to understand backend batch
 * limits. Custom stores that do not implement `deleteMany` retain the simple
 * one-id contract. */
export async function deleteVectorRecords(
  store: VectorStore,
  ids: string[],
): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  if (store.deleteMany) {
    await store.deleteMany(unique);
    return;
  }
  await Promise.all(unique.map((id) => store.delete(id)));
}

/** Fetch known ids while preserving caller order. */
export async function getVectorRecords(
  store: VectorStore,
  ids: string[],
): Promise<Array<VectorRecord | null>> {
  if (!ids.length) return [];
  if (store.getMany) return store.getMany(ids);
  return Promise.all(ids.map((id) => store.get(id)));
}
