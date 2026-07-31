import { createFileRoute } from "@tanstack/react-router";
import { putDocumentUploadContent } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/document-uploads/$id/content")({
  server: {
    handlers: {
      PUT: ({ request, params }) =>
        putDocumentUploadContent(request, params.id),
    },
  },
});
