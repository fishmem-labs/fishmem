import { appApiPath } from "@/lib/config";
import type { AppWorkspace } from "@/lib/user";

export class ApiError extends Error {
  status: number;
  body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type ApiFetchOptions = RequestInit & {
  jwt?: string | null;
};

async function readBody(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function errorMessage(body: unknown, status: number) {
  if (typeof body === "string" && body.trim()) {
    return body;
  }
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const nested = record.error;
    if (nested && typeof nested === "object") {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === "string") {
        return message;
      }
    }
    if (typeof record.message === "string") {
      return record.message;
    }
  }
  return `Request failed with status ${status}`;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}) {
  const headers = new Headers(options.headers);
  const formBody =
    typeof FormData !== "undefined" && options.body instanceof FormData;
  if (options.jwt) {
    headers.set("Authorization", `Bearer ${options.jwt}`);
  }
  if (options.body && !formBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(appApiPath(path), {
    ...options,
    headers,
    credentials: "include",
    cache: options.cache ?? "no-store"
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body = await readBody(response);
  if (!response.ok) {
    throw new ApiError(errorMessage(body, response.status), response.status, body);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function fetchProjects(jwt: string) {
  const response = await apiFetch<{ data: AppWorkspace[] }>(`/api/projects`, {
    jwt,
  });
  return response.data ?? [];
}

export async function createProject(
  jwt: string,
  name: string,
  description?: string,
) {
  const response = await apiFetch<{ data: AppWorkspace }>(`/api/projects`, {
    method: "POST",
    jwt,
    body: JSON.stringify({ name, description }),
  });
  return response.data;
}

export async function updateProjectName(
  jwt: string,
  projectId: string,
  name: string,
) {
  const response = await apiFetch<{ data: AppWorkspace }>(
    `/api/projects/${projectId}`,
    {
      method: "PATCH",
      jwt,
      body: JSON.stringify({ name }),
    },
  );
  return response.data;
}

export async function updateProject(
  jwt: string,
  projectId: string,
  patch: { name: string; description?: string },
) {
  const response = await apiFetch<{ data: AppWorkspace }>(
    `/api/projects/${projectId}`,
    {
      method: "PATCH",
      jwt,
      body: JSON.stringify(patch),
    },
  );
  return response.data;
}

export async function deleteProject(jwt: string, projectId: string) {
  await apiFetch(`/api/projects/${projectId}`, { method: "DELETE", jwt });
}

// ---------------------------------------------------------------------------
// Engine configuration (instance-level, admin-only edit)
// ---------------------------------------------------------------------------

export type EngineConfig = {
  embedderModel: string;
  embedderBaseUrl: string;
  embedderApiKeySet: boolean;
  /** True when embedderBaseUrl comes from env (no DB override). */
  embedderBaseUrlFromEnv: boolean;
  llmProvider: "openai" | "anthropic";
  llmModel: string;
  llmBaseUrl: string;
  llmApiKeySet: boolean;
  /** True when llmBaseUrl comes from env (no DB override). */
  llmBaseUrlFromEnv: boolean;
  derivationEnabled: boolean;
  /** OPENAI_API_KEY present in env (serves the embedder + the OpenAI LLM). */
  envEmbedderKey: boolean;
  /** ANTHROPIC_API_KEY present in env (serves the Anthropic LLM). */
  envAnthropicKey: boolean;
  /** Memory-store backend label — read-only (fixed at deploy time via env). */
  store: string;
  configured: boolean;
  canEdit: boolean;
};

export type EngineConfigInput = {
  embedderModel?: string;
  embedderBaseUrl?: string;
  embedderApiKey?: string;
  llmProvider?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  derivationEnabled?: boolean;
};

export async function fetchEngineConfig(jwt: string) {
  const response = await apiFetch<{ data: EngineConfig }>("/api/config", { jwt });
  return response.data;
}

export async function updateEngineConfig(jwt: string, body: EngineConfigInput) {
  await apiFetch("/api/config", {
    method: "PUT",
    jwt,
    body: JSON.stringify(body),
  });
}

export type EngineTestResult = {
  ok: boolean;
  dim?: number | null;
  latencyMs?: number;
  message?: string;
};

/** Admin: live-validate a draft embedder/LLM config against the provider. */
export async function testEngineConfig(
  jwt: string,
  body: { target: "embedder" | "llm" } & EngineConfigInput,
) {
  const response = await apiFetch<{ data: EngineTestResult }>(
    "/api/config/test",
    { method: "POST", jwt, body: JSON.stringify(body) },
  );
  return response.data;
}

/** Admin: re-embed every memory in a project against the active embedder. */
export async function reembedMemories(
  jwt: string,
  workspaceId?: string | null,
) {
  const query = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
  const response = await apiFetch<{
    data: { reembedded: number; total: number };
  }>(`/api/config/reembed${query}`, { method: "POST", jwt });
  return response.data;
}

// ---------------------------------------------------------------------------
// Members (invites) — admin-only, instance-scoped (OSS is invite-only).
// ---------------------------------------------------------------------------

export type MemberRole = "admin" | "member";

export type InviteRow = {
  id: string;
  email: string | null;
  role: MemberRole;
  status: "pending" | "accepted" | "expired";
  token?: string | null;
  link?: string;
  createdAt?: string;
  expiresAt?: string;
};

export async function fetchInvites(jwt: string) {
  const response = await apiFetch<{ data: InviteRow[] }>("/api/invites", { jwt });
  return response.data ?? [];
}

export async function inviteMember(
  jwt: string,
  email: string,
  role: MemberRole,
) {
  const response = await apiFetch<{ data: InviteRow }>("/api/invites", {
    method: "POST",
    jwt,
    body: JSON.stringify({ email, role }),
  });
  return response.data;
}

export async function revokeInvite(jwt: string, id: string) {
  await apiFetch(`/api/invites/${id}`, { method: "DELETE", jwt });
}

export async function setInviteRole(jwt: string, id: string, role: MemberRole) {
  await apiFetch(`/api/invites/${id}`, {
    method: "PATCH",
    jwt,
    body: JSON.stringify({ role }),
  });
}

export type ProjectSettings = {
  instructions: string;
  categories: string[];
  updatedAt?: string | null;
};

export async function fetchProjectSettings(
  jwt: string,
  workspaceId?: string | null,
) {
  const params = new URLSearchParams();
  if (workspaceId) {
    params.set("workspace", workspaceId);
  }
  const response = await apiFetch<{ data: ProjectSettings }>(
    `/api/project-settings${params.toString() ? `?${params.toString()}` : ""}`,
    { jwt },
  );
  return response.data;
}

export async function updateProjectSettings(
  jwt: string,
  data: Partial<Pick<ProjectSettings, "instructions" | "categories">>,
  workspaceId?: string | null,
) {
  const params = new URLSearchParams();
  if (workspaceId) {
    params.set("workspace", workspaceId);
  }
  const response = await apiFetch<{ data: ProjectSettings }>(
    `/api/project-settings${params.toString() ? `?${params.toString()}` : ""}`,
    {
      method: "PATCH",
      jwt,
      body: JSON.stringify(data),
    },
  );
  return response.data;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type RequestRange = "today" | "last_7_days" | "last_30_days" | "all";

export type RequestEvent = {
  id: string;
  createdAt: string;
  endpoint: string;
  method?: string;
  path?: string;
  kind: string;
  status: "success" | "failed" | "pending";
  httpStatus?: number;
  latencyMs?: number | null;
  apiKey?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type RequestsSummary = {
  range: RequestRange;
  totalRequests: number;
  addEvents: number;
  retrievalEvents: number;
  failedRequests?: number;
};

export async function fetchRequests(
  jwt: string,
  range: RequestRange,
  workspaceId?: string | null,
) {
  const params = new URLSearchParams({ range });
  if (workspaceId) {
    params.set("workspace", workspaceId);
  }
  return apiFetch<{
    data: RequestEvent[];
    summary: RequestsSummary;
  }>(`/api/requests?${params.toString()}`, { jwt });
}

// ---------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------

export type ApiToken = {
  id: string | number;
  documentId?: string | null;
  name: string;
  token?: string;
  masked_token?: string;
  status: "active" | "revoked" | "expired";
  permissions: string[];
  last_used_at?: string | null;
  expires_at?: string | null;
  revoked_at?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type ApiTokenUsage = {
  tokenId: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  last_used_at?: string;
  dailyUsage: { date: string; requests: number }[];
};

export async function fetchApiTokens(jwt: string, workspaceId?: string | null) {
  const params = new URLSearchParams();
  if (workspaceId) {
    params.set("workspace", workspaceId);
  }
  const query = params.toString();
  const response = await apiFetch<{ data: ApiToken[] }>(
    `/api/api-tokens${query ? `?${query}` : ""}`,
    { jwt }
  );
  return response.data ?? [];
}

export async function createApiToken(
  jwt: string,
  name: string,
  workspaceId?: string | null,
  options?: { permissions?: string[]; expiresAt?: string | null }
) {
  const response = await apiFetch<{ data: ApiToken }>(`/api/api-tokens`, {
    method: "POST",
    jwt,
    body: JSON.stringify({
      name,
      workspace: workspaceId || undefined,
      permissions: options?.permissions,
      expires_at: options?.expiresAt
    })
  });
  return response.data;
}

export async function updateApiToken(
  jwt: string,
  tokenId: string,
  data: { name?: string; permissions?: string[]; expires_at?: string | null },
  workspaceId?: string | null
) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspace", workspaceId);
  const query = params.toString();
  const response = await apiFetch<{ data: ApiToken }>(
    `/api/api-tokens/${tokenId}${query ? `?${query}` : ""}`,
    {
      method: "PUT",
      jwt,
      body: JSON.stringify(data)
    }
  );
  return response.data;
}

export async function revokeApiToken(
  jwt: string,
  tokenId: string,
  workspaceId?: string | null
) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspace", workspaceId);
  const query = params.toString();
  const response = await apiFetch<{ data: ApiToken }>(
    `/api/api-tokens/${tokenId}/revoke${query ? `?${query}` : ""}`,
    {
      method: "POST",
      jwt,
      body: JSON.stringify({})
    }
  );
  return response.data;
}

export async function activateApiToken(
  jwt: string,
  tokenId: string,
  workspaceId?: string | null
) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspace", workspaceId);
  const query = params.toString();
  const response = await apiFetch<{ data: ApiToken }>(
    `/api/api-tokens/${tokenId}/activate${query ? `?${query}` : ""}`,
    {
      method: "POST",
      jwt,
      body: JSON.stringify({})
    }
  );
  return response.data;
}

export async function deleteApiToken(
  jwt: string,
  tokenId: string,
  workspaceId?: string | null
) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspace", workspaceId);
  const query = params.toString();
  await apiFetch(`/api/api-tokens/${tokenId}${query ? `?${query}` : ""}`, {
    method: "DELETE",
    jwt
  });
}

export async function fetchApiTokenUsage(
  jwt: string,
  tokenId: string,
  workspaceId?: string | null
) {
  const params = new URLSearchParams();
  if (workspaceId) {
    params.set("workspace", workspaceId);
  }
  const query = params.toString();
  const response = await apiFetch<{ data: ApiTokenUsage }>(
    `/api/api-tokens/${tokenId}/usage${query ? `?${query}` : ""}`,
    { jwt }
  );
  return response.data;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export type UsageRange = "this_cycle" | "last_30_days" | "last_7_days" | "today";

export type UsageMetric = {
  label?: string;
  value: number;
  formattedValue?: string;
  change?: string;
  trend?: "up" | "down" | "neutral";
};

export type UsageSummary = {
  range: UsageRange;
  metrics?: {
    totalRequests?: UsageMetric;
    successRate?: UsageMetric;
    avgLatency?: UsageMetric;
  };
  dailyUsage?: Array<{ date: string; requests: number }>;
  topApiKeys?: Array<{
    keyId: string;
    keyName: string;
    requests: number;
    percentage?: number;
  }>;
  topEndpoints?: Array<{
    endpoint: string;
    requests: number;
    avgLatency?: number;
  }>;
  observability?: {
    events: number;
    inputTokens: number;
    outputTokens: number;
    knownCostMicros: number;
    unpricedCalls: number;
    warnings: number;
    retries: number;
    p50LatencyMs: number | null;
    p95LatencyMs: number | null;
  };
};

export async function fetchUsage(
  jwt: string,
  range: UsageRange,
  workspaceId?: string | null
) {
  const params = new URLSearchParams({ range });
  if (workspaceId) {
    params.set("workspace", workspaceId);
  }
  const response = await apiFetch<{ data: UsageSummary }>(
    `/api/usage?${params}`,
    { jwt }
  );
  return response.data;
}

export type OperatorOperation = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  error: string | null;
  raw_status?: string;
  vector_status?: string;
  derived_status?: string;
  result_count?: number;
  document_id?: string | null;
  chunks?: number | null;
  query_visibility_target_ms?: number | null;
  created_at: string;
  updated_at: string;
};

export type OperationsConsoleData = {
  operations: OperatorOperation[];
  events: Array<{
    id: string;
    kind: string;
    operation_id: string | null;
    provider: string | null;
    model: string | null;
    latency_ms: number | null;
    retry_count: number;
    warning_code: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>;
  warnings: Array<{
    id: string;
    code: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>;
  health: {
    pending_tasks: number;
    dead_tasks: number;
    active_warnings: number;
    projection_repairs: number;
    webhooks: Record<string, number>;
  };
};

export async function fetchOperationsConsole(
  jwt: string,
  workspaceId?: string | null,
) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspace", workspaceId);
  const response = await apiFetch<{ data: OperationsConsoleData }>(
    `/api/operations?${params.toString()}`,
    { jwt },
  );
  return response.data;
}

export async function requestProjectionRebuild(
  jwt: string,
  workspaceId?: string | null,
) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspace", workspaceId);
  return apiFetch(`/api/operations/rebuild?${params.toString()}`, {
    jwt,
    method: "POST",
  });
}

export async function retryOperation(
  jwt: string,
  operationId: string,
  workspaceId?: string | null,
) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspace", workspaceId);
  return apiFetch(
    `/api/operations/${encodeURIComponent(operationId)}/retry?${params.toString()}`,
    { jwt, method: "POST" },
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export type WebhookEventType =
  | "memory_add"
  | "memory_update"
  | "memory_delete"
  | "document_extract_queued"
  | "document_ingest"
  | "document_delete"
  | "webhook.test";

export type WebhookEndpoint = {
  id: number | string;
  documentId: string;
  url: string;
  description?: string;
  enabled: boolean;
  events: WebhookEventType[];
  createdAt: string;
  updatedAt: string;
};

export type WebhookEndpointWithSecret = WebhookEndpoint & {
  secret: string;
};

export type WebhookDelivery = {
  id: string | number;
  documentId: string;
  eventId: string;
  eventType: string;
  taskId?: string;
  status: "pending" | "processing" | "success" | "failed" | "unknown";
  attempts: number;
  httpStatus?: number | null;
  error?: string | null;
  createdAt: string;
};

export type WebhookTestResult = {
  success: boolean;
  httpStatus?: number | null;
  responseTime?: number | null;
  error?: string;
};

function normalizeWebhook<T extends { id?: string | number; documentId?: string | null }>(
  webhook: T
): T & { documentId: string } {
  return {
    ...webhook,
    documentId: webhook.documentId ?? String(webhook.id ?? "")
  };
}

function normalizeDelivery<
  T extends { id?: string | number; documentId?: string | null }
>(delivery: T): T & { documentId: string } {
  return {
    ...delivery,
    documentId: delivery.documentId ?? String(delivery.id ?? "")
  };
}

export async function fetchWebhooks(jwt: string, workspaceId?: string | null) {
  const params = new URLSearchParams();
  if (workspaceId) {
    params.set("workspace", workspaceId);
  }
  const query = params.toString();
  const response = await apiFetch<{ data: WebhookEndpoint[] }>(
    `/api/webhook-endpoints${query ? `?${query}` : ""}`,
    { jwt }
  );
  return (response.data ?? []).map(normalizeWebhook);
}

export async function createWebhook(
  jwt: string,
  data: {
    url: string;
    description?: string;
    events?: WebhookEventType[];
    enabled?: boolean;
    workspace?: string;
  }
) {
  const response = await apiFetch<{ data: WebhookEndpointWithSecret }>(
    `/api/webhook-endpoints`,
    {
      method: "POST",
      jwt,
      body: JSON.stringify(data)
    }
  );
  return normalizeWebhook(response.data);
}

export async function updateWebhook(
  jwt: string,
  documentId: string,
  data: {
    url?: string;
    description?: string;
    events?: WebhookEventType[];
    enabled?: boolean;
  },
  workspaceId?: string | null
) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspace", workspaceId);
  const query = params.toString();
  const response = await apiFetch<{ data: WebhookEndpoint }>(
    `/api/webhook-endpoints/${documentId}${query ? `?${query}` : ""}`,
    {
      method: "PATCH",
      jwt,
      body: JSON.stringify(data)
    }
  );
  return normalizeWebhook(response.data);
}

export async function deleteWebhook(
  jwt: string,
  documentId: string,
  workspaceId?: string | null
) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspace", workspaceId);
  const query = params.toString();
  await apiFetch(`/api/webhook-endpoints/${documentId}${query ? `?${query}` : ""}`, {
    method: "DELETE",
    jwt
  });
}

export async function rotateWebhookSecret(
  jwt: string,
  documentId: string,
  workspaceId?: string | null
) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspace", workspaceId);
  const query = params.toString();
  const response = await apiFetch<{ data: WebhookEndpointWithSecret }>(
    `/api/webhook-endpoints/${documentId}/rotate-secret${query ? `?${query}` : ""}`,
    {
      method: "POST",
      jwt,
      body: JSON.stringify({})
    }
  );
  return normalizeWebhook(response.data);
}

export async function testWebhook(
  jwt: string,
  documentId: string,
  workspaceId?: string | null
) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspace", workspaceId);
  const query = params.toString();
  const response = await apiFetch<{ data: WebhookTestResult }>(
    `/api/webhook-endpoints/${documentId}/test${query ? `?${query}` : ""}`,
    {
      method: "POST",
      jwt,
      body: JSON.stringify({})
    }
  );
  return response.data;
}

export async function fetchWebhookDeliveries(
  jwt: string,
  documentId: string,
  workspaceId?: string | null
) {
  const params = new URLSearchParams();
  if (workspaceId) {
    params.set("workspace", workspaceId);
  }
  const query = params.toString();
  const response = await apiFetch<{ data: WebhookDelivery[] }>(
    `/api/webhook-endpoints/${documentId}/deliveries${query ? `?${query}` : ""}`,
    { jwt }
  );
  return (response.data ?? []).map(normalizeDelivery);
}
