import { createFileRoute } from "@tanstack/react-router";
import { completeDocumentUpload } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/document-uploads/$id/complete")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        completeDocumentUpload(request, params.id),
    },
  },
});
