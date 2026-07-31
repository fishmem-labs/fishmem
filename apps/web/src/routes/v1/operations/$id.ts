import { createFileRoute } from "@tanstack/react-router";
import { getOperationById } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/operations/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => getOperationById(request, params.id),
    },
  },
});
