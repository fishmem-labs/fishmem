import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * SQLite schema (shared by better-sqlite3, libSQL/Turso, and Cloudflare D1).
 * Column modes mirror the Postgres schema so the JS-side row shape is identical
 * across all dialects.
 */
export const memories = sqliteTable(
  "fishmem_memories",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    memoryType: text("memory_type").notNull(),
    importance: real("importance").notNull().default(0.5),
    hash: text("hash"),
    namespaceId: text("namespace_id"),
    userId: text("user_id"),
    agentId: text("agent_id"),
    runId: text("run_id"),
    source: text("source"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    lastAccessedAt: integer("last_accessed_at", {
      mode: "timestamp_ms",
    }).notNull(),
    accessCount: integer("access_count").notNull().default(0),
    forgotten: integer("forgotten", { mode: "boolean" })
      .notNull()
      .default(false),
    tier: text("tier").notNull().default("graph"),
    demotedAt: integer("demoted_at", { mode: "timestamp_ms" }),
    eventDate: integer("event_date", { mode: "timestamp_ms" }),
    validFrom: integer("valid_from", { mode: "timestamp_ms" }),
    validTo: integer("valid_to", { mode: "timestamp_ms" }),
    supersededBy: text("superseded_by"),
    subject: text("subject"),
    attribute: text("attribute"),
    episodeId: text("episode_id"),
  },
  (t) => ({
    typeIdx: index("fishmem_mem_type_idx").on(t.memoryType),
    importanceIdx: index("fishmem_mem_importance_idx").on(t.importance),
    scopeIdx: index("fishmem_mem_scope_idx").on(
      t.namespaceId,
      t.userId,
      t.agentId,
      t.runId,
    ),
    eventDateIdx: index("fishmem_mem_event_date_idx").on(t.eventDate),
  }),
);

export const associations = sqliteTable(
  "fishmem_associations",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    targetId: text("target_id").notNull(),
    relationType: text("relation_type").notNull(),
    weight: real("weight").notNull().default(0.5),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("fishmem_assoc_uniq").on(
      t.sourceId,
      t.targetId,
      t.relationType,
    ),
    sourceIdx: index("fishmem_assoc_source_idx").on(t.sourceId),
    targetIdx: index("fishmem_assoc_target_idx").on(t.targetId),
  }),
);

export const history = sqliteTable("fishmem_history", {
  id: text("id").primaryKey(),
  memoryId: text("memory_id").notNull(),
  event: text("event").notNull(),
  previousValue: text("previous_value"),
  newValue: text("new_value"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const memoryOperations = sqliteTable(
  "fishmem_operations",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    requestHash: text("request_hash").notNull(),
    command: text("command", { mode: "json" }).notNull(),
    memoryIds: text("memory_ids", { mode: "json" }).notNull(),
    episodeId: text("episode_id"),
    status: text("status").notNull(),
    rawStatus: text("raw_status").notNull(),
    vectorStatus: text("vector_status").notNull(),
    derivedStatus: text("derived_status").notNull(),
    result: text("result", { mode: "json" }),
    error: text("error"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    attempts: integer("attempts").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    idempotency: uniqueIndex("fishmem_operation_idempotency_uniq").on(
      t.namespaceId,
      t.idempotencyKey,
    ),
  }),
);

export const memoryEvents = sqliteTable(
  "fishmem_events",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    operationId: text("operation_id").notNull(),
    memoryId: text("memory_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    namespaceTime: index("fishmem_event_namespace_time_idx").on(
      t.namespaceId,
      t.occurredAt,
    ),
    operation: index("fishmem_event_operation_idx").on(t.operationId),
  }),
);

export const entities = sqliteTable(
  "fishmem_entities",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    normalized: text("normalized").notNull(),
    namespaceId: text("namespace_id"),
    userId: text("user_id"),
    agentId: text("agent_id"),
    runId: text("run_id"),
    embedding: text("embedding", { mode: "json" }),
    mentionCount: integer("mention_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    normIdx: index("fishmem_ent_norm_idx").on(t.normalized),
    scopeIdx: index("fishmem_ent_scope_idx").on(
      t.namespaceId,
      t.userId,
      t.agentId,
      t.runId,
    ),
  }),
);

export const memoryEntities = sqliteTable(
  "fishmem_memory_entities",
  {
    memoryId: text("memory_id").notNull(),
    entityId: text("entity_id").notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("fishmem_mement_uniq").on(t.memoryId, t.entityId),
    entIdx: index("fishmem_mement_ent_idx").on(t.entityId),
  }),
);

export const episodes = sqliteTable("fishmem_episodes", {
  id: text("id").primaryKey(),
  namespaceId: text("namespace_id"),
  userId: text("user_id"),
  agentId: text("agent_id"),
  runId: text("run_id"),
  messages: text("messages", { mode: "json" }).notNull(),
  source: text("source"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const documents = sqliteTable(
  "fishmem_documents",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    sourceKey: text("source_key").notNull(),
    contentHash: text("content_hash").notNull(),
    versionHash: text("version_hash").notNull(),
    content: text("content").notNull(),
    title: text("title"),
    mimeType: text("mime_type").notNull(),
    sourceUri: text("source_uri"),
    userId: text("user_id"),
    agentId: text("agent_id"),
    runId: text("run_id"),
    metadata: text("metadata", { mode: "json" }),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    sourceVersion: uniqueIndex("fishmem_document_source_version_uniq").on(
      t.namespaceId,
      t.sourceKey,
      t.versionHash,
    ),
    scopeIdx: index("fishmem_document_scope_idx").on(
      t.namespaceId,
      t.userId,
      t.agentId,
      t.runId,
      t.createdAt,
    ),
  }),
);

export const documentHeads = sqliteTable(
  "fishmem_document_heads",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    sourceKey: text("source_key").notNull(),
    documentId: text("document_id").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    source: uniqueIndex("fishmem_document_head_source_uniq").on(
      t.namespaceId,
      t.sourceKey,
    ),
    document: index("fishmem_document_head_document_idx").on(t.documentId),
  }),
);

export const documentChunks = sqliteTable(
  "fishmem_document_chunks",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    documentId: text("document_id").notNull(),
    sourceKey: text("source_key").notNull(),
    index: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    contentHash: text("content_hash").notNull(),
    userId: text("user_id"),
    agentId: text("agent_id"),
    runId: text("run_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    documentIndex: uniqueIndex("fishmem_document_chunk_index_uniq").on(
      t.documentId,
      t.index,
    ),
    namespaceIdx: index("fishmem_document_chunk_namespace_idx").on(
      t.namespaceId,
      t.documentId,
    ),
  }),
);

/** Rebuildable belief/state projection, physically separate from canonical
 * `fishmem_memories`. */
export const stateSlots = sqliteTable(
  "fishmem_state_slots",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id"),
    userId: text("user_id"),
    agentId: text("agent_id"),
    runId: text("run_id"),
    subject: text("subject").notNull(),
    attribute: text("attribute").notNull(),
    /** lowercased subject/attribute — the lookup key (dialect-neutral). */
    subjectKey: text("subject_key").notNull(),
    attributeKey: text("attribute_key").notNull(),
    value: text("value").notNull(),
    validFrom: integer("valid_from", { mode: "timestamp_ms" }).notNull(),
    validTo: integer("valid_to", { mode: "timestamp_ms" }),
    supersededBy: text("superseded_by"),
    sources: text("sources", { mode: "json" }).notNull(),
  },
  (t) => ({
    slotKeyIdx: index("fishmem_slot_key_idx").on(
      t.namespaceId,
      t.userId,
      t.agentId,
      t.runId,
      t.subjectKey,
      t.attributeKey,
    ),
  }),
);

export const sqliteSchema = {
  memories,
  associations,
  history,
  memoryOperations,
  memoryEvents,
  entities,
  memoryEntities,
  episodes,
  documents,
  documentHeads,
  documentChunks,
  stateSlots,
};
