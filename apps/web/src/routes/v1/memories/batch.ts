import { createFileRoute } from "@tanstack/react-router";
import {
  batchDeleteMemories,
  batchUpdateMemories,
} from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/memories/batch")({
  server: {
    handlers: {
      PUT: ({ request }) => batchUpdateMemories(request),
      DELETE: ({ request }) => batchDeleteMemories(request),
    },
  },
});
