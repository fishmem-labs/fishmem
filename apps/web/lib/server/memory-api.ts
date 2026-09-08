/**
 * FishMem public memory API with familiar memory scopes and an explicit
 * FishMem contract.
 *
 * Endpoints (wired under app/v1/memories/*):
 *   POST   /v1/memories            add (messages | string, scope, infer)
 *   GET    /v1/memories            list by scope
 *   DELETE /v1/memories            delete-all by scope
 *   PUT    /v1/memories/batch      durable batch update
 *   DELETE /v1/memories/batch      durable batch delete
 *   POST   /v1/memories/search     semantic/hybrid search
 *   GET    /v1/memories/:id        fetch one
 *   PUT    /v1/memories/:id        update content/metadata
 *   DELETE /v1/memories/:id        delete one
 *   GET    /v1/memories/:id/history change log
 *   GET/POST/DELETE /v1/memories/:id/feedback quality signal
 *   GET    /v1/beliefs             governed inferred-belief shadow view
 *
 * Tenancy: every request binds `Memory.forNamespace(workspace.documentId)`.
 * Namespace is a first-class field across raw, vector, graph, and derived
 * stores; user_id / agent_id / run_id remain subject-level filters inside it.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  chunkDocumentText,
  DeleteAllLimitError,
  ensureSqliteSchemaColumns,
  Memory,
  type BeliefViewResult,
  type OperationSummary,
  parseNamespaceSnapshot,
  SQLITE_DDL,
} from "fishmem";
import {
  AddMemoryCommandSchema,
  BatchDeleteMemoriesCommandSchema,
  BatchUpdateMemoriesCommandSchema,
  ListDocumentQuerySchema,
  MAX_DOCUMENT_UPLOAD_BYTES,
  SearchDocumentCommandSchema,
  type AddMemoryCommand,
  type SourceAssetWire,
  type IngestDocumentCommand,
} from "@fishmem/contracts";
import type { AppDb } from "@/db";
import {
  apiTokens,
  engineConfig,
  observabilityEvents,
  operationTasks,
  projectSettings,
  requestLogs,
} from "@/db/schema";
import { hashToken } from "@/lib/server/token";
import { getServerDb } from "@/lib/server/user";
import { getRuntimeEnv } from "@/lib/cloudflare";
import { createMemoryStores, IS_CLOUDFLARE } from "@/lib/platform";
import { R2DocumentOriginalStore } from "@/lib/server/document-originals";
import { parseDocumentIngestRequest } from "@/lib/server/document-ingest-request";
import {
  createDocumentIngestion,
  DocumentIngestionError,
} from "@/lib/server/document-ingestion";
import {
  apiTokenAuthFailure,
  apiPermissionForRequest,
  memoryDerivationConfig,
} from "@/lib/server/runtime-contracts";
import { sanitizePublicSnapshot } from "@/lib/server/public-snapshot";
import {
  enqueueOperationTask,
  enqueueProfileDerivation,
  retryOperationTask,
  type OperationTask,
} from "@/lib/server/operation-tasks";
import {
  enqueueMemoryInferenceTask,
  type MemoryInferenceUsageAuthorization,
} from "@/lib/server/memory-inference-tasks";
import {
  createMemoryInferencePolicySnapshot,
  type MemoryInferencePolicySnapshot,
} from "@/lib/server/memory-inference-policy";
import {
  getMemoryEvent,
  listMemoryEvents,
  shapeMemoryEvent,
} from "@/lib/server/memory-events";
import { dispatchPendingMemoryTasks } from "@/lib/server/memory-task-worker";
import { enqueueWebhookEvent } from "@/lib/server/webhook-outbox";
import {
  recordMemoryWarning,
  recordProviderUsage,
} from "@/lib/server/observability";
import {
  MemoryApplication,
  MemoryApplicationError,
} from "@fishmem/application";

type JsonRecord = Record<string, unknown>;

export type DashboardMemoryStats = {
  totalMemories: number;
  totalEntities: number;
};

export async function queryDashboardMemoryStats(
  db: AppDb,
  namespaceId: string,
): Promise<DashboardMemoryStats> {
  const [row] = await db.all<DashboardMemoryStats>(sql`
    select
      count(*) as "totalMemories",
      count(distinct case
        when user_id is not null and user_id <> '' then user_id
      end)
      + count(distinct case
        when agent_id is not null and agent_id <> '' then agent_id
      end)
      + count(distinct case
        when run_id is not null and run_id <> '' then run_id
      end) as "totalEntities"
    from fishmem_memories
    where namespace_id = ${namespaceId} and forgotten = 0
  `);

  return {
    totalMemories: Number(row?.totalMemories ?? 0),
    totalEntities: Number(row?.totalEntities ?? 0),
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(payload: unknown, init?: ResponseInit) {
  const requestId =
    isRecord(payload) && typeof payload.request_id === "string"
      ? payload.request_id
      : crypto.randomUUID();
  const headers = new Headers(init?.headers);
  headers.set("x-request-id", requestId);
  return Response.json(payload, { ...init, headers });
}

function apiError(status: number, message: string, error: string) {
  const requestId = crypto.randomUUID();
  return json(
    { code: error, message, request_id: requestId },
    { status },
  );
}

export class PublicMemoryApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PublicMemoryApiError";
  }
}

export function readMutationIdempotencyKey(
  request: Request,
  options: { required?: boolean } = {},
) {
  const header = request.headers.get("Idempotency-Key");
  if (header === null) {
    if (options.required) {
      throw new PublicMemoryApiError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "This mutation requires an Idempotency-Key header",
      );
    }
    return undefined;
  }
  const value = header.trim();
  if (!value || value.length > 200) {
    throw new PublicMemoryApiError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must contain 1 to 200 characters",
    );
  }
  return value;
}

function classifyMemoryError(error: unknown) {
  if (error instanceof PublicMemoryApiError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error instanceof DocumentIngestionError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error instanceof MemoryApplicationError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error instanceof DeleteAllLimitError) {
    return { code: error.code, message: error.message, status: 413 };
  }
  if (error instanceof Error && error.name === "ZodError") {
    return { code: "INVALID_REQUEST", message: error.message, status: 400 };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("idempotency key conflict:")) {
    return { code: "IDEMPOTENCY_CONFLICT", message, status: 409 };
  }
  if (message.startsWith("idempotent operation ")) {
    return { code: "IDEMPOTENCY_INCOMPLETE", message, status: 409 };
  }
  if (message === "INVALID_EVENT_CURSOR") {
    return { code: "INVALID_CURSOR", message: "Invalid cursor", status: 400 };
  }
  return { code: "MEMORY_ENGINE_ERROR", message, status: 500 };
}

function memoryErrorResponse(error: unknown) {
  const failure = classifyMemoryError(error);
  return apiError(failure.status, failure.message, failure.code);
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

export async function authenticateMemoryApi(request: Request) {
  const token = bearerToken(request);
  if (!token) {
    return { error: apiError(401, "API key missing", "INVALID_API_KEY") } as const;
  }
  const db = await getServerDb();
  const tokenHash = await hashToken(token);
  const apiToken = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, tokenHash))
    .get();
  if (!apiToken) {
    return { error: apiError(401, "API key invalid", "INVALID_API_KEY") } as const;
  }
  const authFailure = apiTokenAuthFailure(apiToken);
  if (authFailure === "expired") {
    return { error: apiError(401, "API key expired", "API_KEY_EXPIRED") } as const;
  }
  if (authFailure) {
    return { error: apiError(401, "API key invalid", "INVALID_API_KEY") } as const;
  }
  const requiredPermission = apiPermissionForRequest(request);
  if (!apiToken.permissions.includes(requiredPermission)) {
    return {
      error: apiError(
        403,
        `API key lacks ${requiredPermission}`,
        "INSUFFICIENT_PERMISSION",
      ),
    } as const;
  }
  await db
    .update(apiTokens)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(apiTokens.id, apiToken.id));
  return { db, apiToken } as const;
}

// ── engine ───────────────────────────────────────────────────────────────────

let memorySingleton: Promise<Memory> | null = null;
let migrated = false;

async function ensureMemoryTables(d1: D1Database) {
  if (migrated) return;
  for (const statement of SQLITE_DDL) {
    await d1.prepare(statement).run();
  }
  await ensureSqliteSchemaColumns({
    columns: async (table) => {
      const result = await d1.prepare(`PRAGMA table_info(${table})`).all();
      return new Set(
        (result.results ?? []).map((row) => String(row.name)),
      );
    },
    execute: (sql) => d1.prepare(sql).run(),
  });
  migrated = true;
}

/** The DB engine-config row (instance-level, id="default"), or undefined. */
export async function readEngineConfig() {
  const db = await getServerDb();
  return db
    .select()
    .from(engineConfig)
    .where(eq(engineConfig.id, "default"))
    .get();
}

/**
 * Resolve the effective embedder/LLM config: a DB row overrides env, env is the
 * first-run default. The embedder is always OpenAI-compatible (baseURL points
 * at OpenAI / Ollama / Together / …); the LLM may be openai-compatible or
 * anthropic.
 */
/** Provider settings read from env — the deploy-time defaults the DB row
 * overrides. Keys + baseURL + model are all honored, so a docker run with just
 * env can be fully configured (and the dashboard reflects it). */
function providerEnv(env: Awaited<ReturnType<typeof getRuntimeEnv>>) {
  const r = env as unknown as Record<string, string | undefined>;
  return {
    openaiKey: env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    anthropicKey: r.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
    baseUrl: r.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "",
    embModel: r.FISHMEM_EMBEDDER_MODEL ?? process.env.FISHMEM_EMBEDDER_MODEL ?? "",
    llmModel: r.FISHMEM_LLM_MODEL ?? process.env.FISHMEM_LLM_MODEL ?? "",
  };
}

async function resolveEngineConfig() {
  const env = await getRuntimeEnv();
  const db = await getServerDb();
  const onUsage = async (
    usage: Parameters<typeof recordProviderUsage>[1],
  ): Promise<void> => {
    await recordProviderUsage(db, usage);
  };
  const e = providerEnv(env);
  const row = await readEngineConfig();

  const embBase = row?.embedderBaseUrl || e.baseUrl || undefined;
  const embKey = row?.embedderApiKey || e.openaiKey || (embBase ? "-" : "");
  const embedder = {
    provider: "openai" as const,
    config: {
      apiKey: embKey,
      model: row?.embedderModel || e.embModel || "text-embedding-3-small",
      onUsage,
      ...(embBase ? { baseURL: embBase } : {}),
    },
  };

  const llmProvider = (row?.llmProvider as "openai" | "anthropic") || "openai";
  const llmBase =
    row?.llmBaseUrl || (llmProvider === "openai" ? e.baseUrl : "") || undefined;
  const llmKey =
    row?.llmApiKey ||
    (llmProvider === "anthropic" ? e.anthropicKey : e.openaiKey) ||
    (llmBase ? "-" : "");
  const llmModel =
    row?.llmModel ||
    e.llmModel ||
    (llmProvider === "anthropic" ? "claude-3-5-haiku-latest" : "gpt-4o-mini");
  const llm =
    llmProvider === "anthropic"
      ? {
          provider: "anthropic" as const,
          config: { apiKey: llmKey, model: llmModel, onUsage },
        }
      : {
          provider: "openai" as const,
          config: {
            apiKey: llmKey,
            model: llmModel,
            onUsage,
            ...(llmBase ? { baseURL: llmBase } : {}),
          },
        };

  return {
    embedder,
    llm,
    derivationEnabled: row?.derivationEnabled ?? false,
    // "Configured" = a usable embedder (a key, or a no-auth local baseURL).
    configured: Boolean(row?.embedderApiKey || e.openaiKey || embBase),
  };
}

/** Display-safe effective config for the dashboard (no secrets): DB row merged
 * over env, with flags marking which fields are env-derived. */
export async function describeProviderConfig() {
  const env = await getRuntimeEnv();
  const e = providerEnv(env);
  const row = await readEngineConfig();
  const llmProvider = (row?.llmProvider as "openai" | "anthropic") || "openai";
  const embedderBaseUrl = row?.embedderBaseUrl || e.baseUrl || "";
  const llmBaseUrl =
    row?.llmBaseUrl || (llmProvider === "openai" ? e.baseUrl : "") || "";
  return {
    embedderModel: row?.embedderModel || e.embModel || "text-embedding-3-small",
    embedderBaseUrl,
    embedderApiKeySet: Boolean(row?.embedderApiKey),
    embedderBaseUrlFromEnv: !row?.embedderBaseUrl && Boolean(e.baseUrl),
    llmProvider,
    llmModel:
      row?.llmModel ||
      e.llmModel ||
      (llmProvider === "anthropic" ? "claude-3-5-haiku-latest" : "gpt-4o-mini"),
    llmBaseUrl,
    llmApiKeySet: Boolean(row?.llmApiKey),
    llmBaseUrlFromEnv: !row?.llmBaseUrl && llmProvider === "openai" && Boolean(e.baseUrl),
    derivationEnabled: row?.derivationEnabled ?? false,
    envEmbedderKey: Boolean(e.openaiKey),
    envAnthropicKey: Boolean(e.anthropicKey),
    configured: Boolean(row?.embedderApiKey || row?.embedderBaseUrl || e.openaiKey || e.baseUrl),
  };
}

/** Drop the cached engine so the next call rebuilds with fresh DB config. */
export function resetMemoryEngine() {
  memorySingleton = null;
}

/** Build (once per worker) the engine from the resolved config. */
export async function getMemoryEngine(): Promise<Memory> {
  if (!memorySingleton) {
    memorySingleton = (async () => {
      const env = await getRuntimeEnv();
      const cfg = await resolveEngineConfig();
      if (!cfg.configured) {
        throw new Error(
          "Engine not configured — set an embedder provider in Settings → Configuration",
        );
      }
      // Cloudflare runs the D1 DDL up front; the Node SQLite/Postgres stores
      // create their own tables.
      if (IS_CLOUDFLARE) await ensureMemoryTables(env.D1);
      const { graphStore, stateSidecar, beliefReconciler, vectorStore } =
        await createMemoryStores(env);
      const documentOriginalStore = IS_CLOUDFLARE
        ? new R2DocumentOriginalStore(env.R2)
        : undefined;
      return Memory.create({
        graphStore,
        vectorStore,
        embedder: cfg.embedder,
        llm: cfg.llm,
        ...(documentOriginalStore ? { documentOriginalStore } : {}),
        onWarning: (warning) => {
          const namespaceId =
            typeof warning.context?.namespaceId === "string"
              ? warning.context.namespaceId
              : "__system__";
          void getServerDb()
            .then((db) => recordMemoryWarning(db, namespaceId, warning))
            .catch((error) => {
              console.error("Failed to persist FishMem warning", error);
            });
        },
        ...memoryDerivationConfig(
          cfg.derivationEnabled,
          stateSidecar,
          beliefReconciler,
        ),
      });
    })();
    memorySingleton.catch(() => {
      memorySingleton = null; // allow retry after a failed init
    });
  }
  return memorySingleton;
}

// ── tenancy & shaping helpers ────────────────────────────────────────────────

function scopeOf(body: JsonRecord) {
  return {
    userId: typeof body.user_id === "string" ? body.user_id : undefined,
    agentId: typeof body.agent_id === "string" ? body.agent_id : undefined,
    runId: typeof body.run_id === "string" ? body.run_id : undefined,
  };
}

function hasScope(scope: { userId?: string; agentId?: string; runId?: string }) {
  return Boolean(scope.userId || scope.agentId || scope.runId);
}

type MemoryItem = {
  id: string;
  content: string;
  memoryType: string;
  importance: number;
  userId?: string;
  agentId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  eventDate?: Date;
  validFrom?: Date;
  validTo?: Date;
  // Structured-fact (belief-slot) fields — present when extraction set them.
  // Powers the dashboard's per-entity state/timeline view.
  subject?: string;
  attribute?: string;
  supersededBy?: string;
  // Access signal — bumped by recordAccess() on every search hit.
  accessCount?: number;
  lastAccessedAt?: Date;
};

function shapeMemory(m: MemoryItem, score?: number) {
  return {
    id: m.id,
    memory: m.content,
    memory_type: m.memoryType,
    importance: m.importance,
    user_id: m.userId ?? null,
    agent_id: m.agentId ?? null,
    run_id: m.runId ?? null,
    metadata: m.metadata ?? null,
    created_at: m.createdAt.toISOString(),
    updated_at: m.updatedAt.toISOString(),
    event_date: m.eventDate?.toISOString() ?? null,
    valid_from: m.validFrom?.toISOString() ?? null,
    valid_to: m.validTo?.toISOString() ?? null,
    subject: m.subject ?? null,
    attribute: m.attribute ?? null,
    superseded_by: m.supersededBy ?? null,
    access_count: m.accessCount ?? 0,
    last_accessed_at: m.lastAccessedAt?.toISOString() ?? null,
    ...(score !== undefined ? { score } : {}),
  };
}

function shapeBeliefs(
  beliefs: Array<{
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
  }>,
) {
  return beliefs.map((belief) => ({
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
  }));
}

function shapeSearchTrace(trace: {
  lists: {
    vector: Array<{ id: string; score: number }>;
    fts: Array<{ id: string; score: number }>;
    graph: Array<{ id: string; score: number }>;
    temporal: Array<{ id: string; score: number }>;
  };
  fused: Array<{ id: string; score: number }>;
  selected: string[];
  selectedItems: Array<{ id: string; content: string }>;
}) {
  return {
    lists: trace.lists,
    fused: trace.fused,
    selected: trace.selected,
    selected_items: trace.selectedItems,
  };
}

function shapeStateSlot(slot: {
  id: string;
  subject: string;
  attribute: string;
  value: string;
  validFrom: Date;
  validTo?: Date;
  supersededBy?: string;
  sources: string[];
}) {
  return {
    id: slot.id,
    subject: slot.subject,
    attribute: slot.attribute,
    value: slot.value,
    valid_from: slot.validFrom.toISOString(),
    valid_to: slot.validTo?.toISOString() ?? null,
    superseded_by: slot.supersededBy ?? null,
    source_ids: slot.sources,
  };
}

function shapeApplicability(
  applicability: BeliefViewResult["applicability"],
) {
  return {
    kind: applicability.kind,
    ...(applicability.key ? { key: applicability.key } : {}),
    ...(applicability.validFrom
      ? { valid_from: applicability.validFrom.toISOString() }
      : {}),
    ...(applicability.validTo
      ? { valid_to: applicability.validTo.toISOString() }
      : {}),
  };
}

function shapeBeliefCandidate(
  candidate: NonNullable<BeliefViewResult["winner"]>,
) {
  return {
    id: candidate.id,
    subject: candidate.subject,
    attribute: candidate.attribute,
    value: candidate.value,
    applicability: shapeApplicability(candidate.applicability),
    status: candidate.status,
    score: candidate.score,
    support: candidate.support,
    evidence_count: candidate.evidenceCount,
    context_count: candidate.contextCount,
    source_ids: candidate.sourceIds,
    first_observed_at: candidate.firstObservedAt.toISOString(),
    last_observed_at: candidate.lastObservedAt.toISOString(),
    superseded_by: candidate.supersededBy ?? null,
    reason_codes: candidate.reasonCodes,
    ...(candidate.evidence
      ? {
          evidence: candidate.evidence.map((evidence) => ({
            id: evidence.id,
            source_id: evidence.sourceId,
            evidence_key: evidence.evidenceKey,
            context_id: evidence.contextId,
            applicability: shapeApplicability(evidence.applicability),
            observed_at: evidence.observedAt.toISOString(),
            valid_from: evidence.validFrom.toISOString(),
            valid_to: evidence.validTo?.toISOString() ?? null,
            weight: evidence.weight,
            active: evidence.active,
          })),
        }
      : {}),
  };
}

function shapeBeliefView(view: BeliefViewResult) {
  return {
    projection_status: view.projectionStatus,
    mode: view.mode,
    subject: view.subject,
    attribute: view.attribute,
    applicability: shapeApplicability(view.applicability),
    winner: view.winner ? shapeBeliefCandidate(view.winner) : null,
    candidates: view.candidates.map(shapeBeliefCandidate),
    unresolved: view.unresolved,
    reason_codes: view.reasonCodes,
    shadow: {
      outcome: view.shadow.outcome,
      state: view.shadow.state ? shapeStateSlot(view.shadow.state) : null,
      winner_id: view.shadow.winnerId ?? null,
    },
  };
}

export type AuthenticatedMemoryApi = {
  db: Awaited<ReturnType<typeof getServerDb>>;
  apiToken: typeof apiTokens.$inferSelect;
};

function requestDocumentId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function scopeMetadata(scope: {
  userId?: string;
  agentId?: string;
  runId?: string;
}) {
  return {
    ...(scope.userId ? { user_id: scope.userId } : {}),
    ...(scope.agentId ? { agent_id: scope.agentId } : {}),
    ...(scope.runId ? { run_id: scope.runId } : {}),
  };
}

async function recordPublicRequestLog({
  auth,
  credits = 0,
  errorCode,
  errorMessage,
  httpStatus,
  metadata,
  operation,
  request,
  startedAt,
  status,
}: {
  auth: AuthenticatedMemoryApi;
  credits?: number;
  errorCode?: string;
  errorMessage?: string;
  httpStatus: number;
  metadata?: Record<string, unknown>;
  operation: string;
  request: Request;
  startedAt: number;
  status: "success" | "failed";
}) {
  try {
    const url = new URL(request.url);
    const id = requestDocumentId("req");
    await auth.db.insert(requestLogs).values({
      id,
      documentId: id,
      workspaceId: auth.apiToken.workspaceId,
      apiTokenId: auth.apiToken.documentId,
      apiTokenName: auth.apiToken.name,
      endpoint: `${request.method.toUpperCase()} ${url.pathname}`,
      method: request.method.toUpperCase(),
      path: url.pathname,
      operation,
      status,
      httpStatus,
      latencyMs: Math.max(0, Date.now() - startedAt),
      credits,
      errorCode,
      errorMessage,
      metadata,
      createdAt: new Date(startedAt),
    });
  } catch (error) {
    console.error("Failed to persist public request log", error);
  }
}

async function emitWebhookEvent(
  auth: AuthenticatedMemoryApi,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await enqueueWebhookEvent(
    auth.db,
    auth.apiToken.workspaceId,
    eventType,
    payload,
  );
}

// ── handlers ─────────────────────────────────────────────────────────────────

export type PublicMemoryApiDependencies = {
  authenticate: typeof authenticateMemoryApi;
  derivationEnabled: () => Promise<boolean>;
  enqueueDerivation: typeof enqueueProfileDerivation;
  enqueueInference: typeof enqueueMemoryInferenceTask;
  emitWebhook: typeof emitWebhookEvent;
  getEngine: typeof getMemoryEngine;
  notifyTask: typeof notifyOperationTask;
  recordRequest: typeof recordPublicRequestLog;
  resolveInferencePolicy: typeof resolveMemoryInferencePolicy;
  reserveUsage: (input: {
    asynchronous?: boolean;
    auth: AuthenticatedMemoryApi;
    idempotencyKey?: string;
    operation:
      | "memories.add"
      | "memories.add_raw"
      | "memories.search"
      | "documents.ingest"
      | "documents.search";
    request: Request;
    units?: number;
  }) => Promise<PublicMemoryUsageReservation>;
  settleUsage: (input: {
    auth: AuthenticatedMemoryApi;
    operation:
      | "memories.add"
      | "memories.add_raw"
      | "memories.search"
      | "documents.ingest"
      | "documents.search";
    outcome: "success" | "failed";
    request: Request;
    reservation: PublicMemoryUsageReservation;
  }) => Promise<void>;
};

export type PublicMemoryUsageReservation = {
  credits: number;
  metadata?: Record<string, unknown>;
};

export async function resolveMemoryInferencePolicy(
  db: AppDb,
  workspaceId: string,
): Promise<MemoryInferencePolicySnapshot> {
  const [row] = await db
    .select({
      instructions: projectSettings.instructions,
      categories: projectSettings.categories,
      updatedAt: projectSettings.updatedAt,
    })
    .from(projectSettings)
    .where(eq(projectSettings.workspaceId, workspaceId))
    .limit(1);
  return createMemoryInferencePolicySnapshot({
    instructions: row?.instructions,
    categories: row?.categories,
    updatedAt: row?.updatedAt,
  });
}

export function createPublicMemoryApiDependencies(
  overrides: Partial<PublicMemoryApiDependencies> = {},
): PublicMemoryApiDependencies {
  return {
    authenticate: authenticateMemoryApi,
    derivationEnabled: async () => (await resolveEngineConfig()).derivationEnabled,
    enqueueDerivation: enqueueProfileDerivation,
    enqueueInference: enqueueMemoryInferenceTask,
    emitWebhook: emitWebhookEvent,
    getEngine: getMemoryEngine,
    notifyTask: notifyOperationTask,
    recordRequest: recordPublicRequestLog,
    resolveInferencePolicy: resolveMemoryInferencePolicy,
    reserveUsage: async () => ({ credits: 0 }),
    settleUsage: async () => {},
    ...overrides,
  };
}

export async function addMemories(
  request: Request,
  dependencies = createPublicMemoryApiDependencies(),
) {
  const startedAt = Date.now();
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error;
  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    await dependencies.recordRequest({
      auth,
      errorCode: "INVALID_BODY",
      errorMessage: "Invalid JSON body",
      httpStatus: 400,
      operation: "memories.add",
      request,
      startedAt,
      status: "failed",
    });
    return apiError(400, "Invalid JSON body", "INVALID_BODY");
  }
  let command: ReturnType<typeof AddMemoryCommandSchema.parse>;
  try {
    command = AddMemoryCommandSchema.parse(body);
  } catch (error) {
    const failure = classifyMemoryError(error);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      operation: "memories.add",
      request,
      startedAt,
      status: "failed",
    });
    return apiError(failure.status, failure.message, failure.code);
  }
  const scope = scopeOf(command);
  const infer = command.infer;
  const operation = infer ? "memories.add" : "memories.add_raw";
  let idempotencyKey: string | undefined;
  try {
    idempotencyKey = readMutationIdempotencyKey(request, {
      required: infer,
    });
  } catch (error) {
    return memoryErrorResponse(error);
  }
  let reservation: PublicMemoryUsageReservation | undefined;
  let engineCompleted = false;
  let taskQueued = false;
  try {
    reservation = await dependencies.reserveUsage({
      asynchronous: infer,
      auth,
      idempotencyKey,
      operation,
      request,
    });
    if (infer) {
      const policy = await dependencies.resolveInferencePolicy(
        auth.db,
        auth.apiToken.workspaceId,
      );
      const task = await dependencies.enqueueInference(auth.db, {
        workspaceId: auth.apiToken.workspaceId,
        command,
        idempotencyKey: idempotencyKey!,
        derivationEnabled: await dependencies.derivationEnabled(),
        policy,
        ...(reservation.credits > 0 || reservation.metadata
          ? {
              usage: {
                version: 1 as const,
                api_token_id: auth.apiToken.documentId,
                credits: reservation.credits,
                ...(reservation.metadata
                  ? { reservation: reservation.metadata }
                  : {}),
              },
            }
          : {}),
      });
      taskQueued = true;
      const event = shapeMemoryEvent(task);
      await dependencies.recordRequest({
        auth,
        credits: reservation.credits,
        httpStatus: 202,
        metadata: {
          ...scopeMetadata(scope),
          event_id: task.documentId,
          event_status: event.status,
          infer: true,
        },
        operation,
        request,
        startedAt,
        status: "success",
      });
      await dependencies.notifyTask(task.documentId);
      return json(
        {
          message:
            "Memory inference accepted for durable background processing",
          status: event.status,
          event_id: task.documentId,
        },
        { status: 202 },
      );
    }
    const application = new MemoryApplication(await dependencies.getEngine());
    const result = await application.add(
      auth.apiToken.workspaceId,
      command,
      idempotencyKey,
    );
    engineCompleted = true;
    await dependencies.settleUsage({
      auth,
      operation,
      outcome: "success",
      request,
      reservation,
    });
    await dependencies.recordRequest({
      auth,
      credits: reservation.credits,
      httpStatus: 200,
      metadata: {
        ...scopeMetadata(scope),
        infer,
        results: result.results.length,
      },
      operation,
      request,
      startedAt,
      status: "success",
    });
    await dependencies.emitWebhook(auth, "memory_add", {
      operation,
      memory_ids: result.results.map((item) => item.id),
      results: result.results.length,
      ...scopeMetadata(scope),
    });
    return json({
      results: result.results.map((r) => ({
        id: r.id,
        memory: r.memory,
        event: r.event,
      })),
    });
  } catch (err) {
    if (reservation && !engineCompleted && !taskQueued) {
      try {
        await dependencies.settleUsage({
          auth,
          operation,
          outcome: "failed",
          request,
          reservation,
        });
      } catch (settlementError) {
        console.error(
          "Failed to release memory usage reservation",
          settlementError,
        );
      }
    }
    const failure = classifyMemoryError(err);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: {
        ...scopeMetadata(scope),
        infer,
        reserved_credits: reservation?.credits ?? 0,
      },
      operation,
      request,
      startedAt,
      status: "failed",
    });
    return apiError(failure.status, failure.message, failure.code);
  }
}

export async function searchMemories(
  request: Request,
  dependencies = createPublicMemoryApiDependencies(),
) {
  const startedAt = Date.now();
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error;
  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body) || typeof body.query !== "string" || !body.query.trim()) {
    await dependencies.recordRequest({
      auth,
      errorCode: "INVALID_QUERY",
      errorMessage: "query (string) is required",
      httpStatus: 400,
      operation: "memories.search",
      request,
      startedAt,
      status: "failed",
    });
    return apiError(400, "query (string) is required", "INVALID_QUERY");
  }
  const scope = scopeOf(body);
  if (!hasScope(scope)) {
    await dependencies.recordRequest({
      auth,
      errorCode: "SCOPE_REQUIRED",
      errorMessage: "One of user_id, agent_id, run_id is required",
      httpStatus: 400,
      metadata: scopeMetadata(scope),
      operation: "memories.search",
      request,
      startedAt,
      status: "failed",
    });
    return apiError(
      400,
      "One of user_id, agent_id, run_id is required",
      "SCOPE_REQUIRED",
    );
  }
  const limit = Math.min(Math.max(Number(body.top_k ?? body.limit ?? 10), 1), 50);

  let reservation: PublicMemoryUsageReservation | undefined;
  let engineCompleted = false;
  try {
    reservation = await dependencies.reserveUsage({
      auth,
      operation: "memories.search",
      request,
    });
    const application = new MemoryApplication(await dependencies.getEngine());
    const { results, beliefs, trace } = await application.search(
      auth.apiToken.workspaceId,
      body,
    );
    engineCompleted = true;
    await dependencies.settleUsage({
      auth,
      operation: "memories.search",
      outcome: "success",
      request,
      reservation,
    });
    // Persist the query + the scored hits into the request log so the dashboard
    // can render the "why did it retrieve this" trace (Request Payload +
    // Retrieved Memories). Kept compact to bound log size.
    const loggedResults = results.map((r) => {
      const m = r.memory as MemoryItem;
      const cats = (m.metadata as Record<string, unknown> | undefined)
        ?.categories;
      return {
        id: m.id,
        memory: m.content,
        memory_type: m.memoryType,
        categories: Array.isArray(cats) ? cats : undefined,
        created_at: m.createdAt.toISOString(),
        score: r.score,
      };
    });
    await dependencies.recordRequest({
      auth,
      credits: reservation.credits,
      httpStatus: 200,
      metadata: {
        ...scopeMetadata(scope),
        query: body.query,
        limit,
        memory_type: body.memory_type,
        mode: body.mode,
        search_strategy: body.search_strategy,
        sort_by: body.sort_by,
        min_score: body.min_score,
        filters: body.filters,
        result_count: results.length,
        results: loggedResults,
      },
      operation: "memories.search",
      request,
      startedAt,
      status: "success",
    });
    return json({
      results: results.map((r) => shapeMemory(r.memory as MemoryItem, r.score)),
      ...(beliefs ? { beliefs: shapeBeliefs(beliefs) } : {}),
      ...(trace ? { trace: shapeSearchTrace(trace) } : {}),
    });
  } catch (err) {
    if (reservation && !engineCompleted) {
      try {
        await dependencies.settleUsage({
          auth,
          operation: "memories.search",
          outcome: "failed",
          request,
          reservation,
        });
      } catch (settlementError) {
        console.error(
          "Failed to release memory usage reservation",
          settlementError,
        );
      }
    }
    const failure = classifyMemoryError(err);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { ...scopeMetadata(scope), limit },
      operation: "memories.search",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(err);
  }
}

export async function listMemories(request: Request) {
  const startedAt = Date.now();
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  const url = new URL(request.url);
  const q = (key: string) => url.searchParams.get(key) ?? undefined;
  const scope = {
    userId: q("user_id"),
    agentId: q("agent_id"),
    runId: q("run_id"),
  };
  if (!hasScope(scope)) {
    await recordPublicRequestLog({
      auth,
      errorCode: "SCOPE_REQUIRED",
      errorMessage: "One of user_id, agent_id, run_id is required",
      httpStatus: 400,
      metadata: scopeMetadata(scope),
      operation: "memories.list",
      request,
      startedAt,
      status: "failed",
    });
    return apiError(
      400,
      "One of user_id, agent_id, run_id is required",
      "SCOPE_REQUIRED",
    );
  }
  const limit = Math.min(Math.max(Number(q("limit") ?? 50), 1), 100);
  const cursor = q("cursor");

  try {
    const application = new MemoryApplication(await getMemoryEngine());
    const all = await application.list(auth.apiToken.workspaceId, {
      user_id: scope.userId,
      agent_id: scope.agentId,
      run_id: scope.runId,
      limit,
      cursor,
    });
    await recordPublicRequestLog({
      auth,
      httpStatus: 200,
      metadata: {
        ...scopeMetadata(scope),
        limit,
        cursor,
        results: all.results.length,
      },
      operation: "memories.list",
      request,
      startedAt,
      status: "success",
    });
    return json({
      results: all.results.map((m) => shapeMemory(m as MemoryItem)),
      next_cursor: all.next_cursor,
    });
  } catch (err) {
    const failure = classifyMemoryError(err);
    await recordPublicRequestLog({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { ...scopeMetadata(scope), limit, cursor },
      operation: "memories.list",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(err);
  }
}

export async function getMemoryById(request: Request, id: string) {
  const startedAt = Date.now();
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const application = new MemoryApplication(await getMemoryEngine());
    const m = await application.get(auth.apiToken.workspaceId, id);
    await recordPublicRequestLog({
      auth,
      httpStatus: 200,
      metadata: { memory_id: id },
      operation: "memories.get",
      request,
      startedAt,
      status: "success",
    });
    return json(shapeMemory(m as MemoryItem));
  } catch (err) {
    const failure = classifyMemoryError(err);
    await recordPublicRequestLog({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { memory_id: id },
      operation: "memories.get",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(err);
  }
}

export async function getMemoryFeedback(
  request: Request,
  id: string,
  dependencies = createPublicMemoryApiDependencies(),
) {
  const startedAt = Date.now();
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error;
  try {
    const application = new MemoryApplication(await dependencies.getEngine());
    const result = await application.getFeedback(
      auth.apiToken.workspaceId,
      id,
    );
    await dependencies.recordRequest({
      auth,
      httpStatus: 200,
      metadata: { memory_id: id, has_feedback: Boolean(result.feedback) },
      operation: "memories.feedback.get",
      request,
      startedAt,
      status: "success",
    });
    return json(result);
  } catch (error) {
    const failure = classifyMemoryError(error);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { memory_id: id },
      operation: "memories.feedback.get",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export async function setMemoryFeedback(
  request: Request,
  id: string,
  dependencies = createPublicMemoryApiDependencies(),
  options: { requireIdempotencyKey?: boolean } = {},
) {
  const startedAt = Date.now();
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error;
  const body: unknown = await request.json().catch(() => null);
  try {
    const idempotencyKey = readMutationIdempotencyKey(request, {
      required: options.requireIdempotencyKey,
    });
    const application = new MemoryApplication(await dependencies.getEngine());
    const result = await application.setFeedback(
      auth.apiToken.workspaceId,
      id,
      body,
      idempotencyKey,
    );
    await dependencies.recordRequest({
      auth,
      httpStatus: 200,
      metadata: {
        memory_id: id,
        rating: result.feedback.rating,
        request_id: result.feedback.request_id,
      },
      operation: "memories.feedback.set",
      request,
      startedAt,
      status: "success",
    });
    await dependencies.emitWebhook(auth, "memory_feedback", {
      memory_id: id,
      rating: result.feedback.rating,
      request_id: result.feedback.request_id,
    });
    return json(result);
  } catch (error) {
    const failure = classifyMemoryError(error);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { memory_id: id },
      operation: "memories.feedback.set",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export async function clearMemoryFeedback(
  request: Request,
  id: string,
  dependencies = createPublicMemoryApiDependencies(),
  options: { requireIdempotencyKey?: boolean } = {},
) {
  const startedAt = Date.now();
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error;
  try {
    const idempotencyKey = readMutationIdempotencyKey(request, {
      required: options.requireIdempotencyKey,
    });
    const application = new MemoryApplication(await dependencies.getEngine());
    const result = await application.clearFeedback(
      auth.apiToken.workspaceId,
      id,
      idempotencyKey,
    );
    await dependencies.recordRequest({
      auth,
      httpStatus: 200,
      metadata: { memory_id: id, cleared: result.cleared },
      operation: "memories.feedback.clear",
      request,
      startedAt,
      status: "success",
    });
    await dependencies.emitWebhook(auth, "memory_feedback", {
      memory_id: id,
      rating: null,
    });
    return json(result);
  } catch (error) {
    const failure = classifyMemoryError(error);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { memory_id: id },
      operation: "memories.feedback.clear",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export async function updateMemoryById(
  request: Request,
  id: string,
  options: { requireIdempotencyKey?: boolean } = {},
) {
  const startedAt = Date.now();
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    await recordPublicRequestLog({
      auth,
      errorCode: "INVALID_BODY",
      errorMessage: "Invalid JSON body",
      httpStatus: 400,
      metadata: { memory_id: id },
      operation: "memories.update",
      request,
      startedAt,
      status: "failed",
    });
    return apiError(400, "Invalid JSON body", "INVALID_BODY");
  }
  try {
    const idempotencyKey = readMutationIdempotencyKey(request, {
      required: options.requireIdempotencyKey,
    });
    const application = new MemoryApplication(await getMemoryEngine());
    const result = await application.update(
      auth.apiToken.workspaceId,
      id,
      body,
      idempotencyKey,
    );
    await recordPublicRequestLog({
      auth,
      httpStatus: 200,
      metadata: {
        memory_id: id,
        updated_fields: Object.keys(body),
      },
      operation: "memories.update",
      request,
      startedAt,
      status: "success",
    });
    await emitWebhookEvent(auth, "memory_update", {
      memory_id: id,
      updated_fields: Object.keys(body),
    });
    return json({ id: result.id, memory: result.memory, event: result.event });
  } catch (err) {
    const failure = classifyMemoryError(err);
    await recordPublicRequestLog({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { memory_id: id },
      operation: "memories.update",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(err);
  }
}

export async function deleteMemoryById(
  request: Request,
  id: string,
  options: { requireIdempotencyKey?: boolean } = {},
) {
  const startedAt = Date.now();
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const idempotencyKey = readMutationIdempotencyKey(request, {
      required: options.requireIdempotencyKey,
    });
    const application = new MemoryApplication(await getMemoryEngine());
    await application.delete(
      auth.apiToken.workspaceId,
      id,
      idempotencyKey,
    );
    await recordPublicRequestLog({
      auth,
      httpStatus: 200,
      metadata: { memory_id: id },
      operation: "memories.delete",
      request,
      startedAt,
      status: "success",
    });
    await emitWebhookEvent(auth, "memory_delete", { memory_id: id });
    return json({ id, deleted: true });
  } catch (err) {
    const failure = classifyMemoryError(err);
    await recordPublicRequestLog({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { memory_id: id },
      operation: "memories.delete",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(err);
  }
}

export async function deleteAllMemories(
  request: Request,
  options: { requireIdempotencyKey?: boolean } = {},
) {
  const startedAt = Date.now();
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  const url = new URL(request.url);
  const q = (key: string) => url.searchParams.get(key) ?? undefined;
  const scope = { userId: q("user_id"), agentId: q("agent_id"), runId: q("run_id") };
  if (!hasScope(scope)) {
    await recordPublicRequestLog({
      auth,
      errorCode: "SCOPE_REQUIRED",
      errorMessage: "One of user_id, agent_id, run_id is required",
      httpStatus: 400,
      metadata: scopeMetadata(scope),
      operation: "memories.delete_all",
      request,
      startedAt,
      status: "failed",
    });
    return apiError(
      400,
      "One of user_id, agent_id, run_id is required",
      "SCOPE_REQUIRED",
    );
  }
  try {
    const idempotencyKey = readMutationIdempotencyKey(request, {
      required: options.requireIdempotencyKey,
    });
    const memory = (await getMemoryEngine()).forNamespace(
      auth.apiToken.workspaceId,
    );
    const { deleted } = await memory.deleteAll(scope, { idempotencyKey });
    await recordPublicRequestLog({
      auth,
      httpStatus: 200,
      metadata: { ...scopeMetadata(scope), deleted },
      operation: "memories.delete_all",
      request,
      startedAt,
      status: "success",
    });
    await emitWebhookEvent(auth, "memory_delete", {
      deleted,
      ...scopeMetadata(scope),
    });
    return json({ deleted });
  } catch (err) {
    const failure = classifyMemoryError(err);
    await recordPublicRequestLog({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: scopeMetadata(scope),
      operation: "memories.delete_all",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(err);
  }
}

export async function listScopeEntities(
  request: Request,
  dependencies = createPublicMemoryApiDependencies(),
) {
  const startedAt = Date.now();
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error;
  try {
    const application = new MemoryApplication(await dependencies.getEngine());
    const result = await application.listScopeEntities(
      auth.apiToken.workspaceId,
      queryRecord(request),
    );
    await dependencies.recordRequest({
      auth,
      httpStatus: 200,
      metadata: {
        entity_type: new URL(request.url).searchParams.get("type") ?? undefined,
        results: result.results.length,
      },
      operation: "entities.list",
      request,
      startedAt,
      status: "success",
    });
    return json(result);
  } catch (error) {
    const failure = classifyMemoryError(error);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      operation: "entities.list",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export async function getScopeEntity(
  request: Request,
  type: string,
  id: string,
  dependencies = createPublicMemoryApiDependencies(),
) {
  const startedAt = Date.now();
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error;
  try {
    const application = new MemoryApplication(await dependencies.getEngine());
    const result = await application.getScopeEntity(
      auth.apiToken.workspaceId,
      type,
      id,
    );
    await dependencies.recordRequest({
      auth,
      httpStatus: 200,
      metadata: { entity_id: id, entity_type: type },
      operation: "entities.get",
      request,
      startedAt,
      status: "success",
    });
    return json(result);
  } catch (error) {
    const failure = classifyMemoryError(error);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { entity_id: id, entity_type: type },
      operation: "entities.get",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export async function deleteScopeEntity(
  request: Request,
  type: string,
  id: string,
  dependencies = createPublicMemoryApiDependencies(),
) {
  const startedAt = Date.now();
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error;
  try {
    const idempotencyKey = readMutationIdempotencyKey(request, {
      required: true,
    })!;
    const application = new MemoryApplication(await dependencies.getEngine());
    const result = await application.deleteScopeEntity(
      auth.apiToken.workspaceId,
      type,
      id,
      idempotencyKey,
    );
    await dependencies.recordRequest({
      auth,
      httpStatus: 200,
      metadata: {
        deleted: result.deleted_memories,
        entity_id: id,
        entity_type: type,
      },
      operation: "entities.delete",
      request,
      startedAt,
      status: "success",
    });
    await dependencies.emitWebhook(auth, "memory_delete", {
      deleted: result.deleted_memories,
      entity_id: id,
      entity_type: type,
    });
    return json(result);
  } catch (error) {
    const failure = classifyMemoryError(error);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { entity_id: id, entity_type: type },
      operation: "entities.delete",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export type BatchMemoryMutationDependencies = {
  authenticate: typeof authenticateMemoryApi;
  enqueueTask: typeof enqueueOperationTask;
  notifyTask: typeof notifyOperationTask;
  recordRequest: typeof recordPublicRequestLog;
};

function batchMemoryMutationDependencies(
  overrides: Partial<BatchMemoryMutationDependencies> = {},
): BatchMemoryMutationDependencies {
  return {
    authenticate: authenticateMemoryApi,
    enqueueTask: enqueueOperationTask,
    notifyTask: notifyOperationTask,
    recordRequest: recordPublicRequestLog,
    ...overrides,
  };
}

async function createBatchMemoryMutation(
  request: Request,
  kind: "batch_update" | "batch_delete",
  dependencies = batchMemoryMutationDependencies(),
) {
  const startedAt = Date.now();
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error;
  let itemCount = 0;
  try {
    const idempotencyKey = readMutationIdempotencyKey(request, {
      required: true,
    })!;
    const body: unknown = await request.json().catch(() => null);
    const command =
      kind === "batch_update"
        ? BatchUpdateMemoriesCommandSchema.parse(body)
        : BatchDeleteMemoriesCommandSchema.parse(body);
    itemCount = command.memories.length;
    const task = await dependencies.enqueueTask(auth.db, {
      workspaceId: auth.apiToken.workspaceId,
      operationId: `${kind}:${idempotencyKey}`,
      kind,
      payload: { memories: command.memories },
    });
    await dependencies.notifyTask(task.documentId);
    await dependencies.recordRequest({
      auth,
      httpStatus: 202,
      metadata: {
        operation_id: task.documentId,
        items: itemCount,
      },
      operation:
        kind === "batch_update"
          ? "memories.batch_update"
          : "memories.batch_delete",
      request,
      startedAt,
      status: "success",
    });
    return json(shapeOperationTask(task), { status: 202 });
  } catch (error) {
    const failure = classifyMemoryError(error);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { items: itemCount },
      operation:
        kind === "batch_update"
          ? "memories.batch_update"
          : "memories.batch_delete",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export function batchUpdateMemories(
  request: Request,
  dependencies?: BatchMemoryMutationDependencies,
) {
  return createBatchMemoryMutation(
    request,
    "batch_update",
    dependencies ?? batchMemoryMutationDependencies(),
  );
}

export function batchDeleteMemories(
  request: Request,
  dependencies?: BatchMemoryMutationDependencies,
) {
  return createBatchMemoryMutation(
    request,
    "batch_delete",
    dependencies ?? batchMemoryMutationDependencies(),
  );
}

export async function ingestDocument(
  request: Request,
  dependencies = createPublicMemoryApiDependencies(),
  options: { requireIdempotencyKey?: boolean } = {},
) {
  const startedAt = Date.now();
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error;
  let reservation: PublicMemoryUsageReservation | undefined;
  let engineCompleted = false;
  let command: IngestDocumentCommand | undefined;
  let idempotencyKey: string | undefined;
  try {
    command = (await parseDocumentIngestRequest(request)).command;
    idempotencyKey = readMutationIdempotencyKey(request, {
      required: options.requireIdempotencyKey,
    });
    const units = Math.max(1, chunkDocumentText(command.content).length);
    reservation = await dependencies.reserveUsage({
      auth,
      idempotencyKey,
      operation: "documents.ingest",
      request,
      units,
    });
    const application = new MemoryApplication(await dependencies.getEngine());
    const result = await application.ingestDocument(
      auth.apiToken.workspaceId,
      command,
      idempotencyKey,
    );
    engineCompleted = true;
    await dependencies.settleUsage({
      auth,
      operation: "documents.ingest",
      outcome: "success",
      request,
      reservation,
    });
    await dependencies.recordRequest({
      auth,
      credits: reservation.credits,
      httpStatus: 200,
      metadata: {
        ...scopeMetadata(scopeOf(command)),
        document_id: result.document.id,
        source_key: result.document.source_key,
        size_bytes: result.document.size_bytes,
        chunks: result.chunks,
        created: result.created,
      },
      operation: "documents.ingest",
      request,
      startedAt,
      status: "success",
    });
    await dependencies.emitWebhook(auth, "document_ingest", {
      document_id: result.document.id,
      source_key: result.document.source_key,
      content_hash: result.document.content_hash,
      chunks: result.chunks,
      created: result.created,
      ...scopeMetadata(scopeOf(command)),
    });
    return json(result);
  } catch (error) {
    if (reservation && !engineCompleted) {
      try {
        await dependencies.settleUsage({
          auth,
          operation: "documents.ingest",
          outcome: "failed",
          request,
          reservation,
        });
      } catch (settlementError) {
        console.error(
          "Failed to release document usage reservation",
          settlementError,
        );
      }
    }
    const failure = classifyMemoryError(error);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: {
        ...(command ? scopeMetadata(scopeOf(command)) : {}),
        source_key: command?.source_key,
        size_bytes: command
          ? new TextEncoder().encode(command.content).byteLength
          : undefined,
        reserved_credits: reservation?.credits ?? 0,
      },
      operation: "documents.ingest",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export async function createDocumentUpload(request: Request) {
  const startedAt = Date.now();
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const idempotencyKey = readMutationIdempotencyKey(request, {
      required: true,
    })!;
    const body = await request.json().catch(() => null);
    const ingestion = await createDocumentIngestion(auth.db);
    const result = await ingestion.create(
      auth.apiToken.workspaceId,
      body,
      idempotencyKey,
      request.url,
    );
    await recordPublicRequestLog({
      auth,
      httpStatus: 201,
      metadata: {
        source_asset_id: result.source_asset.id,
        operation_id: result.operation.id,
        source_key: result.source_asset.source_key,
        size_bytes: result.source_asset.size_bytes,
        content_type: result.source_asset.content_type,
      },
      operation: "documents.upload.create",
      request,
      startedAt,
      status: "success",
    });
    return json(result, { status: 201 });
  } catch (error) {
    const failure = classifyMemoryError(error);
    await recordPublicRequestLog({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      operation: "documents.upload.create",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export async function getDocumentUpload(request: Request, assetId: string) {
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    return json(
      await (await createDocumentIngestion(auth.db)).get(
        auth.apiToken.workspaceId,
        assetId,
      ),
    );
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export type DocumentUploadCancellationHook = (input: {
  db: AppDb;
  task: OperationTask;
  workspaceId: string;
}) => Promise<void>;

export type DeleteDocumentUploadDependencies = {
  authenticate: typeof authenticateMemoryApi;
  createIngestion: typeof createDocumentIngestion;
  recordRequest: typeof recordPublicRequestLog;
  afterTaskFenced?: DocumentUploadCancellationHook;
};

export function createDeleteDocumentUploadDependencies(
  overrides: Partial<DeleteDocumentUploadDependencies> = {},
): DeleteDocumentUploadDependencies {
  return {
    authenticate: authenticateMemoryApi,
    createIngestion: createDocumentIngestion,
    recordRequest: recordPublicRequestLog,
    ...overrides,
  };
}

export async function deleteDocumentUpload(
  request: Request,
  assetId: string,
  dependencies = createDeleteDocumentUploadDependencies(),
) {
  const startedAt = Date.now();
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error;
  try {
    await (
      await dependencies.createIngestion(auth.db)
    ).deleteUpload(auth.apiToken.workspaceId, assetId, {
      afterTaskFenced: dependencies.afterTaskFenced
        ? (task) =>
            dependencies.afterTaskFenced!({
              db: auth.db,
              task,
              workspaceId: auth.apiToken.workspaceId,
            })
        : undefined,
    });
    await dependencies.recordRequest({
      auth,
      httpStatus: 204,
      metadata: { source_asset_id: assetId },
      operation: "documents.upload.delete",
      request,
      startedAt,
      status: "success",
    });
    return new Response(null, {
      status: 204,
      headers: {
        "x-request-id": crypto.randomUUID(),
      },
    });
  } catch (error) {
    const failure = classifyMemoryError(error);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { source_asset_id: assetId },
      operation: "documents.upload.delete",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export async function putDocumentUploadContent(
  request: Request,
  assetId: string,
) {
  const startedAt = Date.now();
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const declaredLength = request.headers.get("content-length");
    if (
      declaredLength !== null &&
      Number.isFinite(Number(declaredLength)) &&
      Number(declaredLength) > MAX_DOCUMENT_UPLOAD_BYTES
    ) {
      throw new DocumentIngestionError(
        413,
        "DOCUMENT_UPLOAD_TOO_LARGE",
        `Document uploads must be at most ${MAX_DOCUMENT_UPLOAD_BYTES} bytes`,
      );
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    const sourceAsset = await (
      await createDocumentIngestion(auth.db)
    ).putContent(auth.apiToken.workspaceId, assetId, bytes);
    await recordPublicRequestLog({
      auth,
      httpStatus: 204,
      metadata: {
        source_asset_id: assetId,
        size_bytes: sourceAsset.size_bytes,
        checksum_sha256: sourceAsset.checksum_sha256,
      },
      operation: "documents.upload.content",
      request,
      startedAt,
      status: "success",
    });
    return new Response(null, {
      status: 204,
      headers: { "x-request-id": crypto.randomUUID() },
    });
  } catch (error) {
    const failure = classifyMemoryError(error);
    await recordPublicRequestLog({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { source_asset_id: assetId },
      operation: "documents.upload.content",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export type DocumentUploadAuthorization = {
  credits?: number;
  taskPayload?: Record<string, unknown>;
  rollback?: () => Promise<void>;
};

export type CompleteDocumentUploadDependencies = {
  authenticate: typeof authenticateMemoryApi;
  authorize: (input: {
    auth: AuthenticatedMemoryApi;
    request: Request;
    sourceAsset: SourceAssetWire;
  }) => Promise<DocumentUploadAuthorization>;
  createIngestion: typeof createDocumentIngestion;
  emitWebhook: typeof emitWebhookEvent;
  notifyTask: typeof notifyDocumentExtractionTask;
  recordRequest: typeof recordPublicRequestLog;
};

export function createCompleteDocumentUploadDependencies(
  overrides: Partial<CompleteDocumentUploadDependencies> = {},
): CompleteDocumentUploadDependencies {
  return {
    authenticate: authenticateMemoryApi,
    authorize: async () => ({ credits: 0 }),
    createIngestion: createDocumentIngestion,
    emitWebhook: emitWebhookEvent,
    notifyTask: notifyDocumentExtractionTask,
    recordRequest: recordPublicRequestLog,
    ...overrides,
  };
}

export async function completeDocumentUpload(
  request: Request,
  assetId: string,
  dependencies = createCompleteDocumentUploadDependencies(),
) {
  const startedAt = Date.now();
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error;
  let authorization: DocumentUploadAuthorization | undefined;
  let queued = false;
  try {
    const ingestion = await dependencies.createIngestion(auth.db);
    const sourceAsset = await ingestion.get(
      auth.apiToken.workspaceId,
      assetId,
    );
    authorization = await dependencies.authorize({
      auth,
      request,
      sourceAsset,
    });
    const result = await ingestion.complete(
      auth.apiToken.workspaceId,
      assetId,
      new Date(),
      { taskPayload: authorization.taskPayload },
    );
    queued = true;
    await dependencies.recordRequest({
      auth,
      credits: authorization.credits ?? 0,
      httpStatus: 202,
      metadata: {
        source_asset_id: assetId,
        operation_id: result.operation.id,
      },
      operation: "documents.upload.complete",
      request,
      startedAt,
      status: "success",
    });
    await dependencies.emitWebhook(auth, "document_extract_queued", {
      source_asset_id: assetId,
      operation_id: result.operation.id,
      source_key: result.source_asset.source_key,
    });
    await dependencies.notifyTask(result.operation.id);
    return json(result, { status: 202 });
  } catch (error) {
    if (authorization?.rollback && !queued) {
      try {
        await authorization.rollback();
      } catch (rollbackError) {
        console.error(
          "Failed to release document extraction authorization",
          rollbackError,
        );
      }
    }
    const failure = classifyMemoryError(error);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: {
        source_asset_id: assetId,
        reserved_credits: authorization?.credits ?? 0,
      },
      operation: "documents.upload.complete",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export async function notifyOperationTask(taskId: string) {
  if (!IS_CLOUDFLARE) return;
  try {
    const env = await getRuntimeEnv();
    if (!env.DOCUMENT_TASKS) {
      console.warn(
        "DOCUMENT_TASKS binding is absent; cron will pick up the operation",
        taskId,
      );
      return;
    }
    await env.DOCUMENT_TASKS.send({ task_id: taskId });
  } catch (error) {
    // D1 already owns the pending task. The minute cron is the repair path if
    // this best-effort wakeup fails.
    console.error("Failed to wake operation queue", taskId, error);
  }
}

export const notifyDocumentExtractionTask = notifyOperationTask;

export async function searchDocuments(
  request: Request,
  dependencies = createPublicMemoryApiDependencies(),
) {
  const startedAt = Date.now();
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error;
  let reservation: PublicMemoryUsageReservation | undefined;
  let engineCompleted = false;
  let command: ReturnType<typeof SearchDocumentCommandSchema.parse> | undefined;
  try {
    command = SearchDocumentCommandSchema.parse(
      await request.json().catch(() => null),
    );
    reservation = await dependencies.reserveUsage({
      auth,
      operation: "documents.search",
      request,
    });
    const application = new MemoryApplication(await dependencies.getEngine());
    const result = await application.searchDocuments(
      auth.apiToken.workspaceId,
      command,
    );
    engineCompleted = true;
    await dependencies.settleUsage({
      auth,
      operation: "documents.search",
      outcome: "success",
      request,
      reservation,
    });
    await dependencies.recordRequest({
      auth,
      credits: reservation.credits,
      httpStatus: 200,
      metadata: {
        ...scopeMetadata(scopeOf(command)),
        query: command.query,
        limit: command.limit,
        neighbors: command.neighbors,
        source_key: command.source_key,
        result_count: result.results.length,
        results: result.results.map((hit) => ({
          document_id: hit.document.id,
          chunk_id: hit.chunk.id,
          score: hit.score,
        })),
      },
      operation: "documents.search",
      request,
      startedAt,
      status: "success",
    });
    return json(result);
  } catch (error) {
    if (reservation && !engineCompleted) {
      try {
        await dependencies.settleUsage({
          auth,
          operation: "documents.search",
          outcome: "failed",
          request,
          reservation,
        });
      } catch (settlementError) {
        console.error(
          "Failed to release document search usage reservation",
          settlementError,
        );
      }
    }
    const failure = classifyMemoryError(error);
    await dependencies.recordRequest({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: command
        ? {
            ...scopeMetadata(scopeOf(command)),
            query: command.query,
            limit: command.limit,
          }
        : undefined,
      operation: "documents.search",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export async function listDocuments(request: Request) {
  const startedAt = Date.now();
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const url = new URL(request.url);
    const query = ListDocumentQuerySchema.parse(
      Object.fromEntries(url.searchParams),
    );
    const application = new MemoryApplication(await getMemoryEngine());
    const result = await application.listDocuments(
      auth.apiToken.workspaceId,
      query,
    );
    await recordPublicRequestLog({
      auth,
      httpStatus: 200,
      metadata: {
        ...scopeMetadata(scopeOf(query)),
        source_key: query.source_key,
        limit: query.limit,
        cursor: query.cursor,
        results: result.results.length,
      },
      operation: "documents.list",
      request,
      startedAt,
      status: "success",
    });
    return json(result);
  } catch (error) {
    const failure = classifyMemoryError(error);
    await recordPublicRequestLog({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      operation: "documents.list",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export async function getDocumentById(request: Request, id: string) {
  return getPublicDocumentById(request, id, false);
}

export async function getDocumentContentById(request: Request, id: string) {
  return getPublicDocumentById(request, id, true);
}

async function getPublicDocumentById(
  request: Request,
  id: string,
  includeContent: boolean,
) {
  const startedAt = Date.now();
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  const operation = includeContent ? "documents.content" : "documents.get";
  try {
    const application = new MemoryApplication(await getMemoryEngine());
    const result = includeContent
      ? await application.getDocumentContent(auth.apiToken.workspaceId, id)
      : await application.getDocument(auth.apiToken.workspaceId, id);
    await recordPublicRequestLog({
      auth,
      httpStatus: 200,
      metadata: { document_id: id },
      operation,
      request,
      startedAt,
      status: "success",
    });
    return json(result);
  } catch (error) {
    const failure = classifyMemoryError(error);
    await recordPublicRequestLog({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { document_id: id },
      operation,
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

export async function deleteDocumentById(
  request: Request,
  id: string,
  options: { requireIdempotencyKey?: boolean } = {},
) {
  const startedAt = Date.now();
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const idempotencyKey = readMutationIdempotencyKey(request, {
      required: options.requireIdempotencyKey,
    });
    const application = new MemoryApplication(await getMemoryEngine());
    const result = await application.deleteDocument(
      auth.apiToken.workspaceId,
      id,
      idempotencyKey,
    );
    await (
      await createDocumentIngestion(auth.db)
    ).deleteForDocument(auth.apiToken.workspaceId, id);
    await recordPublicRequestLog({
      auth,
      httpStatus: 200,
      metadata: {
        document_id: id,
        versions: result.versions,
        chunks: result.chunks,
      },
      operation: "documents.delete",
      request,
      startedAt,
      status: "success",
    });
    await emitWebhookEvent(auth, "document_delete", {
      document_id: id,
      versions: result.versions,
      chunks: result.chunks,
    });
    return json(result);
  } catch (error) {
    const failure = classifyMemoryError(error);
    await recordPublicRequestLog({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { document_id: id },
      operation: "documents.delete",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(error);
  }
}

// ── internal dashboard handler (session-authenticated, /api/app/memories) ───

type AppUserLike = {
  id?: string | number;
  workspaces?: Array<{ documentId: string }> | null;
};

function dashboardWorkspaceId(
  user: AppUserLike,
  requestedWorkspaceId?: string | null,
) {
  if (requestedWorkspaceId) {
    const workspace = user.workspaces?.find(
      (item) => item.documentId === requestedWorkspaceId,
    );
    if (workspace) return workspace.documentId;
  }
  return user.workspaces?.[0]?.documentId ?? null;
}

export async function exportWorkspaceSnapshot(
  workspaceId: string,
  engineFactory: typeof getMemoryEngine = getMemoryEngine,
) {
  return sanitizePublicSnapshot(
    await (await engineFactory()).forNamespace(workspaceId).exportSnapshot(),
  );
}

export type DashboardMemoryInferenceAuthorization = {
  usage?: MemoryInferenceUsageAuthorization;
  release?: () => Promise<void>;
};

export type DashboardMemoryInferenceQueue = {
  enqueue: typeof enqueueMemoryInferenceTask;
  notify: typeof notifyOperationTask;
  resolvePolicy: typeof resolveMemoryInferencePolicy;
  authorize?: (input: {
    command: AddMemoryCommand;
    db: AppDb;
    idempotencyKey: string;
    request: Request;
    user: AppUserLike;
    workspaceId: string;
  }) => Promise<DashboardMemoryInferenceAuthorization | undefined>;
};

/**
 * Session-side memories API for the dashboard:
 *   GET    /api/app/memories?query=&user_id=&agent_id=&run_id=&limit=
 *          query present → hybrid search; absent → tenant-wide list
 *   POST   /api/app/memories         { messages|content, user_id?, infer? }
 *   DELETE /api/app/memories/{id}
 */
export async function appMemoriesHandler(
  request: Request,
  path: string[],
  url: URL,
  db: AppDb,
  user: AppUserLike,
  engineFactory: typeof getMemoryEngine = getMemoryEngine,
  derivationQueue: typeof enqueueProfileDerivation = enqueueProfileDerivation,
  derivationEnabled: () => Promise<boolean> = async () =>
    (await resolveEngineConfig()).derivationEnabled,
  batchTaskQueue: {
    enqueue: typeof enqueueOperationTask;
    notify: typeof notifyOperationTask;
  } = {
    enqueue: enqueueOperationTask,
    notify: notifyOperationTask,
  },
  inferenceTaskQueue: DashboardMemoryInferenceQueue = {
    enqueue: enqueueMemoryInferenceTask,
    notify: notifyOperationTask,
    resolvePolicy: resolveMemoryInferencePolicy,
  },
  dashboardStatsQuery: (
    db: AppDb,
    namespaceId: string,
  ) => Promise<DashboardMemoryStats> = queryDashboardMemoryStats,
) {
  const requestedWorkspaceId = url.searchParams.get("workspace");
  const workspaceId = dashboardWorkspaceId(user, requestedWorkspaceId);
  if (!workspaceId) {
    return apiError(400, "No project for user", "NO_PROJECT");
  }
  const method = request.method.toUpperCase();
  const sub = path[1];

  try {
    if (method === "GET" && !sub && url.searchParams.get("stats") === "1") {
      return json(await dashboardStatsQuery(db, workspaceId));
    }

    const engine = await engineFactory();
    const application = new MemoryApplication(engine);

    if (method === "GET" && sub === "snapshot") {
      return json({ data: await exportWorkspaceSnapshot(workspaceId) });
    }

    if (method === "POST" && sub === "snapshot") {
      const key = requiredIdempotencyKey(request);
      const body = await request.json();
      if (!isRecord(body) || !("snapshot" in body)) {
        throw new MemoryApplicationError(
          "INVALID_SNAPSHOT",
          "snapshot is required",
          400,
        );
      }
      const snapshot = sanitizePublicSnapshot(body.snapshot);
      parseNamespaceSnapshot(snapshot, workspaceId);
      const task = await enqueueOperationTask(db, {
        workspaceId,
        operationId: `import:${key}`,
        kind: "import",
        payload: { snapshot },
      });
      await dispatchPendingMemoryTasks(db, async () => engine);
      return json({ data: shapeOperationTask(task) }, { status: 202 });
    }

    if (
      sub === "batch" &&
      (method === "PUT" || method === "DELETE")
    ) {
      const key = requiredIdempotencyKey(request);
      const body: unknown = await request.json().catch(() => null);
      const kind = method === "PUT" ? "batch_update" : "batch_delete";
      const command =
        kind === "batch_update"
          ? BatchUpdateMemoriesCommandSchema.parse(body)
          : BatchDeleteMemoriesCommandSchema.parse(body);
      const task = await batchTaskQueue.enqueue(db, {
        workspaceId,
        operationId: `${kind}:${key}`,
        kind,
        payload: { memories: command.memories },
      });
      await batchTaskQueue.notify(task.documentId);
      return json({ data: shapeOperationTask(task) }, { status: 202 });
    }

    if (method === "GET" && sub === "state") {
      return json({
        data: await application.getState(workspaceId, queryRecord(request)),
      });
    }

    if (method === "GET" && sub === "state-history") {
      return json({
        data: await application.getStateHistory(
          workspaceId,
          queryRecord(request),
        ),
      });
    }

    if (method === "GET" && sub === "beliefs") {
      return json({
        data: shapeBeliefView(
          await application.getBeliefView(
            workspaceId,
            queryRecord(request),
          ),
        ),
      });
    }

    if (method === "GET" && sub === "profile") {
      return json({
        data: await application.getProfile(workspaceId, queryRecord(request)),
      });
    }

    if (method === "GET" && sub && path[2] === "history") {
      const entries = await application.history(workspaceId, sub);
      return json({
        results: entries.map((entry) => ({
          id: entry.id,
          memory_id: entry.memoryId,
          event: entry.event,
          previous_value: entry.previousValue,
          new_value: entry.newValue,
          created_at: entry.createdAt.toISOString(),
        })),
      });
    }

    if (method === "GET" && sub) {
      return json({ data: shapeMemory((await application.get(workspaceId, sub)) as MemoryItem) });
    }

    if (method === "DELETE" && sub) {
      return json(await application.delete(workspaceId, sub));
    }

    if ((method === "PATCH" || method === "PUT") && sub) {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body)) return apiError(400, "Invalid body", "INVALID_BODY");
      const updated = await application.update(workspaceId, sub, {
        ...body,
        content:
          typeof body.content === "string" ? body.content : body.memory,
      });
      const current = await application.get(workspaceId, updated.id);
      return json({ data: shapeMemory(current as MemoryItem) });
    }

    if (method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body)) return apiError(400, "Invalid body", "INVALID_BODY");
      const bodyWorkspaceId =
        typeof body.workspace === "string" ? body.workspace : requestedWorkspaceId;
      const selectedWorkspaceId = dashboardWorkspaceId(user, bodyWorkspaceId);
      if (!selectedWorkspaceId) {
        return apiError(400, "No project for user", "NO_PROJECT");
      }
      const command = AddMemoryCommandSchema.parse(body);
      const idempotencyKey = readMutationIdempotencyKey(request, {
        required: command.infer,
      });
      if (command.infer) {
        const authorization = await inferenceTaskQueue.authorize?.({
          command,
          db,
          idempotencyKey: idempotencyKey!,
          request,
          user,
          workspaceId: selectedWorkspaceId,
        });
        let task: Awaited<
          ReturnType<typeof enqueueMemoryInferenceTask>
        >;
        try {
          const policy = await inferenceTaskQueue.resolvePolicy(
            db,
            selectedWorkspaceId,
          );
          task = await inferenceTaskQueue.enqueue(db, {
            workspaceId: selectedWorkspaceId,
            command,
            idempotencyKey: idempotencyKey!,
            derivationEnabled: await derivationEnabled(),
            policy,
            ...(authorization?.usage ? { usage: authorization.usage } : {}),
          });
        } catch (error) {
          await authorization?.release?.();
          throw error;
        }
        await inferenceTaskQueue.notify(task.documentId);
        const event = shapeMemoryEvent(task);
        return json(
          {
            message:
              "Memory inference accepted for durable background processing",
            status: event.status,
            event_id: task.documentId,
          },
          { status: 202 },
        );
      }
      const result = await application.add(
        selectedWorkspaceId,
        command,
        idempotencyKey,
      );
      if (await derivationEnabled()) {
        await derivationQueue(db, {
          workspaceId: selectedWorkspaceId,
          operationId: `derive:${idempotencyKey ?? result.results.map((item) => item.id).join(",")}`,
          ...scopeOf(command),
        });
      }
      return json(result);
    }

    // GET — search or list
    const q = (key: string) => url.searchParams.get(key) ?? undefined;
    const requestScope = {
      user_id: q("user_id"),
      agent_id: q("agent_id"),
      run_id: q("run_id"),
    };
    const limit = Math.min(Math.max(Number(q("limit") ?? 50), 1), 100);
    const query = q("query")?.trim();
    if (query) {
      const searchLimit = Math.min(limit, 50);
      // Playground recall asks for the per-source retrieval trace so it can
      // show which lane (vector/fts/graph/temporal) surfaced each hit.
      const wantTrace = q("trace") === "1";
      const hasExplicitScope = Object.values(requestScope).some(Boolean);
      const { results, beliefs, trace } = hasExplicitScope
        ? await application.search(workspaceId, {
            ...requestScope,
            query,
            limit: searchLimit,
            trace: wantTrace,
          })
        : await application.searchWorkspace(workspaceId, {
            query,
            limit: searchLimit,
            trace: wantTrace,
          });
      const laneScore = (
        list: Array<{ id: string; score: number }> | undefined,
        id: string,
      ) => list?.find((x) => x.id === id)?.score ?? null;
      const shaped = results.map((r) => {
        const base = shapeMemory(r.memory as MemoryItem, r.score);
        if (!wantTrace || !trace) return base;
        return {
          ...base,
          sources: {
            vector: laneScore(trace.lists.vector, r.memory.id),
            fts: laneScore(trace.lists.fts, r.memory.id),
            graph: laneScore(trace.lists.graph, r.memory.id),
            temporal: laneScore(trace.lists.temporal, r.memory.id),
          },
        };
      });
      return json({ results: shaped, ...(beliefs ? { beliefs } : {}) });
    }
    const all = await application.list(workspaceId, {
      ...requestScope,
      limit,
      cursor: q("cursor"),
    });
    return json({
      results: all.results.map((m) => shapeMemory(m as MemoryItem)),
      next_cursor: all.next_cursor,
    });
  } catch (err) {
    return memoryErrorResponse(err);
  }
}

export async function appEntitiesHandler(
  request: Request,
  path: string[],
  url: URL,
  _db: AppDb,
  user: AppUserLike,
  engineFactory: typeof getMemoryEngine = getMemoryEngine,
) {
  const workspaceId = dashboardWorkspaceId(
    user,
    url.searchParams.get("workspace"),
  );
  if (!workspaceId) {
    return apiError(400, "No project for user", "NO_PROJECT");
  }
  const application = new MemoryApplication(await engineFactory());
  const type = path[1];
  const id = path[2];
  try {
    if (!type && request.method === "GET") {
      return json({
        data: await application.listScopeEntities(
          workspaceId,
          queryRecord(request),
        ),
      });
    }
    if (type && id && request.method === "GET") {
      return json({
        data: await application.getScopeEntity(workspaceId, type, id),
      });
    }
    if (type && id && request.method === "DELETE") {
      return json({
        data: await application.deleteScopeEntity(
          workspaceId,
          type,
          id,
          requiredIdempotencyKey(request),
        ),
      });
    }
    return apiError(405, "Method not allowed", "METHOD_NOT_ALLOWED");
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function appDocumentsHandler(
  request: Request,
  path: string[],
  url: URL,
  db: AppDb,
  user: AppUserLike & { id: string | number },
  engineFactory: typeof getMemoryEngine = getMemoryEngine,
) {
  const requestedWorkspaceId = url.searchParams.get("workspace");
  const workspaceId = dashboardWorkspaceId(user, requestedWorkspaceId);
  if (!workspaceId) {
    return apiError(400, "No project for user", "NO_PROJECT");
  }
  const application = new MemoryApplication(await engineFactory());
  const method = request.method.toUpperCase();
  const documentId = path[1];
  const action = path[2];

  try {
    if (method === "GET" && documentId && action === "content") {
      return json({
        data: await application.getDocumentContent(workspaceId, documentId),
      });
    }

    if (method === "GET" && documentId) {
      return json({
        data: await application.getDocument(workspaceId, documentId),
      });
    }

    if (method === "DELETE" && documentId) {
      const result = await application.deleteDocument(
        workspaceId,
        documentId,
        request.headers.get("Idempotency-Key") ?? undefined,
      );
      await (
        await createDocumentIngestion(db)
      ).deleteForDocument(workspaceId, documentId);
      return json({
        data: result,
      });
    }

    if (method === "POST" && !documentId) {
      const parsed = await parseDocumentIngestRequest(request, {
        defaultScope: { user_id: String(user.id) },
      });
      const selectedWorkspaceId = dashboardWorkspaceId(
        user,
        parsed.workspace ?? requestedWorkspaceId,
      );
      if (!selectedWorkspaceId) {
        return apiError(400, "No project for user", "NO_PROJECT");
      }
      return json({
        data: await application.ingestDocument(
          selectedWorkspaceId,
          parsed.command,
          request.headers.get("Idempotency-Key") ?? undefined,
        ),
      });
    }

    if (method === "GET" && !documentId) {
      const query = Object.fromEntries(url.searchParams);
      delete query.workspace;
      if (typeof query.query === "string" && query.query.trim()) {
        return json(
          await application.searchDocuments(workspaceId, query, {
            requireScope: false,
          }),
        );
      }
      return json(
        await application.listDocuments(workspaceId, query, {
          requireScope: false,
        }),
      );
    }

    return apiError(405, "Method not allowed", "METHOD_NOT_ALLOWED");
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

/**
 * Session-authenticated companion to the public upload lifecycle.
 *
 * The same DocumentIngestion module owns both surfaces; this handler only
 * resolves dashboard tenancy, supplies the current user scope, and shapes the
 * `/api/app/*` envelope.
 */
export async function appDocumentUploadsHandler(
  request: Request,
  path: string[],
  url: URL,
  db: AppDb,
  user: AppUserLike & { id: string | number },
  afterTaskFenced?: DocumentUploadCancellationHook,
) {
  const requestedWorkspaceId = url.searchParams.get("workspace");
  const workspaceId = dashboardWorkspaceId(user, requestedWorkspaceId);
  if (!workspaceId) {
    return apiError(400, "No project for user", "NO_PROJECT");
  }
  const method = request.method.toUpperCase();
  const assetId = path[1];
  const action = path[2];

  try {
    const ingestion = await createDocumentIngestion(db);
    if (method === "GET" && !assetId) {
      return json({
        data: await ingestion.list(
          workspaceId,
          Number(url.searchParams.get("limit") ?? 100),
        ),
      });
    }

    if (method === "POST" && !assetId) {
      const body = await request.json().catch(() => null);
      const command = isRecord(body)
        ? {
            ...body,
            user_id:
              typeof body.user_id === "string" && body.user_id.trim()
                ? body.user_id
                : String(user.id),
          }
        : body;
      const result = await ingestion.create(
        workspaceId,
        command,
        readMutationIdempotencyKey(request, { required: true })!,
        request.url,
      );
      result.upload.url = new URL(
        `/api/app/document-uploads/${encodeURIComponent(
          result.source_asset.id,
        )}/content?workspace=${encodeURIComponent(workspaceId)}`,
        request.url,
      ).toString();
      return json({ data: result }, { status: 201 });
    }

    if (method === "GET" && assetId && !action) {
      return json({ data: await ingestion.get(workspaceId, assetId) });
    }

    if (method === "DELETE" && assetId && !action) {
      const result = await ingestion.deleteUpload(workspaceId, assetId, {
        afterTaskFenced: afterTaskFenced
          ? (task) => afterTaskFenced({ db, task, workspaceId })
          : undefined,
      });
      return json({ data: result });
    }

    if (method === "PUT" && assetId && action === "content") {
      const declaredLength = request.headers.get("content-length");
      if (
        declaredLength !== null &&
        Number.isFinite(Number(declaredLength)) &&
        Number(declaredLength) > MAX_DOCUMENT_UPLOAD_BYTES
      ) {
        throw new DocumentIngestionError(
          413,
          "DOCUMENT_UPLOAD_TOO_LARGE",
          `Document uploads must be at most ${MAX_DOCUMENT_UPLOAD_BYTES} bytes`,
        );
      }
      await ingestion.putContent(
        workspaceId,
        assetId,
        new Uint8Array(await request.arrayBuffer()),
      );
      return new Response(null, {
        status: 204,
        headers: { "x-request-id": crypto.randomUUID() },
      });
    }

    if (method === "POST" && assetId && action === "complete") {
      const result = await ingestion.complete(workspaceId, assetId);
      await notifyDocumentExtractionTask(result.operation.id);
      return json({ data: result }, { status: 202 });
    }

    return apiError(405, "Method not allowed", "METHOD_NOT_ALLOWED");
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function memoryHistoryById(request: Request, id: string) {
  const startedAt = Date.now();
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const application = new MemoryApplication(await getMemoryEngine());
    const entries = await application.history(auth.apiToken.workspaceId, id);
    await recordPublicRequestLog({
      auth,
      httpStatus: 200,
      metadata: { memory_id: id, results: entries.length },
      operation: "memories.history",
      request,
      startedAt,
      status: "success",
    });
    return json({
      results: entries.map((h) => ({
        id: h.id,
        memory_id: h.memoryId,
        event: h.event,
        previous_value: h.previousValue,
        new_value: h.newValue,
        created_at: h.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    const failure = classifyMemoryError(err);
    await recordPublicRequestLog({
      auth,
      errorCode: failure.code,
      errorMessage: failure.message,
      httpStatus: failure.status,
      metadata: { memory_id: id },
      operation: "memories.history",
      request,
      startedAt,
      status: "failed",
    });
    return memoryErrorResponse(err);
  }
}

export async function getOperationById(request: Request, id: string) {
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const task = await auth.db
      .select()
      .from(operationTasks)
      .where(
        and(
          eq(operationTasks.workspaceId, auth.apiToken.workspaceId),
          eq(operationTasks.documentId, id),
        ),
      )
      .get();
    if (task) return json(shapeOperationTask(task));
    const application = new MemoryApplication(await getMemoryEngine());
    return json(await application.getOperation(auth.apiToken.workspaceId, id));
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function retryMemoryOperation(request: Request, id: string) {
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const task = await retryOperationTask(
      auth.db,
      auth.apiToken.workspaceId,
      id,
    );
    if (!task) {
      return apiError(
        404,
        "Retryable operation not found",
        "OPERATION_NOT_RETRYABLE",
      );
    }
    await notifyOperationTask(task.documentId);
    return json(shapeOperationTask(task), { status: 202 });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function listMemoryOperations(request: Request) {
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
  try {
    const application = new MemoryApplication(await getMemoryEngine());
    const [journal, tasks] = await Promise.all([
      application.listOperations(auth.apiToken.workspaceId, limit),
      auth.db
        .select()
        .from(operationTasks)
        .where(eq(operationTasks.workspaceId, auth.apiToken.workspaceId))
        .orderBy(desc(operationTasks.createdAt))
        .limit(limit),
    ]);
    return json({
      results: [...journal.results, ...tasks.map(shapeOperationTask)]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit),
    });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function getMemoryInferenceEventById(
  request: Request,
  eventId: string,
) {
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const event = await getMemoryEvent(
      auth.db,
      auth.apiToken.workspaceId,
      eventId,
    );
    if (!event) return apiError(404, "Event not found", "EVENT_NOT_FOUND");
    return json(event);
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function listMemoryInferenceEvents(request: Request) {
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    return json(
      await listMemoryEvents(
        auth.db,
        auth.apiToken.workspaceId,
        queryRecord(request),
      ),
    );
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

type OperationalHealth = {
  tasks: {
    pending: number;
    dead: number;
    oldestPendingAt?: Date;
  };
  warningsLast24h: number;
};

function aggregateDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const numeric =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function readOperationalHealth(
  db: AppDb,
  workspaceId: string,
  now: Date,
): Promise<OperationalHealth> {
  const [taskRows, warningRows] = await Promise.all([
    db
      .select({
        pending: sql<number>`sum(case when ${operationTasks.status} in ('pending', 'processing', 'retry') then 1 else 0 end)`,
        dead: sql<number>`sum(case when ${operationTasks.status} = 'dead' then 1 else 0 end)`,
        oldestPendingAt: sql<number | null>`min(case when ${operationTasks.status} in ('pending', 'processing', 'retry') then ${operationTasks.createdAt} end)`,
      })
      .from(operationTasks)
      .where(eq(operationTasks.workspaceId, workspaceId)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(observabilityEvents)
      .where(
        and(
          eq(observabilityEvents.workspaceId, workspaceId),
          eq(observabilityEvents.kind, "warning"),
          gte(
            observabilityEvents.createdAt,
            new Date(now.getTime() - 24 * 60 * 60 * 1_000),
          ),
        ),
      ),
  ]);
  const tasks = taskRows[0];
  const oldestPendingAt = aggregateDate(tasks?.oldestPendingAt);
  return {
    tasks: {
      pending: Number(tasks?.pending ?? 0),
      dead: Number(tasks?.dead ?? 0),
      ...(oldestPendingAt ? { oldestPendingAt } : {}),
    },
    warningsLast24h: Number(warningRows[0]?.count ?? 0),
  };
}

export type MemoryHealthDependencies = {
  authenticate: typeof authenticateMemoryApi;
  describeProvider: typeof describeProviderConfig;
  getEngine: typeof getMemoryEngine;
  readOperationalHealth: typeof readOperationalHealth;
  now: () => Date;
};

const defaultMemoryHealthDependencies: MemoryHealthDependencies = {
  authenticate: authenticateMemoryApi,
  describeProvider: describeProviderConfig,
  getEngine: getMemoryEngine,
  readOperationalHealth,
  now: () => new Date(),
};

export async function getMemoryHealth(
  request: Request,
  dependencies: MemoryHealthDependencies = defaultMemoryHealthDependencies,
): Promise<Response> {
  const auth = await dependencies.authenticate(request);
  if ("error" in auth) return auth.error!;

  const now = dependencies.now();
  const [provider, operational] = await Promise.all([
    dependencies.describeProvider(),
    dependencies.readOperationalHealth(
      auth.db,
      auth.apiToken.workspaceId,
      now,
    ),
  ]);
  let initialized = false;
  let engineCode: string | null = provider.configured
    ? null
    : "ENGINE_NOT_CONFIGURED";
  let operations: OperationSummary = {
    pending: 0,
    failed: 0,
    vectorPending: 0,
    derivedPending: 0,
  };
  if (provider.configured) {
    try {
      const engine = await dependencies.getEngine();
      operations = await engine
        .forNamespace(auth.apiToken.workspaceId)
        .summarizeOperations();
      initialized = true;
    } catch {
      engineCode = "ENGINE_UNAVAILABLE";
    }
  }

  const backlogThresholdMs = 5 * 60 * 1_000;
  const operationBacklogStale =
    operations.oldestPendingAt !== undefined &&
    now.getTime() - operations.oldestPendingAt.getTime() >= backlogThresholdMs;
  const taskBacklogStale =
    operational.tasks.oldestPendingAt !== undefined &&
    now.getTime() - operational.tasks.oldestPendingAt.getTime() >=
      backlogThresholdMs;
  const degraded =
    !provider.configured ||
    !initialized ||
    operations.failed > 0 ||
    operational.tasks.dead > 0 ||
    operationBacklogStale ||
    taskBacklogStale;

  return json({
    status: degraded ? "degraded" : "ok",
    checked_at: now.toISOString(),
    engine: {
      configured: provider.configured,
      initialized,
      code: engineCode,
    },
    operations: {
      pending: operations.pending,
      failed: operations.failed,
      oldest_pending_at: operations.oldestPendingAt?.toISOString() ?? null,
    },
    tasks: {
      pending: operational.tasks.pending,
      dead: operational.tasks.dead,
      oldest_pending_at:
        operational.tasks.oldestPendingAt?.toISOString() ?? null,
    },
    projections: {
      vector_pending: operations.vectorPending,
      derived_pending: operations.derivedPending,
    },
    warnings: { last_24h: operational.warningsLast24h },
  });
}

function shapeOperationTask(task: typeof operationTasks.$inferSelect) {
  return {
    id: task.documentId,
    kind: task.kind,
    status: task.status,
    attempts: task.attempts,
    max_attempts: task.maxAttempts,
    error: task.error,
    next_attempt_at: task.nextAttemptAt?.toISOString() ?? null,
    result: task.result ?? null,
    started_at: task.startedAt?.toISOString() ?? null,
    completed_at: task.completedAt?.toISOString() ?? null,
    created_at: task.createdAt.toISOString(),
    updated_at: task.updatedAt.toISOString(),
  };
}

function queryRecord(request: Request) {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}

function requiredIdempotencyKey(request: Request) {
  const value = request.headers.get("Idempotency-Key")?.trim();
  if (!value || value.length > 200) {
    throw new MemoryApplicationError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must contain 1 to 200 characters",
      400,
    );
  }
  return value;
}

export async function createMemoryExport(request: Request) {
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const key = requiredIdempotencyKey(request);
    const task = await enqueueOperationTask(auth.db, {
      workspaceId: auth.apiToken.workspaceId,
      operationId: `export:${key}`,
      kind: "export",
      payload: {},
    });
    await dispatchPendingMemoryTasks(auth.db, getMemoryEngine);
    return json(shapeOperationTask(task), { status: 202 });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function createMemoryImport(request: Request) {
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const key = requiredIdempotencyKey(request);
    const body = await request.json();
    if (!isRecord(body) || !("snapshot" in body)) {
      throw new MemoryApplicationError(
        "INVALID_SNAPSHOT",
        "snapshot is required",
        400,
      );
    }
    const snapshot = sanitizePublicSnapshot(body.snapshot);
    parseNamespaceSnapshot(snapshot, auth.apiToken.workspaceId);
    const task = await enqueueOperationTask(auth.db, {
      workspaceId: auth.apiToken.workspaceId,
      operationId: `import:${key}`,
      kind: "import",
      payload: { snapshot },
    });
    await dispatchPendingMemoryTasks(auth.db, getMemoryEngine);
    return json(shapeOperationTask(task), { status: 202 });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function getMemoryState(request: Request) {
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const application = new MemoryApplication(await getMemoryEngine());
    const state = await application.getState(
      auth.apiToken.workspaceId,
      queryRecord(request),
    );
    return json({ data: state ? shapeStateSlot(state) : null });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function getMemoryStateHistory(request: Request) {
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const application = new MemoryApplication(await getMemoryEngine());
    const history = await application.getStateHistory(
      auth.apiToken.workspaceId,
      queryRecord(request),
    );
    return json({ data: history.map(shapeStateSlot) });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function getMemoryBeliefs(request: Request) {
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const application = new MemoryApplication(await getMemoryEngine());
    const view = await application.getBeliefView(
      auth.apiToken.workspaceId,
      queryRecord(request),
    );
    return json({ data: shapeBeliefView(view) });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function getMemoryProfile(request: Request) {
  const auth = await authenticateMemoryApi(request);
  if ("error" in auth) return auth.error;
  try {
    const application = new MemoryApplication(await getMemoryEngine());
    return json({
      data: await application.getProfile(
        auth.apiToken.workspaceId,
        queryRecord(request),
      ),
    });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}
