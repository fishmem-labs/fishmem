import { createFileRoute } from "@tanstack/react-router";
import { memoryHistoryById } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/memories/$id/history")({
  server: {
    handlers: {
      GET: ({ request, params }) => memoryHistoryById(request, params.id),
    },
  },
});
