import type { MemoryFilters } from "../types.js";
import type { VectorHit, VectorRecord, VectorStore } from "./base.js";

export interface QdrantConfig {
  url?: string;
  apiKey?: string;
  collectionName?: string;
  /** An existing @qdrant/js-client-rest client. */
  client?: any;
}

/**
 * Qdrant vector store (cosine). Payload holds scoping keys + content, filtered
 * server-side via `must` match conditions. No full-text search is exposed, so
 * hybrid retrieval falls back to vector + graph (graceful, same as spacebot
 * when its FTS index is absent).
 *
 * The `@qdrant/js-client-rest` package is an optional, lazily-imported peer dep.
 */
export class QdrantStore implements VectorStore {
  private readonly collectionName: string;
  private readonly url: string;
  private readonly apiKey?: string;
  private client: any;

  constructor(config: QdrantConfig = {}) {
    this.collectionName = config.collectionName ?? "fishmem";
    this.url = config.url ?? "http://localhost:6333";
    this.apiKey = config.apiKey;
    this.client = config.client;
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    let mod: any;
    try {
      mod = await import("@qdrant/js-client-rest");
    } catch {
      throw new Error(
        "The '@qdrant/js-client-rest' package is required for QdrantStore.",
      );
    }
    const QdrantClient = mod.QdrantClient ?? mod.default?.QdrantClient;
    this.client = new QdrantClient({ url: this.url, apiKey: this.apiKey });
    return this.client;
  }

  async init(dimensions: number): Promise<void> {
    const client = await this.getClient();
    const existing = await client.getCollections();
    const found = existing.collections?.some(
      (c: { name: string }) => c.name === this.collectionName,
    );
    if (!found) {
      await client.createCollection(this.collectionName, {
        vectors: { size: dimensions, distance: "Cosine" },
      });
    }
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    const client = await this.getClient();
    await client.upsert(this.collectionName, {
      wait: true,
      points: records.map((r) => ({
        id: toPointId(r.id),
        vector: r.vector,
        payload: { ...r.payload, content: r.content, _id: r.id },
      })),
    });
  }

  async search(
    vector: number[],
    limit: number,
    filters?: MemoryFilters,
  ): Promise<VectorHit[]> {
    const client = await this.getClient();
    const res = await client.search(this.collectionName, {
      vector,
      limit,
      filter: toQdrantFilter(filters),
      with_payload: true,
    });
    return res.map((p: any) => ({
      id: p.payload?._id ?? String(p.id),
      score: p.score,
      content: p.payload?.content,
      payload: p.payload ?? {},
    }));
  }

  async get(id: string): Promise<VectorRecord | null> {
    const client = await this.getClient();
    const res = await client.retrieve(this.collectionName, {
      ids: [toPointId(id)],
      with_payload: true,
      with_vector: true,
    });
    const p = res[0];
    if (!p) return null;
    return {
      id,
      vector: (p.vector as number[]) ?? [],
      content: p.payload?.content ?? "",
      payload: p.payload ?? {},
    };
  }

  async getMany(ids: string[]): Promise<Array<VectorRecord | null>> {
    const client = await this.getClient();
    const byId = new Map<string, VectorRecord>();
    for (let offset = 0; offset < ids.length; offset += 1_000) {
      const points = await client.retrieve(this.collectionName, {
        ids: ids.slice(offset, offset + 1_000).map(toPointId),
        with_payload: true,
        with_vector: true,
      });
      for (const point of points ?? []) {
        const id = point.payload?._id ?? String(point.id);
        byId.set(id, {
          id,
          vector: (point.vector as number[]) ?? [],
          content: point.payload?.content ?? "",
          payload: point.payload ?? {},
        });
      }
    }
    return ids.map((id) => byId.get(id) ?? null);
  }

  async delete(id: string): Promise<void> {
    const client = await this.getClient();
    await client.delete(this.collectionName, {
      wait: true,
      points: [toPointId(id)],
    });
  }

  async deleteMany(ids: string[]): Promise<void> {
    const client = await this.getClient();
    for (let offset = 0; offset < ids.length; offset += 1_000) {
      await client.delete(this.collectionName, {
        wait: true,
        points: ids.slice(offset, offset + 1_000).map(toPointId),
      });
    }
  }

  async deleteByFilter(filters: MemoryFilters): Promise<void> {
    const client = await this.getClient();
    await client.delete(this.collectionName, {
      wait: true,
      filter: toQdrantFilter(filters),
    });
  }

  async list(filters: MemoryFilters, limit: number): Promise<VectorRecord[]> {
    const client = await this.getClient();
    const res = await client.scroll(this.collectionName, {
      limit,
      filter: toQdrantFilter(filters),
      with_payload: true,
      with_vector: true,
    });
    return (res.points ?? []).map((p: any) => ({
      id: p.payload?._id ?? String(p.id),
      vector: (p.vector as number[]) ?? [],
      content: p.payload?.content ?? "",
      payload: p.payload ?? {},
    }));
  }
}

function toQdrantFilter(filters?: MemoryFilters): any {
  if (!filters) return undefined;
  const must: any[] = [];
  const add = (key: string, value: unknown) => {
    if (value !== undefined) must.push({ key, match: { value } });
  };
  add("namespaceId", filters.namespaceId);
  add("userId", filters.userId);
  add("agentId", filters.agentId);
  add("runId", filters.runId);
  add("memoryType", filters.memoryType);
  add("recordKind", filters.recordKind);
  add("documentId", filters.documentId);
  add("sourceKey", filters.sourceKey);
  if (filters.metadata) {
    for (const [k, v] of Object.entries(filters.metadata)) {
      must.push({ key: `metadata.${k}`, match: { value: v } });
    }
  }
  return must.length ? { must } : undefined;
}

/**
 * Qdrant point ids must be unsigned ints or UUIDs. Memory ids are UUIDs, so we
 * pass them through; non-UUID ids would need hashing (left to the caller).
 */
function toPointId(id: string): string {
  return id;
}
