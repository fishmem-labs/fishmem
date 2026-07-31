import { apiFetch } from "@/lib/api";
import type { AddResultWire, MemoryWire } from "@fishmem/contracts";
import type { NamespaceSnapshotV1 } from "fishmem";

export type MemoryRow = MemoryWire;
export type AddResultRow = AddResultWire;

export async function fetchMemories(
  jwt: string,
  params: {
    query?: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    limit?: number;
    cursor?: string;
    workspace?: string | null;
  },
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  const response = await apiFetch<{
    results: MemoryRow[];
    next_cursor?: string | null;
  }>(
    `/api/memories${qs ? `?${qs}` : ""}`,
    { jwt },
  );
  return response.results ?? [];
}

export async function fetchAllMemories(
  jwt: string,
  params: Omit<Parameters<typeof fetchMemories>[1], "cursor" | "limit">,
) {
  const results: MemoryRow[] = [];
  let cursor: string | undefined;
  do {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, cursor, limit: 100 })) {
      if (value !== undefined && value !== "") search.set(key, String(value));
    }
    const page = await apiFetch<{
      results: MemoryRow[];
      next_cursor: string | null;
    }>(`/api/memories?${search.toString()}`, { jwt });
    results.push(...(page.results ?? []));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return results;
}

export type MemoryHistoryRow = {
  id: string;
  memory_id: string;
  event: string;
  previous_value?: string | null;
  new_value?: string | null;
  created_at: string;
};

export async function fetchMemoryHistory(
  jwt: string,
  id: string,
  workspace?: string | null,
) {
  const search = new URLSearchParams();
  if (workspace) search.set("workspace", workspace);
  const response = await apiFetch<{ results: MemoryHistoryRow[] }>(
    `/api/memories/${encodeURIComponent(id)}/history?${search.toString()}`,
    { jwt },
  );
  return response.results ?? [];
}

export async function fetchMemorySnapshot(
  jwt: string,
  workspace?: string | null,
) {
  const search = new URLSearchParams();
  if (workspace) search.set("workspace", workspace);
  const query = search.toString();
  const response = await apiFetch<{ data: NamespaceSnapshotV1 }>(
    `/api/memories/snapshot${query ? `?${query}` : ""}`,
    { jwt },
  );
  return response.data;
}

export async function importMemorySnapshot(
  jwt: string,
  snapshot: unknown,
  idempotencyKey: string,
  workspace?: string | null,
) {
  const search = new URLSearchParams();
  if (workspace) search.set("workspace", workspace);
  const query = search.toString();
  const response = await apiFetch<{
    data: { id: string; kind: string; status: string };
  }>(`/api/memories/snapshot${query ? `?${query}` : ""}`, {
    method: "POST",
    jwt,
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ snapshot }),
  });
  return response.data;
}

/** Per-source RRF inputs for one recalled memory (null = absent from that lane). */
export type RecallSources = {
  vector: number | null;
  fts: number | null;
  graph: number | null;
  temporal: number | null;
};

export type RecallItem = MemoryRow & { sources?: RecallSources };

export type BeliefChainRow = {
  subject: string;
  attribute: string;
  entries: Array<{
    id: string;
    content: string;
    eventDate?: string;
    validFrom?: string;
    validTo?: string;
    current: boolean;
  }>;
};

/**
 * Recall with the per-source retrieval trace (Playground): returns each hit's
 * fused score plus its vector/fts/graph/temporal contributions, and any belief
 * timelines for superseded facts.
 */
export async function recallWithContext(
  jwt: string,
  params: {
    query: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    limit?: number;
    workspace?: string | null;
  },
) {
  const search = new URLSearchParams({ trace: "1" });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "" && value !== null) {
      search.set(key, String(value));
    }
  }
  const response = await apiFetch<{
    results: RecallItem[];
    beliefs?: BeliefChainRow[];
  }>(`/api/memories?${search.toString()}`, { jwt });
  return {
    results: response.results ?? [],
    beliefs: response.beliefs ?? [],
  };
}

export async function addMemory(
  jwt: string,
  body: {
    content?: string;
    messages?: { role: string; content: string }[];
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    infer?: boolean;
    metadata?: Record<string, unknown>;
    workspace?: string | null;
  },
) {
  const idempotencyKey = `dashboard-add:${crypto.randomUUID()}`;
  const response = await apiFetch<
    | { results: AddResultRow[] }
    | { event_id: string; status: string }
  >("/api/memories", {
    jwt,
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
  if ("results" in response) return response.results ?? [];

  const startedAt = Date.now();
  while (Date.now() - startedAt < 130_000) {
    const params = new URLSearchParams();
    if (body.workspace) params.set("workspace", body.workspace);
    const query = params.toString();
    const operation = await apiFetch<{ data: MemoryOperationRow }>(
      `/api/operations/${encodeURIComponent(response.event_id)}${
        query ? `?${query}` : ""
      }`,
      { jwt },
    );
    if (operation.data.status === "success") {
      const result = operation.data.result;
      if (
        result &&
        typeof result === "object" &&
        Array.isArray((result as { results?: unknown }).results)
      ) {
        return (result as { results: AddResultRow[] }).results;
      }
      throw new Error("Memory inference completed without refined results");
    }
    if (operation.data.status === "dead") {
      throw new Error(
        operation.data.error ?? "Memory inference exhausted its retry budget",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Memory inference did not complete within 130 seconds");
}

export async function updateMemory(
  jwt: string,
  id: string,
  patch: { memory?: string; metadata?: Record<string, unknown> },
  workspace?: string | null,
) {
  const params = new URLSearchParams();
  if (workspace) params.set("workspace", workspace);
  const query = params.toString();
  const response = await apiFetch<{ data: MemoryRow }>(
    `/api/memories/${id}${query ? `?${query}` : ""}`,
    { jwt, method: "PATCH", body: JSON.stringify(patch) },
  );
  return response.data;
}

export async function deleteMemory(
  jwt: string,
  id: string,
  workspace?: string | null,
) {
  const params = new URLSearchParams();
  if (workspace) params.set("workspace", workspace);
  const query = params.toString();
  await apiFetch(`/api/memories/${id}${query ? `?${query}` : ""}`, {
    jwt,
    method: "DELETE",
  });
}

export type MemoryOperationRow = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  error: string | null;
  next_attempt_at: string | null;
  result: unknown;
  created_at: string;
  updated_at: string;
};

export async function batchDeleteMemories(
  jwt: string,
  ids: string[],
  workspace?: string | null,
) {
  const params = new URLSearchParams();
  if (workspace) params.set("workspace", workspace);
  const query = params.toString();
  const response = await apiFetch<{ data: MemoryOperationRow }>(
    `/api/memories/batch${query ? `?${query}` : ""}`,
    {
      jwt,
      method: "DELETE",
      headers: {
        "Idempotency-Key": `dashboard-batch-delete:${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        memories: ids.map((memory_id) => ({ memory_id })),
      }),
    },
  );
  return response.data;
}

export async function fetchMemoryState(
  jwt: string,
  params: {
    subject: string;
    attribute: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    as_of?: string;
    workspace?: string | null;
  },
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const response = await apiFetch<{ data: unknown }>(
    `/api/memories/state?${search.toString()}`,
    { jwt },
  );
  return response.data;
}

export type StateSlotRow = {
  id: string;
  subject: string;
  attribute: string;
  value: string;
  validFrom: string;
  validTo?: string;
  supersededBy?: string;
  sources: string[];
};

export async function fetchMemoryStateHistory(
  jwt: string,
  params: Omit<Parameters<typeof fetchMemoryState>[1], "as_of">,
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const response = await apiFetch<{ data: StateSlotRow[] }>(
    `/api/memories/state-history?${search.toString()}`,
    { jwt },
  );
  return response.data ?? [];
}

export async function fetchMemoryProfile(
  jwt: string,
  params: {
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    workspace?: string | null;
  },
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const response = await apiFetch<{ data: string | null }>(
    `/api/memories/profile?${search.toString()}`,
    { jwt },
  );
  return response.data;
}
