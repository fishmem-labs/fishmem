import { relations } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("emailVerified", { mode: "boolean" })
      .notNull()
      .default(false),
    image: text("image"),
    // "admin" | "member" — the first user (created via the setup wizard) is the
    // admin; everyone else joins by invite. Open-signup deployments (the Cloud
    // application) supplies its own lib/auth.ts and leaves everyone the default.
    role: text("role").notNull().default("member"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    emailIdx: uniqueIndex("user_email_unique").on(table.email),
  }),
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    tokenIdx: uniqueIndex("session_token_unique").on(table.token),
    userIdx: index("session_user_id_idx").on(table.userId),
  }),
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    accessTokenExpiresAt: integer("accessTokenExpiresAt", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refreshTokenExpiresAt", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    idToken: text("idToken"),
    password: text("password"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    userIdx: index("account_user_id_idx").on(table.userId),
    providerAccountIdx: uniqueIndex("account_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
  }),
);

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }),
});

// Invitations for closed-signup (self-host) deployments. An admin mints an
// invite; the invitee registers via /invite/<token>. Open-signup deployments
// never create rows here.
export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    // Optional: pin the invite to one email address.
    email: text("email"),
    role: text("role").notNull().default("member"),
    invitedBy: text("invited_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    acceptedUserId: text("accepted_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    tokenIdx: uniqueIndex("invites_token_unique").on(table.token),
  }),
);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    kind: text("kind").notNull().default("business"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    documentIdx: uniqueIndex("workspaces_document_id_unique").on(
      table.documentId,
    ),
    ownerKindIdx: index("workspaces_owner_kind_idx").on(
      table.ownerId,
      table.kind,
    ),
  }),
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.documentId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    maskedToken: text("masked_token").notNull(),
    status: text("status").notNull().default("active"),
    permissions: text("permissions", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(["memory:read", "memory:write", "operations:read"]),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    documentIdx: uniqueIndex("api_tokens_document_id_unique").on(
      table.documentId,
    ),
    hashIdx: uniqueIndex("api_tokens_token_hash_unique").on(table.tokenHash),
    workspaceIdx: index("api_tokens_workspace_idx").on(table.workspaceId),
  }),
);

export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.documentId, { onDelete: "cascade" }),
    apiTokenId: text("api_token_id").references(() => apiTokens.documentId, {
      onDelete: "set null",
    }),
    apiTokenName: text("api_token_name"),
    endpoint: text("endpoint").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    operation: text("operation").notNull(),
    status: text("status").notNull(),
    httpStatus: integer("http_status").notNull(),
    latencyMs: integer("latency_ms"),
    credits: integer("credits").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    documentIdx: uniqueIndex("request_logs_document_id_unique").on(
      table.documentId,
    ),
    workspaceCreatedIdx: index("request_logs_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    tokenCreatedIdx: index("request_logs_token_created_idx").on(
      table.apiTokenId,
      table.createdAt,
    ),
    operationCreatedIdx: index("request_logs_operation_created_idx").on(
      table.operation,
      table.createdAt,
    ),
  }),
);

export const projectSettings = sqliteTable(
  "project_settings",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.documentId, { onDelete: "cascade" }),
    instructions: text("instructions").notNull().default(""),
    categories: text("categories", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([
        "User preferences",
        "Profile facts",
        "Long-term context",
        "Agent instructions",
      ]),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    documentIdx: uniqueIndex("project_settings_document_id_unique").on(
      table.documentId,
    ),
    workspaceIdx: uniqueIndex("project_settings_workspace_unique").on(
      table.workspaceId,
    ),
  }),
);

/**
 * Instance-level engine configuration (single row, id="default"). Lets a
 * self-host operator configure the embedder/LLM from the UI instead of env.
 * env stays the first-run default; a row here overrides it. The embedder is
 * always OpenAI-compatible (Ollama/Together/Groq/… via baseURL); the LLM can be
 * openai-compatible or anthropic.
 */
export const engineConfig = sqliteTable("engine_config", {
  id: text("id").primaryKey().default("default"),
  embedderModel: text("embedder_model"),
  embedderBaseUrl: text("embedder_base_url"),
  embedderApiKey: text("embedder_api_key"),
  llmProvider: text("llm_provider").$type<"openai" | "anthropic">(),
  llmModel: text("llm_model"),
  llmBaseUrl: text("llm_base_url"),
  llmApiKey: text("llm_api_key"),
  derivationEnabled: integer("derivation_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

export const webhookEndpoints = sqliteTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    url: text("url").notNull(),
    description: text("description"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    events: text("events", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(["task.completed", "task.failed"]),
    secret: text("secret").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    documentIdx: uniqueIndex("webhook_endpoints_document_id_unique").on(
      table.documentId,
    ),
    workspaceIdx: index("webhook_endpoints_workspace_idx").on(
      table.workspaceId,
    ),
  }),
);

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.documentId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    taskId: text("task_id"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    httpStatus: integer("http_status"),
    error: text("error"),
    payload: text("payload").notNull().default("{}"),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
    lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    documentIdx: uniqueIndex("webhook_deliveries_document_id_unique").on(
      table.documentId,
    ),
    endpointCreatedIdx: index("webhook_deliveries_endpoint_created_idx").on(
      table.endpointId,
      table.createdAt,
    ),
  }),
);

export const operationTasks = sqliteTable(
  "operation_tasks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    operationId: text("operation_id"),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    payload: text("payload", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    result: text("result", { mode: "json" }).$type<unknown>(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    documentIdx: uniqueIndex("operation_tasks_document_id_unique").on(
      table.documentId,
    ),
    workspaceStatusIdx: index("operation_tasks_workspace_status_idx").on(
      table.workspaceId,
      table.status,
      table.nextAttemptAt,
    ),
    workspaceCreatedIdx: index("operation_tasks_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
      table.documentId,
    ),
    operationIdx: uniqueIndex("operation_tasks_workspace_operation_unique").on(
      table.workspaceId,
      table.kind,
      table.operationId,
    ),
  }),
);

/**
 * Immutable binary inputs for asynchronous document extraction.
 *
 * The object bytes live in R2 (Cloudflare) or the configured durable asset
 * directory (Node). This table is the ownership, integrity, and lifecycle
 * fence; an object key alone never grants access to another workspace.
 */
export const sourceAssets = sqliteTable(
  "source_assets",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    operationTaskId: text("operation_task_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceKey: text("source_key").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    expectedChecksumSha256: text("expected_checksum_sha256"),
    checksumSha256: text("checksum_sha256"),
    storageKey: text("storage_key").notNull(),
    status: text("status").notNull().default("awaiting_upload"),
    title: text("title"),
    sourceUri: text("source_uri"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    userId: text("user_id"),
    agentId: text("agent_id"),
    runId: text("run_id"),
    artifactId: text("artifact_id"),
    ingestedDocumentId: text("ingested_document_id"),
    error: text("error"),
    uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    documentIdx: uniqueIndex("source_assets_document_id_unique").on(
      table.documentId,
    ),
    workspaceIdempotencyIdx: uniqueIndex(
      "source_assets_workspace_idempotency_unique",
    ).on(table.workspaceId, table.idempotencyKey),
    workspaceStatusIdx: index("source_assets_workspace_status_idx").on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
    operationTaskIdx: uniqueIndex("source_assets_operation_task_unique").on(
      table.operationTaskId,
    ),
  }),
);

/**
 * Version-pinned, immutable output of one extractor run.
 *
 * Markdown and lossless structure remain object-store artifacts; the final
 * FishMem document id links the artifact to the canonical RAG corpus.
 */
export const extractionArtifacts = sqliteTable(
  "extraction_artifacts",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    sourceAssetId: text("source_asset_id").notNull(),
    extractor: text("extractor").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    contentKey: text("content_key").notNull(),
    structureKey: text("structure_key").notNull(),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    pageCount: integer("page_count").notNull(),
    ingestedDocumentId: text("ingested_document_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    documentIdx: uniqueIndex("extraction_artifacts_document_id_unique").on(
      table.documentId,
    ),
    sourceVersionIdx: uniqueIndex(
      "extraction_artifacts_source_version_unique",
    ).on(table.sourceAssetId, table.extractor, table.extractorVersion),
    workspaceCreatedIdx: index(
      "extraction_artifacts_workspace_created_idx",
    ).on(table.workspaceId, table.createdAt),
  }),
);

export const observabilityEvents = sqliteTable(
  "observability_events",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    requestId: text("request_id"),
    operationId: text("operation_id"),
    kind: text("kind").notNull(),
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMicros: integer("cost_micros"),
    latencyMs: integer("latency_ms"),
    retryCount: integer("retry_count").notNull().default(0),
    warningCode: text("warning_code"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    workspaceCreatedIdx: index("observability_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  }),
);

export const providerPriceSnapshots = sqliteTable(
  "provider_price_snapshots",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    workspaceId: text("workspace_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    kind: text("kind").notNull(),
    inputMicrosPerMillion: integer("input_micros_per_million").notNull(),
    outputMicrosPerMillion: integer("output_micros_per_million").notNull(),
    source: text("source").notNull(),
    effectiveAt: integer("effective_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    documentIdx: uniqueIndex("provider_price_snapshots_document_id_unique").on(
      table.documentId,
    ),
    lookupIdx: index("provider_prices_lookup_idx").on(
      table.workspaceId,
      table.provider,
      table.model,
      table.kind,
      table.effectiveAt,
    ),
  }),
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  workspaces: many(workspaces),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));
