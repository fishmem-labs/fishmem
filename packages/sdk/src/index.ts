export type {
  AddMemoryInput,
  AddMemoryResult,
  AddMemoriesResult,
  AsyncMemoryReceipt,
  BatchDeleteMemoriesInput,
  BatchUpdateMemoriesInput,
  BeliefChain,
  BeliefEntry,
  CompleteDocumentUploadResult,
  ClearMemoryFeedbackResponse,
  CreateDocumentUploadInput,
  CreateDocumentUploadResult,
  DeleteMemoriesResult,
  DeleteDocumentResult,
  DeleteMemoryResult,
  DeleteScopeEntityResult,
  Document,
  DocumentChunk,
  DocumentContent,
  DocumentPage,
  DocumentSearchHit,
  HealthStatus,
  IdempotentRequestOptions,
  ImportMemoriesInput,
  IngestDocumentInput,
  IngestDocumentResult,
  ListDocumentsInput,
  ListMemoryEventsInput,
  ListMemoriesInput,
  ListScopeEntitiesInput,
  Memory,
  MemoryFeedback,
  MemoryFeedbackRating,
  MemoryFeedbackResponse,
  MemoryFilterCondition,
  MemoryFilterExpression,
  MemoryFilterField,
  MemoryFilterOperator,
  MemoryFiltersInput,
  MemoryBatchResult,
  MemoryHistoryEntry,
  MemoryEvent,
  MemoryEventPage,
  MemoryEventStatus,
  MemoryWriteSummary,
  MemoryMessage,
  MemoryOperation,
  MemoryPage,
  MemoryScope,
  ProfileQuery,
  ProfileSection,
  RequestOptions,
  SearchDocumentsInput,
  SearchDocumentsResult,
  SearchTrace,
  SearchMemoriesInput,
  SearchMemoriesResult,
  ScopeEntity,
  ScopeEntityPage,
  ScopeEntityType,
  SetMemoryFeedbackInput,
  SourceAsset,
  StateQuery,
  StateSlot,
  UpdateMemoryInput,
  UploadDocumentInput,
  WaitForOperationOptions,
  WaitForEventOptions,
} from "./types.js";

import type {
  AddMemoryInput,
  AddMemoriesResult,
  AsyncMemoryReceipt,
  BatchDeleteMemoriesInput,
  BatchUpdateMemoriesInput,
  CompleteDocumentUploadResult,
  ClearMemoryFeedbackResponse,
  CreateDocumentUploadInput,
  CreateDocumentUploadResult,
  DeleteMemoriesResult,
  DeleteDocumentResult,
  DeleteMemoryResult,
  DeleteScopeEntityResult,
  Document,
  DocumentContent,
  DocumentPage,
  HealthStatus,
  IdempotentRequestOptions,
  ImportMemoriesInput,
  IngestDocumentInput,
  IngestDocumentResult,
  ListDocumentsInput,
  ListMemoryEventsInput,
  ListMemoriesInput,
  ListScopeEntitiesInput,
  Memory,
  MemoryFeedbackResponse,
  MemoryBatchResult,
  MemoryHistoryEntry,
  MemoryEvent,
  MemoryEventPage,
  MemoryOperation,
  MemoryPage,
  MemoryScope,
  ProfileQuery,
  ProfileSection,
  RequestOptions,
  SearchDocumentsInput,
  SearchDocumentsResult,
  SearchMemoriesInput,
  SearchMemoriesResult,
  ScopeEntity,
  ScopeEntityPage,
  ScopeEntityType,
  SetMemoryFeedbackInput,
  SourceAsset,
  StateQuery,
  StateSlot,
  UpdateMemoryInput,
  UploadDocumentInput,
  WaitForOperationOptions,
  WaitForEventOptions,
} from "./types.js";
import { prepareApiDocumentUpload } from "./document-upload.js";

export type FishMemClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
};

export class FishMemError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(options: {
    message: string;
    status: number;
    code?: string;
    requestId?: string;
    details?: unknown;
  }) {
    super(options.message);
    this.name = "FishMemError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

export class FishMemOperationError extends Error {
  readonly operation: MemoryOperation;

  constructor(operation: MemoryOperation) {
    super(
      operation.error ??
        `FishMem operation ${operation.id} ended with status ${operation.status}`,
    );
    this.name = "FishMemOperationError";
    this.operation = operation;
  }
}

export class FishMemOperationTimeoutError extends Error {
  readonly operationId: string;
  readonly timeoutMs: number;

  constructor(operationId: string, timeoutMs: number) {
    super(
      `FishMem operation ${operationId} did not complete within ${timeoutMs}ms`,
    );
    this.name = "FishMemOperationTimeoutError";
    this.operationId = operationId;
    this.timeoutMs = timeoutMs;
  }
}

export class FishMemEventError extends Error {
  readonly event: MemoryEvent;

  constructor(event: MemoryEvent) {
    super(
      event.error ??
        `FishMem event ${event.id} ended with status ${event.status}`,
    );
    this.name = "FishMemEventError";
    this.event = event;
  }
}

export class FishMemEventTimeoutError extends Error {
  readonly eventId: string;
  readonly timeoutMs: number;

  constructor(eventId: string, timeoutMs: number) {
    super(
      `FishMem event ${eventId} did not complete within ${timeoutMs}ms`,
    );
    this.name = "FishMemEventTimeoutError";
    this.eventId = eventId;
    this.timeoutMs = timeoutMs;
  }
}

function requireIdempotencyOptions(
  options: IdempotentRequestOptions,
  operation = "documents.upload",
): IdempotentRequestOptions {
  if (!options?.idempotencyKey?.trim()) {
    throw new TypeError(
      `${operation} requires a non-empty idempotencyKey`,
    );
  }
  return { ...options, idempotencyKey: options.idempotencyKey.trim() };
}

export class FishMem {
  readonly documents: DocumentsResource;
  readonly events: EventsResource;
  readonly entities: EntitiesResource;
  readonly health: HealthResource;
  readonly memories: MemoriesResource;
  readonly operations: OperationsResource;
  readonly state: StateResource;
  readonly profile: ProfileResource;
  readonly exports: ExportsResource;
  readonly imports: ImportsResource;
  private readonly api: FishMemTransport;

  constructor(options: FishMemClientOptions) {
    this.api = new FishMemTransport(options);
    this.documents = new DocumentsResource(this.api);
    this.events = new EventsResource(this.api);
    this.entities = new EntitiesResource(this.api);
    this.health = new HealthResource(this.api);
    this.memories = new MemoriesResource(this.api);
    this.operations = new OperationsResource(this.api);
    this.state = new StateResource(this.api);
    this.profile = new ProfileResource(this.api);
    this.exports = new ExportsResource(this.api);
    this.imports = new ImportsResource(this.api);
  }
}

export class DocumentsResource {
  constructor(private readonly api: FishMemTransport) {}

  ingest(input: IngestDocumentInput, options: RequestOptions = {}) {
    return this.api.request<IngestDocumentResult>("POST", "/v1/documents", {
      body: input,
      ...options,
    });
  }

  createUpload(
    input: CreateDocumentUploadInput,
    options: IdempotentRequestOptions,
  ) {
    const requestOptions = requireIdempotencyOptions(options);
    return this.api.request<CreateDocumentUploadResult>(
      "POST",
      "/v1/document-uploads",
      { body: input, ...requestOptions },
    );
  }

  getUpload(id: string, options: RequestOptions = {}) {
    return this.api.request<SourceAsset>(
      "GET",
      `/v1/document-uploads/${encodeURIComponent(id)}`,
      options,
    );
  }

  deleteUpload(id: string, options: RequestOptions = {}) {
    return this.api.request<void>(
      "DELETE",
      `/v1/document-uploads/${encodeURIComponent(id)}`,
      options,
    );
  }

  completeUpload(id: string, options: RequestOptions = {}) {
    return this.api.request<CompleteDocumentUploadResult>(
      "POST",
      `/v1/document-uploads/${encodeURIComponent(id)}/complete`,
      options,
    );
  }

  async upload(
    input: UploadDocumentInput,
    options: IdempotentRequestOptions,
  ) {
    const requestOptions = requireIdempotencyOptions(options);
    const prepared = await prepareApiDocumentUpload(input);
    const created = await this.createUpload(prepared.command, requestOptions);
    const uploadHeaders = new Headers(created.upload.headers);
    await this.api.request<void>(
      created.upload.method,
      "",
      {
        absoluteUrl: created.upload.url,
        rawBody: prepared.file,
        signal: requestOptions.signal,
        headers: uploadHeaders,
      },
    );
    return this.completeUpload(created.source_asset.id, {
      signal: requestOptions.signal,
      headers: requestOptions.headers,
    });
  }

  list(input: ListDocumentsInput, options: RequestOptions = {}) {
    return this.api.request<DocumentPage>("GET", "/v1/documents", {
      query: input,
      ...options,
    });
  }

  async *listAll(
    input: Omit<ListDocumentsInput, "cursor">,
    options: RequestOptions = {},
  ): AsyncGenerator<Document, void, void> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...input, cursor }, options);
      for (const document of page.results) yield document;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  search(input: SearchDocumentsInput, options: RequestOptions = {}) {
    return this.api.request<SearchDocumentsResult>(
      "POST",
      "/v1/documents/search",
      { body: input, ...options },
    );
  }

  get(id: string, options: RequestOptions = {}) {
    return this.api.request<Document>(
      "GET",
      `/v1/documents/${encodeURIComponent(id)}`,
      options,
    );
  }

  content(id: string, options: RequestOptions = {}) {
    return this.api.request<DocumentContent>(
      "GET",
      `/v1/documents/${encodeURIComponent(id)}/content`,
      options,
    );
  }

  delete(id: string, options: RequestOptions = {}) {
    return this.api.request<DeleteDocumentResult>(
      "DELETE",
      `/v1/documents/${encodeURIComponent(id)}`,
      options,
    );
  }
}

export class HealthResource {
  constructor(private readonly api: FishMemTransport) {}

  get(options: RequestOptions = {}) {
    return this.api.request<HealthStatus>("GET", "/v1/health", options);
  }
}

export class EntitiesResource {
  constructor(private readonly api: FishMemTransport) {}

  list(input: ListScopeEntitiesInput = {}, options: RequestOptions = {}) {
    return this.api.request<ScopeEntityPage>("GET", "/v1/entities", {
      query: input,
      ...options,
    });
  }

  async *listAll(
    input: Omit<ListScopeEntitiesInput, "cursor"> = {},
    options: RequestOptions = {},
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
    options: RequestOptions = {},
  ) {
    return this.api.request<ScopeEntity>(
      "GET",
      `/v1/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
      options,
    );
  }

  delete(
    type: ScopeEntityType,
    id: string,
    options: IdempotentRequestOptions,
  ) {
    const requestOptions = requireIdempotencyOptions(
      options,
      "entities.delete",
    );
    return this.api.request<DeleteScopeEntityResult>(
      "DELETE",
      `/v1/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
      requestOptions,
    );
  }
}

export class MemoriesResource {
  constructor(private readonly api: FishMemTransport) {}

  add(
    input: AddMemoryInput & { infer: false },
    options?: RequestOptions,
  ): Promise<AddMemoriesResult>;
  add(
    input: AddMemoryInput & { infer?: true },
    options: IdempotentRequestOptions,
  ): Promise<AsyncMemoryReceipt>;
  add(
    input: AddMemoryInput,
    options: RequestOptions = {},
  ): Promise<AddMemoriesResult | AsyncMemoryReceipt> {
    const requestOptions =
      input.infer === false
        ? options
        : requireIdempotencyOptions(options as IdempotentRequestOptions, "memories.add");
    return this.api.request<AddMemoriesResult | AsyncMemoryReceipt>(
      "POST",
      "/v1/memories",
      {
      body: input,
        ...requestOptions,
      },
    );
  }

  addAsync(
    input: Omit<AddMemoryInput, "infer"> & { infer?: true },
    options: IdempotentRequestOptions,
  ) {
    return this.add(
      { ...input, infer: true },
      requireIdempotencyOptions(options, "memories.addAsync"),
    );
  }

  async addAndWait(
    input: Omit<AddMemoryInput, "infer"> & { infer?: true },
    options: IdempotentRequestOptions & WaitForEventOptions,
  ): Promise<AddMemoriesResult> {
    const receipt = await this.addAsync(input, options);
    const event = await new EventsResource(this.api).wait(
      receipt.event_id,
      options,
    );
    return { results: event.results };
  }

  list(input: ListMemoriesInput, options: RequestOptions = {}) {
    return this.api.request<MemoryPage>("GET", "/v1/memories", {
      query: input,
      ...options,
    });
  }

  async *listAll(
    input: Omit<ListMemoriesInput, "cursor">,
    options: RequestOptions = {},
  ): AsyncGenerator<Memory, void, void> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...input, cursor }, options);
      for (const memory of page.results) yield memory;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  search(input: SearchMemoriesInput, options: RequestOptions = {}) {
    return this.api.request<SearchMemoriesResult>(
      "POST",
      "/v1/memories/search",
      { body: input, ...options },
    );
  }

  batchUpdate(
    input: BatchUpdateMemoriesInput,
    options: IdempotentRequestOptions,
  ) {
    const requestOptions = requireIdempotencyOptions(
      options,
      "memories.batchUpdate",
    );
    return this.api.request<MemoryOperation<MemoryBatchResult>>(
      "PUT",
      "/v1/memories/batch",
      { body: input, ...requestOptions },
    );
  }

  batchDelete(
    input: BatchDeleteMemoriesInput,
    options: IdempotentRequestOptions,
  ) {
    const requestOptions = requireIdempotencyOptions(
      options,
      "memories.batchDelete",
    );
    return this.api.request<MemoryOperation<MemoryBatchResult>>(
      "DELETE",
      "/v1/memories/batch",
      { body: input, ...requestOptions },
    );
  }

  get(id: string, options: RequestOptions = {}) {
    return this.api.request<Memory>(
      "GET",
      `/v1/memories/${encodeURIComponent(id)}`,
      options,
    );
  }

  update(
    id: string,
    input: UpdateMemoryInput,
    options: RequestOptions = {},
  ) {
    return this.api.request<AddMemoriesResult["results"][number]>(
      "PUT",
      `/v1/memories/${encodeURIComponent(id)}`,
      { body: input, ...options },
    );
  }

  delete(id: string, options: RequestOptions = {}) {
    return this.api.request<DeleteMemoryResult>(
      "DELETE",
      `/v1/memories/${encodeURIComponent(id)}`,
      options,
    );
  }

  deleteAll(scope: MemoryScope, options: RequestOptions = {}) {
    return this.api.request<DeleteMemoriesResult>("DELETE", "/v1/memories", {
      query: scope,
      ...options,
    });
  }

  history(id: string, options: RequestOptions = {}) {
    return this.api.request<{ results: MemoryHistoryEntry[] }>(
      "GET",
      `/v1/memories/${encodeURIComponent(id)}/history`,
      options,
    );
  }

  getFeedback(id: string, options: RequestOptions = {}) {
    return this.api.request<MemoryFeedbackResponse>(
      "GET",
      `/v1/memories/${encodeURIComponent(id)}/feedback`,
      options,
    );
  }

  setFeedback(
    id: string,
    input: SetMemoryFeedbackInput,
    options: IdempotentRequestOptions,
  ) {
    const requestOptions = requireIdempotencyOptions(
      options,
      "memories.setFeedback",
    );
    return this.api.request<MemoryFeedbackResponse>(
      "POST",
      `/v1/memories/${encodeURIComponent(id)}/feedback`,
      { body: input, ...requestOptions },
    );
  }

  clearFeedback(id: string, options: IdempotentRequestOptions) {
    const requestOptions = requireIdempotencyOptions(
      options,
      "memories.clearFeedback",
    );
    return this.api.request<ClearMemoryFeedbackResponse>(
      "DELETE",
      `/v1/memories/${encodeURIComponent(id)}/feedback`,
      requestOptions,
    );
  }
}

export class EventsResource {
  constructor(private readonly api: FishMemTransport) {}

  list(
    input: ListMemoryEventsInput = {},
    options: RequestOptions = {},
  ) {
    return this.api.request<MemoryEventPage>("GET", "/v1/events", {
      query: input,
      ...options,
    });
  }

  get(id: string, options: RequestOptions = {}) {
    return this.api.request<MemoryEvent>(
      "GET",
      `/v1/events/${encodeURIComponent(id)}`,
      options,
    );
  }

  async wait(
    id: string,
    options: WaitForEventOptions = {},
  ): Promise<MemoryEvent> {
    const intervalMs = options.intervalMs ?? 500;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new TypeError("intervalMs must be a non-negative finite number");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive finite number");
    }
    const startedAt = Date.now();
    while (true) {
      const event = await this.get(id, options);
      if (event.status === "SUCCEEDED") return event;
      if (event.status === "FAILED") throw new FishMemEventError(event);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new FishMemEventTimeoutError(id, timeoutMs);
      }
      await waitForDelay(intervalMs, options.signal);
    }
  }
}

export class OperationsResource {
  constructor(private readonly api: FishMemTransport) {}

  list(input: { limit?: number } = {}, options: RequestOptions = {}) {
    return this.api.request<{ results: MemoryOperation[] }>(
      "GET",
      "/v1/operations",
      { query: input, ...options },
    );
  }

  get(id: string, options: RequestOptions = {}) {
    return this.api.request<MemoryOperation>(
      "GET",
      `/v1/operations/${encodeURIComponent(id)}`,
      options,
    );
  }

  retry(id: string, options: RequestOptions = {}) {
    return this.api.request<MemoryOperation>(
      "POST",
      `/v1/operations/${encodeURIComponent(id)}/retry`,
      options,
    );
  }

  async wait(
    id: string,
    options: WaitForOperationOptions = {},
  ): Promise<MemoryOperation> {
    const intervalMs = options.intervalMs ?? 500;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new TypeError("intervalMs must be a non-negative finite number");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive finite number");
    }
    const startedAt = Date.now();
    while (true) {
      const operation = await this.get(id, options);
      if (
        operation.status === "success" ||
        operation.status === "committed"
      ) {
        return operation;
      }
      if (operation.status === "dead" || operation.status === "failed") {
        throw new FishMemOperationError(operation);
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new FishMemOperationTimeoutError(id, timeoutMs);
      }
      await waitForDelay(intervalMs, options.signal);
    }
  }
}

export class StateResource {
  constructor(private readonly api: FishMemTransport) {}

  get(input: StateQuery, options: RequestOptions = {}) {
    return this.api
      .request<{ data: StateSlot | null }>("GET", "/v1/state", {
        query: input,
        ...options,
      })
      .then((response) => response.data);
  }

  history(
    input: Omit<StateQuery, "as_of">,
    options: RequestOptions = {},
  ) {
    return this.api
      .request<{ data: StateSlot[] }>("GET", "/v1/state/history", {
        query: input,
        ...options,
      })
      .then((response) => response.data);
  }
}

export class ProfileResource {
  constructor(private readonly api: FishMemTransport) {}

  get(input: ProfileQuery, options: RequestOptions = {}) {
    return this.api
      .request<{ data: string | null | ProfileSection[] }>(
        "GET",
        "/v1/profile",
        { query: input, ...options },
      )
      .then((response) => response.data);
  }
}

export class ExportsResource {
  constructor(private readonly api: FishMemTransport) {}

  create(options: IdempotentRequestOptions) {
    return this.api.request<MemoryOperation>("POST", "/v1/exports", options);
  }
}

export class ImportsResource {
  constructor(private readonly api: FishMemTransport) {}

  create(input: ImportMemoriesInput, options: IdempotentRequestOptions) {
    return this.api.request<MemoryOperation>("POST", "/v1/imports", {
      body: input,
      ...options,
    });
  }
}

type TransportRequest = RequestOptions & {
  absoluteUrl?: string;
  body?: unknown;
  form?: FormData;
  rawBody?: BodyInit;
  query?: Record<string, unknown>;
};

class FishMemTransport {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly headers: Headers;

  constructor(options: FishMemClientOptions) {
    if (!options.apiKey?.trim()) {
      throw new TypeError("FishMem apiKey is required");
    }
    const runtimeFetch = options.fetch ?? globalThis.fetch;
    if (!runtimeFetch) {
      throw new TypeError(
        "This runtime does not provide fetch; pass a standards-compatible fetch implementation",
      );
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? "https://fishmem.com").replace(/\/+$/, "");
    this.fetch = runtimeFetch;
    this.headers = new Headers(options.headers);
  }

  async request<T>(
    method: string,
    path: string,
    options: TransportRequest = {},
  ): Promise<T> {
    const url = options.absoluteUrl
      ? new URL(options.absoluteUrl, `${this.baseUrl}/`)
      : new URL(`${this.baseUrl}${path}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new TypeError("FishMem upload URLs must use HTTP or HTTPS");
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const authenticated =
      !options.absoluteUrl || url.origin === new URL(this.baseUrl).origin;
    const headers = authenticated
      ? new Headers(this.headers)
      : new Headers();
    for (const [key, value] of new Headers(options.headers)) {
      headers.set(key, value);
    }
    if (authenticated) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
      headers.set("Accept", "application/json");
    }
    if (options.idempotencyKey) {
      headers.set("Idempotency-Key", options.idempotencyKey);
    }
    const bodyKinds = [
      options.body !== undefined,
      options.form !== undefined,
      options.rawBody !== undefined,
    ].filter(Boolean).length;
    if (bodyKinds > 1) {
      throw new TypeError(
        "A FishMem request cannot contain multiple body encodings",
      );
    }
    const body =
      options.form ??
      options.rawBody ??
      (options.body === undefined ? undefined : JSON.stringify(options.body));
    if (options.form) {
      headers.delete("Content-Type");
    } else if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const response = await this.fetch(url, {
      method,
      headers,
      body,
      signal: options.signal,
    });
    const payload = await readResponse(response);
    if (!response.ok) {
      const error =
        payload && typeof payload === "object"
          ? ((payload as { error?: unknown }).error ?? payload)
          : undefined;
      const record =
        error && typeof error === "object"
          ? (error as Record<string, unknown>)
          : undefined;
      throw new FishMemError({
        message:
          (typeof record?.message === "string" && record.message) ||
          (typeof payload === "string" && payload) ||
          `FishMem request failed with status ${response.status}`,
        status: response.status,
        ...(typeof record?.code === "string" ? { code: record.code } : {}),
        ...(typeof record?.request_id === "string"
          ? { requestId: record.request_id }
          : {}),
        ...(record?.details !== undefined ? { details: record.details } : {}),
      });
    }
    return payload as T;
  }
}

async function readResponse(response: Response) {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FishMemError({
      message: "FishMem returned invalid JSON",
      status: response.status,
    });
  }
}

function waitForDelay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
