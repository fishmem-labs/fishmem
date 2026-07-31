import type { MemoryFilters } from "../types.js";
import type { VectorHit, VectorRecord, VectorStore } from "./base.js";
import { matchesFilters } from "./memory.js";

export interface SqliteVectorConfig {
  /** libSQL url: ":memory:", "file:local.db", or a Turso "libsql://..." url. */
  url?: string;
  authToken?: string;
  /** An existing @libsql/client Client. */
  client?: any;
  tableName?: string;
  /** Stable provider/model identity. A change requires rebuilding embeddings. */
  indexIdentity?: string;
}

/**
 * SQLite/libSQL vector store using libSQL's native F32_BLOB vector type and
 * DiskANN index. Keyword retrieval is backed by an FTS5 projection with
 * explicit CJK n-grams, so Chinese queries do not depend on whitespace.
 */
export class SqliteVectorStore implements VectorStore {
  private readonly tableName: string;
  private readonly indexName: string;
  private readonly ftsTableName: string;
  private readonly indexIdentity?: string;
  private readonly url: string;
  private readonly authToken?: string;
  private client: any;
  private dimensions?: number;
  private requiresRebuild_ = false;

  constructor(config: SqliteVectorConfig = {}) {
    this.tableName = sqlIdentifier(config.tableName ?? "fishmem_vectors");
    this.indexName = `${this.tableName}_embedding_idx`;
    this.ftsTableName = `${this.tableName}_fts`;
    this.indexIdentity = config.indexIdentity?.trim() || undefined;
    this.url = config.url ?? ":memory:";
    this.authToken = config.authToken;
    this.client = config.client;
  }

  get requiresRebuild(): boolean {
    return this.requiresRebuild_;
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    let mod: any;
    try {
      mod = await import("@libsql/client");
    } catch {
      throw new Error(
        "The '@libsql/client' package is required for SqliteVectorStore.",
      );
    }
    this.client = mod.createClient({
      url: this.url,
      authToken: this.authToken,
    });
    return this.client;
  }

  async init(dimensions: number): Promise<void> {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error("SQLite vector dimensions must be a positive integer");
    }
    this.dimensions = dimensions;
    const client = await this.getClient();
    await this.applyIndexIdentity(client, dimensions);
    await this.migrateLegacyTable(client, dimensions);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding F32_BLOB(${dimensions}) NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      )
    `);
    await client.execute(
      `CREATE INDEX IF NOT EXISTS ${this.indexName}
       ON ${this.tableName} (
         libsql_vector_idx(embedding, 'metric=cosine')
       )`,
    );
    const ftsInfo = await client.execute(
      `PRAGMA table_info(${this.ftsTableName})`,
    );
    if (
      ftsInfo.rows.length > 0 &&
      !ftsInfo.rows.some(
        (row: Record<string, unknown>) => row.name === "payload",
      )
    ) {
      await client.execute(`DROP TABLE ${this.ftsTableName}`);
    }
    await client.execute(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${this.ftsTableName}
      USING fts5(id UNINDEXED, content UNINDEXED, payload UNINDEXED, tokens)
    `);
    await this.rebuildTextIndex(client);
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    const client = await this.getClient();
    const dimensions = this.requireDimensions();
    const statements = records.flatMap((record) => {
      if (record.vector.length !== dimensions) {
        throw new Error(
          `Vector dimension mismatch: expected ${dimensions}, got ${record.vector.length}`,
        );
      }
      return [
        {
          sql: `INSERT INTO ${this.tableName} (id, content, embedding, payload)
                VALUES (?, ?, vector32(?), ?)
                ON CONFLICT(id) DO UPDATE SET
                  content = excluded.content,
                  embedding = excluded.embedding,
                  payload = excluded.payload`,
          args: [
            record.id,
            record.content,
            JSON.stringify(record.vector),
            JSON.stringify(record.payload),
          ],
        },
        {
          sql: `DELETE FROM ${this.ftsTableName} WHERE id = ?`,
          args: [record.id],
        },
        {
          sql: `INSERT INTO ${this.ftsTableName} (id, content, payload, tokens)
                VALUES (?, ?, ?, ?)`,
          args: [
            record.id,
            record.content,
            JSON.stringify(record.payload),
            lexicalTokens(record.content).join(" "),
          ],
        },
      ];
    });
    if (statements.length > 0) await client.batch(statements, "write");
  }

  async upsertText(
    records: Array<Pick<VectorRecord, "id" | "content" | "payload">>,
  ): Promise<void> {
    const client = await this.getClient();
    const statements = records.flatMap((record) => [
      {
        sql: `DELETE FROM ${this.ftsTableName} WHERE id = ?`,
        args: [record.id],
      },
      {
        sql: `INSERT INTO ${this.ftsTableName} (id, content, payload, tokens)
              VALUES (?, ?, ?, ?)`,
        args: [
          record.id,
          record.content,
          JSON.stringify(record.payload),
          lexicalTokens(record.content).join(" "),
        ],
      },
    ]);
    if (statements.length > 0) await client.batch(statements, "write");
  }

  async search(
    vector: number[],
    limit: number,
    filters?: MemoryFilters,
  ): Promise<VectorHit[]> {
    if (vector.length !== this.requireDimensions()) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.dimensions}, got ${vector.length}`,
      );
    }
    const safeLimit = positiveLimit(limit);
    const candidateLimit = Math.min(Math.max(safeLimit * 20, 100), 10_000);
    const client = await this.getClient();
    const serialized = JSON.stringify(vector);
    const rs = await client.execute({
      sql: `SELECT v.id, v.content, v.payload,
                   vector_extract(v.embedding) AS embedding,
                   vector_distance_cos(v.embedding, vector32(?)) AS distance
            FROM vector_top_k('${this.indexName}', vector32(?), ${candidateLimit}) AS nearest
            JOIN ${this.tableName} AS v ON v.rowid = nearest.id
            ORDER BY distance ASC`,
      args: [serialized, serialized],
    });
    const hits: VectorHit[] = [];
    for (const row of rs.rows) {
      const payload = decodePayload(row.payload);
      if (!matchesFilters(payload, filters)) continue;
      const distance = Number(row.distance);
      hits.push({
        id: String(row.id),
        score: clamp01(1 - distance / 2),
        content: String(row.content),
        payload,
      });
      if (hits.length >= safeLimit) break;
    }
    return hits;
  }

  async textSearch(
    query: string,
    limit: number,
    filters?: MemoryFilters,
  ): Promise<VectorHit[]> {
    const terms = lexicalQueryTokens(query);
    if (terms.length === 0) return [];
    const client = await this.getClient();
    const safeLimit = positiveLimit(limit);
    const candidateLimit = Math.min(Math.max(safeLimit * 20, 100), 10_000);
    const match = [...new Set(terms)]
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(" OR ");
    const rs = await client.execute({
      sql: `SELECT f.id, f.content, f.payload, bm25(${this.ftsTableName}) AS rank
            FROM ${this.ftsTableName} AS f
            WHERE ${this.ftsTableName} MATCH ?
            ORDER BY rank ASC
            LIMIT ${candidateLimit}`,
      args: [match],
    });
    const hits: VectorHit[] = [];
    for (const row of rs.rows) {
      const payload = decodePayload(row.payload);
      if (!matchesFilters(payload, filters)) continue;
      hits.push({
        id: String(row.id),
        score: 1 / (hits.length + 1),
        content: String(row.content),
        payload,
      });
      if (hits.length >= safeLimit) break;
    }
    return hits;
  }

  async get(id: string): Promise<VectorRecord | null> {
    const client = await this.getClient();
    const rs = await client.execute({
      sql: `SELECT id, content, vector_extract(embedding) AS embedding, payload
            FROM ${this.tableName}
            WHERE id = ?`,
      args: [id],
    });
    const row = rs.rows[0];
    return row ? decodeRow(row) : null;
  }

  async getMany(ids: string[]): Promise<Array<VectorRecord | null>> {
    if (!ids.length) return [];
    const client = await this.getClient();
    const byId = new Map<string, VectorRecord>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      const placeholders = batch.map(() => "?").join(", ");
      const result = await client.execute({
        sql: `SELECT id, content, vector_extract(embedding) AS embedding, payload
              FROM ${this.tableName}
              WHERE id IN (${placeholders})`,
        args: batch,
      });
      for (const row of result.rows) {
        const record = decodeRow(row);
        byId.set(record.id, record);
      }
    }
    return ids.map((id) => byId.get(id) ?? null);
  }

  async delete(id: string): Promise<void> {
    const client = await this.getClient();
    await client.batch(
      [
        {
          sql: `DELETE FROM ${this.ftsTableName} WHERE id = ?`,
          args: [id],
        },
        { sql: `DELETE FROM ${this.tableName} WHERE id = ?`, args: [id] },
      ],
      "write",
    );
  }

  async deleteMany(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const client = await this.getClient();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      const placeholders = batch.map(() => "?").join(", ");
      await client.batch(
        [
          {
            sql: `DELETE FROM ${this.ftsTableName} WHERE id IN (${placeholders})`,
            args: batch,
          },
          {
            sql: `DELETE FROM ${this.tableName} WHERE id IN (${placeholders})`,
            args: batch,
          },
        ],
        "write",
      );
    }
  }

  async deleteByFilter(filters: MemoryFilters): Promise<void> {
    const client = await this.getClient();
    const rows = await this.allRows();
    const ids = rows
      .filter((r) => matchesFilters(r.payload, filters))
      .map((r) => r.id);
    if (ids.length === 0) return;
    await client.batch(
      ids.flatMap((id) => [
        {
          sql: `DELETE FROM ${this.ftsTableName} WHERE id = ?`,
          args: [id],
        },
        { sql: `DELETE FROM ${this.tableName} WHERE id = ?`, args: [id] },
      ]),
      "write",
    );
  }

  async list(filters: MemoryFilters, limit: number): Promise<VectorRecord[]> {
    const rows = await this.allRows();
    const out: VectorRecord[] = [];
    for (const r of rows) {
      if (matchesFilters(r.payload, filters)) out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  private async allRows(): Promise<VectorRecord[]> {
    const client = await this.getClient();
    const rs = await client.execute(
      `SELECT id, content, vector_extract(embedding) AS embedding, payload
       FROM ${this.tableName}`,
    );
    return rs.rows.map(decodeRow);
  }

  private requireDimensions(): number {
    if (!this.dimensions) {
      throw new Error("SQLite vector store must be initialized before use");
    }
    return this.dimensions;
  }

  private async migrateLegacyTable(client: any, dimensions: number) {
    const info = await client.execute(`PRAGMA table_info(${this.tableName})`);
    if (info.rows.length === 0) return;
    const embedding = info.rows.find(
      (row: Record<string, unknown>) => row.name === "embedding",
    );
    const expectedType = `F32_BLOB(${dimensions})`;
    if (String(embedding?.type ?? "").toUpperCase() === expectedType) return;

    const legacy = `${this.tableName}_legacy`;
    const compatible = await this.legacyVectorsMatchDimensions(
      client,
      dimensions,
    );
    await client.batch(
      [
        `DROP TABLE IF EXISTS ${legacy}`,
        `ALTER TABLE ${this.tableName} RENAME TO ${legacy}`,
        `CREATE TABLE ${this.tableName} (
           id TEXT PRIMARY KEY,
           content TEXT NOT NULL,
           embedding F32_BLOB(${dimensions}) NOT NULL,
           payload TEXT NOT NULL DEFAULT '{}'
         )`,
        ...(compatible
          ? [
              `INSERT INTO ${this.tableName} (id, content, embedding, payload)
               SELECT id, content, vector32(embedding), payload FROM ${legacy}`,
            ]
          : []),
        `DROP TABLE ${legacy}`,
      ],
      "write",
    );
    if (!compatible) this.requiresRebuild_ = true;
  }

  private async legacyVectorsMatchDimensions(
    client: any,
    dimensions: number,
  ): Promise<boolean> {
    const sample = await client.execute(
      `SELECT vector_extract(embedding) AS embedding
       FROM ${this.tableName}
       LIMIT 1`,
    );
    if (sample.rows.length === 0) return true;
    try {
      const vector = JSON.parse(String(sample.rows[0]?.embedding ?? "[]"));
      return Array.isArray(vector) && vector.length === dimensions;
    } catch {
      return false;
    }
  }

  private async applyIndexIdentity(client: any, dimensions: number) {
    if (!this.indexIdentity) return;
    await client.execute(`
      CREATE TABLE IF NOT EXISTS fishmem_vector_indexes (
        table_name TEXT PRIMARY KEY,
        identity TEXT NOT NULL,
        dimensions INTEGER NOT NULL
      )
    `);
    const result = await client.execute({
      sql: `SELECT identity, dimensions
            FROM fishmem_vector_indexes
            WHERE table_name = ?`,
      args: [this.tableName],
    });
    const current = result.rows[0];
    if (
      current &&
      (String(current.identity) !== this.indexIdentity ||
        Number(current.dimensions) !== dimensions)
    ) {
      await client.execute(`DROP TABLE IF EXISTS ${this.tableName}`);
      this.requiresRebuild_ = true;
    }
    await client.execute({
      sql: `INSERT INTO fishmem_vector_indexes
              (table_name, identity, dimensions)
            VALUES (?, ?, ?)
            ON CONFLICT(table_name) DO UPDATE SET
              identity = excluded.identity,
              dimensions = excluded.dimensions`,
      args: [this.tableName, this.indexIdentity, dimensions],
    });
  }

  private async rebuildTextIndex(client: any) {
    const count = await client.execute(
      `SELECT COUNT(*) AS total FROM ${this.ftsTableName}`,
    );
    if (Number(count.rows[0]?.total ?? 0) > 0) return;
    const rows = await client.execute(
      `SELECT id, content, payload FROM ${this.tableName}`,
    );
    const statements = rows.rows.map((row: Record<string, unknown>) => ({
      sql: `INSERT INTO ${this.ftsTableName} (id, content, payload, tokens)
            VALUES (?, ?, ?, ?)`,
      args: [
        String(row.id),
        String(row.content),
        String(row.payload ?? "{}"),
        lexicalTokens(String(row.content)).join(" "),
      ],
    }));
    if (statements.length > 0) await client.batch(statements, "write");
  }
}

function decodeRow(row: any): VectorRecord {
  return {
    id: String(row.id),
    content: String(row.content),
    vector: JSON.parse(row.embedding ?? "[]"),
    payload: decodePayload(row.payload),
  };
}

function decodePayload(value: unknown): Record<string, unknown> {
  return JSON.parse(String(value ?? "{}")) as Record<string, unknown>;
}

function lexicalTokens(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens = normalized.match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? [];
  const output = new Set<string>();
  for (const token of tokens) {
    if (!/^\p{Script=Han}+$/u.test(token)) {
      if (token.length > 1) output.add(token);
      continue;
    }
    const chars = [...token];
    for (const char of chars) output.add(char);
    for (let size = 2; size <= 3; size++) {
      for (let index = 0; index + size <= chars.length; index++) {
        output.add(chars.slice(index, index + size).join(""));
      }
    }
  }
  return [...output];
}

function lexicalQueryTokens(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens = normalized.match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? [];
  const output = new Set<string>();
  for (const token of tokens) {
    if (!/^\p{Script=Han}+$/u.test(token)) {
      if (token.length > 1) output.add(token);
      continue;
    }
    const chars = [...token];
    if (chars.length <= 3) {
      output.add(token);
      continue;
    }
    for (let index = 0; index + 3 <= chars.length; index++) {
      output.add(chars.slice(index, index + 3).join(""));
    }
  }
  return [...output];
}

function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQLite identifier: ${value}`);
  }
  return value;
}

function positiveLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Search limit must be a positive integer");
  }
  return value;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
