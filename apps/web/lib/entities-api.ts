import { apiFetch } from "@/lib/api";
import type { ScopeType } from "@/components/dashboard/entities-shared";

export type ScopeEntityRow = {
  id: string;
  type: ScopeType;
  total_memories: number;
  created_at: string;
  updated_at: string;
};

export async function fetchAllScopeEntities(
  jwt: string,
  workspace?: string | null,
) {
  const results: ScopeEntityRow[] = [];
  let cursor: string | undefined;
  do {
    const search = new URLSearchParams({ limit: "100" });
    if (workspace) search.set("workspace", workspace);
    if (cursor) search.set("cursor", cursor);
    const response = await apiFetch<{
      data: {
        results: ScopeEntityRow[];
        next_cursor: string | null;
      };
    }>(`/api/entities?${search.toString()}`, { jwt });
    results.push(...response.data.results);
    cursor = response.data.next_cursor ?? undefined;
  } while (cursor);
  return results;
}
export async function deleteScopeEntity(
  jwt: string,
  entity: Pick<ScopeEntityRow, "id" | "type">,
  workspace?: string | null,
) {
  const search = new URLSearchParams();
  if (workspace) search.set("workspace", workspace);
  const query = search.toString();
  const response = await apiFetch<{
    data: { id: string; type: ScopeType; deleted_memories: number };
  }>(
    `/api/entities/${encodeURIComponent(entity.type)}/${encodeURIComponent(entity.id)}${
      query ? `?${query}` : ""
    }`,
    {
      method: "DELETE",
      jwt,
      headers: {
        "Idempotency-Key": `dashboard-entity-delete:${crypto.randomUUID()}`,
      },
    },
  );
  return response.data;
}
