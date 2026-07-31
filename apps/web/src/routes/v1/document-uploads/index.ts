import { createFileRoute } from "@tanstack/react-router";
import { createDocumentUpload } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/document-uploads/")({
  server: {
    handlers: {
      POST: ({ request }) => createDocumentUpload(request),
    },
  },
});
