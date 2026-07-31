import type { MemoryWarningHandler } from "../config.js";
import type { Embedder } from "../embeddings/base.js";
import type { GraphStore, ListOptions } from "../graph/base.js";
import type {
  DocumentChunk,
  DocumentFilters,
  DocumentHead,
  DocumentSource,
  MemoryFilters,
} from "../types.js";
import {
  deleteVectorRecords,
  getVectorRecords,
  type VectorHit,
  type VectorStore,
} from "../vector/base.js";
import type { DocumentOriginalStore } from "./document-originals.js";
import type { MemoryOperation } from "./journal.js";
import { contentHash, uuid } from "./util.js";

const OPERATION_LEASE_MS = 5 * 60 * 1_000;
const DEFAULT_CHUNK_CHARS = 1_600;
const DEFAULT_CHUNK_OVERLAP = 200;
const FUSION_K = 60;

export type DocumentDescriptor = Omit<DocumentSource, "content">;

export type DocumentIngestInput = {
  sourceKey: string;
  content: string;
  title?: string;
  mimeType?: string;
  sourceUri?: string;
  metadata?: Record<string, unknown>;
};

export type DocumentScope = {
  namespaceId: string;
  userId?: string;
  agentId?: string;
  runId?: string;
};

export type DocumentIngestOptions = DocumentScope & {
  idempotencyKey: string;
};

export type DocumentSearchOptions = Omit<DocumentScope, "namespaceId"> & {
  limit?: number;
  neighbors?: number;
  sourceKey?: string;
};

export type DocumentSearchHit = {
  document: DocumentDescriptor;
  chunk: DocumentChunk;
  neighbors: DocumentChunk[];
  score: number;
};

export type DocumentIngestResult = {
  document: DocumentDescriptor;
  chunks: number;
  created: boolean;
};

export type DocumentDeleteResult = {
  id: string;
  deleted: true;
  versions: number;
  chunks: number;
};

type StoredDocumentIngestResult = Omit<DocumentIngestResult, "document"> & {
  document: Omit<DocumentDescriptor, "createdAt"> & {
    createdAt: string;
  };
};

type ChunkDraft = Pick<
  DocumentChunk,
  "index" | "content" | "startOffset" | "endOffset" | "contentHash"
>;

/**
 * Long-text/file corpus module. Original UTF-8 source versions are canonical;
 * chunks and vector/FTS rows are deterministic, rebuildable projections.
 */
export class DocumentCorpus {
  constructor(
    private readonly store: GraphStore,
    private readonly vectors: VectorStore,
    private readonly embedder: Embedder,
    private readonly initialize: () => Promise<void>,
    private readonly onWarning?: MemoryWarningHandler,
    private readonly originals?: DocumentOriginalStore,
  ) {}

  async ingest(
    input: DocumentIngestInput,
    options: DocumentIngestOptions,
  ): Promise<DocumentIngestResult> {
    await this.initialize();
    const normalized = normalizeIngest(input, options);
    const idempotencyKey = options.idempotencyKey.trim();
    if (!idempotencyKey) {
      throw new TypeError("document ingest requires an idempotency key");
    }
    const exactHash = await sha256Hex(normalized.content);
    const versionHash = await sha256Hex(
      canonicalJson({
        content_hash: exactHash,
        title: normalized.title,
        mime_type: normalized.mimeType,
        source_uri: normalized.sourceUri,
        user_id: normalized.userId,
        agent_id: normalized.agentId,
        run_id: normalized.runId,
        metadata: normalized.metadata,
      }),
    );
    const sourceId = await deterministicUuid(
      `fishmem-document\0${normalized.namespaceId}\0${normalized.sourceKey}\0${versionHash}`,
    );
    const headId = await deterministicUuid(
      `fishmem-document-head\0${normalized.namespaceId}\0${normalized.sourceKey}`,
    );
    const chunkDrafts = chunkDocumentText(normalized.content);
    const createdAt = new Date();
    const chunks = await Promise.all(
      chunkDrafts.map(async (chunk) => ({
        ...chunk,
        id: await deterministicUuid(
          `fishmem-document-chunk\0${sourceId}\0${chunk.index}\0${chunk.contentHash}`,
        ),
        namespaceId: normalized.namespaceId,
        documentId: sourceId,
        sourceKey: normalized.sourceKey,
        userId: normalized.userId,
        agentId: normalized.agentId,
        runId: normalized.runId,
        createdAt,
      })),
    );
    const source: DocumentSource = {
      id: sourceId,
      namespaceId: normalized.namespaceId,
      sourceKey: normalized.sourceKey,
      contentHash: exactHash,
      versionHash,
      content: normalized.content,
      title: normalized.title,
      mimeType: normalized.mimeType,
      sourceUri: normalized.sourceUri,
      userId: normalized.userId,
      agentId: normalized.agentId,
      runId: normalized.runId,
      metadata: normalized.metadata,
      sizeBytes: new TextEncoder().encode(normalized.content).byteLength,
      createdAt,
    };
    const request = {
      source_id: source.id,
      source_key: source.sourceKey,
      content_hash: source.contentHash,
      version_hash: source.versionHash,
      title: source.title,
      mime_type: source.mimeType,
      source_uri: source.sourceUri,
      user_id: source.userId,
      agent_id: source.agentId,
      run_id: source.runId,
      metadata: source.metadata,
    };
    const requestHash = contentHash(canonicalJson(request));
    const candidate: MemoryOperation = {
      id: uuid(),
      namespaceId: normalized.namespaceId,
      idempotencyKey,
      kind: "document_ingest",
      requestHash,
      command: request,
      memoryIds: [],
      status: "pending",
      rawStatus: "pending",
      vectorStatus: "pending",
      derivedStatus: "not_requested",
      leaseExpiresAt: new Date(createdAt.getTime() + OPERATION_LEASE_MS),
      attempts: 1,
      createdAt,
      updatedAt: createdAt,
    };
    const claim = await this.store.claimOperation(candidate);
    let operation = claim.operation;
    if (operation.requestHash !== requestHash) {
      throw new Error(
        `idempotency key conflict: ${idempotencyKey} was used for a different document command`,
      );
    }
    if (!claim.claimed) {
      if (operation.status === "committed" && operation.result) {
        return restoreDocumentIngestResult(operation.result);
      }
      if (operation.status === "failed") {
        if (
          !(await this.store.retryOperation(
            operation.id,
            candidate.leaseExpiresAt!,
          ))
        ) {
          throw new Error(
            `idempotent operation ${operation.id} is already being repaired`,
          );
        }
      } else {
        throw new Error(
          `idempotent operation ${operation.id} is pending; repair is required before retry`,
        );
      }
    }

    try {
      let created = readBoolean(operation.command.created);
      let previousDocumentId = readString(
        operation.command.previous_document_id,
      );
      if (created === undefined) {
        const current = await this.store.getCurrentDocument(
          normalized.namespaceId,
          normalized.sourceKey,
        );
        created = current?.id !== source.id;
        previousDocumentId = current?.id;
        operation = await this.store.planOperation(
          operation.id,
          {
            ...operation.command,
            created,
            previous_document_id: previousDocumentId,
          },
          [],
        );
      }
      const plannedCreatedAt = operation.createdAt;
      const existingSource = await this.store.getDocument(source.id);
      source.createdAt = existingSource?.createdAt ?? plannedCreatedAt;
      const existingChunks = existingSource
        ? new Map(
            (await this.store.listDocumentChunks(source.id)).map((chunk) => [
              chunk.id,
              chunk,
            ]),
          )
        : new Map<string, DocumentChunk>();
      for (const chunk of chunks) {
        chunk.createdAt =
          existingChunks.get(chunk.id)?.createdAt ?? source.createdAt;
      }
      const head: DocumentHead = {
        id: headId,
        namespaceId: source.namespaceId,
        sourceKey: source.sourceKey,
        documentId: source.id,
        updatedAt: plannedCreatedAt,
      };
      const storedSource = await this.prepareForStorage(source);
      await this.store.commitDocumentVersion(storedSource, chunks, head);
      if (created) {
        await this.projectChunks(source, chunks);
        if (previousDocumentId && previousDocumentId !== source.id) {
          await this.cleanupDocumentVectors(previousDocumentId);
        }
      }
      const result: DocumentIngestResult = {
        document: descriptor(source),
        chunks: chunks.length,
        created,
      };
      await this.store.completeOperation(
        operation.id,
        storeDocumentIngestResult(result),
        {
          raw: "ready",
          vector: "ready",
          derived: "not_requested",
        },
        [],
      );
      return result;
    } catch (error) {
      const stored = await this.store.getDocument(source.id);
      const vectorReady = stored
        ? await this.documentVectorsReady(source.id)
        : false;
      await this.store.failOperation(
        operation.id,
        error instanceof Error ? error.message : String(error),
        {
          raw: stored ? "ready" : "pending",
          vector: vectorReady ? "ready" : "pending",
          derived: "not_requested",
        },
      );
      throw error;
    }
  }

  async get(documentId: string, namespaceId: string) {
    await this.initialize();
    const source = await this.store.getDocument(documentId);
    if (!source || source.namespaceId !== namespaceId) return null;
    return this.hydrateOriginal(source);
  }

  async list(filters: DocumentFilters, options: ListOptions = {}) {
    await this.initialize();
    return (await this.store.listCurrentDocuments(filters, options)).map(
      descriptor,
    );
  }

  async search(
    namespaceId: string,
    query: string,
    options: DocumentSearchOptions = {},
  ): Promise<DocumentSearchHit[]> {
    await this.initialize();
    const normalizedQuery = query.trim();
    if (!normalizedQuery)
      throw new TypeError("document query must not be blank");
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
    const neighborCount = Math.min(Math.max(options.neighbors ?? 1, 0), 2);
    const candidateLimit = Math.min(limit * 8, 100);
    const filters: MemoryFilters = {
      namespaceId,
      recordKind: "document_chunk",
      userId: options.userId,
      agentId: options.agentId,
      runId: options.runId,
      sourceKey: options.sourceKey,
    };
    const lanes: Array<Promise<{ name: "vector" | "fts"; hits: VectorHit[] }>> =
      [
        this.embedder
          .embed(normalizedQuery, {
            context: {
              namespaceId,
              operation: "document.search.embedding",
            },
          })
          .then((vector) =>
            this.vectors.search(vector, candidateLimit, filters),
          )
          .then((hits) => ({ name: "vector" as const, hits })),
      ];
    if (this.vectors.textSearch) {
      lanes.push(
        this.vectors
          .textSearch(normalizedQuery, candidateLimit, filters)
          .then((hits) => ({ name: "fts" as const, hits })),
      );
    }
    const settled = await Promise.allSettled(lanes);
    const successful = settled.flatMap((lane) =>
      lane.status === "fulfilled" ? [lane.value] : [],
    );
    for (const lane of settled) {
      if (lane.status !== "rejected") continue;
      this.warn(
        successful.length
          ? "document_search_lane_failed"
          : "document_search_failed",
        successful.length
          ? "A document retrieval lane failed; returning results from the remaining lane."
          : "All available document retrieval lanes failed.",
        lane.reason,
        { namespaceId, query: normalizedQuery },
      );
    }
    if (!successful.length) {
      throw new Error("document retrieval failed");
    }
    const fused = new Map<string, number>();
    for (const lane of successful) {
      lane.hits.forEach((hit, index) => {
        fused.set(
          hit.id,
          (fused.get(hit.id) ?? 0) + 1 / (FUSION_K + index + 1),
        );
      });
    }
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]);
    const maxScore = ranked[0]?.[1] ?? 1;
    const chunkCache = new Map<string, DocumentChunk[]>();
    const hits: DocumentSearchHit[] = [];
    for (const [chunkId, fusedScore] of ranked) {
      const chunk = await this.store.getDocumentChunk(chunkId);
      if (!chunk || chunk.namespaceId !== namespaceId) continue;
      if (options.userId !== undefined && chunk.userId !== options.userId)
        continue;
      if (options.agentId !== undefined && chunk.agentId !== options.agentId)
        continue;
      if (options.runId !== undefined && chunk.runId !== options.runId)
        continue;
      if (
        options.sourceKey !== undefined &&
        chunk.sourceKey !== options.sourceKey
      )
        continue;
      const source = await this.store.getDocument(chunk.documentId);
      if (!source) continue;
      const current = await this.store.getCurrentDocument(
        namespaceId,
        source.sourceKey,
      );
      if (current?.id !== source.id) continue;
      let allChunks = chunkCache.get(source.id);
      if (!allChunks) {
        allChunks = await this.store.listDocumentChunks(source.id);
        chunkCache.set(source.id, allChunks);
      }
      const neighbors =
        neighborCount === 0
          ? []
          : allChunks.filter(
              (candidate) =>
                candidate.id !== chunk.id &&
                Math.abs(candidate.index - chunk.index) <= neighborCount,
            );
      hits.push({
        document: descriptor(source),
        chunk,
        neighbors,
        score: fusedScore / maxScore,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  async rebuild(documentId: string, namespaceId: string): Promise<number> {
    await this.initialize();
    const source = await this.get(documentId, namespaceId);
    if (!source) throw new Error(`document not found: ${documentId}`);
    const chunks = await this.store.listDocumentChunks(source.id);
    await this.projectChunks(source, chunks);
    return chunks.length;
  }

  async delete(
    documentId: string,
    options: DocumentScope & { idempotencyKey: string },
  ): Promise<DocumentDeleteResult> {
    await this.initialize();
    const idempotencyKey = options.idempotencyKey.trim();
    if (!idempotencyKey) {
      throw new TypeError("document delete requires an idempotency key");
    }
    const now = new Date();
    const requestHash = contentHash(canonicalJson({ documentId }));
    const candidate: MemoryOperation = {
      id: uuid(),
      namespaceId: options.namespaceId,
      idempotencyKey,
      kind: "document_delete",
      requestHash,
      command: { document_id: documentId },
      memoryIds: [],
      status: "pending",
      rawStatus: "pending",
      vectorStatus: "pending",
      derivedStatus: "not_requested",
      leaseExpiresAt: new Date(now.getTime() + OPERATION_LEASE_MS),
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    };
    const claim = await this.store.claimOperation(candidate);
    let operation = claim.operation;
    if (operation.requestHash !== requestHash) {
      throw new Error(
        `idempotency key conflict: ${idempotencyKey} was used for a different document command`,
      );
    }
    if (!claim.claimed) {
      if (operation.status === "committed" && operation.result) {
        return structuredClone(operation.result) as DocumentDeleteResult;
      }
      if (operation.status === "failed") {
        if (
          !(await this.store.retryOperation(
            operation.id,
            candidate.leaseExpiresAt!,
          ))
        ) {
          throw new Error(
            `idempotent operation ${operation.id} is already being repaired`,
          );
        }
      } else {
        throw new Error(
          `idempotent operation ${operation.id} is pending; repair is required before retry`,
        );
      }
    }

    let originalsReady = !this.originals;
    try {
      let chunkIds = readStringArray(operation.command.chunk_ids);
      let documentIds = readStringArray(operation.command.document_ids);
      if (!chunkIds || !documentIds) {
        const source = await this.store.getDocument(documentId);
        if (!source || source.namespaceId !== options.namespaceId) {
          throw new Error(`document not found: ${documentId}`);
        }
        const versions = await this.store.listDocumentVersions(
          options.namespaceId,
          source.sourceKey,
        );
        documentIds = versions.map((version) => version.id);
        chunkIds = (
          await Promise.all(
            versions.map((version) =>
              this.store.listDocumentChunks(version.id),
            ),
          )
        )
          .flat()
          .map((chunk) => chunk.id);
        operation = await this.store.planOperation(
          operation.id,
          {
            ...operation.command,
            document_ids: documentIds,
            chunk_ids: chunkIds,
          },
          [],
        );
      }
      await this.store.purgeDocument(documentId);
      if (this.originals) {
        await this.originals.delete(options.namespaceId, documentIds);
        originalsReady = true;
      }
      await deleteVectorRecords(this.vectors, chunkIds);
      const result: DocumentDeleteResult = {
        id: documentId,
        deleted: true,
        versions: documentIds.length,
        chunks: chunkIds.length,
      };
      await this.store.completeOperation(
        operation.id,
        result,
        {
          raw: "ready",
          vector: "ready",
          derived: "not_requested",
        },
        [],
      );
      return result;
    } catch (error) {
      const source = await this.store.getDocument(documentId);
      const chunkIds = readStringArray(operation.command.chunk_ids) ?? [];
      const vectorReady = await this.vectorIdsAbsent(chunkIds);
      await this.store.failOperation(
        operation.id,
        error instanceof Error ? error.message : String(error),
        {
          raw: !source && originalsReady ? "ready" : "pending",
          vector: vectorReady ? "ready" : "pending",
          derived: "not_requested",
        },
      );
      throw error;
    }
  }

  /**
   * Hydrate exact originals before a namespace snapshot crosses the public
   * interface. Relational stores may contain only descriptors when an object
   * adapter is configured.
   */
  async hydrateForSnapshot(
    sources: DocumentSource[],
  ): Promise<DocumentSource[]> {
    return Promise.all(sources.map((source) => this.hydrateOriginal(source)));
  }

  /**
   * Persist imported originals through the same storage seam used by ingest,
   * returning the relational representation to stage transactionally.
   */
  async prepareSnapshotImport(
    sources: DocumentSource[],
  ): Promise<DocumentSource[]> {
    return Promise.all(sources.map((source) => this.prepareForStorage(source)));
  }

  async deleteNamespaceOriginals(namespaceId: string): Promise<void> {
    await this.originals?.deleteNamespace(namespaceId);
  }

  async clearOriginals(): Promise<void> {
    await this.originals?.clear();
  }

  private async prepareForStorage(
    source: DocumentSource,
  ): Promise<DocumentSource> {
    if (!this.originals) return source;
    await this.originals.put(source);
    return { ...source, content: "" };
  }

  private async hydrateOriginal(
    source: DocumentSource,
  ): Promise<DocumentSource> {
    if (source.content) return source;
    if (!this.originals) {
      throw new Error(`document original missing: ${source.id}`);
    }
    const content = await this.originals.get(descriptor(source));
    const hash = await sha256Hex(content);
    const sizeBytes = utf8Length(content);
    if (hash !== source.contentHash || sizeBytes !== source.sizeBytes) {
      throw new Error(`document original integrity mismatch: ${source.id}`);
    }
    return { ...source, content };
  }

  private async projectChunks(source: DocumentSource, chunks: DocumentChunk[]) {
    for (let offset = 0; offset < chunks.length; offset += 32) {
      const batch = chunks.slice(offset, offset + 32);
      const vectors = await this.embedder.embedBatch(
        batch.map((chunk) => chunk.content),
        {
          context: {
            namespaceId: source.namespaceId,
            operation: "document.embedding",
          },
        },
      );
      if (vectors.length !== batch.length) {
        throw new Error(
          `document embedder returned ${vectors.length} vectors for ${batch.length} chunks`,
        );
      }
      await this.vectors.upsert(
        batch.map((chunk, index) => ({
          id: chunk.id,
          vector: vectors[index]!,
          content: chunk.content,
          payload: {
            namespaceId: chunk.namespaceId,
            recordKind: "document_chunk",
            documentId: chunk.documentId,
            sourceKey: chunk.sourceKey,
            chunkIndex: chunk.index,
            userId: chunk.userId,
            agentId: chunk.agentId,
            runId: chunk.runId,
            metadata: source.metadata ?? {},
          },
        })),
      );
    }
  }

  private async cleanupDocumentVectors(documentId: string) {
    const chunks = await this.store.listDocumentChunks(documentId);
    try {
      await deleteVectorRecords(
        this.vectors,
        chunks.map((chunk) => chunk.id),
      );
    } catch (error) {
      this.warn(
        "document_vector_cleanup_failed",
        "A superseded document version remains in the vector projection but is fenced by the current-source pointer.",
        error,
        { documentId },
      );
    }
  }

  private async documentVectorsReady(documentId: string) {
    const chunks = await this.store.listDocumentChunks(documentId);
    if (!chunks.length) return false;
    const records = await getVectorRecords(
      this.vectors,
      chunks.map((chunk) => chunk.id),
    );
    return records.every(Boolean);
  }

  private async vectorIdsAbsent(ids: string[]) {
    if (!ids.length) return true;
    const records = await getVectorRecords(this.vectors, ids);
    return records.every((record) => record === null);
  }

  private warn(
    code:
      | "document_vector_cleanup_failed"
      | "document_search_lane_failed"
      | "document_search_failed",
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ) {
    this.onWarning?.({
      code,
      message,
      recoverable: code !== "document_search_failed",
      error,
      context,
    });
  }
}

function storeDocumentIngestResult(
  result: DocumentIngestResult,
): StoredDocumentIngestResult {
  return {
    ...structuredClone(result),
    document: {
      ...structuredClone(result.document),
      createdAt: result.document.createdAt.toISOString(),
    },
  };
}

function restoreDocumentIngestResult(result: unknown): DocumentIngestResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("stored document ingest result is invalid");
  }
  const stored = structuredClone(result) as {
    document?: Omit<DocumentDescriptor, "createdAt"> & {
      createdAt?: Date | string;
    };
    chunks?: unknown;
    created?: unknown;
  };
  const rawCreatedAt = stored.document?.createdAt;
  const createdAt =
    rawCreatedAt instanceof Date
      ? rawCreatedAt
      : new Date(typeof rawCreatedAt === "string" ? rawCreatedAt : "");
  if (
    !stored.document ||
    Number.isNaN(createdAt.getTime()) ||
    typeof stored.chunks !== "number" ||
    typeof stored.created !== "boolean"
  ) {
    throw new Error("stored document ingest result is invalid");
  }
  return {
    document: {
      ...(stored.document as Omit<DocumentDescriptor, "createdAt">),
      createdAt,
    },
    chunks: stored.chunks,
    created: stored.created,
  };
}

export function chunkDocumentText(
  content: string,
  options: { maxChars?: number; overlapChars?: number } = {},
): ChunkDraft[] {
  const maxChars = Math.max(200, options.maxChars ?? DEFAULT_CHUNK_CHARS);
  const overlapChars = Math.min(
    Math.max(0, options.overlapChars ?? DEFAULT_CHUNK_OVERLAP),
    Math.floor(maxChars / 2),
  );
  const chunks: ChunkDraft[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(content.length, start + maxChars);
    if (end < content.length) {
      const minimum = start + Math.floor(maxChars * 0.6);
      const window = content.slice(minimum, end);
      const boundaries = [
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf("。"),
      ];
      const boundary = Math.max(...boundaries);
      if (boundary >= 0) {
        end = minimum + boundary + (window[boundary] === "." ? 1 : 0);
      }
    }
    if (end <= start) end = Math.min(content.length, start + maxChars);
    const text = content.slice(start, end);
    if (text.trim()) {
      chunks.push({
        index: chunks.length,
        content: text,
        startOffset: utf8Length(content.slice(0, start)),
        endOffset: utf8Length(content.slice(0, end)),
        contentHash: contentHash(text),
      });
    }
    if (end >= content.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

function normalizeIngest(
  input: DocumentIngestInput,
  scope: DocumentScope,
): DocumentIngestInput & DocumentScope & { mimeType: string } {
  const namespaceId = scope.namespaceId.trim();
  const sourceKey = input.sourceKey.trim();
  const mimeType = (input.mimeType ?? "text/plain")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (!namespaceId) throw new TypeError("document namespace must not be blank");
  if (!sourceKey || sourceKey.length > 512) {
    throw new TypeError("document sourceKey must contain 1 to 512 characters");
  }
  if (!input.content.trim()) {
    throw new TypeError("document content must not be blank");
  }
  if (
    !mimeType.startsWith("text/") &&
    ![
      "application/json",
      "application/ld+json",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
    ].includes(mimeType)
  ) {
    throw new TypeError(`unsupported textual document media type: ${mimeType}`);
  }
  return {
    ...input,
    namespaceId,
    sourceKey,
    mimeType,
    userId: scope.userId?.trim() || undefined,
    agentId: scope.agentId?.trim() || undefined,
    runId: scope.runId?.trim() || undefined,
    title: input.title?.trim() || undefined,
    sourceUri: input.sourceUri?.trim() || undefined,
    metadata: input.metadata ? structuredClone(input.metadata) : undefined,
  };
}

function descriptor(source: DocumentSource): DocumentDescriptor {
  const { content: _content, ...result } = source;
  return structuredClone(result);
}

async function sha256Bytes(value: string) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto SHA-256 is required");
  return new Uint8Array(
    await subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function sha256Hex(value: string) {
  return [...(await sha256Bytes(value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function deterministicUuid(seed: string) {
  const bytes = (await sha256Bytes(seed)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function utf8Length(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}
