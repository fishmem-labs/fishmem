import {
  MemoryApplication,
  MemoryApplicationError,
} from "@fishmem/application";
import {
  BatchDeleteMemoriesCommandSchema,
  BatchUpdateMemoriesCommandSchema,
} from "@fishmem/contracts";
import {
  type Embedder,
  type LLM,
  Memory,
  type MemoryItem,
  SqliteVectorStore,
  createSqliteGraphStore,
} from "fishmem";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  LocalE5Embedder,
  type LocalEmbeddingState,
} from "./local-embedder";
import type {
  DesktopErrorCode,
  DesktopMemoryPage,
  DesktopMemoryRecord,
  DesktopMethod,
  DesktopSummary,
  DesktopSummaryMemory,
  DesktopStatus,
} from "../shared/protocol";

export interface LocalEmbeddingRuntime extends Embedder {
  readonly model: string;
  readonly state: LocalEmbeddingState;
  prepare(): Promise<void>;
}

export class DesktopMemoryService {
  private application?: MemoryApplication;
  private engine?: Memory;
  private vectorStore?: SqliteVectorStore;
  private localEmbedder?: LocalEmbeddingRuntime;
  private embeddingError?: string;
  private embeddingPreparation?: Promise<void>;
  private rebuildingIndex = false;

  constructor(
    private readonly databasePath: string,
    private readonly modelCachePath: string,
    private readonly socketPath: string,
    private readonly createLocalEmbedder: (
      cachePath: string,
    ) => LocalEmbeddingRuntime = (cachePath) => new LocalE5Embedder(cachePath),
  ) {}

  async initialize() {
    await this.createApplication();
  }

  async close() {
    await this.engine?.close();
    this.application = undefined;
    this.engine = undefined;
    this.vectorStore = undefined;
  }

  status(): DesktopStatus {
    const localState = this.localEmbedder?.state;
    const embeddingState = this.embeddingError
      ? "error"
      : this.rebuildingIndex
        ? "indexing"
        : (localState?.phase ?? "idle");
    return {
      configured: Boolean(this.application),
      embeddingState,
      ...(localState?.phase === "downloading" &&
      localState.progress !== undefined
        ? { embeddingProgress: localState.progress }
        : {}),
      ...(embeddingState === "error"
        ? {
            embeddingError:
              this.embeddingError ??
              (localState?.phase === "error"
                ? localState.message
                : "Local embedding initialization failed"),
          }
        : {}),
      model: this.localEmbedder?.model,
      dimensions: this.localEmbedder?.dimensions,
      databasePath: this.databasePath,
      socketPath: this.socketPath,
    };
  }

  async invoke(method: DesktopMethod, params?: unknown): Promise<unknown> {
    if (method === "status") return this.status();
    if (method === "summary") return this.summary();
    if (method === "retryEmbedding") return this.prepareLocalEmbedding();
    const application = this.requireApplication();
    const input = (params ?? {}) as Record<string, unknown>;
    if (method === "add") {
      this.requireLocalEmbeddingReady();
      return application.add(
        "default",
        {
          content: String(input.content ?? ""),
          user_id: input.user_id,
          agent_id: input.agent_id ?? "fishmem-desktop",
          run_id: input.run_id,
          infer: false,
          metadata: input.metadata,
        },
        typeof input.idempotency_key === "string" &&
          input.idempotency_key.trim()
          ? input.idempotency_key
          : crypto.randomUUID(),
      );
    }
    if (method === "search") {
      this.requireLocalEmbeddingReady();
      const searchInput = {
        query: String(input.query ?? ""),
        top_k: Number(input.top_k ?? input.limit ?? 10),
        user_id: input.user_id,
        agent_id: input.agent_id ?? "fishmem-desktop",
        run_id: input.run_id,
        memory_type: input.memory_type,
        mode: input.mode,
        search_strategy: input.search_strategy,
        sort_by: input.sort_by,
        min_score: input.min_score,
        filters: input.filters,
        trace: input.trace,
      };
      return normalizeSearchResult(
        await application.search("default", searchInput),
      );
    }
    if (method === "batchUpdate") {
      this.requireLocalEmbeddingReady();
      return runLocalMemoryBatch(application, "batch_update", input);
    }
    if (method === "batchDelete") {
      return runLocalMemoryBatch(application, "batch_delete", input);
    }
    if (method === "list") {
      const page = await application.list("default", {
        limit: Number(input.limit ?? 50),
        cursor: typeof input.cursor === "string" ? input.cursor : undefined,
        user_id: input.user_id as string | undefined,
        agent_id: (input.agent_id as string | undefined) ?? "fishmem-desktop",
        run_id: input.run_id as string | undefined,
      });
      return {
        results: page.results.map((memory) => desktopMemory(memory)),
        ...(page.next_cursor ? { nextCursor: page.next_cursor } : {}),
      } satisfies DesktopMemoryPage;
    }
    if (method === "get") {
      return desktopMemory(
        await application.get("default", String(input.id ?? "")),
      );
    }
    if (method === "update") {
      this.requireLocalEmbeddingReady();
      return application.update(
        "default",
        String(input.id ?? ""),
        {
          content: input.content,
          metadata: input.metadata,
          importance: input.importance,
          memory_type: input.memory_type,
          version: input.version,
        },
        typeof input.idempotency_key === "string" &&
          input.idempotency_key.trim()
          ? input.idempotency_key
          : crypto.randomUUID(),
      );
    }
    if (method === "delete") {
      return application.delete(
        "default",
        String(input.id ?? ""),
        typeof input.idempotency_key === "string" &&
          input.idempotency_key.trim()
          ? input.idempotency_key
          : crypto.randomUUID(),
      );
    }
    if (method === "deleteAll") {
      const engine = this.engine;
      if (!engine) throw new Error("FishMem local memory is unavailable");
      return engine.forNamespace("default").deleteAll({
        userId: input.user_id as string | undefined,
        agentId:
          (input.agent_id as string | undefined) ?? "fishmem-desktop",
        runId: input.run_id as string | undefined,
      }, {
        idempotencyKey:
          typeof input.idempotency_key === "string" &&
          input.idempotency_key.trim()
            ? input.idempotency_key
            : undefined,
      });
    }
    if (method === "history") {
      const entries = await application.history(
        "default",
        String(input.id ?? ""),
      );
      return {
        results: entries.map((entry) => ({
          id: entry.id,
          memory_id: entry.memoryId,
          event: entry.event,
          previous_value: entry.previousValue,
          new_value: entry.newValue,
          created_at: entry.createdAt.toISOString(),
        })),
      };
    }
    if (method === "getFeedback") {
      return application.getFeedback("default", String(input.id ?? ""));
    }
    if (method === "setFeedback") {
      return application.setFeedback(
        "default",
        String(input.id ?? ""),
        {
          rating: input.rating,
          reason: input.reason,
          request_id: input.request_id,
        },
        commandIdempotencyKey(input, "feedback"),
      );
    }
    if (method === "clearFeedback") {
      return application.clearFeedback(
        "default",
        String(input.id ?? ""),
        commandIdempotencyKey(input, "feedback-clear"),
      );
    }
    if (method === "entityList") {
      return application.listScopeEntities("default", {
        type: input.type,
        cursor: input.cursor,
        limit: input.limit ?? 50,
      });
    }
    if (method === "entityGet") {
      return application.getScopeEntity(
        "default",
        input.type,
        input.id,
      );
    }
    if (method === "entityDelete") {
      return application.deleteScopeEntity(
        "default",
        input.type,
        input.id,
        requiredCommandIdempotencyKey(input, "entities.delete"),
      );
    }
    if (method === "documentIngest") {
      this.requireLocalEmbeddingReady();
      return application.ingestDocument(
        "default",
        {
          source_key: input.source_key,
          content: input.content,
          title: input.title,
          mime_type: input.mime_type,
          source_uri: input.source_uri,
          metadata: input.metadata,
          ...desktopScope(input),
        },
        commandIdempotencyKey(input, "document"),
      );
    }
    if (method === "documentList") {
      return application.listDocuments("default", {
        source_key: input.source_key,
        cursor: input.cursor,
        limit: input.limit ?? 50,
        ...desktopScope(input),
      });
    }
    if (method === "documentSearch") {
      this.requireLocalEmbeddingReady();
      return application.searchDocuments("default", {
        query: input.query,
        limit: input.limit,
        neighbors: input.neighbors,
        source_key: input.source_key,
        ...desktopScope(input),
      });
    }
    if (method === "documentGet") {
      return application.getDocument("default", String(input.id ?? ""));
    }
    if (method === "documentContent") {
      return application.getDocumentContent(
        "default",
        String(input.id ?? ""),
      );
    }
    if (method === "documentDelete") {
      return application.deleteDocument(
        "default",
        String(input.id ?? ""),
        commandIdempotencyKey(input, "document-delete"),
      );
    }
    throw new Error(`Unsupported desktop method: ${method}`);
  }

  private async summary(): Promise<DesktopSummary> {
    if (!this.engine) {
      throw new Error("FishMem local memory is unavailable");
    }
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const scope = { namespaceId: "default" };
    const recalledScope = {
      ...scope,
      accessed: true,
    } as const;
    const [
      totalMemories,
      rememberedToday,
      recalledToday,
      recentRemembered,
      recentRecalled,
    ] = await Promise.all([
      this.engine.store.countMemories(scope),
      this.engine.store.countMemories({
        ...scope,
        createdAtFrom: startOfToday,
      }),
      this.engine.store.countMemories({
        ...recalledScope,
        lastAccessedAtFrom: startOfToday,
      }),
      this.engine.store.listMemories(scope, {
        sort: "recent",
        limit: 3,
      }),
      this.engine.store.listMemories(recalledScope, {
        sort: "last_accessed",
        limit: 3,
      }),
    ]);
    return {
      totalMemories,
      rememberedToday,
      recalledToday,
      recentRemembered: recentRemembered.map(summaryMemory),
      recentRecalled: recentRecalled.map(summaryMemory),
    };
  }

  private async createApplication() {
    await this.engine?.close();
    this.application = undefined;
    this.embeddingError = undefined;
    this.rebuildingIndex = false;
    await mkdir(dirname(this.databasePath), { recursive: true });
    const url = `file:${this.databasePath}`;
    const embedder = this.createLocalEmbedder(this.modelCachePath);
    this.localEmbedder = embedder;
    const vectorStore = new SqliteVectorStore({
      url,
      indexIdentity: `local:${embedder.model}:q8`,
    });
    const engine = new Memory(
      {
        embedder,
        graphStore: await createSqliteGraphStore({ url }),
        vectorStore,
        llm: DISABLED_LLM,
      },
      {
        derivation: { enabled: false },
      },
    );
    await engine.init();
    this.vectorStore = engine.vectors as SqliteVectorStore;
    this.engine = engine;
    this.application = new MemoryApplication(engine);
    void this.prepareLocalEmbedding().catch((error: unknown) => {
      console.error(
        "FishMem local embedding initialization failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  private async prepareLocalEmbedding(): Promise<DesktopStatus> {
    if (!this.embeddingPreparation) {
      const embedder = this.localEmbedder;
      const vectorStore = this.vectorStore;
      const engine = this.engine;
      if (!embedder || !vectorStore || !engine) {
        throw new DesktopServiceError(
          "LOCAL_EMBEDDING_UNAVAILABLE",
          "FishMem local embedding runtime is unavailable",
        );
      }
      this.embeddingError = undefined;
      const preparation = (async () => {
        await embedder.prepare();
        if (vectorStore.requiresRebuild) {
          this.rebuildingIndex = true;
          try {
            await engine.rebuildProjections({ namespaceId: "default" });
          } finally {
            this.rebuildingIndex = false;
          }
        }
      })();
      this.embeddingPreparation = preparation;
      const clearPreparation = () => {
        if (this.embeddingPreparation === preparation) {
          this.embeddingPreparation = undefined;
        }
      };
      void preparation.then(clearPreparation, clearPreparation);
    }
    try {
      await this.embeddingPreparation;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.embeddingError = message;
      throw new DesktopServiceError(
        "LOCAL_EMBEDDING_UNAVAILABLE",
        `Local embedding initialization failed: ${message}`,
      );
    }
    return this.status();
  }

  private requireLocalEmbeddingReady() {
    const status = this.status();
    if (status.embeddingState === "ready") return;
    if (status.embeddingState === "error") {
      throw new DesktopServiceError(
        "LOCAL_EMBEDDING_UNAVAILABLE",
        `${status.embeddingError ?? "Local embedding is unavailable"}. Retry from Settings or restart FishMem.`,
      );
    }
    throw new DesktopServiceError(
      "LOCAL_EMBEDDING_NOT_READY",
      status.embeddingState === "indexing"
        ? "FishMem is rebuilding the local semantic index. Try again when indexing is complete."
        : "FishMem is downloading the local multilingual embedding model. Try again when the model is ready.",
    );
  }

  private requireApplication() {
    if (!this.application) {
      throw new Error("FishMem local memory is unavailable");
    }
    return this.application;
  }
}

export class DesktopServiceError extends Error {
  constructor(
    readonly code: DesktopErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DesktopServiceError";
  }
}

function summaryMemory(memory: MemoryItem): DesktopSummaryMemory {
  const client = memory.metadata?.fishmemClient;
  return {
    id: memory.id,
    content: memory.content,
    ...(typeof client === "string" && client.trim()
      ? { source: client.trim() }
      : {}),
    createdAt: memory.createdAt.toISOString(),
    lastAccessedAt: memory.lastAccessedAt.toISOString(),
    accessCount: memory.accessCount,
  };
}

function desktopMemory(
  memory: MemoryItem,
  score?: number,
): DesktopMemoryRecord {
  return {
    id: memory.id,
    content: memory.content,
    memoryType: memory.memoryType,
    importance: memory.importance,
    ...(memory.userId ? { userId: memory.userId } : {}),
    ...(memory.agentId ? { agentId: memory.agentId } : {}),
    ...(memory.runId ? { runId: memory.runId } : {}),
    ...(memory.source ? { source: memory.source } : {}),
    ...(memory.metadata ? { metadata: memory.metadata } : {}),
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
    ...(memory.eventDate
      ? { eventDate: memory.eventDate.toISOString() }
      : {}),
    ...(memory.validFrom
      ? { validFrom: memory.validFrom.toISOString() }
      : {}),
    ...(memory.validTo ? { validTo: memory.validTo.toISOString() } : {}),
    ...(memory.subject ? { subject: memory.subject } : {}),
    ...(memory.attribute ? { attribute: memory.attribute } : {}),
    ...(memory.supersededBy
      ? { supersededBy: memory.supersededBy }
      : {}),
    lastAccessedAt: memory.lastAccessedAt.toISOString(),
    accessCount: memory.accessCount,
    ...(score !== undefined ? { score } : {}),
  };
}

const DISABLED_LLM: LLM = {
  async chat() {
    throw new Error(
      "FishMem Desktop does not run an LLM; Codex or Claude Code must provide distilled memory content",
    );
  },
};

function normalizeSearchResult(result: unknown) {
  const value = result as {
    results?: Array<{
      memory?: MemoryItem;
      score?: number;
    }>;
    beliefs?: Array<{
      subject: string;
      attribute: string;
      entries: Array<{
        id: string;
        content: string;
        eventDate?: Date;
        validFrom?: Date;
        validTo?: Date;
        current: boolean;
      }>;
    }>;
    trace?: {
      lists: {
        vector: Array<{ id: string; score: number }>;
        fts: Array<{ id: string; score: number }>;
        graph: Array<{ id: string; score: number }>;
        temporal: Array<{ id: string; score: number }>;
      };
      fused: Array<{ id: string; score: number }>;
      selected: string[];
      selectedItems: Array<{ id: string; content: string }>;
    };
  };
  return {
    results: (value.results ?? []).flatMap((hit) =>
      hit.memory ? [desktopMemory(hit.memory, hit.score)] : [],
    ),
    ...(value.beliefs
      ? {
          beliefs: value.beliefs.map((belief) => ({
            subject: belief.subject,
            attribute: belief.attribute,
            entries: belief.entries.map((entry) => ({
              id: entry.id,
              content: entry.content,
              event_date: entry.eventDate?.toISOString() ?? null,
              valid_from: entry.validFrom?.toISOString() ?? null,
              valid_to: entry.validTo?.toISOString() ?? null,
              current: entry.current,
            })),
          })),
        }
      : {}),
    ...(value.trace
      ? {
          trace: {
            lists: value.trace.lists,
            fused: value.trace.fused,
            selected: value.trace.selected,
            selected_items: value.trace.selectedItems,
          },
        }
      : {}),
  };
}

function desktopScope(input: Record<string, unknown>) {
  return {
    user_id: input.user_id,
    agent_id: input.agent_id ?? "fishmem-desktop",
    run_id: input.run_id,
  };
}

function commandIdempotencyKey(
  input: Record<string, unknown>,
  prefix: string,
) {
  return typeof input.idempotency_key === "string" &&
    input.idempotency_key.trim()
    ? input.idempotency_key
    : `${prefix}:${crypto.randomUUID()}`;
}

function requiredBatchIdempotencyKey(input: Record<string, unknown>) {
  return requiredCommandIdempotencyKey(input, "Desktop batch mutations");
}

function requiredCommandIdempotencyKey(
  input: Record<string, unknown>,
  operation: string,
) {
  const key =
    typeof input.idempotency_key === "string"
      ? input.idempotency_key.trim()
      : "";
  if (!key || key.length > 200) {
    throw new Error(
      `${operation} requires idempotency_key with 1 to 200 characters`,
    );
  }
  return key;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function runLocalMemoryBatch(
  application: MemoryApplication,
  kind: "batch_update" | "batch_delete",
  input: Record<string, unknown>,
) {
  const idempotencyKey = requiredBatchIdempotencyKey(input);
  const command =
    kind === "batch_update"
      ? BatchUpdateMemoriesCommandSchema.parse(input)
      : BatchDeleteMemoriesCommandSchema.parse(input);
  const identity = await sha256Hex(`${kind}\0${idempotencyKey}`);
  const createdAt = new Date();
  const items: Array<Record<string, unknown>> = [];
  for (const [index, item] of command.memories.entries()) {
    const childKey = `batch:${kind}:${identity}:${index}`;
    try {
      if (kind === "batch_update") {
        const update = item as {
          memory_id: string;
          content?: string;
          metadata?: Record<string, unknown>;
          importance?: number;
          memory_type?: string;
          version?: string;
        };
        await application.update(
          "default",
          update.memory_id,
          {
            content: update.content,
            metadata: update.metadata,
            importance: update.importance,
            memory_type: update.memory_type,
            version: update.version,
          },
          childKey,
        );
        items.push({
          memory_id: update.memory_id,
          status: "succeeded",
          event: "UPDATE",
        });
      } else {
        await application.delete(
          "default",
          item.memory_id,
          childKey,
        );
        items.push({
          memory_id: item.memory_id,
          status: "succeeded",
          event: "DELETE",
        });
      }
    } catch (error) {
      if (!(error instanceof MemoryApplicationError) || error.status >= 500) {
        throw error;
      }
      items.push({
        memory_id: item.memory_id,
        status: "failed",
        error: { code: error.code, message: error.message },
      });
    }
  }
  const succeeded = items.filter((item) => item.status === "succeeded").length;
  const updatedAt = new Date();
  return {
    id: `desktop_batch_${identity.slice(0, 32)}`,
    kind,
    status: "success",
    attempts: 1,
    max_attempts: 1,
    error: null,
    next_attempt_at: null,
    result: {
      total: command.memories.length,
      processed: command.memories.length,
      succeeded,
      failed: items.length - succeeded,
      items,
    },
    created_at: createdAt.toISOString(),
    updated_at: updatedAt.toISOString(),
  };
}
