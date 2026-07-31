import { createFileRoute } from "@tanstack/react-router";
import { getMemoryStateHistory } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/state/history")({
  server: {
    handlers: { GET: ({ request }) => getMemoryStateHistory(request) },
  },
});
