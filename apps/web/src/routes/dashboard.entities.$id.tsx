import { createFileRoute } from "@tanstack/react-router";
import { EntityDetail } from "@/components/dashboard/entity-detail";
import type { ScopeType } from "@/components/dashboard/entities-shared";

const scopes = new Set(["user", "agent", "run"]);

export const Route = createFileRoute("/dashboard/entities/$id")({
  validateSearch: (search: Record<string, unknown>) => ({
    type:
      typeof search.type === "string" && scopes.has(search.type)
        ? (search.type as ScopeType)
        : ("user" as ScopeType),
  }),
  component: EntityRoute,
});

function EntityRoute() {
  const { id } = Route.useParams();
  const { type } = Route.useSearch();
  return <EntityDetail entityId={decodeURIComponent(id)} scopeType={type} />;
}
