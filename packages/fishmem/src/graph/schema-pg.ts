import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Postgres schema. Column modes are chosen so that the JS-side row shape is
 * identical to the SQLite schema (Date, boolean, object), letting a single
 * generic store implementation serve every dialect.
 */
export const memories = pgTable(
  "fishmem_memories",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    memoryType: text("memory_type").notNull(),
    importance: doublePrecision("importance").notNull().default(0.5),
    hash: text("hash"),
    namespaceId: text("namespace_id"),
    userId: text("user_id"),
    agentId: text("agent_id"),
    runId: text("run_id"),
    source: text("source"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastAccessedAt: timestamp("last_accessed_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    accessCount: integer("access_count").notNull().default(0),
    forgotten: boolean("forgotten").notNull().default(false),
    tier: text("tier").notNull().default("graph"),
    demotedAt: timestamp("demoted_at", { withTimezone: true, mode: "date" }),
    eventDate: timestamp("event_date", { withTimezone: true, mode: "date" }),
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }),
    validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),
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

export const associations = pgTable(
  "fishmem_associations",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    targetId: text("target_id").notNull(),
    relationType: text("relation_type").notNull(),
    weight: doublePrecision("weight").notNull().default(0.5),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
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

export const history = pgTable("fishmem_history", {
  id: text("id").primaryKey(),
  memoryId: text("memory_id").notNull(),
  event: text("event").notNull(),
  previousValue: text("previous_value"),
  newValue: text("new_value"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const memoryOperations = pgTable(
  "fishmem_operations",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    requestHash: text("request_hash").notNull(),
    command: jsonb("command").notNull(),
    memoryIds: jsonb("memory_ids").notNull(),
    episodeId: text("episode_id"),
    status: text("status").notNull(),
    rawStatus: text("raw_status").notNull(),
    vectorStatus: text("vector_status").notNull(),
    derivedStatus: text("derived_status").notNull(),
    result: jsonb("result"),
    error: text("error"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    attempts: integer("attempts").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idempotency: uniqueIndex("fishmem_operation_idempotency_uniq").on(
      t.namespaceId,
      t.idempotencyKey,
    ),
  }),
);

export const memoryEvents = pgTable(
  "fishmem_events",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    operationId: text("operation_id").notNull(),
    memoryId: text("memory_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    namespaceTime: index("fishmem_event_namespace_time_idx").on(
      t.namespaceId,
      t.occurredAt,
    ),
    operation: index("fishmem_event_operation_idx").on(t.operationId),
  }),
);

export const entities = pgTable(
  "fishmem_entities",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    normalized: text("normalized").notNull(),
    namespaceId: text("namespace_id"),
    userId: text("user_id"),
    agentId: text("agent_id"),
    runId: text("run_id"),
    embedding: jsonb("embedding"),
    mentionCount: integer("mention_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
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

export const memoryEntities = pgTable(
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

export const episodes = pgTable("fishmem_episodes", {
  id: text("id").primaryKey(),
  namespaceId: text("namespace_id"),
  userId: text("user_id"),
  agentId: text("agent_id"),
  runId: text("run_id"),
  messages: jsonb("messages").notNull(),
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const documents = pgTable(
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
    metadata: jsonb("metadata"),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
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

export const documentHeads = pgTable(
  "fishmem_document_heads",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    sourceKey: text("source_key").notNull(),
    documentId: text("document_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    source: uniqueIndex("fishmem_document_head_source_uniq").on(
      t.namespaceId,
      t.sourceKey,
    ),
    document: index("fishmem_document_head_document_idx").on(t.documentId),
  }),
);

export const documentChunks = pgTable(
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
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
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

/** Rebuildable belief/state projection, separate from canonical
 * `fishmem_memories`. Postgres mirror of SQLite `state_slots`. */
export const stateSlots = pgTable(
  "fishmem_state_slots",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id"),
    userId: text("user_id"),
    agentId: text("agent_id"),
    runId: text("run_id"),
    subject: text("subject").notNull(),
    attribute: text("attribute").notNull(),
    subjectKey: text("subject_key").notNull(),
    attributeKey: text("attribute_key").notNull(),
    value: text("value").notNull(),
    validFrom: timestamp("valid_from", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),
    supersededBy: text("superseded_by"),
    sources: jsonb("sources").notNull(),
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

export const pgSchema = {
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
