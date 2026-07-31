import { contentHash } from "../core/util.js";
import type { MemoryFilters } from "../types.js";
import type { VectorHit, VectorRecord, VectorStore } from "./base.js";

/** Minimal shape of a Cloudflare Vectorize binding (no workers-types needed). */
export interface VectorizeBinding {
  upsert(vectors: any[]): Promise<unknown>;
  query(vector: number[], options?: any): Promise<{ matches: any[] }>;
  getByIds(ids: string[]): Promise<any[]>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

export interface VectorizeConfig {
  /** The Vectorize index binding from `env.MY_INDEX`. */
  index: VectorizeBinding;
}

/**
 * Cloudflare Vectorize store — the recommended vector backend when running on
 * Workers with D1 as the graph store. Vectorize has no full-text search, so
 * hybrid retrieval degrades to vector + graph (same fallback as spacebot).
 *
 * Note: Vectorize cannot enumerate all ids or delete by metadata filter.
 * Maintenance workflows rebuild known canonical ids in place and verify them
 * with `getByIds`; search always rehydrates hits through the canonical store.
 */
export class VectorizeStore implements VectorStore {
  readonly capabilities = {
    filterDelete: false,
    enumeration: false,
    metadataFilter: false,
  } as const;

  private readonly index: VectorizeBinding;

  constructor(config: VectorizeConfig) {
    if (!config?.index) {
      throw new Error("VectorizeStore requires a Vectorize index binding.");
    }
    this.index = config.index;
  }

  async init(_dimensions: number): Promise<void> {
    // Vectorize indexes are provisioned out-of-band (wrangler / dashboard).
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    await this.index.upsert(
      records.map((r) => ({
        id: r.id,
        values: r.vector,
        metadata: flattenPayload(r.payload, r.content),
      })),
    );
  }

  async search(
    vector: number[],
    limit: number,
    filters?: MemoryFilters,
  ): Promise<VectorHit[]> {
    const res = await this.index.query(vector, {
      // Vectorize caps queries that return full metadata at 50.
      topK: Math.min(limit, 50),
      returnMetadata: "all",
      filter: toVectorizeFilter(filters),
    });
    return (res.matches ?? []).map((m: any) => ({
      id: m.id,
      score: m.score,
      content: m.metadata?.content,
      payload: unflattenPayload(m.metadata),
    }));
  }

  async get(id: string): Promise<VectorRecord | null> {
    const res = await this.index.getByIds([id]);
    return decodeVector(res?.[0]);
  }

  async getMany(ids: string[]): Promise<Array<VectorRecord | null>> {
    const byId = new Map<string, VectorRecord>();
    for (let offset = 0; offset < ids.length; offset += 1_000) {
      const vectors = await this.index.getByIds(
        ids.slice(offset, offset + 1_000),
      );
      for (const vector of vectors ?? []) {
        const decoded = decodeVector(vector);
        if (decoded) byId.set(decoded.id, decoded);
      }
    }
    return ids.map((id) => byId.get(id) ?? null);
  }

  async delete(id: string): Promise<void> {
    await this.index.deleteByIds([id]);
  }

  async deleteMany(ids: string[]): Promise<void> {
    for (let offset = 0; offset < ids.length; offset += 1_000) {
      await this.index.deleteByIds(ids.slice(offset, offset + 1_000));
    }
  }

  async deleteByFilter(_filters: MemoryFilters): Promise<void> {
    throw new Error(
      "Cloudflare Vectorize does not support deleteByFilter; delete records by known ids.",
    );
  }

  async list(_filters: MemoryFilters, _limit: number): Promise<VectorRecord[]> {
    throw new Error(
      "Cloudflare Vectorize does not support listing vectors; use the graph store as the source of record ids.",
    );
  }
}

function decodeVector(vector: any): VectorRecord | null {
  if (!vector) return null;
  return {
    id: vector.id,
    vector: vector.values ?? [],
    content: vector.metadata?.content ?? "",
    payload: unflattenPayload(vector.metadata),
  };
}

// Vectorize metadata keys may not contain "." or '"', start with "$", or be
// empty — nested metadata is flattened with this prefix instead.
const META_PREFIX = "md_";

function isPrimitive(v: unknown): v is string | number | boolean {
  return (
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  );
}

function flattenPayload(
  payload: Record<string, unknown>,
  content: string,
): Record<string, unknown> {
  const metadata =
    payload.metadata && typeof payload.metadata === "object"
      ? (payload.metadata as Record<string, unknown>)
      : undefined;
  const retrievalDocument = metadata?.__retrievalDoc === "slot_summary";
  const out: Record<string, unknown> = {
    projectionContentHash: contentHash(content),
    // Ordinary memory and document content is canonical in D1 and is
    // rehydrated after every hit. Only vector-only retrieval documents need
    // their content co-located in Vectorize.
    ...(retrievalDocument ? { content } : {}),
  };
  for (const [k, v] of Object.entries(payload)) {
    if (k === "metadata" && v && typeof v === "object") {
      if (!retrievalDocument) continue;
      for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
        // Retrieval-document metadata is internal and required to reconstruct
        // that vector-only projection. User metadata remains canonical in D1.
        if (isPrimitive(mv) && !/[."]|^\$|^$/.test(mk)) {
          out[`${META_PREFIX}${mk}`] = mv;
        }
      }
    } else if (isPrimitive(v)) {
      out[k] = v;
    }
  }
  if (new TextEncoder().encode(JSON.stringify(out)).byteLength > 10 * 1_024) {
    throw new Error(
      "Vectorize metadata exceeds the 10 KiB platform limit; keep canonical content in the graph/document store.",
    );
  }
  return out;
}

/** Rebuild the nested payload shape from Vectorize's flattened metadata. */
function unflattenPayload(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const out: Record<string, unknown> = {};
  const nested: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (k === "content") continue;
    if (k.startsWith(META_PREFIX)) nested[k.slice(META_PREFIX.length)] = v;
    else out[k] = v;
  }
  if (Object.keys(nested).length) out.metadata = nested;
  return out;
}

function toVectorizeFilter(filters?: MemoryFilters): any {
  if (!filters) return undefined;
  const f: Record<string, unknown> = {};
  if (filters.namespaceId !== undefined) f.namespaceId = filters.namespaceId;
  if (filters.userId !== undefined) f.userId = filters.userId;
  if (filters.agentId !== undefined) f.agentId = filters.agentId;
  if (filters.runId !== undefined) f.runId = filters.runId;
  if (filters.memoryType !== undefined) f.memoryType = filters.memoryType;
  if (filters.recordKind !== undefined) f.recordKind = filters.recordKind;
  if (filters.documentId !== undefined) f.documentId = filters.documentId;
  if (filters.sourceKey !== undefined) f.sourceKey = filters.sourceKey;
  // Arbitrary user metadata is canonical in D1 rather than duplicated into
  // Vectorize. MemorySearch applies it after rehydrating each candidate.
  return Object.keys(f).length ? f : undefined;
}
