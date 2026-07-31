import { createFileRoute } from "@tanstack/react-router";
import {
  deleteDocumentById,
  getDocumentById,
} from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/documents/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => getDocumentById(request, params.id),
      DELETE: ({ request, params }) => deleteDocumentById(request, params.id),
    },
  },
});
