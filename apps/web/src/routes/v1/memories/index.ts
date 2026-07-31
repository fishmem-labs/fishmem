import { createFileRoute } from "@tanstack/react-router";
import {
  addMemories,
  deleteAllMemories,
  listMemories,
} from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/memories/")({
  server: {
    handlers: {
      GET: ({ request }) => listMemories(request),
      POST: ({ request }) => addMemories(request),
      DELETE: ({ request }) => deleteAllMemories(request),
    },
  },
});
