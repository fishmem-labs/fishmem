import type { DocumentChunk, DocumentHead, DocumentSource } from "../types.js";
import type { GraphStore } from "./base.js";
import { ensureSqliteSchemaColumns, SQLITE_DDL } from "./ddl.js";
import { DrizzleGraphStore } from "./drizzle-store.js";
import { sqliteSchema } from "./schema-sqlite.js";

export interface D1GraphStoreConfig {
  /** The D1 binding from `env.MY_DB`. */
  binding: any;
  /**
   * Run CREATE TABLE IF NOT EXISTS on init (default false). For production
   * prefer wrangler migrations; this convenience path is handy for dev.
   */
  autoMigrate?: boolean;
}

/**
 * Build a Cloudflare D1-backed `GraphStore` (Drizzle + drizzle-orm/d1). This is
 * the recommended graph store for Workers; pair it with the Vectorize vector
 * store. D1 has no interactive transactions, so merges run as sequential
 * statements (`DrizzleGraphStore` is written for this).
 *
 * `drizzle-orm/d1` is lazily imported.
 */
export async function createD1GraphStore(
  config: D1GraphStoreConfig,
): Promise<GraphStore> {
  if (!config?.binding) {
    throw new Error("createD1GraphStore requires a D1 binding.");
  }
  let drizzleMod: any;
  try {
    drizzleMod = await import("drizzle-orm/d1");
  } catch {
    throw new Error("drizzle-orm/d1 is required for Cloudflare D1.");
  }
  const db = drizzleMod.drizzle(config.binding, { schema: sqliteSchema });
  const autoMigrate = config.autoMigrate ?? false;

  return new DrizzleGraphStore({
    db,
    tables: sqliteSchema,
    commitDocumentVersion: (source, chunks, head) =>
      commitD1DocumentVersion(config.binding, source, chunks, head),
    deleteMemories: (ids) => deleteD1Memories(config.binding, ids),
    migrate: autoMigrate
      ? async () => {
          for (const stmt of SQLITE_DDL) {
            await config.binding.prepare(stmt).run();
          }
          await ensureSqliteSchemaColumns({
            columns: async (table) => {
              const result = await config.binding
                .prepare(`PRAGMA table_info(${table})`)
                .all();
              return new Set(
                (result.results ?? []).map((row: any) => String(row.name)),
              );
            },
            execute: (sql) => config.binding.prepare(sql).run(),
          });
        }
      : undefined,
  });
}

const D1_CHUNK_JSON_BYTES = 512 * 1_024;

/**
 * Commit one source version with a bounded number of D1 subqueries.
 *
 * D1 limits queries per Worker invocation. A generic Drizzle insert emits one
 * statement per chunk, so a large source can exhaust that budget. D1's batch
 * API is transactional; each JSON payload is expanded by SQLite's `json_each`
 * into chunk rows before the stable head is moved.
 */
async function commitD1DocumentVersion(
  binding: any,
  source: DocumentSource,
  chunks: DocumentChunk[],
  head: DocumentHead,
): Promise<void> {
  const statements = [
    binding
      .prepare(
        `INSERT OR IGNORE INTO fishmem_documents (
          id, namespace_id, source_key, content_hash, version_hash, content,
          title, mime_type, source_uri, user_id, agent_id, run_id, metadata,
          size_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        source.id,
        source.namespaceId,
        source.sourceKey,
        source.contentHash,
        source.versionHash,
        source.content,
        source.title ?? null,
        source.mimeType,
        source.sourceUri ?? null,
        source.userId ?? null,
        source.agentId ?? null,
        source.runId ?? null,
        source.metadata ? JSON.stringify(source.metadata) : null,
        source.sizeBytes,
        source.createdAt.getTime(),
      ),
    ...serializeD1ChunkBatches(chunks).map((payload) =>
      binding
        .prepare(
          `INSERT OR IGNORE INTO fishmem_document_chunks (
            id, namespace_id, document_id, source_key, chunk_index, content,
            start_offset, end_offset, content_hash, user_id, agent_id, run_id,
            created_at
          )
          SELECT
            json_extract(value, '$.id'),
            json_extract(value, '$.namespaceId'),
            json_extract(value, '$.documentId'),
            json_extract(value, '$.sourceKey'),
            json_extract(value, '$.index'),
            json_extract(value, '$.content'),
            json_extract(value, '$.startOffset'),
            json_extract(value, '$.endOffset'),
            json_extract(value, '$.contentHash'),
            json_extract(value, '$.userId'),
            json_extract(value, '$.agentId'),
            json_extract(value, '$.runId'),
            json_extract(value, '$.createdAt')
          FROM json_each(?)`,
        )
        .bind(payload),
    ),
    binding
      .prepare(
        `INSERT INTO fishmem_document_heads (
          id, namespace_id, source_key, document_id, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          document_id = excluded.document_id,
          updated_at = excluded.updated_at
        WHERE fishmem_document_heads.updated_at <= excluded.updated_at`,
      )
      .bind(
        head.id,
        head.namespaceId,
        head.sourceKey,
        head.documentId,
        head.updatedAt.getTime(),
      ),
  ];
  await binding.batch(statements);
}

function serializeD1ChunkBatches(chunks: DocumentChunk[]): string[] {
  const encoder = new TextEncoder();
  const batches: string[] = [];
  let rows: string[] = [];
  let bytes = 2;
  for (const chunk of chunks) {
    const row = JSON.stringify({
      id: chunk.id,
      namespaceId: chunk.namespaceId,
      documentId: chunk.documentId,
      sourceKey: chunk.sourceKey,
      index: chunk.index,
      content: chunk.content,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      contentHash: chunk.contentHash,
      userId: chunk.userId ?? null,
      agentId: chunk.agentId ?? null,
      runId: chunk.runId ?? null,
      createdAt: chunk.createdAt.getTime(),
    });
    const rowBytes = encoder.encode(row).byteLength;
    if (rows.length && bytes + rowBytes + 1 > D1_CHUNK_JSON_BYTES) {
      batches.push(`[${rows.join(",")}]`);
      rows = [];
      bytes = 2;
    }
    rows.push(row);
    bytes += rowBytes + (rows.length > 1 ? 1 : 0);
  }
  if (rows.length) batches.push(`[${rows.join(",")}]`);
  return batches;
}

async function deleteD1Memories(binding: any, ids: string[]): Promise<void> {
  const statements = serializeD1StringBatches(ids).flatMap((payload) => [
    binding
      .prepare(
        `DELETE FROM fishmem_associations
         WHERE source_id IN (SELECT value FROM json_each(?))
            OR target_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(payload, payload),
    binding
      .prepare(
        `DELETE FROM fishmem_history
         WHERE memory_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(payload),
    binding
      .prepare(
        `DELETE FROM fishmem_memory_entities
         WHERE memory_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(payload),
    binding
      .prepare(
        `DELETE FROM fishmem_memories
         WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .bind(payload),
  ]);
  if (statements.length) await binding.batch(statements);
}

function serializeD1StringBatches(values: string[]): string[] {
  const encoder = new TextEncoder();
  const batches: string[] = [];
  let rows: string[] = [];
  let bytes = 2;
  for (const value of new Set(values)) {
    const row = JSON.stringify(value);
    const rowBytes = encoder.encode(row).byteLength;
    if (rows.length && bytes + rowBytes + 1 > D1_CHUNK_JSON_BYTES) {
      batches.push(`[${rows.join(",")}]`);
      rows = [];
      bytes = 2;
    }
    rows.push(row);
    bytes += rowBytes + (rows.length > 1 ? 1 : 0);
  }
  if (rows.length) batches.push(`[${rows.join(",")}]`);
  return batches;
}
