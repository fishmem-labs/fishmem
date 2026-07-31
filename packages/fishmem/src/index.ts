/**
 * fishmem — an open-source, TypeScript memory layer for AI agents.
 *
 * mem0-compatible API, spacebot-style hybrid recall engine: graph memory in a
 * relational `associations` table, embeddings + search/recall in a pluggable
 * vector store, fused with Reciprocal Rank Fusion.
 */

export {
  type EmbedderSpec,
  type GraphStoreSpec,
  type LLMSpec,
  type MemoryConfig,
  type MemoryWarning,
  type MemoryWarningCode,
  type MemoryWarningHandler,
  type ResolvedProviders,
  resolveProviders,
  type VectorStoreSpec,
} from "./config.js";
export {
  type CalibrationCurve,
  type CalibrationTables,
  calibrate,
  fitIsotonic,
  noisyOr,
} from "./core/calibration.js";
export type {
  DocumentOriginalDescriptor,
  DocumentOriginalStore,
} from "./core/document-originals.js";
// Config.
export {
  chunkDocumentText,
  DocumentCorpus,
  type DocumentDeleteResult,
  type DocumentDescriptor,
  type DocumentIngestInput,
  type DocumentIngestOptions,
  type DocumentIngestResult,
  type DocumentScope,
  type DocumentSearchHit,
  type DocumentSearchOptions,
} from "./core/documents.js";
export { matchesMemoryFilter } from "./core/filter.js";
export type {
  MemoryJournalEvent,
  MemoryOperation,
  OperationClaim,
  OperationStatus,
  OperationSummary,
  ProjectionStatus,
} from "./core/journal.js";
export {
  chooseMergePair,
  DEFAULT_MAINTENANCE_CONFIG,
  type MaintenanceConfig,
  MemoryMaintenance,
  mergedContent,
} from "./core/maintenance.js";
export {
  DEFAULT_PROFILE_CONFIG,
  PROFILE_SYNTHESIS_SYSTEM,
  type ProfileConfig,
  ProfileManager,
  type ProfileSection,
} from "./core/profile.js";
export { reciprocalRankFusion, type ScoredMemory } from "./core/rrf.js";
// Engine config + classes.
export {
  classifySearchIntent,
  DEFAULT_SEARCH_CONFIG,
  MemorySearch,
  type SearchConfig,
  type SearchIntent,
  type SearchStrategy,
  type SearchTrace,
} from "./core/search.js";
export {
  InMemoryStateSidecar,
  type StateSidecar,
  type StateSlot,
  type StateUpsert,
} from "./core/sidecar.js";
export {
  createD1StateSidecar,
  createPostgresStateSidecar,
  createSqliteStateSidecar,
  type D1StateSidecarConfig,
  DrizzleStateSidecar,
  type PostgresStateSidecarConfig,
  type SqliteStateSidecarConfig,
} from "./core/sidecar-drizzle.js";
export {
  createNamespaceSnapshot,
  type NamespaceSnapshotV1,
  parseNamespaceSnapshot,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type SnapshotAssociation,
  type SnapshotDocument,
  type SnapshotDocumentChunk,
  type SnapshotDocumentHead,
  type SnapshotEntity,
  type SnapshotEpisode,
  type SnapshotHistoryEntry,
  type SnapshotJournalEvent,
  type SnapshotMemory,
  type SnapshotOperation,
} from "./core/snapshot.js";
export {
  type DateRange,
  extractDateRange,
  parseEventDate,
} from "./core/temporal.js";
export { contentHash, uuid } from "./core/util.js";
// Embedders.
export type { Embedder, EmbeddingOptions } from "./embeddings/base.js";
export { CenteredEmbedder } from "./embeddings/centered.js";
export { MockEmbedder } from "./embeddings/mock.js";
export {
  OpenAIEmbedder,
  type OpenAIEmbedderConfig,
} from "./embeddings/openai.js";
// Graph stores.
export type {
  GraphSnapshotData,
  GraphStore,
  ListOptions,
  ScopeEntityCursor,
  ScopeEntityListOptions,
} from "./graph/base.js";
export { createD1GraphStore, type D1GraphStoreConfig } from "./graph/d1.js";
export {
  ensureSqliteSchemaColumns,
  PG_DDL,
  SQLITE_DDL,
} from "./graph/ddl.js";
export {
  DrizzleGraphStore,
  type DrizzleGraphStoreOptions,
} from "./graph/drizzle-store.js";
export { InMemoryGraphStore } from "./graph/memory-store.js";
export {
  createPostgresGraphStore,
  type PostgresGraphStoreConfig,
} from "./graph/postgres.js";
export { pgSchema } from "./graph/schema-pg.js";
export { sqliteSchema } from "./graph/schema-sqlite.js";
export {
  createSqliteGraphStore,
  type SqliteGraphStoreConfig,
} from "./graph/sqlite.js";
export { AnthropicLLM, type AnthropicLLMConfig } from "./llms/anthropic.js";
// LLMs.
export type {
  LLM,
  LLMChatOptions,
  ProviderCallContext,
  ProviderUsage,
  ProviderUsageHandler,
} from "./llms/base.js";
export { MockLLM, type MockResponder } from "./llms/mock.js";
export { OpenAILLM, type OpenAILLMConfig } from "./llms/openai.js";
// Facade + options.
export {
  type AddOptions,
  type AssociationInput,
  type BeliefChain,
  DELETE_ALL_MAX_TARGETS,
  DeleteAllLimitError,
  type GetAllOptions,
  Memory,
  type MemoryFeedbackInput,
  NamespacedMemory,
  type Scope,
  type SearchOptions,
  type UpdateData,
} from "./memory.js";
// Prompts (exported so users can customise derivation-extraction behaviour).
export {
  buildExtractionMessages,
  FACT_EXTRACTION_SYSTEM,
} from "./prompts/index.js";
// Core domain types. The record interface is exported as `MemoryItem` to avoid
// clashing with the `Memory` facade class (which is also a type).
export {
  type AddInput,
  type AddResult,
  type AddResultItem,
  type Association,
  DEFAULT_IMPORTANCE,
  type DocumentChunk,
  type DocumentFilters,
  type DocumentHead,
  type DocumentSource,
  type Entity,
  type Episode,
  type HistoryEntry,
  MEMORY_TYPES,
  type Memory as MemoryItem,
  type MemoryEvent,
  type MemoryFeedback,
  type MemoryFeedbackRating,
  type MemoryFilterExpression,
  type MemoryFilterField,
  type MemoryFilterOperator,
  type MemoryFilters,
  type MemoryFilterValue,
  type MemorySearchResult,
  type MemoryTier,
  type MemoryType,
  type Message,
  RELATION_TYPE_MULTIPLIER,
  RELATION_TYPES,
  type RelationType,
  type ScopeEntity,
  type ScopeEntityType,
  type SearchMode,
  type SearchSort,
} from "./types.js";
// Vector stores.
export type {
  VectorHit,
  VectorRecord,
  VectorStore,
  VectorStoreCapabilities,
} from "./vector/base.js";
export { deleteVectorRecords, getVectorRecords } from "./vector/base.js";
export {
  cosineSimilarity,
  InMemoryVectorStore,
  matchesFilters,
} from "./vector/memory.js";
export { type PgVectorConfig, PgVectorStore } from "./vector/pgvector.js";
export { type QdrantConfig, QdrantStore } from "./vector/qdrant.js";
export { type SqliteVectorConfig, SqliteVectorStore } from "./vector/sqlite.js";
export {
  type VectorizeBinding,
  type VectorizeConfig,
  VectorizeStore,
} from "./vector/vectorize.js";
