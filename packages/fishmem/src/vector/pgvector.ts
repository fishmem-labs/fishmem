import type { MemoryFilters } from "../types.js";
import type { VectorHit, VectorRecord, VectorStore } from "./base.js";

export type PgVectorWarningHandler = (warning: {
  code: "pgvector_ivfflat_index_failed";
  message: string;
  recoverable: true;
  error?: unknown;
  context?: Record<string, unknown>;
}) => void;

export interface PgVectorConfig {
  /** A `pg` Pool/Client, or a connection string to construct one. */
  connectionString?: string;
  pool?: any;
  tableName?: string;
  /** Recoverable diagnostics, such as optional ANN index creation failures. */
  onWarning?: PgVectorWarningHandler;
}

/**
 * Postgres + pgvector store. Uses the cosine distance operator (`<=>`) for ANN
 * and Postgres full-text search (`websearch_to_tsquery`) for keyword search,
 * giving a single store that serves both halves of hybrid retrieval.
 *
 * Requires the `vector` extension. The `pg` package is an optional peer dep.
 */
export class PgVectorStore implements VectorStore {
  private readonly tableName: string;
  private pool: any;
  private readonly connectionString?: string;
  private readonly onWarning?: PgVectorWarningHandler;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: assigned in ensureTable(), read in search()
  private dimensions = 0;

  constructor(config: PgVectorConfig = {}) {
    this.tableName = config.tableName ?? "fishmem_vectors";
    this.pool = config.pool;
    this.connectionString = config.connectionString;
    this.onWarning = config.onWarning;
  }

  private async getPool(): Promise<any> {
    if (this.pool) return this.pool;
    let mod: any;
    try {
      mod = await import("pg");
    } catch {
      throw new Error("The 'pg' package is required for PgVectorStore.");
    }
    const Pool = mod.default?.Pool ?? mod.Pool;
    this.pool = new Pool({ connectionString: this.connectionString });
    return this.pool;
  }

  async init(dimensions: number): Promise<void> {
    this.dimensions = dimensions;
    const pool = await this.getPool();
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding vector(${dimensions}) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.tableName}_fts
       ON ${this.tableName} USING GIN (to_tsvector('english', content))`,
    );
    // IVFFlat index for cosine. Search remains correct without it, but that is
    // a performance downgrade and must be observable by callers.
    try {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${this.tableName}_vec
         ON ${this.tableName} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
      );
    } catch (error) {
      this.warn(
        "pgvector_ivfflat_index_failed",
        "PgVectorStore could not create the IVFFlat ANN index; vector search will fall back to PostgreSQL scans.",
        error,
        { tableName: this.tableName, dimensions },
      );
    }
  }

  private warn(
    code: "pgvector_ivfflat_index_failed",
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ): void {
    if (this.onWarning) {
      this.onWarning({
        code,
        message,
        recoverable: true,
        error,
        context,
      });
      return;
    }
    console.warn(`[fishmem] ${message}`);
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    const pool = await this.getPool();
    for (const r of records) {
      await pool.query(
        `INSERT INTO ${this.tableName} (id, content, embedding, payload)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET content = EXCLUDED.content,
               embedding = EXCLUDED.embedding,
               payload = EXCLUDED.payload`,
        [r.id, r.content, toVectorLiteral(r.vector), JSON.stringify(r.payload)],
      );
    }
  }

  async search(
    vector: number[],
    limit: number,
    filters?: MemoryFilters,
  ): Promise<VectorHit[]> {
    const pool = await this.getPool();
    const { clause, params } = buildWhere(filters, 2);
    const res = await pool.query(
      `SELECT id, content, payload, 1 - (embedding <=> $1) AS score
       FROM ${this.tableName}
       ${clause}
       ORDER BY embedding <=> $1
       LIMIT ${Number(limit)}`,
      [toVectorLiteral(vector), ...params],
    );
    return res.rows.map(rowToHit);
  }

  async textSearch(
    query: string,
    limit: number,
    filters?: MemoryFilters,
  ): Promise<VectorHit[]> {
    const pool = await this.getPool();
    const { clause, params } = buildWhere(filters, 2);
    const where = clause
      ? `${clause} AND to_tsvector('english', content) @@ websearch_to_tsquery('english', $1)`
      : `WHERE to_tsvector('english', content) @@ websearch_to_tsquery('english', $1)`;
    const res = await pool.query(
      `SELECT id, content, payload,
              ts_rank(to_tsvector('english', content), websearch_to_tsquery('english', $1)) AS score
       FROM ${this.tableName}
       ${where}
       ORDER BY score DESC
       LIMIT ${Number(limit)}`,
      [query, ...params],
    );
    return res.rows.map(rowToHit);
  }

  async get(id: string): Promise<VectorRecord | null> {
    const pool = await this.getPool();
    const res = await pool.query(
      `SELECT id, content, embedding, payload FROM ${this.tableName} WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  }

  async getMany(ids: string[]): Promise<Array<VectorRecord | null>> {
    if (!ids.length) return [];
    const pool = await this.getPool();
    const res = await pool.query(
      `SELECT id, content, embedding, payload FROM ${this.tableName} WHERE id = ANY($1::text[])`,
      [ids],
    );
    const byId = new Map<string, VectorRecord>(
      res.rows.map((row: any) => {
        const record = rowToRecord(row);
        return [record.id, record];
      }),
    );
    return ids.map((id) => byId.get(id) ?? null);
  }

  async delete(id: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(`DELETE FROM ${this.tableName} WHERE id = $1`, [id]);
  }

  async deleteMany(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const pool = await this.getPool();
    await pool.query(
      `DELETE FROM ${this.tableName} WHERE id = ANY($1::text[])`,
      [ids],
    );
  }

  async deleteByFilter(filters: MemoryFilters): Promise<void> {
    const pool = await this.getPool();
    const { clause, params } = buildWhere(filters, 1);
    await pool.query(`DELETE FROM ${this.tableName} ${clause}`, params);
  }

  async list(filters: MemoryFilters, limit: number): Promise<VectorRecord[]> {
    const pool = await this.getPool();
    const { clause, params } = buildWhere(filters, 1);
    const res = await pool.query(
      `SELECT id, content, embedding, payload FROM ${this.tableName} ${clause} LIMIT ${Number(limit)}`,
      params,
    );
    return res.rows.map((row: any) => ({
      id: row.id,
      content: row.content,
      vector: parseVectorLiteral(row.embedding),
      payload: row.payload ?? {},
    }));
  }
}

function buildWhere(
  filters: MemoryFilters | undefined,
  startIdx: number,
): { clause: string; params: unknown[] } {
  if (!filters) return { clause: "", params: [] };
  const conds: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;
  const eq = (key: string, val: unknown) => {
    conds.push(`payload->>'${key}' = $${i++}`);
    params.push(String(val));
  };
  if (filters.namespaceId !== undefined) eq("namespaceId", filters.namespaceId);
  if (filters.userId !== undefined) eq("userId", filters.userId);
  if (filters.agentId !== undefined) eq("agentId", filters.agentId);
  if (filters.runId !== undefined) eq("runId", filters.runId);
  if (filters.memoryType !== undefined) eq("memoryType", filters.memoryType);
  if (filters.recordKind !== undefined) eq("recordKind", filters.recordKind);
  if (filters.documentId !== undefined) eq("documentId", filters.documentId);
  if (filters.sourceKey !== undefined) eq("sourceKey", filters.sourceKey);
  if (filters.metadata) {
    for (const [k, v] of Object.entries(filters.metadata)) {
      conds.push(`payload->'metadata'->>'${k}' = $${i++}`);
      params.push(String(v));
    }
  }
  return {
    clause: conds.length ? `WHERE ${conds.join(" AND ")}` : "",
    params,
  };
}

function rowToHit(row: any): VectorHit {
  return {
    id: row.id,
    score: Number(row.score),
    content: row.content,
    payload: row.payload ?? {},
  };
}

function rowToRecord(row: any): VectorRecord {
  return {
    id: row.id,
    content: row.content,
    vector: parseVectorLiteral(row.embedding),
    payload: row.payload ?? {},
  };
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function parseVectorLiteral(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === "string") {
    return value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .filter((s) => s.length > 0)
      .map(Number);
  }
  return [];
}
