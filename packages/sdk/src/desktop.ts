import { execFile } from "node:child_process";
import type {
  AddMemoryResult,
  AddMemoriesResult,
  BatchDeleteMemoriesInput,
  BatchUpdateMemoriesInput,
  ClearMemoryFeedbackResponse,
  DeleteScopeEntityResult,
  DeleteMemoriesResult,
  DeleteDocumentResult,
  DeleteMemoryResult,
  Document,
  DocumentContent,
  DocumentPage,
  IngestDocumentInput,
  IngestDocumentResult,
  ListDocumentsInput,
  ListMemoriesInput,
  ListScopeEntitiesInput,
  Memory,
  MemoryFeedbackResponse,
  MemoryBatchResult,
  MemoryHistoryEntry,
  MemoryOperation,
  MemoryPage,
  MemoryScope,
  SearchDocumentsInput,
  SearchDocumentsResult,
  SearchMemoriesInput,
  SearchMemoriesResult,
  ScopeEntity,
  ScopeEntityPage,
  ScopeEntityType,
  SetMemoryFeedbackInput,
  UploadDocumentInput,
  UpdateMemoryInput,
} from "./types.js";
import { documentUploadCommand } from "./document-upload.js";

export type DesktopStatus = {
  configured: boolean;
  embeddingState: "idle" | "downloading" | "indexing" | "ready" | "error";
  embeddingProgress?: number;
  embeddingError?: string;
  model?: string;
  dimensions?: number;
  databasePath: string;
  socketPath: string;
};

export type DesktopAddMemoryInput = MemoryScope & {
  content: string;
  infer?: false;
  metadata?: Record<string, unknown>;
};

export type DesktopRequestOptions = {
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type DesktopIdempotentRequestOptions = DesktopRequestOptions & {
  idempotencyKey: string;
};

export type DesktopCommandResult = {
  stdout: string;
  stderr: string;
};

export type DesktopCommandRunner = (
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number; stdin?: string },
) => Promise<DesktopCommandResult>;

export type FishMemDesktopOptions = {
  command?: string;
  timeoutMs?: number;
  runner?: DesktopCommandRunner;
};

type DesktopMemoryRecord = {
  id: string;
  content: string;
  memoryType: string;
  importance: number;
  userId?: string;
  agentId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  eventDate?: string;
  validFrom?: string;
  validTo?: string;
  subject?: string;
  attribute?: string;
  supersededBy?: string;
  lastAccessedAt: string;
  accessCount: number;
  score?: number;
};

export class FishMemDesktopError extends Error {
  readonly command: string;
  readonly stderr?: string;
  readonly cause?: unknown;

  constructor(options: {
    command: string;
    message: string;
    stderr?: string;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = "FishMemDesktopError";
    this.command = options.command;
    this.stderr = options.stderr;
    this.cause = options.cause;
  }
}

export class FishMemDesktop {
  readonly documents: DesktopDocumentsResource;
  readonly entities: DesktopEntitiesResource;
  readonly memories: DesktopMemoriesResource;
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly runner: DesktopCommandRunner;

  constructor(options: FishMemDesktopOptions = {}) {
    this.command = options.command?.trim() || "fishmem";
    // Local source ingestion can embed hundreds of chunks on CPU. Keep one
    // safe default for the CLI subprocess; callers can still choose a tighter
    // timeout for memory-only workloads.
    this.timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive finite number");
    }
    this.runner = options.runner ?? runDesktopCommand;
    this.documents = new DesktopDocumentsResource(this);
    this.entities = new DesktopEntitiesResource(this);
    this.memories = new DesktopMemoriesResource(this);
  }

  status(options: DesktopRequestOptions = {}) {
    return this.call<DesktopStatus>("status", undefined, options);
  }

  async call<T>(
    method: string,
    params?: Record<string, unknown>,
    options: DesktopRequestOptions = {},
  ): Promise<T> {
    const args = ["call", method];
    let stdin: string | undefined;
    if (params !== undefined) {
      args.push("--input-stdin");
      stdin = JSON.stringify(params);
    }
    let result: DesktopCommandResult;
    try {
      result = await this.runner(this.command, args, {
        signal: options.signal,
        timeoutMs: this.timeoutMs,
        stdin,
      });
    } catch (cause) {
      if (cause instanceof FishMemDesktopError) throw cause;
      throw new FishMemDesktopError({
        command: this.command,
        message:
          cause instanceof Error
            ? cause.message
            : "FishMem Desktop command failed",
        cause,
      });
    }
    try {
      return JSON.parse(result.stdout) as T;
    } catch (cause) {
      throw new FishMemDesktopError({
        command: this.command,
        message: "fishmem CLI returned invalid JSON",
        stderr: result.stderr,
        cause,
      });
    }
  }
}

export class DesktopEntitiesResource {
  constructor(private readonly desktop: FishMemDesktop) {}

  list(
    input: ListScopeEntitiesInput = {},
    options: DesktopRequestOptions = {},
  ): Promise<ScopeEntityPage> {
    return this.desktop.call("entityList", input, options);
  }

  async *listAll(
    input: Omit<ListScopeEntitiesInput, "cursor"> = {},
    options: DesktopRequestOptions = {},
  ): AsyncGenerator<ScopeEntity, void, void> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...input, cursor }, options);
      for (const entity of page.results) yield entity;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  get(
    type: ScopeEntityType,
    id: string,
    options: DesktopRequestOptions = {},
  ): Promise<ScopeEntity> {
    return this.desktop.call("entityGet", { type, id }, options);
  }

  delete(
    type: ScopeEntityType,
    id: string,
    options: DesktopIdempotentRequestOptions,
  ): Promise<DeleteScopeEntityResult> {
    return this.desktop.call(
      "entityDelete",
      withRequiredIdempotency(
        { type, id },
        options.idempotencyKey,
        "entities.delete",
      ),
      options,
    );
  }
}

export class DesktopDocumentsResource {
  constructor(private readonly desktop: FishMemDesktop) {}

  ingest(
    input: IngestDocumentInput,
    options: DesktopRequestOptions = {},
  ): Promise<IngestDocumentResult> {
    return this.desktop.call(
      "documentIngest",
      withIdempotency(input, options.idempotencyKey),
      options,
    );
  }

  async upload(
    input: UploadDocumentInput,
    options: DesktopRequestOptions = {},
  ): Promise<IngestDocumentResult> {
    return this.ingest(await documentUploadCommand(input), options);
  }

  list(
    input: ListDocumentsInput,
    options: DesktopRequestOptions = {},
  ): Promise<DocumentPage> {
    return this.desktop.call("documentList", input, options);
  }

  async *listAll(
    input: Omit<ListDocumentsInput, "cursor">,
    options: DesktopRequestOptions = {},
  ): AsyncGenerator<Document, void, void> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...input, cursor }, options);
      for (const document of page.results) yield document;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  search(
    input: SearchDocumentsInput,
    options: DesktopRequestOptions = {},
  ): Promise<SearchDocumentsResult> {
    return this.desktop.call("documentSearch", input, options);
  }

  get(
    id: string,
    options: DesktopRequestOptions = {},
  ): Promise<Document> {
    return this.desktop.call("documentGet", { id }, options);
  }

  content(
    id: string,
    options: DesktopRequestOptions = {},
  ): Promise<DocumentContent> {
    return this.desktop.call("documentContent", { id }, options);
  }

  delete(
    id: string,
    options: DesktopRequestOptions = {},
  ): Promise<DeleteDocumentResult> {
    return this.desktop.call(
      "documentDelete",
      withIdempotency({ id }, options.idempotencyKey),
      options,
    );
  }
}

export class DesktopMemoriesResource {
  constructor(private readonly desktop: FishMemDesktop) {}

  add(
    input: DesktopAddMemoryInput,
    options: DesktopRequestOptions = {},
  ): Promise<AddMemoriesResult> {
    if ((input as { infer?: boolean }).infer === true) {
      throw new TypeError(
        "FishMem Desktop accepts distilled records only; infer must be false",
      );
    }
    return this.desktop.call(
      "add",
      withIdempotency(input, options.idempotencyKey),
      options,
    );
  }

  async list(
    input: ListMemoriesInput,
    options: DesktopRequestOptions = {},
  ): Promise<MemoryPage> {
    const page = await this.desktop.call<{
      results: DesktopMemoryRecord[];
      nextCursor?: string;
    }>("list", input, options);
    return {
      results: page.results.map(desktopMemoryToWire),
      next_cursor: page.nextCursor ?? null,
    };
  }

  async *listAll(
    input: Omit<ListMemoriesInput, "cursor">,
    options: DesktopRequestOptions = {},
  ): AsyncGenerator<Memory, void, void> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...input, cursor }, options);
      for (const memory of page.results) yield memory;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  async search(
    input: SearchMemoriesInput,
    options: DesktopRequestOptions = {},
  ): Promise<SearchMemoriesResult> {
    const result = await this.desktop.call<{
      results: DesktopMemoryRecord[];
      beliefs?: SearchMemoriesResult["beliefs"];
      trace?: SearchMemoriesResult["trace"];
    }>("search", input, options);
    return {
      ...result,
      results: result.results.map(desktopMemoryToWire),
    };
  }

  batchUpdate(
    input: BatchUpdateMemoriesInput,
    options: DesktopIdempotentRequestOptions,
  ): Promise<MemoryOperation<MemoryBatchResult>> {
    return this.desktop.call(
      "batchUpdate",
      withRequiredIdempotency(
        input,
        options.idempotencyKey,
        "memories.batchUpdate",
      ),
      options,
    );
  }

  batchDelete(
    input: BatchDeleteMemoriesInput,
    options: DesktopIdempotentRequestOptions,
  ): Promise<MemoryOperation<MemoryBatchResult>> {
    return this.desktop.call(
      "batchDelete",
      withRequiredIdempotency(
        input,
        options.idempotencyKey,
        "memories.batchDelete",
      ),
      options,
    );
  }

  async get(
    id: string,
    options: DesktopRequestOptions = {},
  ): Promise<Memory> {
    const memory = await this.desktop.call<DesktopMemoryRecord>(
      "get",
      { id },
      options,
    );
    return desktopMemoryToWire(memory);
  }

  update(
    id: string,
    input: UpdateMemoryInput,
    options: DesktopRequestOptions = {},
  ): Promise<AddMemoryResult> {
    return this.desktop.call(
      "update",
      withIdempotency({ id, ...input }, options.idempotencyKey),
      options,
    );
  }

  delete(
    id: string,
    options: DesktopRequestOptions = {},
  ): Promise<DeleteMemoryResult> {
    return this.desktop.call(
      "delete",
      withIdempotency({ id }, options.idempotencyKey),
      options,
    );
  }

  deleteAll(
    scope: MemoryScope,
    options: DesktopRequestOptions = {},
  ): Promise<DeleteMemoriesResult> {
    return this.desktop.call(
      "deleteAll",
      withIdempotency(scope, options.idempotencyKey),
      options,
    );
  }

  history(
    id: string,
    options: DesktopRequestOptions = {},
  ): Promise<{ results: MemoryHistoryEntry[] }> {
    return this.desktop.call("history", { id }, options);
  }

  getFeedback(
    id: string,
    options: DesktopRequestOptions = {},
  ): Promise<MemoryFeedbackResponse> {
    return this.desktop.call("getFeedback", { id }, options);
  }

  setFeedback(
    id: string,
    input: SetMemoryFeedbackInput,
    options: DesktopIdempotentRequestOptions,
  ): Promise<MemoryFeedbackResponse> {
    return this.desktop.call(
      "setFeedback",
      withRequiredIdempotency(
        { id, ...input },
        options.idempotencyKey,
        "memories.setFeedback",
      ),
      options,
    );
  }

  clearFeedback(
    id: string,
    options: DesktopIdempotentRequestOptions,
  ): Promise<ClearMemoryFeedbackResponse> {
    return this.desktop.call(
      "clearFeedback",
      withRequiredIdempotency(
        { id },
        options.idempotencyKey,
        "memories.clearFeedback",
      ),
      options,
    );
  }
}

function withIdempotency<T extends Record<string, unknown>>(
  input: T,
  idempotencyKey?: string,
) {
  return {
    ...input,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  };
}

function withRequiredIdempotency<T extends Record<string, unknown>>(
  input: T,
  idempotencyKey: string,
  operation: string,
) {
  const key = idempotencyKey?.trim();
  if (!key) {
    throw new TypeError(
      `${operation} requires a non-empty idempotencyKey`,
    );
  }
  return { ...input, idempotency_key: key };
}

function desktopMemoryToWire(memory: DesktopMemoryRecord): Memory {
  return {
    id: memory.id,
    memory: memory.content,
    memory_type: memory.memoryType,
    importance: memory.importance,
    user_id: memory.userId ?? null,
    agent_id: memory.agentId ?? null,
    run_id: memory.runId ?? null,
    metadata: memory.metadata ?? null,
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
    event_date: memory.eventDate ?? null,
    valid_from: memory.validFrom ?? null,
    valid_to: memory.validTo ?? null,
    subject: memory.subject ?? null,
    attribute: memory.attribute ?? null,
    superseded_by: memory.supersededBy ?? null,
    access_count: memory.accessCount,
    last_accessed_at: memory.lastAccessedAt,
    ...(memory.score !== undefined ? { score: memory.score } : {}),
  };
}

function runDesktopCommand(
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number; stdin?: string },
): Promise<DesktopCommandResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        signal: options.signal,
        timeout: options.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const cliMessage = parseCliError(stderr);
        reject(
          new FishMemDesktopError({
            command,
            message:
              cliMessage ??
              `fishmem CLI failed with exit code ${error.code ?? "unknown"}`,
            stderr,
            cause: error,
          }),
        );
      },
    );
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    }
  });
}

function parseCliError(stderr: string) {
  try {
    const value = JSON.parse(stderr) as { error?: unknown };
    return typeof value.error === "string" ? value.error : undefined;
  } catch {
    return stderr.trim() || undefined;
  }
}
