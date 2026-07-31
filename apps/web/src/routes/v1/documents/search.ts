import { createFileRoute } from "@tanstack/react-router";
import { searchDocuments } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/documents/search")({
  server: {
    handlers: {
      POST: ({ request }) => searchDocuments(request),
    },
  },
});
