import { createFileRoute } from "@tanstack/react-router";
import { listScopeEntities } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/entities/")({
  server: {
    handlers: {
      GET: ({ request }) => listScopeEntities(request),
    },
  },
});
