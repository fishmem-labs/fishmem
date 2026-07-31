import { createFileRoute } from "@tanstack/react-router";
import { getDocumentContentById } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/documents/$id/content")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        getDocumentContentById(request, params.id),
    },
  },
});
