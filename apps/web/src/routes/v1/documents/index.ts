import { createFileRoute } from "@tanstack/react-router";
import {
  ingestDocument,
  listDocuments,
} from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/documents/")({
  server: {
    handlers: {
      GET: ({ request }) => listDocuments(request),
      POST: ({ request }) => ingestDocument(request),
    },
  },
});
