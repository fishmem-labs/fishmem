import { createFileRoute } from "@tanstack/react-router";
import {
  deleteDocumentUpload,
  getDocumentUpload,
} from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/document-uploads/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => getDocumentUpload(request, params.id),
      DELETE: ({ request, params }) =>
        deleteDocumentUpload(request, params.id),
    },
  },
});
