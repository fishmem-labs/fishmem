import type { MemoryFilters } from "../types.js";
import type { VectorHit, VectorRecord, VectorStore } from "./base.js";

/**
 * In-memory vector store. Fully functional (cosine NN + keyword FTS), zero
 * dependencies — the default store and the backbone of the test suite.
 *
 * It is the spiritual equivalent of spacebot's LanceDB layer: it holds the
 * embedding, the content (for FTS), and a payload for scoped filtering.
 */
export class InMemoryVectorStore implements VectorStore {
  private records = new Map<string, VectorRecord>();
  private dimensions = 0;

  async init(dimensions: number): Promise<void> {
    this.dimensions = dimensions;
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const r of records) {
      if (this.dimensions && r.vector.length !== this.dimensions) {
        throw new Error(
          `vector dim mismatch: expected ${this.dimensions}, got ${r.vector.length}`,
        );
      }
      this.records.set(r.id, {
        id: r.id,
        vector: [...r.vector],
        content: r.content,
        payload: { ...r.payload },
      });
    }
  }

  async search(
    vector: number[],
    limit: number,
    filters?: MemoryFilters,
  ): Promise<VectorHit[]> {
    const hits: VectorHit[] = [];
    for (const r of this.records.values()) {
      if (!matchesFilters(r.payload, filters)) continue;
      const score = cosineSimilarity(vector, r.vector);
      hits.push({ id: r.id, score, content: r.content, payload: r.payload });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async textSearch(
    query: string,
    limit: number,
    filters?: MemoryFilters,
  ): Promise<VectorHit[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const docs: Array<{ r: VectorRecord; terms: string[] }> = [];
    for (const r of this.records.values()) {
      if (!matchesFilters(r.payload, filters)) continue;
      const docTerms = tokenize(r.content);
      if (docTerms.length === 0) continue;
      docs.push({ r, terms: docTerms });
    }
    const hits = bm25Rank(terms, docs).map(({ r, score }) => ({
      id: r.id,
      score,
      content: r.content,
      payload: r.payload,
    }));
    return hits.slice(0, limit);
  }

  async get(id: string): Promise<VectorRecord | null> {
    const r = this.records.get(id);
    return r
      ? { ...r, vector: [...r.vector], payload: { ...r.payload } }
      : null;
  }

  async getMany(ids: string[]): Promise<Array<VectorRecord | null>> {
    return Promise.all(ids.map((id) => this.get(id)));
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async deleteMany(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.delete(id)));
  }

  async deleteByFilter(filters: MemoryFilters): Promise<void> {
    for (const [id, r] of this.records) {
      if (matchesFilters(r.payload, filters)) this.records.delete(id);
    }
  }

  async list(filters: MemoryFilters, limit: number): Promise<VectorRecord[]> {
    const out: VectorRecord[] = [];
    for (const r of this.records.values()) {
      if (matchesFilters(r.payload, filters)) out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Payload-equality filter matching (used by every store's filter logic). */
export function matchesFilters(
  payload: Record<string, unknown>,
  filters?: MemoryFilters,
): boolean {
  if (!filters) return true;
  if (
    filters.namespaceId !== undefined &&
    payload.namespaceId !== filters.namespaceId
  )
    return false;
  if (filters.userId !== undefined && payload.userId !== filters.userId)
    return false;
  if (filters.agentId !== undefined && payload.agentId !== filters.agentId)
    return false;
  if (filters.runId !== undefined && payload.runId !== filters.runId)
    return false;
  if (
    filters.memoryType !== undefined &&
    payload.memoryType !== filters.memoryType
  )
    return false;
  if (
    filters.recordKind !== undefined &&
    payload.recordKind !== filters.recordKind
  )
    return false;
  if (
    filters.documentId !== undefined &&
    payload.documentId !== filters.documentId
  )
    return false;
  if (
    filters.sourceKey !== undefined &&
    payload.sourceKey !== filters.sourceKey
  )
    return false;
  if (filters.metadata) {
    const md = (payload.metadata ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(filters.metadata)) {
      if (md[k] !== v) return false;
    }
  }
  return true;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/u)
    .filter((t) => t.length > 1);
}

function bm25Rank(
  queryTerms: string[],
  docs: Array<{ r: VectorRecord; terms: string[] }>,
): Array<{ r: VectorRecord; score: number }> {
  if (!docs.length) return [];
  const uniqueQueryTerms = [...new Set(queryTerms)];
  const avgLen =
    docs.reduce((sum, doc) => sum + doc.terms.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const term of uniqueQueryTerms) {
    let count = 0;
    for (const doc of docs) {
      if (doc.terms.includes(term)) count++;
    }
    df.set(term, count);
  }
  const k1 = 1.5;
  const b = 0.75;
  return docs
    .map((doc) => {
      let score = 0;
      for (const term of uniqueQueryTerms) {
        const freq = doc.terms.filter((t) => t === term).length;
        if (freq === 0) continue;
        const docFreq = df.get(term) ?? 0;
        const idf = Math.log(
          (docs.length - docFreq + 0.5) / (docFreq + 0.5) + 1,
        );
        score +=
          (idf * freq * (k1 + 1)) /
          (freq + k1 * (1 - b + (b * doc.terms.length) / avgLen));
      }
      return { r: doc.r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b2) => b2.score - a.score);
}
