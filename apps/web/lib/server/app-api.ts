import { and, avg, count, desc, eq, gte, sql } from "drizzle-orm";
import {
  apiTokens,
  engineConfig,
  observabilityEvents,
  operationTasks,
  providerPriceSnapshots,
  projectSettings,
  requestLogs,
  webhookDeliveries,
  webhookEndpoints,
  workspaces,
} from "@/db/schema";
import type { AppDb } from "@/db";
import {
  createProjectForUser,
  getCurrentAppUser,
  getServerDb,
  toWorkspace,
  updateCurrentAppUser,
} from "@/lib/server/user";
import { resolveCurrentWorkspace, type AppUser } from "@/lib/user";
import { getRuntimeEnv } from "@/lib/cloudflare";
import { sendInviteEmail } from "@/lib/server/email";
import {
  createInvite,
  listInvites,
  revokeInvite,
  setInviteRole,
} from "@/lib/server/invites";
import { getObservabilitySummary } from "@/lib/server/observability";
import { createDocumentIngestion } from "@/lib/server/document-ingestion";
import {
  enqueueOperationTask,
  retryOperationTask,
} from "@/lib/server/operation-tasks";
import {
  appDocumentUploadsHandler,
  appDocumentsHandler,
  appEntitiesHandler,
  appMemoriesHandler,
  describeProviderConfig,
  getMemoryEngine,
  readEngineConfig,
  resetMemoryEngine,
} from "@/lib/server/memory-api";
import { dispatchPendingMemoryTasks } from "@/lib/server/memory-task-worker";
import { hashToken } from "@/lib/server/token";
import { retryWebhookDelivery } from "@/lib/server/webhook-outbox";
import {
  DEFAULT_MEMORY_CATEGORIES,
  DEFAULT_MEMORY_INSTRUCTIONS,
} from "@/lib/server/memory-inference-policy";

type RouteHandler = (
  request: Request,
  path: string[],
  url: URL,
  db: AppDb,
  user: AppUser,
) => Promise<Response>;

function json(payload: unknown, init?: ResponseInit) {
  return Response.json(payload, init);
}

function now() {
  return new Date();
}

function documentId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function randomHex(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function toHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function signWebhookPayload(secret: string, payload: string, timestamp: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  return `v1=${toHex(signature)}`;
}

function maskToken(token: string) {
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

export const API_TOKEN_PERMISSIONS = [
  "memory:read",
  "memory:write",
  "operations:read",
] as const;

function parseApiTokenPermissions(value: unknown): string[] {
  if (value === undefined) return [...API_TOKEN_PERMISSIONS];
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("At least one API key permission is required");
  }
  const permissions = [...new Set(value)];
  if (
    permissions.some(
      (permission) =>
        typeof permission !== "string" ||
        !API_TOKEN_PERMISSIONS.includes(
          permission as (typeof API_TOKEN_PERMISSIONS)[number],
        ),
    )
  ) {
    throw new TypeError("API key permissions contain an unsupported value");
  }
  return permissions as string[];
}

function parseApiTokenExpiry(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new TypeError("API key expiry must be an ISO date-time");
  }
  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new TypeError("API key expiry must be in the future");
  }
  return expiresAt;
}

function toApiToken(row: typeof apiTokens.$inferSelect, token?: string) {
  const expired = Boolean(
    row.expiresAt && row.expiresAt.getTime() <= Date.now(),
  );
  return {
    id: row.id,
    documentId: row.documentId,
    name: row.name,
    token,
    masked_token: row.maskedToken,
    status: expired ? "expired" : (row.status as "active" | "revoked"),
    permissions: row.permissions,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWebhook(row: typeof webhookEndpoints.$inferSelect, includeSecret = false) {
  return {
    id: row.id,
    documentId: row.documentId,
    url: row.url,
    description: row.description ?? "",
    enabled: row.enabled,
    events: row.events as Array<string>,
    secret: includeSecret ? row.secret : undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDelivery(row: typeof webhookDeliveries.$inferSelect) {
  return {
    id: row.id,
    documentId: row.documentId,
    eventId: row.eventId,
    eventType: row.eventType,
    taskId: row.taskId,
    status: row.status,
    attempts: row.attempts,
    httpStatus: row.httpStatus,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

function getWorkspace(user: AppUser, requestedWorkspaceId?: string | null) {
  return (
    resolveCurrentWorkspace(user, requestedWorkspaceId) ??
    user.workspaces?.[0] ??
    null
  );
}

function requestedWorkspaceFromUrl(url: URL) {
  return url.searchParams.get("workspace");
}

const MEMORY_ENDPOINT_LABELS: Record<string, string> = {
  "memories.add": "POST /v1/memories (inferred)",
  "memories.add_raw": "POST /v1/memories (verbatim)",
  "memories.search": "POST /v1/memories/search",
  "memories.list": "GET /v1/memories",
  "memories.get": "GET /v1/memories/:id",
  "memories.update": "PUT /v1/memories/:id",
  "memories.delete": "DELETE /v1/memories/:id",
  "memories.delete_all": "DELETE /v1/memories",
  "memories.batch_update": "PUT /v1/memories/batch",
  "memories.batch_delete": "DELETE /v1/memories/batch",
  "memories.history": "GET /v1/memories/:id/history",
  "documents.ingest": "POST /v1/documents",
  "documents.search": "POST /v1/documents/search",
  "documents.list": "GET /v1/documents",
  "documents.get": "GET /v1/documents/:id",
  "documents.content": "GET /v1/documents/:id/content",
  "documents.delete": "DELETE /v1/documents/:id",
};

function sinceForRange(range: string) {
  if (range === "all" || range === "this_cycle") {
    return null;
  }
  if (range === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start;
  }
  const days = range === "last_90_days" ? 90 : range === "last_30_days" ? 30 : 7;
  return new Date(Date.now() - days * 86_400_000);
}

function requestLogLabel(row: typeof requestLogs.$inferSelect) {
  return MEMORY_ENDPOINT_LABELS[row.operation] ?? `${row.method} ${row.path}`;
}

const DEFAULT_WEBHOOK_EVENTS = [
  "memory_add",
  "memory_update",
  "memory_delete",
  "document_ingest",
  "document_delete",
];

function toProjectSettings(row?: typeof projectSettings.$inferSelect | null) {
  return {
    instructions: row?.instructions || DEFAULT_MEMORY_INSTRUCTIONS,
    categories: row?.categories?.length
      ? row.categories
      : DEFAULT_MEMORY_CATEGORIES,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

async function handleUsers(
  request: Request,
  path: string[],
  _url: URL,
  _db: AppDb,
  user: AppUser,
) {
  if (path[1] !== "me") {
    return json({ message: "Not found" }, { status: 404 });
  }

  if (request.method === "GET") {
    return json({ data: user });
  }

  if (request.method === "PUT" || request.method === "PATCH") {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
    };
    const updated = await updateCurrentAppUser({ name: body.name });
    return json({ data: updated });
  }

  return json({ message: "Method not allowed" }, { status: 405 });
}

async function handleProjects(
  request: Request,
  path: string[],
  _url: URL,
  db: AppDb,
  user: AppUser,
) {
  const projectId = path[1];

  if (!projectId && request.method === "GET") {
    return json({ data: user.workspaces ?? [] });
  }

  if (!projectId && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
    };
    const [existing] = await db
      .select({ count: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.ownerId, String(user.id)))
      .limit(1);
    if (!existing) {
      await getCurrentAppUser();
    }
    const row = await createProjectForUser({
      db,
      userId: String(user.id),
      name: body.name ?? "Untitled project",
      description: typeof body.description === "string" ? body.description : "",
    });
    return json({ data: toWorkspace(row) });
  }

  const workspace = getWorkspace(user, projectId);
  if (!workspace || workspace.documentId !== projectId) {
    return json({ message: "Project not found" }, { status: 404 });
  }

  if (request.method === "PATCH" || request.method === "PUT") {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
    };
    const name = body.name?.trim().slice(0, 80);
    if (!name) {
      return json({ message: "Project name is required" }, { status: 400 });
    }
    const patch: { name: string; updatedAt: Date; description?: string } = {
      name,
      updatedAt: now(),
    };
    if (typeof body.description === "string") {
      patch.description = body.description.slice(0, 500);
    }
    const [row] = await db
      .update(workspaces)
      .set(patch)
      .where(
        and(
          eq(workspaces.documentId, projectId),
          eq(workspaces.ownerId, String(user.id)),
        ),
      )
      .returning();
    return json({ data: row ? toWorkspace(row) : null });
  }

  if (request.method === "DELETE") {
    // Revoke access and queued work before erasing the namespace so no new
    // operation can repopulate it while the project is being deleted.
    await db
      .delete(apiTokens)
      .where(eq(apiTokens.workspaceId, projectId));
    await db
      .delete(operationTasks)
      .where(eq(operationTasks.workspaceId, projectId));
    await (await getMemoryEngine()).forNamespace(projectId).purgeAll();
    await (await createDocumentIngestion(db)).deleteWorkspace(projectId);
    await db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.workspaceId, projectId));
    await db
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.workspaceId, projectId));
    await db
      .delete(observabilityEvents)
      .where(eq(observabilityEvents.workspaceId, projectId));
    await db
      .delete(providerPriceSnapshots)
      .where(eq(providerPriceSnapshots.workspaceId, projectId));
    await db
      .delete(workspaces)
      .where(
        and(
          eq(workspaces.documentId, projectId),
          eq(workspaces.ownerId, String(user.id)),
        ),
      );
    return new Response(null, { status: 204 });
  }

  return json({ message: "Method not allowed" }, { status: 405 });
}

async function handleApiTokens(
  request: Request,
  path: string[],
  url: URL,
  db: AppDb,
  user: AppUser,
) {
  const tokenId = path[1];
  const action = path[2];

  if (!tokenId && request.method === "GET") {
    const workspace = getWorkspace(user, requestedWorkspaceFromUrl(url));
    if (!workspace?.documentId) {
      return json({ message: "Project not found" }, { status: 404 });
    }
    const rows = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.workspaceId, workspace.documentId))
      .orderBy(desc(apiTokens.createdAt))
      .all();
    return json({ data: rows.map((row) => toApiToken(row)) });
  }

  if (!tokenId && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      workspace?: string;
      permissions?: unknown;
      expires_at?: unknown;
    };
    const workspace = getWorkspace(
      user,
      body.workspace ?? requestedWorkspaceFromUrl(url),
    );
    if (!workspace?.documentId) {
      return json({ message: "Project not found" }, { status: 404 });
    }
    let permissions: string[];
    let expiresAt: Date | null;
    try {
      permissions = parseApiTokenPermissions(body.permissions);
      expiresAt = parseApiTokenExpiry(body.expires_at);
    } catch (error) {
      return json(
        { message: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
    const token = `fm_${randomHex(24)}`;
    const createdAt = now();
    const id = documentId("key");
    const [row] = await db
      .insert(apiTokens)
      .values({
        id,
        documentId: id,
        workspaceId: workspace.documentId,
        userId: String(user.id),
        name: body.name?.trim() || "FishMem API key",
        tokenHash: await hashToken(token),
        maskedToken: maskToken(token),
        status: "active",
        permissions,
        expiresAt,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    return json({ data: toApiToken(row, token) });
  }

  if (!tokenId) {
    return json({ message: "Not found" }, { status: 404 });
  }

  const workspace = getWorkspace(user, requestedWorkspaceFromUrl(url));
  if (!workspace?.documentId) {
    return json({ message: "Project not found" }, { status: 404 });
  }

  if (action === "usage" && request.method === "GET") {
    const rows = await db
      .select()
      .from(requestLogs)
      .where(
        and(
          eq(requestLogs.workspaceId, workspace.documentId),
          eq(requestLogs.apiTokenId, tokenId),
        ),
      )
      .orderBy(desc(requestLogs.createdAt))
      .limit(500)
      .all();
    const daily = new Map<string, number>();
    for (const row of rows) {
      const day = row.createdAt.toISOString().slice(0, 10);
      daily.set(day, (daily.get(day) ?? 0) + 1);
    }
    return json({
      data: {
        tokenId,
        totalRequests: rows.length,
        successfulRequests: rows.filter((row) => row.status === "success").length,
        failedRequests: rows.filter((row) => row.status === "failed").length,
        last_used_at: rows[0]?.createdAt.toISOString(),
        dailyUsage: [...daily.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, requests]) => ({ date, requests })),
      },
    });
  }

  if (action === "revoke" && request.method === "POST") {
    const updatedAt = now();
    const [row] = await db
      .update(apiTokens)
      .set({ status: "revoked", revokedAt: updatedAt, updatedAt })
      .where(
        and(
          eq(apiTokens.documentId, tokenId),
          eq(apiTokens.workspaceId, workspace.documentId),
        ),
      )
      .returning();
    return json({ data: row ? toApiToken(row) : null });
  }

  if (action === "activate" && request.method === "POST") {
    const [row] = await db
      .update(apiTokens)
      .set({ status: "active", revokedAt: null, updatedAt: now() })
      .where(
        and(
          eq(apiTokens.documentId, tokenId),
          eq(apiTokens.workspaceId, workspace.documentId),
        ),
      )
      .returning();
    return json({ data: row ? toApiToken(row) : null });
  }

  if (request.method === "PUT" || request.method === "PATCH") {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      permissions?: unknown;
      expires_at?: unknown;
    };
    const patch: {
      name?: string;
      permissions?: string[];
      expiresAt?: Date | null;
      updatedAt: Date;
    } = { updatedAt: now() };
    if (body.name !== undefined) patch.name = body.name.trim() || "API key";
    try {
      if (body.permissions !== undefined) {
        patch.permissions = parseApiTokenPermissions(body.permissions);
      }
      if (body.expires_at !== undefined) {
        patch.expiresAt = parseApiTokenExpiry(body.expires_at);
      }
    } catch (error) {
      return json(
        { message: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
    const [row] = await db
      .update(apiTokens)
      .set(patch)
      .where(
        and(
          eq(apiTokens.documentId, tokenId),
          eq(apiTokens.workspaceId, workspace.documentId),
        ),
      )
      .returning();
    return json({ data: row ? toApiToken(row) : null });
  }

  if (request.method === "DELETE") {
    await db
      .delete(apiTokens)
      .where(
        and(
          eq(apiTokens.documentId, tokenId),
          eq(apiTokens.workspaceId, workspace.documentId),
        ),
      );
    return new Response(null, { status: 204 });
  }

  return json({ message: "Method not allowed" }, { status: 405 });
}

async function handleUsage(
  _request: Request,
  _path: string[],
  url: URL,
  db: AppDb,
  user: AppUser,
) {
  const range = url.searchParams.get("range") || "last_7_days";
  const since = sinceForRange(range);
  const workspace = getWorkspace(user, requestedWorkspaceFromUrl(url));

  const empty = {
    range,
    metrics: {
      totalRequests: { label: "Requests", value: 0, trend: "neutral" },
      successRate: { label: "Success rate", value: 100, formattedValue: "100%" },
      avgLatency: { label: "Avg latency", value: 0, formattedValue: "—" },
    },
    dailyUsage: [] as Array<{ date: string; requests: number }>,
    topApiKeys: [],
    topEndpoints: [] as Array<{ endpoint: string; requests: number }>,
    observability: {
      events: 0,
      inputTokens: 0,
      outputTokens: 0,
      knownCostMicros: 0,
      unpricedCalls: 0,
      warnings: 0,
      retries: 0,
      p50LatencyMs: null,
      p95LatencyMs: null,
    },
  };
  if (!workspace) return json({ data: empty });

  const where = since
    ? and(
        eq(requestLogs.workspaceId, workspace.documentId),
        gte(requestLogs.createdAt, since),
      )
    : eq(requestLogs.workspaceId, workspace.documentId);
  const day = sql<string>`date(${requestLogs.createdAt} / 1000, 'unixepoch')`;
  const [totals, dailyUsage, endpointUsage, keyUsage] = await Promise.all([
    db
      .select({
        requests: count(),
        successful: sql<number>`sum(case when ${requestLogs.status} = 'success' then 1 else 0 end)`,
        avgLatency: avg(requestLogs.latencyMs),
      })
      .from(requestLogs)
      .where(where)
      .get(),
    db
      .select({ date: day, requests: count() })
      .from(requestLogs)
      .where(where)
      .groupBy(day)
      .orderBy(day)
      .all(),
    db
      .select({ operation: requestLogs.operation, requests: count() })
      .from(requestLogs)
      .where(where)
      .groupBy(requestLogs.operation)
      .orderBy(desc(count()))
      .all(),
    db
      .select({
        keyId: requestLogs.apiTokenId,
        keyName: requestLogs.apiTokenName,
        requests: count(),
      })
      .from(requestLogs)
      .where(where)
      .groupBy(requestLogs.apiTokenId, requestLogs.apiTokenName)
      .orderBy(desc(count()))
      .all(),
  ]);
  const totalRequests = totals?.requests ?? 0;
  const successful = totals?.successful ?? 0;
  const successRate = totalRequests
    ? Math.round((successful / totalRequests) * 1000) / 10
    : 100;
  const averageLatency = totals?.avgLatency
    ? Math.round(Number(totals.avgLatency))
    : 0;
  const observability = await getObservabilitySummary(
    db,
    workspace.documentId,
    since ?? undefined,
  );

  return json({
    data: {
      ...empty,
      metrics: {
        ...empty.metrics,
        totalRequests: { label: "Requests", value: totalRequests, trend: "neutral" },
        successRate: {
          label: "Success rate",
          value: successRate,
          formattedValue: `${successRate}%`,
        },
        avgLatency: {
          label: "Avg latency",
          value: averageLatency,
          formattedValue: averageLatency ? `${averageLatency} ms` : "—",
        },
      },
      dailyUsage,
      topEndpoints: endpointUsage.map(({ operation, requests }) => ({
        endpoint: MEMORY_ENDPOINT_LABELS[operation] ?? operation,
        requests,
      })),
      topApiKeys: keyUsage.map(({ keyId, keyName, requests }) => ({
        keyId: keyId ?? "dashboard",
        keyName: keyName ?? (keyId ? "API key" : "Dashboard"),
        requests,
        percentage: totalRequests
          ? Math.round((requests / totalRequests) * 100)
          : 0,
      })),
      observability,
    },
  });
}

async function handleRequests(
  _request: Request,
  _path: string[],
  url: URL,
  db: AppDb,
  user: AppUser,
) {
  const range = url.searchParams.get("range") || "last_30_days";
  const since = sinceForRange(range);
  const workspace = getWorkspace(user, requestedWorkspaceFromUrl(url));
  if (!workspace?.documentId) {
    return json({ message: "Project not found" }, { status: 404 });
  }

  const where = since
    ? and(
        eq(requestLogs.workspaceId, workspace.documentId),
        gte(requestLogs.createdAt, since),
      )
    : eq(requestLogs.workspaceId, workspace.documentId);
  const [rows, summary] = await Promise.all([
    db
    .select()
    .from(requestLogs)
    .where(where)
    .orderBy(desc(requestLogs.createdAt))
    .limit(200)
    .all(),
    db
      .select({
        totalRequests: count(),
        addEvents: sql<number>`sum(case when ${requestLogs.operation} in ('memories.add', 'memories.add_raw') then 1 else 0 end)`,
        retrievalEvents: sql<number>`sum(case when ${requestLogs.operation} in ('memories.search', 'memories.list') then 1 else 0 end)`,
        failedRequests: sql<number>`sum(case when ${requestLogs.status} = 'failed' then 1 else 0 end)`,
      })
      .from(requestLogs)
      .where(where)
      .get(),
  ]);

  return json({
    data: rows.map((row) => ({
      id: row.documentId,
      createdAt: row.createdAt.toISOString(),
      endpoint: requestLogLabel(row),
      method: row.method,
      path: row.path,
      kind: row.operation,
      status: row.status,
      httpStatus: row.httpStatus,
      latencyMs: row.latencyMs,
      apiKey: row.apiTokenName,
      description: row.errorMessage,
      metadata: row.metadata,
    })),
    summary: {
      range,
      totalRequests: summary?.totalRequests ?? 0,
      addEvents: summary?.addEvents ?? 0,
      retrievalEvents: summary?.retrievalEvents ?? 0,
      failedRequests: summary?.failedRequests ?? 0,
    },
    page: { limit: 200, truncated: (summary?.totalRequests ?? 0) > rows.length },
  });
}

function dashboardOperationTask(task: typeof operationTasks.$inferSelect) {
  const taskResult =
    task.result && typeof task.result === "object" && !Array.isArray(task.result)
      ? (task.result as Record<string, unknown>)
      : null;
  const resultDocument =
    taskResult?.document &&
    typeof taskResult.document === "object" &&
    !Array.isArray(taskResult.document)
      ? (taskResult.document as Record<string, unknown>)
      : null;
  const retrieval =
    taskResult?.retrieval &&
    typeof taskResult.retrieval === "object" &&
    !Array.isArray(taskResult.retrieval)
      ? (taskResult.retrieval as Record<string, unknown>)
      : null;
  return {
    id: task.documentId,
    kind: task.kind,
    status: task.status,
    attempts: task.attempts,
    max_attempts: task.maxAttempts,
    error: task.error,
    result: task.result,
    next_attempt_at: task.nextAttemptAt?.toISOString() ?? null,
    started_at: task.startedAt?.toISOString() ?? null,
    completed_at: task.completedAt?.toISOString() ?? null,
    ...(task.kind === "memory_infer"
      ? {
          result_count:
            task.result &&
            typeof task.result === "object" &&
            !Array.isArray(task.result) &&
            Array.isArray((task.result as { results?: unknown }).results)
              ? (task.result as { results: unknown[] }).results.length
              : 0,
        }
      : {}),
    ...(task.kind === "document_extract"
      ? {
          document_id:
            typeof resultDocument?.id === "string" ? resultDocument.id : null,
          chunks:
            typeof taskResult?.chunks === "number" ? taskResult.chunks : null,
          query_visibility_target_ms:
            typeof retrieval?.visibility_target_ms === "number"
              ? retrieval.visibility_target_ms
              : null,
        }
      : {}),
    created_at: task.createdAt.toISOString(),
    updated_at: task.updatedAt.toISOString(),
  };
}

async function handleOperations(
  request: Request,
  path: string[],
  url: URL,
  db: AppDb,
  user: AppUser,
) {
  const workspace = getWorkspace(user, requestedWorkspaceFromUrl(url));
  if (!workspace?.documentId) {
    return json({ message: "Project not found" }, { status: 404 });
  }
  if (request.method === "POST" && path[1] === "rebuild") {
    if (user.role !== "admin") {
      return json({ message: "Admins only" }, { status: 403 });
    }
    const task = await enqueueOperationTask(db, {
      workspaceId: workspace.documentId,
      operationId: crypto.randomUUID(),
      kind: "rebuild",
      payload: { reason: "operator_requested" },
    });
    await dispatchPendingMemoryTasks(db, getMemoryEngine);
    return json({ data: task }, { status: 202 });
  }
  if (request.method === "POST" && path[2] === "retry") {
    const task = await retryOperationTask(
      db,
      workspace.documentId,
      path[1] ?? "",
    );
    if (task) await dispatchPendingMemoryTasks(db, getMemoryEngine);
    return task
      ? json({ data: task })
      : json({ message: "Retryable operation not found" }, { status: 404 });
  }
  if (request.method !== "GET") {
    return json({ message: "Method not allowed" }, { status: 405 });
  }
  if (path[1]) {
    const task = await db
      .select()
      .from(operationTasks)
      .where(
        and(
          eq(operationTasks.workspaceId, workspace.documentId),
          eq(operationTasks.documentId, path[1]),
        ),
      )
      .get();
    return task
      ? json({ data: dashboardOperationTask(task) })
      : json({ message: "Operation not found" }, { status: 404 });
  }
  const [tasks, events, webhookStates] = await Promise.all([
    db
      .select()
      .from(operationTasks)
      .where(eq(operationTasks.workspaceId, workspace.documentId))
      .orderBy(desc(operationTasks.createdAt))
      .limit(100),
    db
      .select()
      .from(observabilityEvents)
      .where(eq(observabilityEvents.workspaceId, workspace.documentId))
      .orderBy(desc(observabilityEvents.createdAt))
      .limit(200),
    db
      .select({ status: webhookDeliveries.status, deliveries: count() })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.workspaceId, workspace.documentId))
      .groupBy(webhookDeliveries.status),
  ]);
  const journal = await (await getMemoryEngine())
    .forNamespace(workspace.documentId)
    .listOperations(100);
  const taskRows = tasks.map(dashboardOperationTask);
  const warnings = events.filter((event) => event.warningCode !== null);
  const journalRows = journal.map((operation) => ({
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    attempts: operation.attempts,
    error: operation.error ?? null,
    raw_status: operation.rawStatus,
    vector_status: operation.vectorStatus,
    derived_status: operation.derivedStatus,
    created_at: operation.createdAt.toISOString(),
    updated_at: operation.updatedAt.toISOString(),
  }));
  return json({
    data: {
      operations: [...taskRows, ...journalRows]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 100),
      warnings: warnings.map((warning) => ({
        id: warning.documentId,
        code: warning.warningCode,
        metadata: warning.metadata,
        created_at: warning.createdAt.toISOString(),
      })),
      events: events.map((event) => ({
        id: event.documentId,
        kind: event.kind,
        operation_id: event.operationId,
        provider: event.provider,
        model: event.model,
        latency_ms: event.latencyMs,
        retry_count: event.retryCount,
        warning_code: event.warningCode,
        metadata: event.metadata,
        created_at: event.createdAt.toISOString(),
      })),
      health: {
        pending_tasks: tasks.filter((task) =>
          ["pending", "processing", "retry"].includes(task.status),
        ).length,
        dead_tasks: tasks.filter((task) => task.status === "dead").length,
        active_warnings: warnings.length,
        projection_repairs: journal.filter(
          (operation) =>
            operation.vectorStatus === "pending" ||
            operation.derivedStatus === "pending",
        ).length,
        webhooks: Object.fromEntries(
          webhookStates.map((row) => [row.status, row.deliveries]),
        ),
      },
    },
  });
}

async function handleProjectSettings(
  request: Request,
  _path: string[],
  url: URL,
  db: AppDb,
  user: AppUser,
) {
  const workspace = getWorkspace(user, requestedWorkspaceFromUrl(url));
  if (!workspace?.documentId) {
    return json({ message: "Project not found" }, { status: 404 });
  }

  if (request.method === "GET") {
    const row = await db
      .select()
      .from(projectSettings)
      .where(eq(projectSettings.workspaceId, workspace.documentId))
      .get();
    return json({ data: toProjectSettings(row) });
  }

  if (request.method === "PATCH" || request.method === "PUT") {
    const body = (await request.json().catch(() => ({}))) as {
      instructions?: string;
      categories?: unknown;
    };
    const nowValue = now();
    const current = await db
      .select()
      .from(projectSettings)
      .where(eq(projectSettings.workspaceId, workspace.documentId))
      .get();
    const categories = Array.isArray(body.categories)
      ? body.categories
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 24)
      : current?.categories ?? DEFAULT_MEMORY_CATEGORIES;
    const instructions =
      typeof body.instructions === "string"
        ? body.instructions.trim().slice(0, 5000)
        : current?.instructions ?? DEFAULT_MEMORY_INSTRUCTIONS;

    if (current) {
      const [row] = await db
        .update(projectSettings)
        .set({ instructions, categories, updatedAt: nowValue })
        .where(eq(projectSettings.workspaceId, workspace.documentId))
        .returning();
      return json({ data: toProjectSettings(row) });
    }

    const id = documentId("ps");
    const [row] = await db
      .insert(projectSettings)
      .values({
        id,
        documentId: id,
        workspaceId: workspace.documentId,
        instructions,
        categories,
        createdAt: nowValue,
        updatedAt: nowValue,
      })
      .returning();
    return json({ data: toProjectSettings(row) });
  }

  return json({ message: "Method not allowed" }, { status: 405 });
}

async function handleWebhooks(
  request: Request,
  path: string[],
  url: URL,
  db: AppDb,
  user: AppUser,
) {
  const id = path[1];
  const action = path[2];

  if (!id && request.method === "GET") {
    const workspace = getWorkspace(user, requestedWorkspaceFromUrl(url));
    if (!workspace?.documentId) {
      return json({ message: "Project not found" }, { status: 404 });
    }
    const rows = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.workspaceId, workspace.documentId))
      .orderBy(desc(webhookEndpoints.createdAt))
      .all();
    return json({ data: rows.map((row) => toWebhook(row)) });
  }

  if (!id && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      url?: string;
      description?: string;
      events?: string[];
      enabled?: boolean;
      workspace?: string;
    };
    const workspace = getWorkspace(
      user,
      body.workspace ?? requestedWorkspaceFromUrl(url),
    );
    if (!workspace?.documentId) {
      return json({ message: "Project not found" }, { status: 404 });
    }
    if (!body.url) {
      return json({ message: "Webhook URL is required" }, { status: 400 });
    }
    const createdAt = now();
    const documentIdValue = documentId("wh");
    const [row] = await db
      .insert(webhookEndpoints)
      .values({
        id: documentIdValue,
        documentId: documentIdValue,
        workspaceId: workspace.documentId,
        url: body.url,
        description: body.description ?? "",
        enabled: body.enabled ?? true,
        events: body.events?.length
          ? body.events
          : DEFAULT_WEBHOOK_EVENTS,
        secret: `whsec_${randomHex(24)}`,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    return json({ data: toWebhook(row, true) });
  }

  if (!id) {
    return json({ message: "Not found" }, { status: 404 });
  }

  const workspace = getWorkspace(user, requestedWorkspaceFromUrl(url));
  if (!workspace?.documentId) {
    return json({ message: "Project not found" }, { status: 404 });
  }

  if (action === "deliveries") {
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, id))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(25)
      .all();
    return json({ data: rows.map(toDelivery) });
  }

  if (action === "replay" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      delivery_id?: string;
    };
    if (!body.delivery_id) {
      return json({ message: "Delivery id is required" }, { status: 400 });
    }
    const delivery = await retryWebhookDelivery(
      db,
      workspace.documentId,
      body.delivery_id,
    );
    return delivery
      ? json({ data: toDelivery(delivery) })
      : json({ message: "Retryable delivery not found" }, { status: 404 });
  }

  if (action === "rotate-secret" && request.method === "POST") {
    const [row] = await db
      .update(webhookEndpoints)
      .set({ secret: `whsec_${randomHex(24)}`, updatedAt: now() })
      .where(eq(webhookEndpoints.documentId, id))
      .returning();
    return json({ data: row ? toWebhook(row, true) : null });
  }

  if (action === "test" && request.method === "POST") {
    const createdAt = now();
    const deliveryId = documentId("wd");
    const eventId = documentId("evt");
    const endpoint = await db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.documentId, id),
          eq(webhookEndpoints.workspaceId, workspace.documentId),
        ),
      )
      .get();
    if (!endpoint) {
      return json({ message: "Webhook not found" }, { status: 404 });
    }
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      documentId: deliveryId,
      endpointId: id,
      workspaceId: workspace.documentId,
      eventId,
      eventType: "webhook.test",
      status: "processing",
      attempts: 1,
      updatedAt: createdAt,
      createdAt,
    });
    const startedAt = Date.now();
    const timestamp = Math.floor(startedAt / 1000);
    const payload = JSON.stringify({
      id: eventId,
      type: "webhook.test",
      created_at: createdAt.toISOString(),
      project_id: workspace.documentId,
      data: {
        message: "Test event from FishMem",
      },
    });
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "FishMem-Webhooks/1.0",
          "x-fishmem-delivery": deliveryId,
          "x-fishmem-event": "webhook.test",
          "x-fishmem-signature": await signWebhookPayload(
            endpoint.secret,
            payload,
            timestamp,
          ),
          "x-fishmem-timestamp": String(timestamp),
        },
        body: payload,
      });
      await db
        .update(webhookDeliveries)
        .set({
          status: response.ok ? "success" : "failed",
          httpStatus: response.status,
          error: response.ok ? null : `HTTP ${response.status}`,
        })
        .where(eq(webhookDeliveries.documentId, deliveryId));
      return json({
        data: {
          success: response.ok,
          httpStatus: response.status,
          responseTime: Date.now() - startedAt,
          error: response.ok ? undefined : `HTTP ${response.status}`,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Delivery failed";
      await db
        .update(webhookDeliveries)
        .set({ status: "failed", error: message })
        .where(eq(webhookDeliveries.documentId, deliveryId));
      return json({
        data: {
          success: false,
          httpStatus: null,
          responseTime: Date.now() - startedAt,
          error: message,
        },
      });
    }
  }

  if (request.method === "PATCH" || request.method === "PUT") {
    const body = (await request.json().catch(() => ({}))) as {
      url?: string;
      description?: string;
      events?: string[];
      enabled?: boolean;
    };
    const [row] = await db
      .update(webhookEndpoints)
      .set({
        url: body.url,
        description: body.description,
        events: body.events,
        enabled: body.enabled,
        updatedAt: now(),
      })
      .where(
        and(
          eq(webhookEndpoints.documentId, id),
          eq(webhookEndpoints.workspaceId, workspace.documentId),
        ),
      )
      .returning();
    return json({ data: row ? toWebhook(row) : null });
  }

  if (request.method === "DELETE") {
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.documentId, id));
    return new Response(null, { status: 204 });
  }

  return json({ message: "Method not allowed" }, { status: 405 });
}

function inviteStatus(row: {
  acceptedAt: Date | null;
  expiresAt: Date;
}): "accepted" | "expired" | "pending" {
  if (row.acceptedAt) return "accepted";
  if (row.expiresAt.getTime() <= Date.now()) return "expired";
  return "pending";
}

async function handleInvites(
  request: Request,
  path: string[],
  url: URL,
  db: AppDb,
  user: AppUser,
): Promise<Response> {
  if (user.role !== "admin") {
    return json(
      { message: "Only an admin can manage invites" },
      { status: 403 },
    );
  }
  const id = path[1];

  if (!id && request.method === "GET") {
    const rows = await listInvites(db);
    return json({
      data: rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        status: inviteStatus(row),
        // The link is only useful while pending; hide the token once accepted.
        token: row.acceptedAt ? null : row.token,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      })),
    });
  }

  if (!id && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      email?: string;
      role?: string;
    };
    const email = body.email?.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return json({ message: "A valid email is required" }, { status: 400 });
    }
    const role = body.role === "admin" ? "admin" : "member";
    const invite = await createInvite(db, {
      email,
      role,
      invitedBy: String(user.id),
    });
    const env = await getRuntimeEnv();
    const base = env.NEXT_PUBLIC_SITE_URL ?? env.BETTER_AUTH_URL ?? url.origin;
    const link = `${base.replace(/\/$/, "")}/invite/${invite.token}`;
    let emailSent = false;
    try {
      const result = await sendInviteEmail({
        email,
        env,
        url: link,
        invitedByName: user.name,
      });
      emailSent = result.sent;
    } catch {
      // Delivery failed — still return the link for the admin to copy.
      emailSent = false;
    }
    return json(
      {
        data: {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          status: "pending" as const,
          token: invite.token,
          link,
          emailSent,
          createdAt: invite.createdAt,
          expiresAt: invite.expiresAt,
        },
      },
      { status: 201 },
    );
  }

  if (id && request.method === "PATCH") {
    const body = (await request.json().catch(() => ({}))) as { role?: string };
    const role = body.role === "admin" ? "admin" : "member";
    await setInviteRole(db, id, role);
    return json({ data: { id, role } });
  }

  if (id && request.method === "DELETE") {
    await revokeInvite(db, id);
    return new Response(null, { status: 204 });
  }

  return json({ message: "Method not allowed" }, { status: 405 });
}

async function handleEngineConfig(
  request: Request,
  path: string[],
  url: URL,
  db: AppDb,
  user: AppUser,
) {
  // POST /config/reembed — admin re-embeds the current project against the
  // active embedder (after an embedder change). Per-workspace + tenant-scoped.
  if (request.method === "POST" && path[1] === "reembed") {
    if (user.role !== "admin") {
      return json({ message: "Admins only" }, { status: 403 });
    }
    const requested = url.searchParams.get("workspace");
    const ws =
      user.workspaces?.find((w) => w.documentId === requested) ??
      user.workspaces?.[0];
    if (!ws) return json({ message: "No project" }, { status: 400 });
    const task = await enqueueOperationTask(db, {
      workspaceId: ws.documentId,
      operationId: crypto.randomUUID(),
      kind: "rebuild",
      payload: { reason: "engine_config_changed" },
    });
    return json({ data: task }, { status: 202 });
  }

  // POST /config/test — live-validate a (possibly unsaved) draft against the
  // provider before saving: embed a short string / send a 1-token completion.
  // Keys fall back to the saved row then env, so testing a config that only
  // changed the model still works.
  if (request.method === "POST" && path[1] === "test") {
    if (user.role !== "admin") {
      return json({ message: "Admins only" }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const str = (k: string) =>
      typeof body[k] === "string" ? (body[k] as string).trim() : "";
    const row = await readEngineConfig();
    const env = await getRuntimeEnv();
    const openaiKey =
      env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    const anthropicKey =
      (env as unknown as Record<string, string | undefined>).ANTHROPIC_API_KEY ??
      process.env.ANTHROPIC_API_KEY ??
      "";
    const trimSlash = (s: string) => s.replace(/\/+$/, "");
    const shortErr = (status: number, text: string) => {
      try {
        const j = JSON.parse(text) as { error?: { message?: string } };
        if (j.error?.message) return `${status}: ${j.error.message}`;
      } catch {
        // not JSON
      }
      return `${status}: ${text.slice(0, 140) || "request failed"}`;
    };

    const startedAt = Date.now();
    try {
      if (body.target === "embedder") {
        const base = trimSlash(
          str("embedderBaseUrl") ||
            row?.embedderBaseUrl ||
            "https://api.openai.com/v1",
        );
        const key =
          str("embedderApiKey") || row?.embedderApiKey || openaiKey || "";
        const model =
          str("embedderModel") || row?.embedderModel || "text-embedding-3-small";
        const res = await fetch(`${base}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, input: "fishmem connection test" }),
        });
        if (!res.ok) {
          return json({
            data: { ok: false, message: shortErr(res.status, await res.text()) },
          });
        }
        const j = (await res.json()) as {
          data?: Array<{ embedding?: number[] }>;
        };
        return json({
          data: {
            ok: true,
            dim: j.data?.[0]?.embedding?.length ?? null,
            latencyMs: Date.now() - startedAt,
          },
        });
      }

      // LLM
      const provider = str("llmProvider") === "anthropic" ? "anthropic" : "openai";
      if (provider === "anthropic") {
        const key = str("llmApiKey") || row?.llmApiKey || anthropicKey || "";
        const model = str("llmModel") || row?.llmModel || "claude-3-5-haiku-latest";
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
        });
        if (!res.ok) {
          return json({
            data: { ok: false, message: shortErr(res.status, await res.text()) },
          });
        }
        return json({ data: { ok: true, latencyMs: Date.now() - startedAt } });
      }
      const base = trimSlash(
        str("llmBaseUrl") || row?.llmBaseUrl || "https://api.openai.com/v1",
      );
      const key = str("llmApiKey") || row?.llmApiKey || openaiKey || "";
      const model = str("llmModel") || row?.llmModel || "gpt-4o-mini";
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (!res.ok) {
        return json({
          data: { ok: false, message: shortErr(res.status, await res.text()) },
        });
      }
      return json({ data: { ok: true, latencyMs: Date.now() - startedAt } });
    } catch (e) {
      return json({
        data: { ok: false, message: (e as Error).message },
      });
    }
  }

  if (request.method === "GET") {
    // Effective provider config (DB row merged over env) — surfaces env-set
    // baseURL/model/keys so an env-only deploy is reflected in the form.
    const provider = await describeProviderConfig();
    return json({
      data: {
        ...provider,
        // Database tab is read-only: the backend is fixed at deploy time (env).
        store:
          process.env.FISHMEM_DB ??
          process.env.FISHMEM_RUNTIME ??
          (IS_CLOUDFLARE_DEPLOY ? "d1 / vectorize" : "libsql"),
        canEdit: user.role === "admin",
      },
    });
  }

  if (request.method === "PUT" || request.method === "PATCH") {
    if (user.role !== "admin") {
      return json({ message: "Admins only" }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const str = (k: string) =>
      typeof body[k] === "string" ? (body[k] as string).trim() : undefined;
    const set: Record<string, unknown> = {
      embedderModel: str("embedderModel") || null,
      embedderBaseUrl: str("embedderBaseUrl") || null,
      llmProvider: str("llmProvider") === "anthropic" ? "anthropic" : "openai",
      llmModel: str("llmModel") || null,
      llmBaseUrl: str("llmBaseUrl") || null,
      derivationEnabled: body.derivationEnabled === true,
      updatedAt: now(),
    };
    // Only overwrite a key when a new (non-empty) value is supplied.
    const embKey = str("embedderApiKey");
    if (embKey) set.embedderApiKey = embKey;
    const llmKey = str("llmApiKey");
    if (llmKey) set.llmApiKey = llmKey;

    await db
      .insert(engineConfig)
      .values({ id: "default", ...set })
      .onConflictDoUpdate({ target: engineConfig.id, set });
    resetMemoryEngine();
    return json({ ok: true });
  }

  return json({ message: "Method not allowed" }, { status: 405 });
}

const IS_CLOUDFLARE_DEPLOY =
  typeof process === "undefined" || process.env.FISHMEM_RUNTIME === "cloudflare";

const handlers: Record<string, RouteHandler> = {
  users: handleUsers,
  invites: handleInvites,
  projects: handleProjects,
  config: handleEngineConfig,
  "api-tokens": handleApiTokens,
  requests: handleRequests,
  operations: handleOperations,
  usage: handleUsage,
  "project-settings": handleProjectSettings,
  "webhook-endpoints": handleWebhooks,
  memories: appMemoriesHandler,
  documents: appDocumentsHandler,
  entities: appEntitiesHandler,
  "document-uploads": appDocumentUploadsHandler,
};

export async function handleAppApi(request: Request, path: string[]) {
  const user = await getCurrentAppUser();
  if (!user) {
    return json({ message: "Unauthorized" }, { status: 401 });
  }

  const db = await getServerDb();
  const url = new URL(request.url);
  const handler = handlers[path[0] ?? ""];
  if (!handler) {
    return json({ message: "Not found" }, { status: 404 });
  }

  return handler(request, path, url, db, user);
}
