import { createFileRoute } from "@tanstack/react-router";
import {
  deleteScopeEntity,
  getScopeEntity,
} from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/entities/$type/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        getScopeEntity(request, params.type, params.id),
      DELETE: ({ request, params }) =>
        deleteScopeEntity(request, params.type, params.id),
    },
  },
});
